import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SubscriptionStatus, SyncJobStatus } from '@prisma/client';

import { PanelProfileComparisonService } from '../src/modules/profile-sync/panel-profile-comparison.service';
import {
  strictInvalidContract,
  strictOk,
  strictUnavailable,
} from '../src/modules/remnawave/interfaces/remnawave-strict-outcome.interface';

/**
 * The per-customer comparison (owner's decision, 24.09.2026): every Remnawave
 * profile whose `reiwa_id` line names a customer, set against that customer's
 * live subscriptions — and the ONE automatic link it may make.
 *
 * The owner's worry is the frame: «мы не удалим случайно чужую подписку». So
 * every case that may not link asserts the table is untouched, and every case
 * that links pins WHICH row got WHICH profile and what it held before.
 */

type Row = Record<string, unknown>;

/** Evaluates the Prisma `where` shapes the service uses; anything else throws. */
function matches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([field, condition]) => {
    if (field === 'OR') return (condition as Row[]).some((alt) => matches(row, alt));
    if (condition !== null && typeof condition === 'object' && !Array.isArray(condition)) {
      const operators = condition as Record<string, unknown>;
      if ('in' in operators) return (operators['in'] as unknown[]).includes(row[field]);
      if ('not' in operators) return row[field] !== operators['not'];
      throw new Error(`unsupported operator ${JSON.stringify(condition)}`);
    }
    return row[field] === condition;
  });
}

function pick(row: Row, select: Record<string, boolean> | undefined): Row {
  return select === undefined ? { ...row } : Object.fromEntries(Object.keys(select).map((key) => [key, row[key]]));
}

interface Harness {
  readonly client: unknown;
  readonly subscriptions: Row[];
  readonly writes: Array<{ where: Row; data: Row }>;
  readonly locks: string[];
  /** Runs inside the transaction, after the lock and before the probe. */
  beforeProbe: (() => void) | null;
}

function harness(input: { users?: string[]; subscriptions?: Row[]; jobs?: Row[] }): Harness {
  const users = (input.users ?? ['user-1']).map((id) => ({ id }));
  const subscriptions = input.subscriptions ?? [];
  const jobs = input.jobs ?? [];
  const writes: Array<{ where: Row; data: Row }> = [];
  const locks: string[] = [];
  const state: Harness = {
    client: null,
    subscriptions,
    writes,
    locks,
    beforeProbe: null,
  };
  const subscription = {
    findMany: async (args: { where: Record<string, unknown>; select?: Record<string, boolean> }) =>
      subscriptions.filter((row) => matches(row, args.where)).map((row) => pick(row, args.select)),
    updateMany: async (args: { where: Record<string, unknown>; data: Row }) => {
      const hit = subscriptions.filter((row) => matches(row, args.where));
      writes.push({ where: args.where, data: args.data });
      hit.forEach((row) => Object.assign(row, args.data));
      return { count: hit.length };
    },
  };
  (state as { client: unknown }).client = {
    user: {
      findMany: async (args: { where: Record<string, unknown> }) => users.filter((row) => matches(row, args.where)),
    },
    subscription,
    profileSyncJob: {
      findMany: async (args: { where: Record<string, unknown>; select?: Record<string, boolean> }) =>
        jobs.filter((row) => matches(row, args.where)).map((row) => pick(row, args.select)),
    },
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        $executeRaw: async (query: { values?: unknown[] }) => {
          locks.push(String(query.values?.[0]));
          return 1;
        },
        // The collision probe under the lock: any OTHER live row naming the
        // profile by either identifier.
        $queryRaw: async (query: { values?: unknown[] }) => {
          state.beforeProbe?.();
          const [candidateId, remnawaveId, panelId] = query.values ?? [];
          return subscriptions
            .filter(
              (row) =>
                row['id'] !== candidateId &&
                row['status'] !== SubscriptionStatus.DELETED &&
                (row['remnawaveId'] === remnawaveId || row['remnawavePanelId'] === panelId),
            )
            .slice(0, 1)
            .map((row) => ({ id: row['id'] }));
        },
        subscription,
      }),
  };
  return state;
}

function profile(panelId: number, description: string | null, extra: Row = {}): Row {
  return {
    uuid: String(panelId),
    panelId,
    username: `rz_user_${panelId}`,
    status: 'ACTIVE',
    subscriptionUrl: `https://sub.example.test/SHORT${panelId}`,
    createdAt: '2026-09-01T10:00:00.000Z',
    description,
    userTraffic: { usedTrafficBytes: 1024, lifetimeUsedTrafficBytes: 2048, onlineAt: null, firstConnectedAt: null },
    ...extra,
  };
}

function subscription(id: string, extra: Row = {}): Row {
  return {
    id,
    userId: 'user-1',
    status: SubscriptionStatus.ACTIVE,
    remnawaveId: null,
    remnawavePanelId: null,
    remnawavePanelUsername: null,
    configUrl: null,
    remnawavePendingUsername: 'rz_user_pending',
    remnawavePendingOwnerId: 'user-1',
    ...extra,
  };
}

function service(prisma: Harness, users: Row[] | { outcome: unknown }): PanelProfileComparisonService {
  const outcome = Array.isArray(users)
    ? strictOk({ users, total: users.length, complete: true })
    : users.outcome;
  return new PanelProfileComparisonService(prisma.client as never, {
    strictGetAllPanelUsers: async () => outcome,
  } as never);
}

async function compareOk(prisma: Harness, users: Row[] | { outcome: unknown }) {
  const outcome = await service(prisma, users).compare(new Date('2026-09-24T12:00:00.000Z'));
  assert.equal(outcome.kind, 'ok');
  if (outcome.kind !== 'ok') throw new Error('unreachable');
  return outcome.result;
}

describe('PanelProfileComparisonService — the one automatic link', () => {
  it("links the customer's one extra profile to their one subscription with an empty link", async () => {
    const prisma = harness({ subscriptions: [subscription('sub-a')] });

    const result = await compareOk(prisma, [profile(4711, 'name: Ann\nreiwa_id: user-1')]);

    assert.equal(result.autoLinked, 1);
    const row = prisma.subscriptions[0];
    assert.equal(row['remnawaveId'], '4711');
    assert.equal(row['remnawavePanelId'], 4711);
    assert.equal(row['remnawavePanelUsername'], 'rz_user_4711');
    assert.equal(row['configUrl'], 'https://sub.example.test/SHORT4711');
    assert.equal(row['remnawavePendingUsername'], null, 'nothing is left for a CREATE to look for');
    assert.equal(row['remnawavePendingOwnerId'], null);
    assert.deepEqual(prisma.locks, ['remnawave-profile:4711'], 'the same advisory lock every link takes');
    assert.deepEqual(result.links, [
      {
        subscriptionId: 'sub-a',
        userId: 'user-1',
        previousRemnawaveId: null,
        previousPanelId: null,
        remnawaveId: '4711',
        panelId: 4711,
        panelUsername: 'rz_user_4711',
        proof: 'reiwa_id',
      },
    ]);
    const [customer] = result.customers;
    assert.equal(customer?.userId, 'user-1');
    assert.equal(customer?.profiles[0]?.autoLink, 'linked');
    assert.equal(customer?.profiles[0]?.autoLinkedSubscriptionId, 'sub-a');
    assert.equal(customer?.profiles[0]?.autoLinkedAt, '2026-09-24T12:00:00.000Z');
  });

  it('rewrites a non-decimal link (a 2.x uuid kept after the upgrade) the same way, and records what it held', async () => {
    const uuid = '330f2b38-1f1e-4f6a-9f2b-0a1b2c3d4e5f';
    const prisma = harness({ subscriptions: [subscription('sub-a', { remnawaveId: uuid })] });

    const result = await compareOk(prisma, [profile(4711, 'reiwa_id: user-1')]);

    assert.equal(prisma.subscriptions[0]['remnawaveId'], '4711');
    assert.equal(result.links[0]?.previousRemnawaveId, uuid);
    // The fence is what the row held when it was read, the uuid included.
    assert.equal(prisma.writes[0]?.where['remnawaveId'], uuid);
  });

  it('writes nothing but the link: our own ids never change', async () => {
    const prisma = harness({ subscriptions: [subscription('sub-a')] });

    await compareOk(prisma, [profile(4711, 'reiwa_id: user-1')]);

    assert.deepEqual(Object.keys(prisma.writes[0]?.data ?? {}).sort(), [
      'configUrl',
      'remnawaveId',
      'remnawavePanelId',
      'remnawavePanelUsername',
      'remnawavePendingOwnerId',
      'remnawavePendingUsername',
    ]);
    assert.equal(prisma.subscriptions[0]['id'], 'sub-a');
    assert.equal(prisma.subscriptions[0]['userId'], 'user-1');
  });

  it('links when the subscription_id line names that very subscription, and says so in the proof', async () => {
    const prisma = harness({ subscriptions: [subscription('sub-a')] });

    const result = await compareOk(prisma, [profile(4711, 'reiwa_id: user-1\nsubscription_id: sub-a')]);

    assert.equal(result.links[0]?.proof, 'reiwa_id+subscription_id');
    assert.equal(result.customers[0]?.profiles[0]?.subscriptionMarker, 'sub-a');
  });
});

describe('PanelProfileComparisonService — never a guess', () => {
  it('two subscriptions without a link: listed, not linked', async () => {
    const prisma = harness({ subscriptions: [subscription('sub-a'), subscription('sub-b')] });

    const result = await compareOk(prisma, [profile(4711, 'reiwa_id: user-1')]);

    assert.equal(result.customers[0]?.profiles[0]?.autoLink, 'severalSubscriptions');
    assert.deepEqual(prisma.writes, []);
  });

  it('two extra profiles: listed, not linked', async () => {
    const prisma = harness({ subscriptions: [subscription('sub-a')] });

    const result = await compareOk(prisma, [profile(4711, 'reiwa_id: user-1'), profile(4712, 'reiwa_id: user-1')]);

    assert.deepEqual(
      result.customers[0]?.profiles.map((entry) => entry.autoLink),
      ['severalProfiles', 'severalProfiles'],
    );
    assert.deepEqual(prisma.writes, []);
  });

  it('a subscription_id line naming another subscription refuses the link', async () => {
    const prisma = harness({ subscriptions: [subscription('sub-a')] });

    const result = await compareOk(prisma, [profile(4711, 'reiwa_id: user-1\nsubscription_id: sub-other')]);

    assert.equal(result.customers[0]?.profiles[0]?.autoLink, 'subscriptionMarkerMismatch');
    assert.deepEqual(prisma.writes, []);
  });

  it('the one candidate recording ANOTHER profile id refuses the link', async () => {
    const prisma = harness({ subscriptions: [subscription('sub-a', { remnawavePanelId: 9999 })] });

    const result = await compareOk(prisma, [profile(4711, 'reiwa_id: user-1')]);

    assert.equal(result.customers[0]?.profiles[0]?.autoLink, 'subscriptionRecordsAnotherProfile');
    assert.deepEqual(prisma.writes, []);
  });

  it('a sync job in flight decides first', async () => {
    const prisma = harness({
      subscriptions: [subscription('sub-a')],
      jobs: [{ subscriptionId: 'sub-a', status: SyncJobStatus.RUNNING }],
    });

    const result = await compareOk(prisma, [profile(4711, 'reiwa_id: user-1')]);

    assert.equal(result.customers[0]?.profiles[0]?.autoLink, 'syncInFlight');
    assert.deepEqual(prisma.writes, []);
  });

  it('a finished sync job does not hold the link back', async () => {
    const prisma = harness({
      subscriptions: [subscription('sub-a')],
      jobs: [{ subscriptionId: 'sub-a', status: SyncJobStatus.FAILED }],
    });

    const result = await compareOk(prisma, [profile(4711, 'reiwa_id: user-1')]);

    assert.equal(result.autoLinked, 1);
  });

  it("a profile another customer's live row links is listed with that row and never taken", async () => {
    const prisma = harness({
      users: ['user-1', 'user-9'],
      subscriptions: [
        subscription('sub-a'),
        subscription('sub-z', { userId: 'user-9', remnawaveId: '4711', remnawavePanelId: 4711 }),
      ],
    });

    const result = await compareOk(prisma, [profile(4711, 'reiwa_id: user-1')]);

    const entry = result.customers[0]?.profiles[0];
    assert.equal(entry?.autoLink, 'takenByOtherRow');
    assert.equal(entry?.linkedBySubscriptionId, 'sub-z');
    assert.deepEqual(prisma.writes, []);
  });

  it("a profile one of the customer's own live rows links is not extra at all", async () => {
    const prisma = harness({
      subscriptions: [
        subscription('sub-a', { remnawaveId: '4711', remnawavePanelId: 4711 }),
        subscription('sub-b'),
      ],
    });

    const result = await compareOk(prisma, [profile(4711, 'reiwa_id: user-1')]);

    assert.deepEqual(result.customers, []);
    assert.deepEqual(prisma.writes, []);
  });

  it('a row that names the profile only by its numeric panel id links it too', async () => {
    const prisma = harness({
      subscriptions: [subscription('sub-a', { remnawaveId: 'abc', remnawavePanelId: 4711 })],
    });

    const result = await compareOk(prisma, [profile(4711, 'reiwa_id: user-1')]);

    assert.deepEqual(result.customers, [], 'the walk rewrites that spelling; the comparison has nothing to add');
  });

  it('profiles with no owner line, or lines naming two owners, are counted and left alone', async () => {
    const prisma = harness({ subscriptions: [subscription('sub-a')] });

    const result = await compareOk(prisma, [
      profile(4711, 'imported from a donor'),
      profile(4712, 'reiwa_id: user-1\nreiwa_id: user-9'),
      profile(4713, 'name: reiwa_id: user-1'),
    ]);

    assert.equal(result.profilesWithoutOwner, 3);
    assert.deepEqual(result.customers, []);
    assert.deepEqual(prisma.writes, []);
  });

  it('a customer who is not in this panel gets no link', async () => {
    const prisma = harness({ users: [], subscriptions: [] });

    const result = await compareOk(prisma, [profile(4711, 'reiwa_id: user-gone')]);

    assert.equal(result.customers[0]?.userId, 'user-gone');
    assert.equal(result.customers[0]?.profiles[0]?.autoLink, 'noSubscriptionWithoutLink');
  });

  it('a DELETED subscription without a link is not a candidate', async () => {
    const prisma = harness({
      subscriptions: [subscription('sub-old', { status: SubscriptionStatus.DELETED })],
    });

    const result = await compareOk(prisma, [profile(4711, 'reiwa_id: user-1')]);

    assert.equal(result.customers[0]?.profiles[0]?.autoLink, 'noSubscriptionWithoutLink');
    assert.deepEqual(prisma.writes, []);
  });

  it('a profile a DELETED subscription still names is that subscription\'s: listed, never given to another', async () => {
    const prisma = harness({
      subscriptions: [
        subscription('sub-new'),
        subscription('sub-gone', { status: SubscriptionStatus.DELETED, remnawaveId: '4711', remnawavePanelId: 4711 }),
      ],
    });

    const result = await compareOk(prisma, [profile(4711, 'reiwa_id: user-1')]);

    const entry = result.customers[0]?.profiles[0];
    assert.equal(entry?.autoLink, 'namedByDeletedSubscription');
    assert.equal(entry?.linkedBySubscriptionId, 'sub-gone');
    assert.deepEqual(prisma.writes, [], 'the new subscription is not handed the deleted one\'s profile');
  });

  it('a profile a DELETED subscription names does not make another free profile ambiguous', async () => {
    const prisma = harness({
      subscriptions: [
        subscription('sub-new'),
        subscription('sub-gone', { status: SubscriptionStatus.DELETED, remnawaveId: '4711', remnawavePanelId: 4711 }),
      ],
    });

    const result = await compareOk(prisma, [profile(4711, 'reiwa_id: user-1'), profile(4712, 'reiwa_id: user-1')]);

    assert.equal(result.autoLinked, 1);
    assert.equal(prisma.subscriptions[0]['remnawaveId'], '4712');
  });
});

describe('PanelProfileComparisonService — under the lock', () => {
  it('a row that took the profile while the comparison read the panel wins', async () => {
    const prisma = harness({
      users: ['user-1', 'user-9'],
      subscriptions: [subscription('sub-a'), subscription('sub-late', { userId: 'user-9' })],
    });
    prisma.beforeProbe = () => {
      prisma.subscriptions[1]['remnawaveId'] = '4711';
    };

    const result = await compareOk(prisma, [profile(4711, 'reiwa_id: user-1')]);

    assert.equal(result.customers[0]?.profiles[0]?.autoLink, 'takenByOtherRow');
    assert.equal(prisma.subscriptions[0]['remnawaveId'], null);
    assert.deepEqual(prisma.writes, [], 'nothing is written once the probe finds a holder');
  });

  it('a subscription whose link changed since it was read is left alone', async () => {
    const prisma = harness({ subscriptions: [subscription('sub-a')] });
    prisma.beforeProbe = () => {
      prisma.subscriptions[0]['remnawaveId'] = '5150';
    };

    const result = await compareOk(prisma, [profile(4711, 'reiwa_id: user-1')]);

    assert.equal(result.customers[0]?.profiles[0]?.autoLink, 'changedDuringCheck');
    assert.equal(prisma.subscriptions[0]['remnawaveId'], '5150', 'the newer link survives');
    assert.equal(result.autoLinked, 0);
  });
});

describe('PanelProfileComparisonService — reading Remnawave', () => {
  it('links nothing from a list Remnawave served only in part', async () => {
    const prisma = harness({ subscriptions: [subscription('sub-a')] });

    const result = await compareOk(prisma, {
      outcome: strictOk({ users: [profile(4711, 'reiwa_id: user-1')], total: 30_000, complete: false }),
    });

    assert.equal(result.readOutcome, 'partial');
    assert.equal(result.customers[0]?.profiles[0]?.autoLink, 'panelUnavailable');
    assert.deepEqual(prisma.writes, []);
  });

  it('answers unavailable, and reads and writes nothing, when the list cannot be read', async () => {
    for (const outcome of [strictUnavailable(), strictInvalidContract('no users array')]) {
      const prisma = harness({ subscriptions: [subscription('sub-a')] });
      const answer = await service(prisma, { outcome }).compare();
      assert.equal(answer.kind, 'unavailable');
      assert.deepEqual(prisma.writes, []);
    }
  });

  it('reports what the profile says about itself', async () => {
    const prisma = harness({ subscriptions: [subscription('sub-a'), subscription('sub-b')] });

    const result = await compareOk(prisma, [profile(4711, 'reiwa_id: user-1', { status: 'DISABLED' })]);

    assert.deepEqual(result.customers[0]?.profiles[0], {
      profileId: '4711',
      username: 'rz_user_4711',
      status: 'DISABLED',
      createdAt: '2026-09-01T10:00:00.000Z',
      usedTrafficBytes: 1024,
      subscriptionMarker: null,
      linkedBySubscriptionId: null,
      autoLink: 'severalSubscriptions',
      autoLinkedSubscriptionId: null,
      autoLinkedAt: null,
    });
    assert.equal(result.profilesRead, 1);
    assert.equal(result.readOutcome, 'complete');
  });
});
