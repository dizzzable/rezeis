import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { throwError } from 'rxjs';

import {
  RemnawaveExternalSquadHostOverrideInterface,
  RemnawaveHostInterface,
} from '../src/modules/remnawave/interfaces/remnawave-host.interface';
import { RemnawaveNodeInterface } from '../src/modules/remnawave/interfaces/remnawave-node.interface';
import { RemnawaveInternalSquadDetailInterface } from '../src/modules/remnawave/interfaces/remnawave-squad-detail.interface';
import { RemnawaveApiService } from '../src/modules/remnawave/services/remnawave-api.service';
import { SubscriberServersService } from '../src/modules/remnawave/services/subscriber-servers.service';

/**
 * `SubscriberServersService.getForSubscription` — the method itself.
 *
 * WHY THIS FILE EXISTS. Everything interesting about this feature was pulled
 * out into pure functions and tested there, which was the right instinct and
 * left the method that CALLS them with no test whatsoever. Three decisions live
 * only here, and all three shipped unverified:
 *
 *   1. a subscription is answered only for its own owner, and never once
 *      deleted — deletion does not clear `internalSquads`, so a stale id kept
 *      answering with a full list headed "available servers";
 *   2. a snapshot missing hosts or nodes is used but NOT cached, because
 *      caching it pinned "you have no servers" for twenty seconds for every
 *      subscriber at once;
 *   3. an empty answer says WHY, at a level that reaches production.
 *
 * The third is here rather than beside `explainEmpty` for a specific reason:
 * that function is pure and well covered, and a mutation that logged every
 * reason at `debug` — discarding the loud ones on exactly the installs that
 * need them — passed the whole suite anyway. The decision was right and
 * nothing reached it. This file reaches it.
 */

const host = (over: Partial<RemnawaveHostInterface> = {}): RemnawaveHostInterface => ({
  uuid: 'host-de',
  viewPosition: 1,
  remark: 'Frankfurt 🇩🇪',
  address: 'de1.internal.example',
  port: 443,
  isDisabled: false,
  isHidden: false,
  securityLayer: 'DEFAULT',
  tag: null,
  tags: [],
  configProfileUuid: 'profile-1',
  configProfileInboundUuid: 'inbound-de',
  nodes: ['node-de'],
  internalSquads: { mode: 'exclude', squads: [] },
  ...over,
});

const node = (over: Partial<RemnawaveNodeInterface> = {}): RemnawaveNodeInterface => ({
  uuid: 'node-de',
  name: 'de-1.hetzner',
  address: '10.0.0.1',
  port: 2222,
  isConnected: true,
  isDisabled: false,
  isConnecting: false,
  isTrafficTrackingActive: false,
  trafficResetDay: null,
  trafficLimitBytes: null,
  trafficUsedBytes: null,
  notifyPercent: null,
  viewPosition: 1,
  countryCode: 'DE',
  consumptionMultiplier: 1,
  tags: [],
  lastStatusChange: null,
  lastStatusMessage: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  xrayUptime: 3600,
  usersOnline: 4,
  activeConfigProfileUuid: 'profile-1',
  ips: [],
  ...over,
});

const squad = (
  over: Partial<RemnawaveInternalSquadDetailInterface> = {},
): RemnawaveInternalSquadDetailInterface => ({
  uuid: 'squad-eu',
  name: 'EU',
  viewPosition: 1,
  membersCount: 1,
  inboundsCount: 1,
  inboundUuids: ['inbound-de'],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

/** What the service stores under its one cache key. */
interface Snapshot {
  readonly hosts: readonly RemnawaveHostInterface[];
  readonly nodes: readonly RemnawaveNodeInterface[];
  readonly squads: readonly RemnawaveInternalSquadDetailInterface[];
  readonly externalSquads?: readonly RemnawaveExternalSquadHostOverrideInterface[];
}

/** A `subscriptions` row, as far as this service could ever select it. */
interface SubscriptionRow {
  readonly internalSquads: string[];
  readonly externalSquad: string | null;
  readonly status: string;
  readonly expiresAt: Date | null;
  readonly remnawavePanelUsername: string | null;
}

const DAY_MS = 86_400_000;

interface Logged {
  readonly level: 'warn' | 'debug' | 'log' | 'error';
  readonly message: string;
}

/** A logger that writes into `logs`, for a class that builds its own `Logger`. */
function loggerInto(logs: Logged[]): Record<Logged['level'], (message: string) => void> {
  return {
    warn: (message: string) => logs.push({ level: 'warn', message }),
    debug: (message: string) => logs.push({ level: 'debug', message }),
    log: (message: string) => logs.push({ level: 'log', message }),
    error: (message: string) => logs.push({ level: 'error', message }),
  };
}

/**
 * The panel's own adapter, with every HTTP request it makes refused with
 * `status` — the way a Remnawave API token without the external-squads scope is
 * refused on 3.4.4.
 *
 * Real on purpose. The line an operator sees for a failed read is written by
 * the adapter's transport, once per failed request, so a stub that throws
 * silently cannot say how often a failure reaches the Logs page. Its log goes
 * into the same `logs` as the service's.
 */
function adapterRefusing(status: number, requests: string[], logs: Logged[]): RemnawaveApiService {
  const adapter = new RemnawaveApiService(
    {
      request: (input: { readonly url: string }) => {
        requests.push(input.url);
        return throwError(() =>
          Object.assign(new Error(`Request failed with status code ${status}`), {
            isAxiosError: true,
            response: { status, data: { message: 'Forbidden resource' }, headers: {} },
          }),
        );
      },
    } as never,
    { host: 'remnawave', port: 3000, token: 'secret', webhookSecret: null },
  );
  (adapter as unknown as { logger: unknown }).logger = loggerInto(logs);
  return adapter;
}

interface Harness {
  readonly service: SubscriberServersService;
  readonly logs: Logged[];
  readonly findFirstArgs: unknown[];
  readonly cacheWrites: { key: string; ttl: number }[];
  readonly cached: () => Snapshot | null;
  readonly calls: { hosts: number; nodes: number; squads: number; externalSquads: number };
  /** Paths the real adapter was asked for; empty unless `externalSquadsStatus` is set. */
  readonly panelRequests: string[];
}

function makeService(over: {
  subscription?: Partial<SubscriptionRow> | null;
  /** Rows by subscription id, for more than one subscriber against one snapshot. */
  subscriptions?: Record<string, Partial<SubscriptionRow>>;
  hosts?: RemnawaveHostInterface[];
  nodes?: RemnawaveNodeInterface[];
  squads?: RemnawaveInternalSquadDetailInterface[];
  externalSquads?: RemnawaveExternalSquadHostOverrideInterface[];
  throws?: boolean;
  externalSquadsThrow?: boolean;
  /**
   * Reads the external squads through the real adapter, every request refused
   * with this HTTP status — see `adapterRefusing`.
   */
  externalSquadsStatus?: number;
} = {}): Harness {
  const logs: Logged[] = [];
  const findFirstArgs: unknown[] = [];
  const cacheWrites: { key: string; ttl: number }[] = [];
  const calls = { hosts: 0, nodes: 0, squads: 0, externalSquads: 0 };
  const panelRequests: string[] = [];
  const adapter =
    over.externalSquadsStatus === undefined
      ? null
      : adapterRefusing(over.externalSquadsStatus, panelRequests, logs);
  let cached: Snapshot | null = null;

  const prisma = {
    subscription: {
      // Answers only the columns the service SELECTS, as Prisma does. A stand-in
      // that returned the whole row would let a select that forgot a column
      // pass every test here and read `undefined` in production.
      findFirst: async (args: {
        where: { id: string };
        select: Record<string, boolean>;
      }) => {
        findFirstArgs.push(args);
        if (over.subscription === null) return null;
        const row: SubscriptionRow = {
          internalSquads: ['squad-eu'],
          externalSquad: null,
          status: 'ACTIVE',
          expiresAt: new Date(Date.now() + 12.5 * DAY_MS),
          remnawavePanelUsername: 'rz_4815',
          ...over.subscription,
          ...over.subscriptions?.[args.where.id],
        };
        return Object.fromEntries(
          Object.entries(row).filter(([column]) => args.select[column] === true),
        );
      },
    },
  };
  const api = {
    getAllHosts: async () => {
      calls.hosts += 1;
      if (over.throws === true) throw new Error('panel down at https://panel.internal');
      return over.hosts ?? [host()];
    },
    getAllNodes: async () => {
      calls.nodes += 1;
      return over.nodes ?? [node()];
    },
    getInternalSquadDetails: async () => {
      calls.squads += 1;
      return over.squads ?? [squad()];
    },
    getExternalSquadHostOverrides: async () => {
      calls.externalSquads += 1;
      if (adapter !== null) return adapter.getExternalSquadHostOverrides();
      if (over.externalSquadsThrow === true) throw new Error('external squads unavailable');
      return over.externalSquads ?? [];
    },
  };
  const cache = {
    get: async () => cached,
    set: async (key: string, value: Snapshot, ttl: number) => {
      cacheWrites.push({ key, ttl });
      cached = value;
    },
  };

  const service = new SubscriberServersService(
    prisma as never,
    api as never,
    cache as never,
  );
  // The service builds its own `Logger` in the class body; swap it for
  // something that can be read back. Private and readonly are compile-time
  // only, and the alternative — asserting on stdout — would tie the test to
  // Nest's formatting rather than to the decision being made.
  (service as unknown as { logger: unknown }).logger = loggerInto(logs);

  return { service, logs, findFirstArgs, cacheWrites, cached: () => cached, calls, panelRequests };
}

describe('the servers behind one subscription, end to end', () => {
  it('answers the servers this subscription reaches', () => {
    // The whole wiring in one assertion: without it, every pure function below
    // could be perfect and the method still return nothing.
    const { service } = makeService();
    return service.getForSubscription('user-1', 'sub-1').then((result) => {
      assert.deepEqual(result.servers.map((s) => s.id), ['host-de']);
      assert.equal(result.servers[0]?.status, 'online');
      assert.equal(result.recommendedServerId, 'host-de');
    });
  });

  it('asks only for this user’s own, undeleted subscription', async () => {
    // Deletion does not clear `internalSquads`, so a subscription id a customer
    // still holds from an earlier session kept answering with a full list.
    const { service, findFirstArgs } = makeService();
    await service.getForSubscription('user-1', 'sub-1');
    const where = (findFirstArgs[0] as { where: Record<string, unknown> }).where;
    assert.equal(where['id'], 'sub-1');
    assert.equal(where['userId'], 'user-1');
    assert.deepEqual(where['status'], { not: 'DELETED' });
  });

  it('answers nothing, quietly, for a subscription that is not theirs', async () => {
    const { service, logs } = makeService({ subscription: null });
    const result = await service.getForSubscription('user-1', 'sub-1');
    assert.deepEqual(result, { servers: [], recommendedServerId: null });
    assert.equal(logs.length, 1);
    assert.equal(logs[0]?.level, 'debug');
    assert.match(logs[0]?.message ?? '', /no such subscription/);
  });

  it('says the plan has no squads rather than saying nothing', async () => {
    const { service, logs } = makeService({ subscription: { internalSquads: [] } });
    const result = await service.getForSubscription('user-1', 'sub-1');
    assert.deepEqual(result.servers, []);
    // Reachable at all: this reason sat behind an early return that fired
    // before the diagnostic could run.
    assert.match(logs[0]?.message ?? '', /no squads/);
    assert.equal(logs[0]?.level, 'debug');
  });
});

describe('what an empty list says to the operator', () => {
  it('WARNS when no host names an inbound — the failure that shipped', async () => {
    // The one that matters. `SystemLogsService` floors at `log` in production,
    // so this reaching the Logs page depends on it being `warn`, and a
    // mutation that logged every reason at `debug` passed every other test in
    // the repository.
    const { service, logs } = makeService({
      hosts: [host({ configProfileInboundUuid: null })],
    });
    await service.getForSubscription('user-1', 'sub-1');
    assert.equal(logs.length, 1);
    assert.equal(logs[0]?.level, 'warn');
    assert.match(logs[0]?.message ?? '', /name an inbound/);
    assert.match(logs[0]?.message ?? '', /sub-1/);
  });

  it('stays quiet when the operator hid every matching host', async () => {
    // A button they pressed. Warning here on every double tap would teach them
    // to stop reading the channel that carries the case above.
    const { service, logs } = makeService({ hosts: [host({ isHidden: true })] });
    await service.getForSubscription('user-1', 'sub-1');
    assert.equal(logs[0]?.level, 'debug');
  });

  it('stays quiet, but says why, when everything left is a section header', async () => {
    // The operator tagged these hosts, so this is theirs to fix and must not
    // warn. But the reason has to be reachable from here at all: it is only
    // logged because a header with no server under it is dropped inside
    // `buildServers`, which is what leaves this method a list empty enough to
    // explain. A header that stayed in would answer one grey row and no word.
    const { service, logs } = makeService({
      hosts: [host({ tags: ['REZEIS:SEPARATOR'] })],
    });
    const result = await service.getForSubscription('user-1', 'sub-1');
    assert.deepEqual(result, { servers: [], recommendedServerId: null });
    assert.equal(logs.length, 1);
    assert.equal(logs[0]?.level, 'debug');
    assert.match(logs[0]?.message ?? '', /all of them separators/);
    assert.match(logs[0]?.message ?? '', /sub-1/);
  });

  it('says nothing at all when there are servers to show', async () => {
    const { service, logs } = makeService();
    await service.getForSubscription('user-1', 'sub-1');
    assert.deepEqual(logs, []);
  });

  it('WARNS about a server on the wrong inbound even under a header that passed', async () => {
    // A header that survives every filter used to keep the diagnosis walking
    // past the servers' own break and blame the tag — at debug, so production
    // logged nothing. The same break without the header warns, and so must this.
    const { service, logs } = makeService({
      hosts: [
        host({ uuid: 'sep', viewPosition: 1, tags: ['REZEIS:SEPARATOR'] }),
        host({ uuid: 'de', viewPosition: 2, configProfileInboundUuid: 'inbound-us' }),
      ],
    });
    const result = await service.getForSubscription('user-1', 'sub-1');
    assert.deepEqual(result, { servers: [], recommendedServerId: null });
    assert.equal(logs.length, 1);
    assert.equal(logs[0]?.level, 'warn');
    assert.match(logs[0]?.message ?? '', /none on the 1 inbound/);
  });
});

describe('what differs per subscriber', () => {
  it('renders each subscriber’s own remark, over one shared snapshot', async () => {
    // Remnawave renders a host remark per user before any client sees it, so
    // the name is rendered per request — and never into the snapshot, which
    // every subscriber shares for twenty seconds.
    const remark = '{{USERNAME}}: {{DAYS_LEFT}} дн.';
    const { service, calls, cached } = makeService({
      hosts: [host({ remark })],
      subscriptions: {
        'sub-1': { remnawavePanelUsername: 'rz_one', expiresAt: new Date(Date.now() + 12.5 * DAY_MS) },
        'sub-2': { remnawavePanelUsername: 'rz_two', expiresAt: new Date(Date.now() + 3.5 * DAY_MS) },
      },
    });
    const first = await service.getForSubscription('user-1', 'sub-1');
    const second = await service.getForSubscription('user-2', 'sub-2');
    assert.equal(first.servers[0]?.name, 'rz_one: 12 дн.');
    assert.equal(second.servers[0]?.name, 'rz_two: 3 дн.');
    assert.equal(calls.hosts, 1);
    assert.equal(cached()?.hosts[0]?.remark, remark);
  });

  it('draws the badge the subscription’s external squad gives every host', async () => {
    const { service } = makeService({
      subscription: { externalSquad: 'ext-premium' },
      hosts: [host({ remark: 'Germany - 1', serverDescription: 'ОСНОВНОЙ | СЕРВЕР' })],
      externalSquads: [
        { uuid: 'ext-other', serverDescription: null },
        { uuid: 'ext-premium', serverDescription: 'PREMIUM' },
      ],
    });
    const result = await service.getForSubscription('user-1', 'sub-1');
    assert.equal(result.servers[0]?.description, 'PREMIUM');
  });

  it('still lists every server, with its own badge, when external squads cannot be read', async () => {
    // The override is a label. Losing it must not cost the customer the list.
    const { service, cacheWrites, cached } = makeService({
      subscription: { externalSquad: 'ext-premium' },
      hosts: [host({ remark: 'Germany - 1', serverDescription: 'ОСНОВНОЙ | СЕРВЕР' })],
      externalSquadsThrow: true,
    });
    const result = await service.getForSubscription('user-1', 'sub-1');
    assert.deepEqual(result.servers.map((server) => server.id), ['host-de']);
    assert.equal(result.servers[0]?.description, 'ОСНОВНОЙ | СЕРВЕР');
    assert.equal(result.recommendedServerId, 'host-de');
    // Nor does it cost everyone the cache: the snapshot is kept, overriding
    // nothing, for its usual twenty seconds.
    assert.deepEqual(cacheWrites, [{ key: 'remnawave:subscriber-servers:snapshot:v3', ttl: 20 }]);
    assert.deepEqual(cached()?.externalSquads, []);
  });

  it('asks the panel once per snapshot, and warns once, while external squads keep failing', async () => {
    // A Remnawave 3.4.4 API token scoped without external squads is refused
    // 403 on every read of them, on a panel that is otherwise healthy. When
    // that refusal kept the snapshot out of the cache, every request by every
    // subscriber made all four calls again and wrote another warning.
    const { service, calls, cacheWrites, logs, panelRequests } = makeService({
      subscription: { externalSquad: 'ext-premium' },
      hosts: [host({ remark: 'Germany - 1', serverDescription: 'ОСНОВНОЙ | СЕРВЕР' })],
      externalSquadsStatus: 403,
    });
    const first = await service.getForSubscription('user-1', 'sub-1');
    const second = await service.getForSubscription('user-2', 'sub-2');
    for (const result of [first, second]) {
      assert.deepEqual(result.servers.map((server) => server.id), ['host-de']);
      assert.equal(result.servers[0]?.description, 'ОСНОВНОЙ | СЕРВЕР');
      assert.equal(result.recommendedServerId, 'host-de');
    }
    // One round for both subscribers, cached for the usual TTL.
    assert.deepEqual(calls, { hosts: 1, nodes: 1, squads: 1, externalSquads: 1 });
    assert.deepEqual(panelRequests, ['/api/external-squads/']);
    assert.deepEqual(cacheWrites, [{ key: 'remnawave:subscriber-servers:snapshot:v3', ttl: 20 }]);
    // Still said, and said once: the adapter's own line for the failed read.
    const warnings = logs.filter((entry) => entry.level !== 'debug');
    assert.equal(warnings.length, 1, JSON.stringify(logs));
    assert.equal(warnings[0]?.level, 'warn');
    assert.match(warnings[0]?.message ?? '', /GET \/api\/external-squads\/ failed: .*403/);
  });
});

describe('the shared snapshot', () => {
  it('caches a complete snapshot and reuses it', async () => {
    const { service, cacheWrites, calls } = makeService();
    await service.getForSubscription('user-1', 'sub-1');
    await service.getForSubscription('user-2', 'sub-2');
    assert.equal(cacheWrites.length, 1);
    assert.equal(cacheWrites[0]?.ttl, 20);
    // Two subscribers, one round of calls upstream.
    assert.deepEqual(calls, { hosts: 1, nodes: 1, squads: 1, externalSquads: 1 });
  });

  it('refuses to cache a snapshot with no hosts', async () => {
    // `getAllHosts` swallows its own failures and answers `[]`, so a panel
    // outage resolves happily with half a snapshot. Caching it pinned "you
    // have no servers" for twenty seconds for everyone at once.
    const { service, cacheWrites } = makeService({ hosts: [] });
    await service.getForSubscription('user-1', 'sub-1');
    assert.deepEqual(cacheWrites, []);
  });

  it('tells the operator, at warn, that the panel returned no hosts', async () => {
    // The one branch of the diagnosis that had no assertion anywhere. It is
    // also the one an operator most needs to see: an empty host list is what a
    // Remnawave outage looks like from here (`getAllHosts` swallows its own
    // failure and answers `[]`), so it must reach the Logs page — `warn`, not
    // `debug`, which production floors out — and it must say "the panel", so
    // nobody goes looking at squads or plans for a fault that is upstream.
    const { service, logs } = makeService({ hosts: [] });
    const result = await service.getForSubscription('user-1', 'sub-1');
    assert.deepEqual(result, { servers: [], recommendedServerId: null });
    assert.equal(logs.length, 1);
    assert.equal(logs[0]?.level, 'warn');
    assert.match(logs[0]?.message ?? '', /the panel returned no hosts/);
    assert.match(logs[0]?.message ?? '', /sub-1/);
  });

  it('refuses to cache a snapshot with no nodes', async () => {
    // Same failure, different half: every server would read `unknown` with no
    // recommendation, for everyone, for the length of the TTL.
    const { service, cacheWrites } = makeService({ nodes: [] });
    await service.getForSubscription('user-1', 'sub-1');
    assert.deepEqual(cacheWrites, []);
  });

  it('answers an empty list, not an error, when the panel throws', async () => {
    const { service } = makeService({ throws: true });
    const result = await service.getForSubscription('user-1', 'sub-1');
    assert.deepEqual(result, { servers: [], recommendedServerId: null });
  });

  it('keeps the panel’s address out of what it answers', async () => {
    const { service } = makeService({ throws: true });
    const result = await service.getForSubscription('user-1', 'sub-1');
    assert.ok(!JSON.stringify(result).includes('panel.internal'));
  });
});
