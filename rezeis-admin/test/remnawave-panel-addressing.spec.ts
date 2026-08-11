import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { of, throwError } from 'rxjs';

import {
  isNumericPanelIdentity,
  panelDeviceOwnerKey,
  panelShortUuidFromConfigUrl,
  panelUserAddress,
  panelUserPatchKey,
  type StoredPanelIdentity,
} from '../src/modules/remnawave/services/panel-user-address';
import { RemnawaveApiService } from '../src/modules/remnawave/services/remnawave-api.service';
import { mapHwidTopUser } from '../src/modules/remnawave/services/remnawave-extended-mappers';

/**
 * The layer that decides HOW a panel profile is named, across all three
 * supported panel versions.
 *
 * This is the load-bearing piece of three-version support: seventeen adapter
 * methods build their paths from it, and the failure it must never produce is
 * the quiet one — addressing SOMEBODY rather than nobody. Remnawave 2.x keys
 * users by UUID, 3.x deleted that column and keys them by a numeric id, and the
 * old uuid survives nowhere after the panel's own upgrade migration. So an
 * identifier that "looks fine" can belong to a different profile entirely.
 */

const UUID = '330f2b38-1362-46ab-b5c0-dea32167eff9';
const SHORT_UUID = 'PyTr7C5568QuLhup';

function stored(patch: Partial<StoredPanelIdentity> = {}): StoredPanelIdentity {
  return { remnawaveId: UUID, panelId: null, panelUsername: null, ...patch };
}

describe('panelShortUuidFromConfigUrl', () => {
  it('extracts the 3.2.3 root-path subscription short uuid', () => {
    assert.equal(panelShortUuidFromConfigUrl(`https://sub.nodeaccess.cc/${SHORT_UUID}`), SHORT_UUID);
    assert.equal(
      panelShortUuidFromConfigUrl(`https://sub.nodeaccess.cc/${SHORT_UUID}?format=sing-box#devices`),
      SHORT_UUID,
    );
  });

  it('keeps the older explicit subscription path formats', () => {
    assert.equal(panelShortUuidFromConfigUrl(`https://sub.nodeaccess.cc/api/sub/${SHORT_UUID}`), SHORT_UUID);
    assert.equal(panelShortUuidFromConfigUrl(`https://sub.nodeaccess.cc/sub/${SHORT_UUID}`), SHORT_UUID);
  });

  it('does not confuse service routes with profile material', () => {
    for (const value of [
      'https://sub.nodeaccess.cc/api',
      'https://sub.nodeaccess.cc/subscription',
      'https://sub.nodeaccess.cc/subscriptions',
      'https://sub.nodeaccess.cc/favicon.ico',
      'https://sub.nodeaccess.cc/assets/app.js',
    ]) {
      assert.equal(panelShortUuidFromConfigUrl(value), null, value);
    }
  });
});

describe('panelUserAddress — 2.x panels (uuid-addressed)', () => {
  it('uses the stored uuid as-is', () => {
    const address = panelUserAddress(stored(), 'uuid');
    assert.deepEqual(address, { kind: 'ready', segment: UUID });
  });

  it('a numeric identity on a uuid panel means a rollback — resolve by name', () => {
    // Only reachable when a profile was created on 3.x and the operator then
    // downgraded. We never had a uuid for it, because 3.x had none to give.
    const address = panelUserAddress(
      stored({ remnawaveId: '42', panelUsername: 'rz_bob_1' }),
      'uuid',
    );
    assert.deepEqual(address, { kind: 'needsResolve', selector: { username: 'rz_bob_1' } });
  });

  it('a numeric identity with no name recorded is honestly impossible', () => {
    const address = panelUserAddress(stored({ remnawaveId: '42' }), 'uuid');
    assert.equal(address.kind, 'impossible');
  });
});

describe('panelUserAddress — 3.x panels (id-addressed)', () => {
  it('uses the stored identity when it is already the numeric id', () => {
    const address = panelUserAddress(stored({ remnawaveId: '42' }), 'id');
    assert.deepEqual(address, { kind: 'ready', segment: '42' });
  });

  it('prefers the recorded numeric id over a round-trip', () => {
    const address = panelUserAddress(stored({ panelId: 7, panelUsername: 'rz_bob_1' }), 'id');
    assert.deepEqual(address, { kind: 'ready', segment: '7' });
  });

  it('falls back to the short uuid when the panel was upgraded before we saw the id', () => {
    const address = panelUserAddress(stored({ panelShortUuid: SHORT_UUID, panelUsername: 'rz_bob_1' }), 'id');
    assert.deepEqual(address, { kind: 'needsResolve', selector: { shortUuid: SHORT_UUID } });
  });

  it('uses the name when no saved subscription short uuid exists', () => {
    const address = panelUserAddress(stored({ panelUsername: 'rz_bob_1' }), 'id');
    assert.deepEqual(address, { kind: 'needsResolve', selector: { username: 'rz_bob_1' } });
  });

  it('refuses when neither the id nor the name was ever recorded', () => {
    const address = panelUserAddress(stored(), 'id');
    assert.equal(address.kind, 'impossible');
    // The reason has to name the actual obstacle — an operator reads this.
    assert.match((address as { reason: string }).reason, /2\.x uuid/);
  });

  it('NEVER falls back to the uuid, which a 3.x panel rejects as NaN', () => {
    // The whole point. A 3.x panel answers `400 expected number, received NaN`
    // for a uuid in an id slot — safe, but the integration is dead. Emitting the
    // uuid anyway would be the bug this type exists to prevent.
    for (const identity of [stored(), stored({ panelUsername: 'rz_bob_1' })]) {
      const address = panelUserAddress(identity, 'id');
      if (address.kind === 'ready') assert.notEqual(address.segment, UUID);
    }
  });
});

describe('panelUserAddress — an unknown panel version', () => {
  it('uses the stored identity unchanged rather than refusing', () => {
    // Deliberate, and the opposite of what looks safe. Version detection fails
    // for the same reasons a request fails — unreachable panel, bad token — so
    // refusing here would fire exactly when the panel is already answering with
    // TERMINAL errors, and would turn those into "cannot act", which the sync
    // layer classifies as transient. Forever-retry with no alert.
    //
    // The stored string names the right profile or nobody; it is a conversion
    // between the two forms, done without the material, that can name someone
    // ELSE. That is what stays impossible.
    assert.deepEqual(panelUserAddress(stored(), 'unknown'), { kind: 'ready', segment: UUID });
    assert.deepEqual(panelUserAddress(stored({ remnawaveId: '42' }), 'unknown'), {
      kind: 'ready',
      segment: '42',
    });
  });

  it('never converts between the two forms without the material', () => {
    // The invariant that survives: no output segment is ever a form the stored
    // identity was not already in, unless it came from a recorded id or a
    // resolve-by-name.
    const address = panelUserAddress(stored({ panelId: 7 }), 'unknown');
    assert.equal(address.kind, 'ready');
    if (address.kind !== 'ready') return;
    assert.equal(address.segment, UUID, 'must not silently switch to the recorded numeric id');
  });
});

describe('panelUserPatchKey — the one write that needs no version branch', () => {
  it('keys by uuid on 2.x and by numeric id on 3.x', () => {
    assert.deepEqual(panelUserPatchKey(stored(), 'uuid'), { uuid: UUID });
    assert.deepEqual(panelUserPatchKey(stored({ panelId: 7 }), 'id'), { id: 7 });
  });

  it('falls back to the username, which every supported version accepts', () => {
    assert.deepEqual(panelUserPatchKey(stored({ panelUsername: 'rz_bob_1' }), 'id'), {
      username: 'rz_bob_1',
    });
  });

  it('keeps preferring the identifier when the version is unknown', () => {
    // The name is the one key BOTH eras accept, so writing by it always lands —
    // and that is exactly why it must not be the preference. Panel usernames are
    // deterministic, so a re-provisioned profile inherits the name of the one we
    // hold an identity for, and a write keyed by name silently retargets it.
    // The stored identifier names the right profile or nobody: the wrong-era key
    // is dropped and the panel answers `400 At least one of …`.
    assert.deepEqual(panelUserPatchKey(stored({ panelUsername: 'rz_bob_1' }), 'unknown'), {
      uuid: UUID,
    });
    assert.deepEqual(
      panelUserPatchKey(
        { remnawaveId: '42', panelId: 42, panelUsername: 'rz_bob_1' },
        'unknown',
      ),
      { id: 42 },
      'a numeric stored identity is a 3.x id, whatever the panel turns out to be',
    );
  });

  it('gives up rather than inventing a key', () => {
    assert.equal(panelUserPatchKey(stored({ remnawaveId: '42' }), 'uuid'), null);
  });

  it('prefers the immutable identifier over the name', () => {
    // An operator who renames a profile by hand in the panel would otherwise
    // silently retarget every later write.
    assert.deepEqual(panelUserPatchKey(stored({ panelUsername: 'renamed' }), 'uuid'), {
      uuid: UUID,
    });
  });
});

describe('panelDeviceOwnerKey — the HWID body key', () => {
  it('is userUuid on 2.x and userId on 3.x', () => {
    assert.deepEqual(panelDeviceOwnerKey(UUID, 'uuid'), { userUuid: UUID });
    assert.deepEqual(panelDeviceOwnerKey('42', 'id'), { userId: 42 });
  });
});

describe('isNumericPanelIdentity', () => {
  it('accepts a decimal id and rejects everything a uuid can look like', () => {
    assert.equal(isNumericPanelIdentity('42'), true);
    assert.equal(isNumericPanelIdentity('0'), true);
    assert.equal(isNumericPanelIdentity(UUID), false);
    assert.equal(isNumericPanelIdentity('4e2'), false);
    assert.equal(isNumericPanelIdentity('+42'), false);
    assert.equal(isNumericPanelIdentity(' 42'), false);
    assert.equal(isNumericPanelIdentity(''), false);
  });
});

// ── The adapter half: shape detection and the resolve round-trip ─────────────

const CONFIG = {
  host: 'remnawave',
  port: 3000,
  token: 'secret',
  webhookSecret: null,
} as const;

function build(handler: (input: { method: string; url: string; data?: unknown }) => unknown) {
  const captured: Array<{ method: string; url: string; data?: unknown }> = [];
  const service = new RemnawaveApiService(
    {
      request: (input: { method: string; url: string; data?: unknown }) => {
        captured.push({ method: input.method, url: input.url, data: input.data });
        return handler(input);
      },
    } as never,
    CONFIG as never,
  );
  return { service, captured };
}

const recap = (version: string) => of({ data: { response: { version } } });

describe('RemnawaveApiService.getPanelShape', () => {
  it('reads 2.8.0 as uuid-addressed with the ip-control family', async () => {
    const { service } = build(() => recap('2.8.0'));
    assert.deepEqual(await service.getPanelShape(), {
      version: '2.8.0',
      addressing: 'uuid',
      connectionsApi: 'ip-control',
      userLookups: { byTelegramId: true, byEmail: true },
      // Keyset paging arrived in 2.8; 2.7.4 has no such route.
      usersStream: true,
    });
  });

  it('reads 3.2.1 as id-addressed with the connections family', async () => {
    const { service } = build(() => recap('3.2.1'));
    assert.deepEqual(await service.getPanelShape(), {
      version: '3.2.1',
      addressing: 'id',
      connectionsApi: 'connections',
      // Both shortcuts were deleted in 3.x; the stream filters replace them.
      userLookups: { byTelegramId: false, byEmail: false },
      usersStream: true,
    });
  });

  it('falls back to /api/system/metadata when recap carries no version', async () => {
    const { service, captured } = build(({ url }) =>
      url.includes('recap') ? of({ data: { response: {} } }) : of({ data: { response: { version: '3.2.1' } } }),
    );
    assert.equal((await service.getPanelShape()).version, '3.2.1');
    assert.deepEqual(
      captured.map((c) => c.url),
      ['/api/system/stats/recap', '/api/system/metadata'],
    );
  });

  it('an unreachable panel is unknown on BOTH fields, never a default', async () => {
    const { service } = build(() => throwError(() => new Error('ECONNREFUSED')));
    assert.deepEqual(await service.getPanelShape(), {
      version: null,
      addressing: 'unknown',
      connectionsApi: 'unknown',
      // The ONE field where unknown does not mean unknown, deliberately: both
      // lookup routes are pure reads that find the right user or nobody, so the
      // tie goes to what every panel this integration has run against serves.
      userLookups: { byTelegramId: true, byEmail: true },
      // And here the conservative choice is the opposite one: the offset route
      // exists on every supported version, the stream does not.
      usersStream: false,
    });
  });

  it('caches a successful read instead of asking on every path build', async () => {
    const { service, captured } = build(() => recap('3.2.1'));
    await service.getPanelShape();
    await service.getPanelShape();
    await service.getPanelShape();
    assert.equal(captured.length, 1);
  });

  it('force re-reads, so a fixed token does not wait out the window', async () => {
    const { service, captured } = build(() => recap('3.2.1'));
    await service.getPanelShape();
    await service.getPanelShape(true);
    assert.equal(captured.length, 2);
  });

  it('does not cache a failure for the full success window', async () => {
    // Both readers fail, so the negative window applies. Asserting the window
    // itself rather than sleeping: a 15s wait in a unit test is not a test.
    const { service } = build(() => throwError(() => new Error('down')));
    await service.getPanelShape();
    const { CAPABILITIES_CACHE_TTL_MS, CAPABILITIES_NEGATIVE_CACHE_TTL_MS } = await import(
      '../src/modules/remnawave/services/panel-version.util'
    );
    assert.ok(CAPABILITIES_NEGATIVE_CACHE_TTL_MS < CAPABILITIES_CACHE_TTL_MS);
  });
});

/** A 2.x user row: has both `uuid` and the numeric `id`. */
function row2x(over: Record<string, unknown> = {}) {
  return {
    uuid: UUID,
    id: 7,
    username: 'rz_bob_1',
    status: 'ACTIVE',
    subscriptionUrl: 'https://example.test/abc',
    telegramId: null,
    email: null,
    expireAt: '2030-01-01T00:00:00.000Z',
    createdAt: '2025-01-01T00:00:00.000Z',
    lastTrafficResetAt: null,
    trafficLimitBytes: 0,
    hwidDeviceLimit: 3,
    trafficLimitStrategy: 'NO_RESET',
    tag: null,
    description: null,
    activeInternalSquads: [],
    externalSquadUuid: null,
    ...over,
  };
}

/** A 3.x user row: no `uuid` FIELD AT ALL, keyed by the numeric `id`. */
function row3x(over: Record<string, unknown> = {}) {
  const { uuid: _dropped, ...rest } = row2x();
  return { ...rest, id: 42, shortUuid: 'PyTr7C5568QuLhup', ...over };
}

describe('decoding a user row across the two eras', () => {
  it('a 2.x row keeps its uuid as the identity', async () => {
    const { service } = build(() => of({ data: { response: { users: [row2x()], total: 1 } } }));
    const outcome = await service.strictGetAllPanelUsers();
    assert.equal(outcome.kind, 'ok');
    if (outcome.kind !== 'ok') return;
    assert.equal(outcome.value.users[0].uuid, UUID);
    assert.equal(outcome.value.users[0].panelId, 7);
  });

  it('a 3.x row is keyed by its numeric id, and the read is ok', async () => {
    // Before: every 3.x row decoded to null for want of a `uuid`, and the walk
    // escalated a whole page of them to "none carried a usable uuid" — taking
    // the bulk list, the import overlay and both anti-fraud bridges dark at once.
    const { service } = build(() => of({ data: { response: { users: [row3x()], total: 1 } } }));
    const outcome = await service.strictGetAllPanelUsers();
    assert.equal(outcome.kind, 'ok');
    if (outcome.kind !== 'ok') return;
    assert.equal(outcome.value.users[0].uuid, '42');
    assert.equal(outcome.value.users[0].panelId, 42);
  });

  it('a 2.x row with an EMPTY uuid stays undecodable, id or no id', async () => {
    // The distinction the decoder turns on. A damaged 2.x row must refuse the
    // read, not acquire a numeric key that matches no stored remnawaveId from
    // that era — that would turn "could not read" into "user unknown", and the
    // callers that act on absence would act.
    const { service } = build(() =>
      of({ data: { response: { users: [row2x({ uuid: '' })], total: 1 } } }),
    );
    const outcome = await service.strictGetAllPanelUsers();
    assert.equal(outcome.kind, 'invalidContract');
  });

  it('a row with neither identity is undecodable', async () => {
    const { service } = build(() =>
      of({ data: { response: { users: [row3x({ id: null })], total: 1 } } }),
    );
    assert.equal((await service.strictGetAllPanelUsers()).kind, 'invalidContract');
  });

  it('the CREATE idempotency lookup finds a 3.x profile', async () => {
    // `getPanelUserByUsername` used to require a string `uuid` and so answered
    // "no such profile" for every 3.x profile that exists. profile-sync would
    // then try to create a duplicate, which the panel refuses with
    // `400 username already exists` — a create loop, from one field name.
    const { service } = build(() => of({ data: { response: row3x() } }));
    const found = await service.getPanelUserByUsername('rz_bob_1');
    assert.notEqual(found, null);
    assert.equal(found?.uuid, '42');
    assert.equal(found?.panelId, 42);
  });
});

describe('live connections across the two endpoint families', () => {
  /** Answers the version probe, then plays the two-phase job. */
  function panel(version: string, result: unknown) {
    return build(({ url }) => {
      if (url.startsWith('/api/system/')) return recap(version);
      if (url.includes('by-user') || url.includes('by-node') || url.includes('fetch-')) {
        // A POST starts the job, a GET collects it. Both hit the same path on
        // 3.x, so the METHOD is what tells them apart.
        return of({ data: { response: { jobId: '9', isCompleted: true, isFailed: false, result } } });
      }
      return of({ data: { response: {} } });
    });
  }

  it('a 2.8 panel is asked through ip-control', async () => {
    const { service, captured } = panel('2.8.0', { users: [{ userId: '7', ips: [] }] });
    await service.fetchUsersIpsForNode('node-uuid');
    const paths = captured.map((c) => c.url).filter((u) => !u.startsWith('/api/system/'));
    assert.ok(paths.every((p) => p.startsWith('/api/ip-control/')), paths.join(', '));
  });

  it('a 3.2 panel is asked through connections, which is all it serves', async () => {
    // The whole family was deleted in 3.x. Asking the old paths there is a
    // guaranteed 404, and a 404 that comes back as `[]` reads to the sharing
    // detector as "nobody is online".
    const { service, captured } = panel('3.2.1', { success: true, users: [{ userId: 7, ips: [] }] });
    await service.fetchUsersIpsForNode('node-uuid');
    const paths = captured.map((c) => c.url).filter((u) => !u.startsWith('/api/system/'));
    assert.ok(paths.length > 0, 'the panel was never asked');
    assert.ok(paths.every((p) => p.startsWith('/api/connections/')), paths.join(', '));
  });

  it('reads a 3.x row whose userId is a NUMBER, not a string', async () => {
    // 2.x sends this id as a string, 3.x as a number. Accepting only the string
    // dropped every row on 3.x — an empty snapshot, not a reported failure.
    const { service } = panel('3.2.1', {
      success: true,
      users: [{ userId: 42, ips: [{ ip: '203.0.113.9', lastSeen: '2026-08-10T13:13:02.000Z' }] }],
    });
    const rows = await service.fetchUsersIpsForNode('node-uuid');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].userId, '42');
    assert.equal(rows[0].ips.length, 1);
  });

  it('a completed-but-failed job is a failure, not an empty snapshot', async () => {
    // This assertion used to be `deepEqual(…, [])` for BOTH cases — it asserted
    // the two are indistinguishable while its name claimed the opposite, and a
    // mutation that deleted the `success: false` guard entirely left the whole
    // suite green. The distinction has to reach the caller, or the guard is
    // decoration: `null` = could not look, `[]` = looked and found nobody.
    const { service } = panel('3.2.1', { success: false, users: [] });
    assert.equal(await service.fetchUsersIpsForNode('node-uuid'), null);

    // Same shape, success true, still empty: the case that legitimately means
    // nobody is online, and it must stay reachable and distinct.
    const ok = panel('3.2.1', { success: true, users: [] });
    assert.deepEqual(await ok.service.fetchUsersIpsForNode('node-uuid'), []);
  });


  it('dropping by user sends numeric ids on 3.x and uuids on 2.x', async () => {
    const three = panel('3.2.1', {});
    await three.service.dropConnections({
      dropBy: { by: 'userUuids', userUuids: ['42', '77'] },
      targetNodes: { target: 'allNodes' },
    });
    const dropped = three.captured.find((c) => c.url === '/api/connections/drop');
    assert.ok(dropped !== undefined, 'the 3.x drop was never sent');
    assert.deepEqual(dropped.data, {
      dropBy: { by: 'userIds', userIds: [42, 77] },
      targetNodes: { target: 'allNodes' },
    });

    const two = panel('2.8.0', {});
    await two.service.dropConnections({
      dropBy: { by: 'userUuids', userUuids: [UUID] },
      targetNodes: { target: 'allNodes' },
    });
    const old = two.captured.find((c) => c.url === '/api/ip-control/drop-connections');
    assert.ok(old !== undefined, 'the 2.x drop was never sent');
    assert.deepEqual(old.data, {
      dropBy: { by: 'userUuids', userUuids: [UUID] },
      targetNodes: { target: 'allNodes' },
    });
  });

  it('refuses a 3.x drop whose identities are all 2.x uuids', async () => {
    // Sending them would have the panel reject the whole request over the first
    // bad element, taking the enforcement action for every OTHER user with it.
    const { service, captured } = panel('3.2.1', {});
    const outcome = await service.dropConnections({
      dropBy: { by: 'userUuids', userUuids: [UUID] },
      targetNodes: { target: 'allNodes' },
    });
    assert.deepEqual(outcome, { ok: false });
    assert.equal(captured.filter((c) => c.url.includes('/drop')).length, 0);
  });
});

describe('getHwidTopUsers — the size the panel would otherwise pick for us', () => {
  /** Serves `/api/hwid/devices/top-users` out of one flat list, honouring the query. */
  function topUsersPanel(total: number) {
    const rows = Array.from({ length: total }, (_, i) => ({
      id: i + 1,
      username: `rz_user_${i + 1}`,
      devicesCount: total - i,
    }));
    return build((input) => {
      if (input.url.startsWith('/api/system/')) return recap('3.2.1');
      const query = new URLSearchParams(input.url.split('?')[1] ?? '');
      const start = Number(query.get('start') ?? '0');
      const size = Number(query.get('size') ?? '5');
      return of({ data: { response: { users: rows.slice(start, start + size), total } } });
    });
  }

  const pages = (captured: ReadonlyArray<{ url: string }>) =>
    captured.filter((c) => c.url.startsWith('/api/hwid/devices/top-users'));

  it('sends an explicit size instead of inheriting the contract default of five', async () => {
    // All three vendored contracts declare `size: z.coerce.number()…default(5)`.
    // Sending nothing did not mean "everything" — it meant five rows, and the
    // device-overage detector called everyone below them clean.
    const { service, captured } = topUsersPanel(3);
    await service.getHwidTopUsers();
    assert.equal(pages(captured).length, 1);
    assert.match(pages(captured)[0].url, /[?&]size=100(&|$)/);
    assert.match(pages(captured)[0].url, /[?&]start=0(&|$)/);
  });

  it('walks past the first page and stops on the reported total', async () => {
    const { service, captured } = topUsersPanel(250);
    const rows = await service.getHwidTopUsers();
    assert.equal(rows.length, 250, 'a 250-user panel must not be judged on 100 of them');
    // 100 + 100 + 50 — and no fourth request asking for rows the total ruled out.
    assert.deepEqual(
      pages(captured).map((c) => c.url),
      [
        '/api/hwid/devices/top-users?start=0&size=100',
        '/api/hwid/devices/top-users?start=100&size=100',
        '/api/hwid/devices/top-users?start=200&size=100',
      ],
    );
  });

  it('honours a caller that only wants a card of rows', async () => {
    // The admin card renders every row it is handed; the fraud detector wants
    // coverage. One method, and the CALLER says which.
    const { service, captured } = topUsersPanel(250);
    const rows = await service.getHwidTopUsers(5);
    assert.equal(rows.length, 5);
    assert.deepEqual(
      pages(captured).map((c) => c.url),
      ['/api/hwid/devices/top-users?start=0&size=5'],
    );
  });

  it('stops on a short page even when the panel ignores size and reports nonsense', async () => {
    // The endless-walk guard: a build that re-serves the same page forever would
    // otherwise be walked until the ceiling, at one request per hundred rows.
    const { service, captured } = build((input) =>
      input.url.startsWith('/api/system/')
        ? recap('3.2.1')
        : of({ data: { response: { users: [{ id: 1, username: 'a', devicesCount: 9 }], total: 999 } } }),
    );
    const rows = await service.getHwidTopUsers();
    assert.equal(rows.length, 1);
    assert.equal(pages(captured).length, 1);
  });

  it('still reports a read failure as blind rather than as a clean panel', async () => {
    const { service } = build((input) =>
      input.url.startsWith('/api/system/') ? recap('3.2.1') : throwError(() => new Error('down')),
    );
    assert.deepEqual(await service.getHwidTopUsers(), []);
  });
});

describe('a panel that changes era under an in-flight request', () => {
  const rejection = (status: number) =>
    throwError(() => ({
      isAxiosError: true,
      response: { status, headers: {}, data: { message: 'expected number, received NaN' } },
      message: `HTTP ${status}`,
    }));

  /**
   * A panel that is 2.8.0 until `flip()` is called and 3.2.1 afterwards, and
   * that refuses every user-scoped request throughout. This is the upgrade
   * window: the shape was cached before, the request was built from it, and the
   * panel has since stopped accepting that shape.
   */
  function upgradingPanel() {
    let version = '2.8.0';
    const harness = build((input) =>
      input.url.startsWith('/api/system/') ? recap(version) : rejection(400),
    );
    return { ...harness, flip: () => { version = '3.2.1'; } };
  }

  it('re-reads the version on a refusal and makes THAT failure retryable', async () => {
    const { service, captured, flip } = upgradingPanel();
    // Warm the cache the way a live process would: one successful shape read.
    assert.equal((await service.getPanelShape()).addressing, 'uuid');
    flip();

    // A 400 is normally TERMINAL — `RemnawaveUpstreamRejectionError`, which
    // `classifyRecovery` never retries. Here the addressing provably moved
    // between building the request and being refused, so the next attempt is
    // built differently and the job must live to make it.
    await assert.rejects(
      () => service.updatePanelUser(stored({ panelId: 7 }), { description: 'x' }),
      (err: Error) => {
        assert.equal(err.name, 'ServiceUnavailableException', err.name);
        return true;
      },
    );
    // The re-read happened, and it was forced rather than served from the
    // five-minute cache.
    assert.ok(
      captured.filter((c) => c.url.startsWith('/api/system/')).length >= 2,
      'the refusal must force a version re-read, not trust the cached shape',
    );
    assert.equal((await service.getPanelShape()).addressing, 'id');
  });

  it('leaves an ordinary refusal terminal — the version has not moved', async () => {
    // The forever-retry-with-no-alert hole this taxonomy was built to close. A
    // bad body, a rejected status value, a bad token: all still 400, all still
    // terminal, because the re-read comes back with the SAME addressing.
    const { service } = build((input) =>
      input.url.startsWith('/api/system/') ? recap('2.8.0') : rejection(400),
    );
    await service.getPanelShape();
    await assert.rejects(
      () => service.updatePanelUser(stored(), { description: 'x' }),
      (err: Error) => {
        assert.equal(err.name, 'RemnawaveUpstreamRejectionError', err.name);
        return true;
      },
    );
  });

  it('does not read an unreadable version as a moved one', async () => {
    // A revoked token 401s every request INCLUDING the version read, so the
    // re-probe comes back with `addressing: 'unknown'`. Counting that as a move
    // would make every auth failure retryable — the same
    // forever-retry-with-no-alert hole, entered from the other side.
    let reachable = true;
    const { service } = build((input) =>
      input.url.startsWith('/api/system/')
        ? (reachable ? recap('2.8.0') : rejection(401))
        : rejection(401),
    );
    assert.equal((await service.getPanelShape()).addressing, 'uuid');
    reachable = false;

    await assert.rejects(
      () => service.updatePanelUser(stored(), { description: 'x' }),
      (err: Error) => {
        assert.equal(err.name, 'RemnawaveUpstreamRejectionError', err.name);
        return true;
      },
    );
  });

  it('does not re-probe on its own version read — that would never terminate', async () => {
    // The re-read goes through this same transport. A panel refusing the recap
    // itself is the recursion this latch exists to stop.
    const { service, captured } = build(() => rejection(403));
    await service.getPanelShape();
    const before = captured.length;
    await service.getPanelShape(true);
    assert.equal(captured.length - before, 2, 'recap + metadata, and nothing recursive');
  });
});

describe('RemnawaveApiService.resolvePanelSegment', () => {
  it('needs no round-trip when the stored identity already fits the panel', async () => {
    const { service, captured } = build(() => recap('2.8.0'));
    const resolved = await service.resolvePanelSegment(stored());
    assert.deepEqual(resolved, { segment: UUID, panelId: null });
    // One call: the version read. No resolve.
    assert.equal(captured.filter((c) => c.url.includes('resolve')).length, 0);
  });

  it('resolves by username when a 2.x profile meets an upgraded panel', async () => {
    const { service, captured } = build(({ url }) =>
      url.includes('recap')
        ? recap('3.2.1')
        : of({ data: { response: { id: 77, shortUuid: 'abc', username: 'rz_bob_1' } } }),
    );
    const resolved = await service.resolvePanelSegment(stored({ panelUsername: 'rz_bob_1' }));
    assert.deepEqual(resolved, { segment: '77', panelId: 77 });
    const call = captured.find((c) => c.url.includes('resolve'));
    assert.ok(call !== undefined);
    assert.deepEqual(call.data, { username: 'rz_bob_1' });
  });

  it('resolves by saved subscription short uuid before falling back to username', async () => {
    const { service, captured } = build(({ url }) =>
      url.includes('recap')
        ? recap('3.2.3')
        : of({ data: { response: { id: 77, shortUuid: SHORT_UUID, username: 'rz_bob_1' } } }),
    );
    const resolved = await service.resolvePanelSegment(
      stored({ panelShortUuid: SHORT_UUID, panelUsername: 'rz_bob_1' }),
    );
    assert.deepEqual(resolved, { segment: '77', panelId: 77 });
    const call = captured.find((c) => c.url.includes('resolve'));
    assert.ok(call !== undefined);
    assert.deepEqual(call.data, { shortUuid: SHORT_UUID });
  });

  it('returns null — not a guess — when the profile cannot be named', async () => {
    const { service } = build(() => recap('3.2.1'));
    assert.equal(await service.resolvePanelSegment(stored()), null);
  });

  it('returns null when the panel does not know that username either', async () => {
    const { service } = build(({ url }) =>
      url.includes('recap')
        ? recap('3.2.1')
        : throwError(() => ({
            isAxiosError: true,
            response: { status: 404, headers: {}, data: { errorCode: 'A025' } },
            message: 'HTTP 404',
          })),
    );
    assert.equal(await service.resolvePanelSegment(stored({ panelUsername: 'gone' })), null);
  });

  it('falls back to the stored identity when the panel version cannot be read', async () => {
    // A down panel must not change how its own errors get classified. See the
    // `panelUserAddress — an unknown panel version` block for why refusing here
    // would be the more dangerous choice.
    const { service } = build(() => throwError(() => new Error('down')));
    assert.deepEqual(await service.resolvePanelSegment(stored({ panelId: 7 })), {
      segment: UUID,
      panelId: null,
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  The identifier in the BODY, and the reads that build it
// ═══════════════════════════════════════════════════════════════════════════

/**
 * `PATCH /api/users` is the one write with no path segment: the identifier
 * travels in the body, under a name that differs per era. These cover the four
 * methods that were still hard-coding `{ uuid }` there or interpolating the
 * stored string straight into a path.
 */

/** Answers the version probe with `version`, everything else with `payload`. */
function panelOn(version: string, payload: unknown) {
  return build((input) =>
    input.url.startsWith('/api/system/')
      ? of({ data: { response: { version } } })
      : of({ data: payload }),
  );
}

const USER_2X = {
  response: {
    uuid: UUID,
    id: 4471,
    username: 'rz_bob_1',
    status: 'ACTIVE',
    createdAt: '2026-01-01T00:00:00.000Z',
    expireAt: '2099-01-01T00:00:00.000Z',
    trafficLimitBytes: 0,
    hwidDeviceLimit: 0,
    trafficLimitStrategy: 'NO_RESET',
    tag: null,
    activeInternalSquads: [],
    externalSquadUuid: null,
  },
};

/** A 3.x row: the `uuid` KEY is absent entirely, not merely empty. */
const USER_3X = {
  response: {
    id: 4471,
    username: 'rz_bob_1',
    status: 'ACTIVE',
    createdAt: '2026-01-01T00:00:00.000Z',
    expireAt: '2099-01-01T00:00:00.000Z',
    trafficLimitBytes: 0,
    hwidDeviceLimit: 0,
    trafficLimitStrategy: 'NO_RESET',
    tag: null,
    activeInternalSquads: [],
    externalSquadUuid: null,
  },
};

function bodyOf(captured: ReadonlyArray<{ url: string; data?: unknown }>): Record<string, unknown> {
  const call = captured.find((c) => !c.url.startsWith('/api/system/'));
  assert.ok(call !== undefined, 'expected a panel request');
  return call.data as Record<string, unknown>;
}

function patchBodyOf(captured: ReadonlyArray<{ method: string; url: string; data?: unknown }>): Record<string, unknown> {
  const call = captured.find((c) => c.method === 'patch' && c.url === '/api/users');
  assert.ok(call !== undefined, 'expected a panel PATCH /api/users request');
  return call.data as Record<string, unknown>;
}

function pathOf(captured: ReadonlyArray<{ url: string }>): string {
  const call = captured.find((c) => !c.url.startsWith('/api/system/'));
  assert.ok(call !== undefined, 'expected a panel request');
  return call.url;
}

describe('updatePanelUser — the identifier travels in the body, keyed per era', () => {
  it('2.x gets { uuid }', async () => {
    const { service, captured } = panelOn('2.8.0', USER_2X);
    await service.updatePanelUser(stored(), { description: 'x' });
    assert.equal(bodyOf(captured)['uuid'], UUID);
    assert.equal('id' in bodyOf(captured), false);
  });

  it('3.x gets { id } as a NUMBER — a decimal string fails validation upstream', async () => {
    const { service, captured } = panelOn('3.2.1', USER_3X);
    await service.updatePanelUser(stored({ remnawaveId: '4471' }), { description: 'x' });
    assert.deepEqual(bodyOf(captured)['id'], 4471);
    assert.equal('uuid' in bodyOf(captured), false);
  });

  it('a 2.x-created profile on an upgraded panel is keyed by its RECORDED id', async () => {
    const { service, captured } = panelOn('3.2.1', USER_3X);
    await service.updatePanelUser(stored({ panelId: 4471 }), { description: 'x' });
    assert.equal(bodyOf(captured)['id'], 4471);
  });

  it('resolves a saved subscription short uuid to the numeric id before PATCH on 3.2.3', async () => {
    const { service, captured } = build((input) => {
      if (input.url.startsWith('/api/system/')) return recap('3.2.3');
      if (input.url === '/api/users/resolve') {
        return of({ data: { response: { id: 4471, shortUuid: SHORT_UUID, username: 'rz_bob_1' } } });
      }
      if (input.method === 'patch' && input.url === '/api/users') return of({ data: USER_3X });
      throw new Error(`unexpected panel call ${input.method} ${input.url}`);
    });

    await service.updatePanelUser(stored({ panelShortUuid: SHORT_UUID, panelUsername: 'rz_bob_1' }), {
      description: 'x',
    });

    assert.deepEqual(
      captured.filter((c) => c.url === '/api/users/resolve').map((c) => c.data),
      [{ shortUuid: SHORT_UUID }],
    );
    assert.equal(patchBodyOf(captured)['id'], 4471);
    assert.equal('shortUuid' in patchBodyOf(captured), false);
    assert.equal('uuid' in patchBodyOf(captured), false);
  });

  it('an unidentifiable panel is STILL keyed by the stored identifier, not the name', async () => {
    // Version detection folds every failure into "no version", and the name is
    // the one key all three eras accept — so writing by it always lands. That is
    // exactly why it is not used: panel usernames are deterministic, so a
    // re-provisioned profile inherits the name and the write lands on IT. The
    // stored uuid names the right profile or earns "At least one of username,
    // id must be provided", which nobody reads as success.
    const { service, captured } = build((input) =>
      input.url.startsWith('/api/system/')
        ? throwError(() => new Error('ECONNREFUSED'))
        : of({ data: USER_2X }),
    );
    await service.updatePanelUser(stored({ panelUsername: 'rz_bob_1' }), { description: 'x' });
    assert.equal(bodyOf(captured)['uuid'], UUID);
    assert.equal('username' in bodyOf(captured), false);
  });

  it('refuses rather than guessing when nothing can name the profile', async () => {
    // A 2.x uuid, a 3.x panel, and neither a numeric id nor a name recorded.
    const { service } = panelOn('3.2.1', USER_3X);
    await assert.rejects(() => service.updatePanelUser(stored(), { description: 'x' }));
  });
});

describe('strictSetUserLimits — same key, and an unaddressable profile DEFERS', () => {
  it('3.x gets { id }', async () => {
    const { service, captured } = panelOn('3.2.1', USER_3X);
    const outcome = await service.strictSetUserLimits(stored({ remnawaveId: '4471' }), {
      trafficLimitBytes: null,
      hwidDeviceLimit: null,
    });
    assert.equal(outcome.kind, 'ok');
    assert.equal(bodyOf(captured)['id'], 4471);
  });

  it('resolves a saved subscription short uuid to the numeric id before PATCH on 3.2.3', async () => {
    const { service, captured } = build((input) => {
      if (input.url.startsWith('/api/system/')) return recap('3.2.3');
      if (input.url === '/api/users/resolve') {
        return of({ data: { response: { id: 4471, shortUuid: SHORT_UUID, username: 'rz_bob_1' } } });
      }
      if (input.method === 'patch' && input.url === '/api/users') return of({ data: USER_3X });
      throw new Error(`unexpected panel call ${input.method} ${input.url}`);
    });

    const outcome = await service.strictSetUserLimits(
      stored({ panelShortUuid: SHORT_UUID, panelUsername: 'rz_bob_1' }),
      {
        trafficLimitBytes: null,
        hwidDeviceLimit: null,
      },
    );

    assert.equal(outcome.kind, 'ok');
    assert.deepEqual(
      captured.filter((c) => c.url === '/api/users/resolve').map((c) => c.data),
      [{ shortUuid: SHORT_UUID }],
    );
    assert.equal(patchBodyOf(captured)['id'], 4471);
    assert.equal('shortUuid' in patchBodyOf(captured), false);
    assert.equal('uuid' in patchBodyOf(captured), false);
  });

  it('reports unavailable, NOT invalidContract, when the profile cannot be named', async () => {
    // The distinction decides whether the saga retries or gives up. The
    // contract is fine here; only our ability to name the profile is missing,
    // and that can come back after a version re-detect.
    const { service } = panelOn('3.2.1', USER_3X);
    const outcome = await service.strictSetUserLimits(stored(), {
      trafficLimitBytes: null,
      hwidDeviceLimit: null,
    });
    assert.equal(outcome.kind, 'unavailable');
  });
});

describe('strictGetPanelUserDevices — legacy profile recovery on Remnawave 3.2.3', () => {
  it('resolves a 2.x uuid-backed subscription through its saved shortUuid before reading HWID rows', async () => {
    const { service, captured } = build((input) => {
      if (input.url.startsWith('/api/system/')) return recap('3.2.3');
      if (input.url === '/api/users/resolve') {
        return of({ data: { response: { id: 4471, shortUuid: SHORT_UUID, username: 'rz_bob_1' } } });
      }
      if (input.url === '/api/hwid/devices/4471') {
        return of({ data: { response: { total: 0, devices: [] } } });
      }
      throw new Error(`unexpected panel call ${input.url}`);
    });

    const outcome = await service.strictGetPanelUserDevices(stored({ panelShortUuid: SHORT_UUID }));

    assert.equal(outcome.kind, 'ok');
    assert.deepEqual(
      captured.filter((c) => c.url === '/api/users/resolve').map((c) => c.data),
      [{ shortUuid: SHORT_UUID }],
    );
    assert.equal(captured.some((c) => c.url === `/api/hwid/devices/${UUID}`), false);
    assert.equal(captured.some((c) => c.url === '/api/hwid/devices/4471'), true);
  });
});

describe('parseStrictUser — a 3.x row has no uuid to validate', () => {
  it('decodes a 3.x row by its numeric id', async () => {
    const { service } = panelOn('3.2.1', USER_3X);
    const outcome = await service.strictGetPanelUser(stored({ remnawaveId: '4471' }));
    assert.equal(outcome.kind, 'ok');
    if (outcome.kind !== 'ok') return;
    assert.equal(outcome.value.uuid, '4471');
    assert.equal(outcome.value.panelId, 4471);
  });

  it('carries the panel id off a 2.x row too, so it can be back-filled early', async () => {
    const { service } = panelOn('2.8.0', USER_2X);
    const outcome = await service.strictGetPanelUser(stored());
    assert.equal(outcome.kind, 'ok');
    if (outcome.kind !== 'ok') return;
    assert.equal(outcome.value.uuid, UUID);
    assert.equal(outcome.value.panelId, 4471);
  });

  it('still REFUSES a 2.x row whose uuid is present but empty', async () => {
    // Absence means 3.x. An empty string means a DAMAGED 2.x row, and falling
    // back to the id there would quietly accept what this parser exists to
    // reject.
    const damaged = { response: { ...USER_2X.response, uuid: '' } };
    const { service } = panelOn('2.8.0', damaged);
    const outcome = await service.strictGetPanelUser(stored());
    assert.equal(outcome.kind, 'invalidContract');
  });
});

describe('the two path-building reads that were still interpolating the raw string', () => {
  it('getPanelUserUsage addresses by id on 3.x', async () => {
    const { service, captured } = panelOn('3.2.1', USER_3X);
    await service.getPanelUserUsage(stored({ panelId: 4471 }));
    assert.equal(pathOf(captured), '/api/users/4471');
  });

  it('getPanelUserUsage answers null — never a zeroed card — when unaddressable', async () => {
    const { service } = panelOn('3.2.1', USER_3X);
    assert.equal(await service.getPanelUserUsage(stored()), null);
  });

  it('the per-user request log follows the same addressing', async () => {
    const { service, captured } = panelOn('3.2.1', { response: { records: [], total: 0 } });
    await service.getSubscriptionRequestHistory({ user: stored({ panelId: 4471 }) });
    assert.equal(pathOf(captured), '/api/users/4471/subscription-request-history');
  });
});

describe('mapHwidTopUser — the HWID overage detector must see 3.x rows', () => {
  it('reads the 2.7 row key', () => {
    assert.equal(mapHwidTopUser({ userUuid: UUID, username: 'a', devicesCount: 9 }).userUuid, UUID);
  });

  it('reads the 2.8 row key', () => {
    assert.equal(mapHwidTopUser({ userId: UUID, username: 'a', devicesCount: 9 }).userUuid, UUID);
  });

  it('reads a 3.x row, which has NEITHER key — only a numeric id', () => {
    // Before this, a 3.x row mapped to '' , missed the limit map keyed by what
    // rezeis stored, took the `?? 0` limit and was filtered out. The detector
    // reported "nobody is over their device limit" for every 3.x panel and
    // logged nothing.
    assert.equal(mapHwidTopUser({ id: 4471, username: 'a', devicesCount: 9 }).userUuid, '4471');
  });

  it('does not invent an identity from a non-integer id', () => {
    assert.equal(mapHwidTopUser({ id: 1.5, username: 'a', devicesCount: 9 }).userUuid, '');
  });
});

describe('resolveRemnawaveUser — two of the four selectors moved in 3.x', () => {
  // The row carries the selector it was found by, which is what a panel that
  // actually APPLIED the filter returns. A row that does not is how a panel
  // which ignored the filter looks, and the adapter now refuses those.
  const SUMMARY = {
    response: {
      users: [
        { id: 7, username: 'rz_bob_1', status: 'ACTIVE', email: 'bob@example.test', telegramId: 12345 },
      ],
    },
  };
  const LEGACY = { response: { uuid: UUID, id: 7, username: 'rz_bob_1', status: 'ACTIVE' } };

  it('2.x keeps the by-email shortcut', async () => {
    const { service, captured } = panelOn('2.8.0', LEGACY);
    await service.resolveRemnawaveUser({ email: 'bob@example.test' });
    assert.equal(pathOf(captured), '/api/users/by-email/bob%40example.test');
  });

  it('3.x filters the stream instead — the shortcut answers 404 Cannot GET there', async () => {
    // Measured on a live 3.2.1, not inferred: `by-email` and `by-telegram-id`
    // are gone, and `stream` gained `email` / `telegramId` filters. Without the
    // branch, an operator searching a real customer is told "no such user",
    // because the 404 lands in the catch-all and comes back as null.
    const { service, captured } = panelOn('3.2.1', SUMMARY);
    const found = await service.resolveRemnawaveUser({ email: 'bob@example.test' });
    assert.equal(pathOf(captured), '/api/users/stream?size=1&email=bob%40example.test');
    assert.equal(found?.username, 'rz_bob_1');
  });

  it('3.x filters the stream by telegram id too', async () => {
    const { service, captured } = panelOn('3.2.1', SUMMARY);
    await service.resolveRemnawaveUser({ telegramId: '12345' });
    assert.equal(pathOf(captured), '/api/users/stream?size=1&telegramId=12345');
  });

  it('an unknown panel takes the LEGACY route, not the stream', async () => {
    // The one place "unknown" leans 2.x rather than refusing. Both branches are
    // pure reads that find the right user or nobody, so the tie goes to what
    // every panel this integration has run against actually serves — and the
    // 2.8 stream does not accept these filters at all, so guessing the other way
    // would silently return an ARBITRARY user from the first keyset page.
    const { service, captured } = build((input) =>
      input.url.startsWith('/api/system/')
        ? throwError(() => new Error('ECONNREFUSED'))
        : of({ data: LEGACY }),
    );
    await service.resolveRemnawaveUser({ email: 'bob@example.test' });
    assert.equal(pathOf(captured), '/api/users/by-email/bob%40example.test');
  });

  it('the two selectors that survive every version are never rerouted', async () => {
    const byName = panelOn('3.2.1', SUMMARY);
    await byName.service.resolveRemnawaveUser({ username: 'rz_bob_1' });
    assert.equal(pathOf(byName.captured), '/api/users/by-username/rz_bob_1');

    const byShort = panelOn('3.2.1', SUMMARY);
    await byShort.service.resolveRemnawaveUser({ subscriptionUuid: 'abc123' });
    assert.equal(pathOf(byShort.captured), '/api/users/by-short-uuid/abc123');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  Whole-panel walk, and the read that separates "gone" from "unreachable"
// ═══════════════════════════════════════════════════════════════════════════

const ROW_3X = (id: number) => ({
  id,
  username: `rz_u${id}`,
  status: 'ACTIVE',
  createdAt: '2026-01-01T00:00:00.000Z',
  expireAt: '2099-01-01T00:00:00.000Z',
  trafficLimitBytes: 0,
  hwidDeviceLimit: 0,
  subscriptionUrl: 'https://sub/x',
});

/** Answers the version probe, then serves `pages` in order to the walker. */
function walker(version: string, pages: readonly unknown[]) {
  let served = 0;
  const urls: string[] = [];
  const { service } = build((input) => {
    if (input.url.startsWith('/api/system/')) return of({ data: { response: { version } } });
    urls.push(input.url);
    const page = pages[Math.min(served, pages.length - 1)];
    served += 1;
    return of({ data: page });
  });
  return { service, urls };
}

describe('strictGetAllPanelUsers — keyset where the panel offers it', () => {
  it('2.8+ walks by cursor, and the cursor is what the panel handed back', async () => {
    // Offset paging loses a row whenever the list shrinks mid-walk: every later
    // row shifts one place left, one live user is never served, and the count
    // check still reconciles because the panel's own total fell by the same one.
    // That user then misses in the overlay map and is written EXPIRED.
    const { service, urls } = walker('2.8.0', [
      { response: { users: [ROW_3X(1)], nextCursor: '41', hasMore: true } },
      { response: { users: [ROW_3X(2)], nextCursor: null, hasMore: false } },
    ]);

    const outcome = await service.strictGetAllPanelUsers();

    assert.equal(outcome.kind, 'ok');
    if (outcome.kind !== 'ok') return;
    assert.equal(outcome.value.users.length, 2);
    assert.equal(outcome.value.complete, true);
    assert.equal(urls[0], '/api/users/stream?size=500');
    assert.equal(urls[1], '/api/users/stream?size=500&cursor=41');
  });

  it('2.7.4 keeps the offset walk — the stream route does not exist there', async () => {
    const { service, urls } = walker('2.7.4', [
      { response: { users: [ROW_3X(1)], total: 1 } },
    ]);

    const outcome = await service.strictGetAllPanelUsers();

    assert.equal(outcome.kind, 'ok');
    assert.equal(urls[0], '/api/users/?start=0&size=500');
  });

  it('an unknown version keeps the offset walk, which every version serves', async () => {
    const { service } = build((input) =>
      input.url.startsWith('/api/system/')
        ? throwError(() => new Error('ECONNREFUSED'))
        : of({ data: { response: { users: [ROW_3X(1)], total: 1 } } }),
    );
    const outcome = await service.strictGetAllPanelUsers();
    assert.equal(outcome.kind, 'ok');
  });

  it('a SHORT keyset page is not the end of the list', async () => {
    // The offset walk reads a short page as the end. Applying that heuristic to
    // a keyset walk would bless a prefix of the panel as all of it — and a
    // prefix is exactly what makes every later "missing" verdict destructive.
    const { service } = walker('3.2.1', [
      { response: { users: [ROW_3X(1)], nextCursor: '9', hasMore: true } },
      { response: { users: [ROW_3X(2), ROW_3X(3)], nextCursor: null, hasMore: false } },
    ]);

    const outcome = await service.strictGetAllPanelUsers();

    assert.equal(outcome.kind, 'ok');
    if (outcome.kind !== 'ok') return;
    assert.equal(outcome.value.users.length, 3, 'a short first page must not end the walk');
    assert.equal(outcome.value.complete, true);
  });

  it('refuses a cursor that does not advance instead of spinning to the page cap', async () => {
    // Without this the walk would fetch the same page fifty times and then
    // report an INCOMPLETE list assembled from one page — a contract failure
    // dressed up as a short read.
    const { service } = walker('3.2.1', [
      { response: { users: [ROW_3X(1)], nextCursor: '7', hasMore: true } },
      { response: { users: [ROW_3X(1)], nextCursor: '7', hasMore: true } },
    ]);

    const outcome = await service.strictGetAllPanelUsers();

    assert.equal(outcome.kind, 'invalidContract');
  });
});

describe('getPanelUserOutcome — an outage is not a missing profile', () => {
  const NOT_FOUND = { errorCode: 'A025', message: 'User not found' };

  it('reports missing only when the PANEL said so', async () => {
    const { service } = build((input) =>
      input.url.startsWith('/api/system/')
        ? of({ data: { response: { version: '3.2.1' } } })
        : throwError(() => ({ isAxiosError: true, response: { status: 404, headers: {}, data: NOT_FOUND }, message: 'HTTP 404' })),
    );
    const outcome = await service.getPanelUserOutcome(stored({ remnawaveId: '4471' }));
    assert.equal(outcome.kind, 'missing');
  });

  it('reports a BARE 404 as unavailable — that is what a proxy answers to everything', async () => {
    const { service } = build((input) =>
      input.url.startsWith('/api/system/')
        ? of({ data: { response: { version: '3.2.1' } } })
        : throwError(() => ({ isAxiosError: true, response: { status: 404, headers: {}, data: '<html>502</html>' }, message: 'HTTP 404' })),
    );
    const outcome = await service.getPanelUserOutcome(stored({ remnawaveId: '4471' }));
    assert.equal(outcome.kind, 'unavailable');
  });

  it('reports a network failure as unavailable, never as missing', async () => {
    const { service } = build(() => throwError(() => new Error('ETIMEDOUT')));
    const outcome = await service.getPanelUserOutcome(stored({ remnawaveId: '4471' }));
    assert.equal(outcome.kind, 'unavailable');
  });

  it('an unaddressable profile is unavailable — it may be perfectly alive', async () => {
    const { service } = panelOn('3.2.1', USER_3X);
    const outcome = await service.getPanelUserOutcome(stored());
    assert.equal(outcome.kind, 'unavailable');
  });

  it('getPanelUser still collapses all of it to null, for the cards that want that', async () => {
    const { service } = build(() => throwError(() => new Error('ETIMEDOUT')));
    assert.equal(await service.getPanelUser(stored({ remnawaveId: '4471' })), null);
  });
});
