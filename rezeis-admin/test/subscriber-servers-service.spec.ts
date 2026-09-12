import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RemnawaveHostInterface } from '../src/modules/remnawave/interfaces/remnawave-host.interface';
import { RemnawaveNodeInterface } from '../src/modules/remnawave/interfaces/remnawave-node.interface';
import { RemnawaveInternalSquadDetailInterface } from '../src/modules/remnawave/interfaces/remnawave-squad-detail.interface';
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
}

interface Logged {
  readonly level: 'warn' | 'debug';
  readonly message: string;
}

interface Harness {
  readonly service: SubscriberServersService;
  readonly logs: Logged[];
  readonly findFirstArgs: unknown[];
  readonly cacheWrites: { key: string; ttl: number }[];
  readonly calls: { hosts: number; nodes: number; squads: number };
}

function makeService(over: {
  subscription?: { internalSquads: string[] } | null;
  hosts?: RemnawaveHostInterface[];
  nodes?: RemnawaveNodeInterface[];
  squads?: RemnawaveInternalSquadDetailInterface[];
  throws?: boolean;
} = {}): Harness {
  const logs: Logged[] = [];
  const findFirstArgs: unknown[] = [];
  const cacheWrites: { key: string; ttl: number }[] = [];
  const calls = { hosts: 0, nodes: 0, squads: 0 };
  let cached: Snapshot | null = null;

  const prisma = {
    subscription: {
      findFirst: async (args: unknown) => {
        findFirstArgs.push(args);
        return over.subscription === undefined
          ? { internalSquads: ['squad-eu'] }
          : over.subscription;
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
  (service as unknown as { logger: unknown }).logger = {
    warn: (message: string) => logs.push({ level: 'warn', message }),
    debug: (message: string) => logs.push({ level: 'debug', message }),
  };

  return { service, logs, findFirstArgs, cacheWrites, calls };
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

  it('says nothing at all when there are servers to show', async () => {
    const { service, logs } = makeService();
    await service.getForSubscription('user-1', 'sub-1');
    assert.deepEqual(logs, []);
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
    assert.deepEqual(calls, { hosts: 1, nodes: 1, squads: 1 });
  });

  it('refuses to cache a snapshot with no hosts', async () => {
    // `getAllHosts` swallows its own failures and answers `[]`, so a panel
    // outage resolves happily with half a snapshot. Caching it pinned "you
    // have no servers" for twenty seconds for everyone at once.
    const { service, cacheWrites } = makeService({ hosts: [] });
    await service.getForSubscription('user-1', 'sub-1');
    assert.deepEqual(cacheWrites, []);
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
