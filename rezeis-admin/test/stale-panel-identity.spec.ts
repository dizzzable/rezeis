import 'reflect-metadata';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { SubscriptionStatus } from '@prisma/client';
import { of } from 'rxjs';

import { _resetProcessRoleCacheForTests } from '../src/common/runtime/process-role.util';
import { EVENT_PRESENTATION } from '../src/common/services/system-events.service';
import {
  panelDeviceOwnerKey,
  panelUserPatchKey,
} from '../src/modules/remnawave/services/panel-user-address';
import {
  RemnawaveApiService,
  StalePanelIdentityRefusal,
} from '../src/modules/remnawave/services/remnawave-api.service';
import {
  STALE_PANEL_IDENTITY_CENSUS_REASON,
  StalePanelIdentityCensus,
} from '../src/modules/remnawave/services/stale-panel-identity.census';
import {
  DECIMAL_PANEL_ID_PATTERN,
  isNumericPanelIdentity,
  isStalePanelIdentity,
  SUBSCRIPTION_DELETE_STALE_PANEL_LINK_CODE,
  SUBSCRIPTION_DEVICE_DELETE_STALE_PANEL_LINK_CODE,
  SUBSCRIPTION_REGENERATE_STALE_PANEL_LINK_CODE,
  UNLINKED_SUBSCRIPTIONS_PATH,
} from '../src/modules/remnawave/services/stale-panel-link';
import { BulkUserOperationsService } from '../src/modules/users/services/bulk-user-operations.service';

/**
 * The safety net under every destructive panel call, and the boot count
 * ═══════════════════════════════════════════════════════════════════════
 * A 3.x panel issues decimal ids and nothing else, so a stored identity that is
 * not a decimal — a 2.x uuid, an empty string, imported junk — names nobody on a
 * supported panel. Resolved through the address chain (recorded panel id →
 * short uuid from the saved link → username), it can land on another customer's
 * LIVE profile. So every destructive adapter method refuses one first, before
 * any address is resolved; and the boot count says how many such rows are left.
 *
 * ONE TEST for both: `isStalePanelIdentity`, spelled by one pattern that the
 * code and the SQL share.
 */

const DEAD_UUID = '330f2b38-1362-46ab-9c1d-5e4d3c2b1a09';
/** A uuid that CONTAINS a transient-looking run of digits (`503`). */
const DEAD_UUID_503 = '5030f2b3-1362-46ab-9c1d-5e4d3c2b1a09';
const LIVE_DECIMAL = '4711';

/**
 * The stale row at its most dangerous: every fallback the address chain would
 * use is recorded, so an unguarded destructive call would resolve it — through
 * `remnawavePanelId` first — to profile 5150, somebody's live account.
 */
const DANGEROUS_IDENTITY = {
  remnawaveId: DEAD_UUID,
  panelId: 5150,
  panelUsername: 'rz_bob_sub',
  panelShortUuid: 'Zq3xLiveShort',
};

describe('the stale-identity test', () => {
  const stale = [
    DEAD_UUID,
    '',
    'abc',
    ' 42',
    '42 ',
    '4 2',
    '-42',
    '+42',
    '4.2',
    '42\n',
    '٤٢', // Arabic-Indic digits: a "digit" to some regex flavours, not to a panel
    '0x2A',
    '1e3',
  ];
  const current = ['0', '42', '0042', LIVE_DECIMAL, '123456789012345678901234'];

  it('a uuid, an empty string and junk are stale; a decimal is not', () => {
    for (const value of stale) assert.equal(isStalePanelIdentity(value), true, JSON.stringify(value));
    for (const value of current) assert.equal(isStalePanelIdentity(value), false, JSON.stringify(value));
  });

  it('is exactly "not numeric" — one test, never a second spelling', () => {
    for (const value of [...stale, ...current]) {
      assert.equal(isStalePanelIdentity(value), !isNumericPanelIdentity(value), JSON.stringify(value));
    }
  });

  it('the pattern shared with the SQL count is the plain decimal one', () => {
    // A literal, not the constant read back: a test that took its expectation
    // from the constant would move with it.
    assert.equal(DECIMAL_PANEL_ID_PATTERN, '^[0-9]+$');
  });

  it('stale-panel-link.ts imports nothing — the SPA test reaches it across the package boundary', () => {
    const source = readFileSync(
      join(__dirname, '..', 'src', 'modules', 'remnawave', 'services', 'stale-panel-link.ts'),
      'utf8',
    );
    assert.equal(/^\s*import\s/m.test(source), false, 'an import statement');
    assert.equal(/\bfrom\s+['"]/.test(source), false, 'a re-export from another module');
    assert.equal(/\brequire\(/.test(source), false, 'a require');
  });
});

describe('the address helpers never turn a stale identity into a number', () => {
  it('the device owner key is chosen by the FORM of the segment', () => {
    assert.deepEqual(panelDeviceOwnerKey('42'), { userId: 42 });
    // `Number.parseInt` would read 330 — another customer.
    assert.equal(panelDeviceOwnerKey(DEAD_UUID), null);
    assert.equal(panelDeviceOwnerKey(''), null);
    assert.equal(panelDeviceOwnerKey('12abc'), null);
    // A decimal past 2^53 rounds to a neighbour's id.
    assert.equal(panelDeviceOwnerKey('99999999999999999999'), null);
  });

  it('the PATCH key has no uuid arm and never parses a uuid', () => {
    assert.deepEqual(panelUserPatchKey({ remnawaveId: '42', panelId: null, panelUsername: null }), { id: 42 });
    assert.deepEqual(panelUserPatchKey({ remnawaveId: DEAD_UUID, panelId: 7, panelUsername: 'x' }), { id: 7 });
    assert.deepEqual(panelUserPatchKey({ remnawaveId: DEAD_UUID, panelId: null, panelUsername: 'rz_bob' }), {
      username: 'rz_bob',
    });
    // A short uuid is resolved by the adapter; the pure helper cannot act.
    assert.equal(
      panelUserPatchKey({ remnawaveId: DEAD_UUID, panelId: null, panelUsername: null, panelShortUuid: 'Zq3x' }),
      null,
    );
    assert.equal(panelUserPatchKey({ remnawaveId: DEAD_UUID, panelId: null, panelUsername: null }), null);
  });
});

/** The adapter over a recording HTTP stub. `major` is what the version gate says. */
function adapter(major: number | null) {
  const sent: Array<{ readonly method: string; readonly url: string; readonly data: unknown }> = [];
  const http = {
    request: (config: { method: string; url: string; data?: unknown }) => {
      sent.push({ method: config.method, url: config.url, data: config.data });
      return of({
        data: {
          response: { total: 0, devices: [], isDeleted: true, subscriptionUrl: 'https://sub.example.test/new', id: 5150 },
        },
      });
    },
  };
  const service = new RemnawaveApiService(
    http as never,
    { host: 'remnawave', port: 3000, token: 'secret', webhookSecret: null } as never,
    undefined,
    { readMajor: async () => major },
  );
  let resolves = 0;
  const original = service.resolvePanelSegment.bind(service);
  (service as unknown as { resolvePanelSegment: unknown }).resolvePanelSegment = async (ref: unknown) => {
    resolves += 1;
    return original(ref as never);
  };
  return { service, sent, resolves: () => resolves };
}

const DESTRUCTIVE: ReadonlyArray<{
  readonly name: string;
  readonly code: string;
  readonly call: (service: RemnawaveApiService, ref: unknown) => Promise<unknown>;
}> = [
  {
    name: 'deletePanelUser',
    code: SUBSCRIPTION_DELETE_STALE_PANEL_LINK_CODE,
    call: (service, ref) => service.deletePanelUser(ref as never),
  },
  {
    name: 'deletePanelUserDevice',
    code: SUBSCRIPTION_DEVICE_DELETE_STALE_PANEL_LINK_CODE,
    call: (service, ref) => service.deletePanelUserDevice(ref as never, 'hwid-1'),
  },
  {
    name: 'deleteAllPanelUserDevices',
    code: SUBSCRIPTION_DEVICE_DELETE_STALE_PANEL_LINK_CODE,
    call: (service, ref) => service.deleteAllPanelUserDevices(ref as never),
  },
  {
    name: 'regeneratePanelUserSubscription',
    code: SUBSCRIPTION_REGENERATE_STALE_PANEL_LINK_CODE,
    call: (service, ref) => service.regeneratePanelUserSubscription(ref as never),
  },
];

describe('each destructive adapter method refuses a stale identity before it resolves an address', () => {
  for (const verb of DESTRUCTIVE) {
    for (const [label, ref] of [
      ['a bare uuid', DEAD_UUID],
      ['a uuid with every fallback recorded', DANGEROUS_IDENTITY],
      ['an empty id', ''],
    ] as const) {
      it(`${verb.name}: ${label} — refused with its code, nothing resolved, nothing sent`, async () => {
        const { service, sent, resolves } = adapter(3);
        const error = await verb.call(service, ref).then(
          () => null,
          (caught: unknown) => caught,
        );
        assert.ok(error instanceof StalePanelIdentityRefusal, `${verb.name} did not refuse`);
        assert.equal(error.code, verb.code);
        assert.ok(error.message.startsWith(`${verb.code}:`));
        assert.equal(resolves(), 0, 'the address chain was consulted');
        assert.deepEqual(sent, []);
      });
    }

    for (const major of [3, null] as const) {
      it(`${verb.name}: a decimal identity proceeds with the version ${major === null ? 'unreadable' : 'at 3'}`, async () => {
        const { service, sent } = adapter(major);
        await verb.call(service, LIVE_DECIMAL);
        assert.equal(sent.length, 1, 'exactly one request');
        assert.match(sent[0].url, /4711|hwid\/devices\/delete/);
      });
    }
  }

  it('the device bodies name the owner by the number — never a uuid, never a parsed prefix', async () => {
    const { service, sent } = adapter(3);
    await service.deletePanelUserDevice(LIVE_DECIMAL, 'hwid-1');
    await service.deleteAllPanelUserDevices(LIVE_DECIMAL);
    assert.deepEqual(
      sent.map((request) => request.data),
      [{ userId: 4711, hwid: 'hwid-1' }, { userId: 4711 }],
    );
  });

  it('strictDeleteUserDevice answers a TERMINAL invalidContract carrying the code, and sends nothing', async () => {
    for (const ref of [DEAD_UUID, DANGEROUS_IDENTITY, '']) {
      const { service, sent, resolves } = adapter(3);
      const outcome = await service.strictDeleteUserDevice(ref as never, 'hwid-1');
      assert.equal(outcome.kind, 'invalidContract');
      assert.ok(
        outcome.kind === 'invalidContract' &&
          outcome.details.startsWith(`${SUBSCRIPTION_DEVICE_DELETE_STALE_PANEL_LINK_CODE}:`),
      );
      assert.equal(resolves(), 0);
      assert.deepEqual(sent, []);
    }
    const { service, sent } = adapter(null);
    const ok = await service.strictDeleteUserDevice(LIVE_DECIMAL, 'hwid-1');
    assert.equal(ok.kind, 'ok');
    assert.deepEqual(sent.map((request) => request.data), [{ userId: 4711, hwid: 'hwid-1' }]);
  });
});

describe('the refusal classifies TERMINAL wherever a message is read for it', () => {
  // The worker-side classifier (`classifyRecovery`, profile-sync) reads a plain
  // `Error`'s MESSAGE for these words, and an id interpolated into it can carry
  // them (`DEAD_UUID_503`). So the message names no identity at all — one
  // sentence per code, whatever row it refuses.
  const TRANSIENT_WORDS = /timeout|temporar|econn|429|502|503|504|unavailable/;

  it('carries none of the transient words, and no identity', async () => {
    for (const verb of DESTRUCTIVE) {
      const messages = new Set<string>();
      for (const ref of [DEAD_UUID, DEAD_UUID_503, DANGEROUS_IDENTITY, '']) {
        const { service } = adapter(3);
        const error = (await verb.call(service, ref).catch((caught: unknown) => caught)) as Error;
        assert.equal(TRANSIENT_WORDS.test(error.message.toLowerCase()), false, error.message);
        messages.add(error.message);
      }
      assert.equal(messages.size, 1, `${verb.name} interpolates the identity`);
    }
  });
});

/** The bulk toolbar over the REAL adapter — the path that used to have no check. */
function bulkOverRealAdapter(subscriptions: ReadonlyArray<Record<string, unknown>>) {
  const { service: adapterService, sent } = adapter(3);
  const audit: Array<Record<string, unknown>> = [];
  const prisma = {
    user: { findFirst: async () => ({ id: 'user-1', telegramId: 42n, isBlocked: false }) },
    subscription: { findMany: async () => subscriptions },
    adminAuditLog: {
      create: async (args: { data: Record<string, unknown> }) => {
        audit.push(args.data);
        return args.data;
      },
    },
  };
  const service = new BulkUserOperationsService(
    prisma as never,
    { warn: () => undefined, info: () => undefined } as never,
    { deleteUser: async () => undefined } as never,
    { block: async () => undefined, unblock: async () => undefined } as never,
    { hasPermission: async () => true } as never,
    adapterService,
    { enqueue: async () => undefined } as never,
  );
  const run = () =>
    service.execute({
      userIds: ['user-1'],
      action: 'revoke_devices',
      currentAdmin: { id: 'admin-1' } as never,
      requestMetadata: { requestId: null, remoteAddress: null, userAgent: null } as never,
    });
  return { run, sent, audit };
}

describe('bulk «Удалить устройства» meets the same net', () => {
  it('a stale row is refused — no device list anywhere is touched — and the row says why', async () => {
    const { run, sent, audit } = bulkOverRealAdapter([
      {
        id: 'sub-1',
        status: SubscriptionStatus.ACTIVE,
        expiresAt: null,
        remnawaveId: DEAD_UUID,
        remnawavePanelId: 5150,
        remnawavePanelUsername: 'rz_bob_sub',
      },
    ]);
    const result = await run();

    assert.deepEqual(sent, []);
    assert.equal(result.items[0]?.status, 'error');
    assert.match(result.items[0]?.message ?? '', /1 refused/);
    assert.ok((result.items[0]?.message ?? '').includes(UNLINKED_SUBSCRIPTIONS_PATH));
    assert.equal((audit[0]?.['metadata'] as { refusedStalePanelLink?: number }).refusedStalePanelLink, 1);
  });

  it('control: a decimal row goes through the same harness to the panel', async () => {
    const { run, sent } = bulkOverRealAdapter([
      {
        id: 'sub-1',
        status: SubscriptionStatus.ACTIVE,
        expiresAt: null,
        remnawaveId: LIVE_DECIMAL,
        remnawavePanelId: 4711,
        remnawavePanelUsername: 'rz_alice_sub',
      },
    ]);
    const result = await run();

    assert.equal(result.items[0]?.status, 'ok');
    assert.deepEqual(sent.map((request) => [request.url, request.data]), [
      ['/api/hwid/devices/delete-all', { userId: 4711 }],
    ]);
  });
});

// ── The boot count ──────────────────────────────────────────────────────────

interface RaisedEvent {
  readonly type: string;
  readonly category: string;
  readonly message: string;
  readonly metadata: Record<string, unknown>;
}

function census(count: () => Promise<Array<{ stale: number }>>) {
  const errors: RaisedEvent[] = [];
  const queries: Array<{ strings: readonly string[]; values: readonly unknown[] }> = [];
  const warnings: string[] = [];
  const service = new StalePanelIdentityCensus(
    {
      $queryRaw: (query: { strings: readonly string[]; values: readonly unknown[] }) => {
        queries.push(query);
        return count();
      },
    } as never,
    {
      error: (type: string, category: string, message: string, metadata: Record<string, unknown>) =>
        errors.push({ type, category, message, metadata }),
    } as never,
  );
  (service as unknown as { logger: unknown }).logger = {
    error: () => undefined,
    warn: (line: string) => warnings.push(line),
  };
  return { service, errors, queries, warnings };
}

describe('the boot count of stale rows', () => {
  let savedRole: string | undefined;
  beforeEach(() => {
    savedRole = process.env.RUID_PROCESS_ROLE;
  });
  afterEach(() => {
    if (savedRole === undefined) delete process.env.RUID_PROCESS_ROLE;
    else process.env.RUID_PROCESS_ROLE = savedRole;
    _resetProcessRoleCacheForTests();
  });

  it('counts live rows with the SAME pattern the refusals test, excluding DELETED and empty links', async () => {
    const { service, queries } = census(async () => [{ stale: 0 }]);
    await service.run();
    const sql = queries[0]?.strings.join('?') ?? '';
    assert.match(sql, /"remnawave_id" !~ \?/);
    assert.match(sql, /"status" <> 'DELETED'/);
    assert.match(sql, /"remnawave_id" IS NOT NULL/);
    assert.deepEqual(queries[0]?.values, [DECIMAL_PANEL_ID_PATTERN]);
  });

  it('n > 0: one ERROR card whose «Почему» carries n and whose «Что проверить» names the list', async () => {
    const { service, errors } = census(async () => [{ stale: 37 }]);
    assert.equal(await service.run(), 37);

    assert.equal(errors.length, 1);
    const [event] = errors;
    assert.equal(event.type, 'system.remnawave_sync');
    assert.equal(event.metadata['subscriptions'], 37);
    assert.equal(event.metadata['reason'], STALE_PANEL_IDENTITY_CENSUS_REASON);
    assert.match(String(event.metadata['why']), /: 37\./);
    assert.ok(String(event.metadata['nextSteps']).includes(UNLINKED_SUBSCRIPTIONS_PATH));
    assert.ok(String(event.metadata['nextSteps']).includes('«Привязать профиль»'));
    assert.match(String(event.metadata['nextSteps']), /Автоматическая проверка привязки/);
  });

  it('its incident card has a header of its own, not the generic one', () => {
    const header = EVENT_PRESENTATION['system.remnawave_sync']?.variants?.find((variant) =>
      variant.when({ reason: STALE_PANEL_IDENTITY_CENSUS_REASON }),
    );
    assert.equal(header?.title, 'В базе остались подписки с идентификатором Remnawave 2.x');
  });

  it('0: says nothing', async () => {
    const { service, errors } = census(async () => [{ stale: 0 }]);
    assert.equal(await service.run(), 0);
    assert.deepEqual(errors, []);
  });

  it('a count that throws is a warning, never a failure', async () => {
    const { service, errors, warnings } = census(async () => {
      throw new Error('relation "subscriptions" does not exist');
    });
    assert.equal(await service.run(), null);
    assert.deepEqual(errors, []);
    assert.equal(warnings.length, 1);
  });

  it('does not run in the API process', async () => {
    process.env.RUID_PROCESS_ROLE = 'api';
    _resetProcessRoleCacheForTests();
    const { service, queries } = census(async () => [{ stale: 5 }]);
    service.onApplicationBootstrap();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(queries, []);
  });

  it('runs on the worker without holding up boot', async () => {
    process.env.RUID_PROCESS_ROLE = 'worker';
    _resetProcessRoleCacheForTests();
    let release: (rows: Array<{ stale: number }>) => void = () => undefined;
    const { service, errors, queries } = census(
      () => new Promise((resolve) => (release = resolve)),
    );
    // Returns while the count is still pending: boot does not wait on it.
    assert.equal(service.onApplicationBootstrap(), undefined);
    assert.equal(queries.length, 1);
    assert.deepEqual(errors, []);
    release([{ stale: 2 }]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(errors.length, 1);
  });
});
