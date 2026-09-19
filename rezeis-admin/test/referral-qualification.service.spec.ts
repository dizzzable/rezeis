import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  PaymentGatewayType,
  PointsLedgerSource,
  Prisma,
  PurchaseChannel,
  PurchaseType,
  ReferralRewardType,
  SubscriptionStatus,
  TransactionStatus,
} from '@prisma/client';

import {
  isRetryableTransactionConflict,
  REFERRAL_REVERSED_AT_KEY,
  referralPaymentRewardSourceKey,
  ReferralQualificationService,
} from '../src/modules/referrals/services/referral-qualification.service';
import { PointsWalletService } from '../src/modules/points/services/points-wallet.service';
import { executeGatewayDataWrites } from './helpers/gateway-data-write-double';

// ── An in-memory panel database ───────────────────────────────────────────────
//
// The service is exercised against STATE, not against call scripts: rewards are
// rows with a UNIQUE `source_key`, the wallet is the real `PointsWalletService`
// writing a real ledger, and `transaction.count` evaluates the `where` it is
// given. The previous suite stubbed `count` with a constant, so the "is this the
// first payment" filter could be deleted without a red test, and it asserted
// that reward rows were CREATED — which stayed green for the four months in
// which nothing ever issued them.

const DAY_MS = 24 * 60 * 60 * 1000;

interface TxRow {
  id: string;
  userId: string;
  amount: number;
  status: TransactionStatus;
  purchaseType: PurchaseType;
  gatewayType: PaymentGatewayType;
  createdAt: Date;
  channel: PurchaseChannel;
  planSnapshot: Record<string, unknown>;
  gatewayData?: Record<string, unknown> | null;
}

interface ReferralRow {
  id: string;
  referrerId: string;
  referredId: string;
  qualifiedAt: Date | null;
  qualifiedTransactionId: string | null;
  qualifiedPurchaseChannel: PurchaseChannel | null;
}

interface RewardRow {
  id: string;
  referralId: string;
  userId: string;
  type: ReferralRewardType;
  amount: number;
  isIssued: boolean;
  issuedAt: Date | null;
  issuedBy: string | null;
  grantedBy: string | null;
  sourceKey: string | null;
  revokedAt: Date | null;
  revokeReason: string | null;
  createdAt: Date;
}

interface UserRow {
  id: string;
  points: number;
  currentSubscriptionId: string | null;
}

interface SubscriptionRow {
  id: string;
  userId: string;
  status: SubscriptionStatus;
  expiresAt: Date | null;
  remnawaveId: string | null;
}

interface LedgerRow {
  id: string;
  userId: string;
  delta: number;
  balanceAfter: number;
  source: PointsLedgerSource;
  referenceKey: string | null;
}

interface WorldInput {
  readonly referralSettings?: Record<string, unknown>;
  readonly transactions?: readonly Partial<TxRow>[];
  readonly referrals?: readonly Partial<ReferralRow>[];
  readonly rewards?: readonly Partial<RewardRow>[];
  readonly users?: readonly Partial<UserRow>[];
  readonly subscriptions?: readonly Partial<SubscriptionRow>[];
  readonly activePartners?: readonly string[];
  readonly enqueueFails?: boolean;
  /** `transaction_items` rows: the plans a combined renewal bought. */
  readonly items?: readonly { readonly transactionId: string; readonly planId: string }[];
  /** How many `$transaction` calls PostgreSQL aborts on a deadlock before one goes through. */
  readonly transactionConflicts?: number;
}

function project(row: Record<string, unknown>, select: unknown): Record<string, unknown> {
  if (select === undefined || select === null) return { ...row };
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(select as Record<string, unknown>)) out[key] = row[key];
  return out;
}

function makeWorld(input: WorldInput = {}) {
  const transactions: TxRow[] = (input.transactions ?? []).map((row, index) => ({
    id: `tx-${index + 1}`,
    userId: 'friend',
    amount: 100,
    status: TransactionStatus.COMPLETED,
    purchaseType: PurchaseType.NEW,
    gatewayType: PaymentGatewayType.YOOKASSA,
    createdAt: new Date(Date.UTC(2026, 8, 1 + index)),
    channel: PurchaseChannel.WEB,
    planSnapshot: { id: 'plan-1' },
    ...row,
  }));
  const referrals: ReferralRow[] = (input.referrals ?? [
    { id: 'ref-friend', referrerId: 'inviter', referredId: 'friend' },
    { id: 'ref-inviter', referrerId: 'ancestor', referredId: 'inviter' },
  ]).map((row) => ({
    id: 'ref-x',
    referrerId: 'inviter',
    referredId: 'friend',
    qualifiedAt: null,
    qualifiedTransactionId: null,
    qualifiedPurchaseChannel: null,
    ...row,
  }));
  let rewardSeq = 0;
  // Reward rows get increasing creation times, so "the earliest reward" has
  // one answer, as it does in the database.
  let clock = Date.UTC(2026, 8, 1);
  const tick = (): Date => new Date((clock += 1000));
  const rewards: RewardRow[] = (input.rewards ?? []).map((row) => ({
    id: `seed-${++rewardSeq}`,
    referralId: 'ref-friend',
    userId: 'inviter',
    type: ReferralRewardType.POINTS,
    amount: 10,
    isIssued: false,
    issuedAt: null,
    issuedBy: null,
    grantedBy: null,
    sourceKey: null,
    revokedAt: null,
    revokeReason: null,
    createdAt: tick(),
    ...row,
  }));
  const users: UserRow[] = (input.users ?? [{ id: 'inviter' }, { id: 'ancestor' }, { id: 'friend' }]).map(
    (row) => ({ id: 'u', points: 0, currentSubscriptionId: null, ...row }),
  );
  const subscriptions: SubscriptionRow[] = (input.subscriptions ?? []).map((row) => ({
    id: 'sub',
    userId: 'inviter',
    status: SubscriptionStatus.ACTIVE,
    expiresAt: new Date(Date.now() + 10 * DAY_MS),
    remnawaveId: 'rw-1',
    ...row,
  }));
  const ledger: LedgerRow[] = [];
  const syncJobs: Array<{ id: string; subscriptionId: string; action: string; payload: Record<string, unknown> }> = [];
  /** Locks and writes, in the order the service issued them. */
  const ops: string[] = [];
  let conflictsLeft = input.transactionConflicts ?? 0;
  const enqueued: string[] = [];
  const events: Array<{ type: string; meta: Record<string, unknown> }> = [];

  // Evaluates the Prisma filter shapes this service uses — equality, `in`,
  // `not`, `startsWith`/`endsWith`, `NOT` and `OR` — with SQL's NULL rules
  // for LIKE (a NULL key matches neither `startsWith` nor its negation).
  const matchesField = (value: unknown, cond: unknown): boolean => {
    if (cond === null || typeof cond !== 'object' || cond instanceof Date) return value === cond;
    const c = cond as { in?: unknown[]; not?: unknown; startsWith?: string; endsWith?: string };
    if (c.in !== undefined && !c.in.includes(value)) return false;
    if ('not' in c && value === c.not) return false;
    if (c.startsWith !== undefined && !(typeof value === 'string' && value.startsWith(c.startsWith))) return false;
    if (c.endsWith !== undefined && !(typeof value === 'string' && value.endsWith(c.endsWith))) return false;
    return true;
  };
  const rewardMatches = (row: RewardRow, where: Record<string, unknown> | undefined): boolean => {
    if (where === undefined) return true;
    for (const [key, cond] of Object.entries(where)) {
      if (key === 'OR') {
        if (!(cond as Array<Record<string, unknown>>).some((branch) => rewardMatches(row, branch))) return false;
        continue;
      }
      if (key === 'NOT') {
        const negated = cond as Record<string, unknown>;
        // SQL: NOT (source_key LIKE '…%') is NULL, not TRUE, for a NULL key.
        const nullInvolved = Object.keys(negated).some(
          (field) => (row as unknown as Record<string, unknown>)[field] === null,
        );
        if (nullInvolved || rewardMatches(row, negated)) return false;
        continue;
      }
      if (!matchesField((row as unknown as Record<string, unknown>)[key], cond)) return false;
    }
    return true;
  };

  const client = {
    $queryRaw: async (statement: { sql?: string; values?: unknown[] }) => {
      const table = /"(\w+)" WHERE/.exec(statement.sql ?? '')?.[1] ?? '?';
      ops.push(`lock:${table}:${String(statement.values?.[0])}`);
      return [];
    },
    $transaction: async <T>(run: (tx: unknown) => Promise<T>): Promise<T> => {
      if (conflictsLeft > 0) {
        conflictsLeft -= 1;
        ops.push('aborted:deadlock');
        throw new Prisma.PrismaClientKnownRequestError(
          'Transaction failed due to a write conflict or a deadlock. Please retry your transaction',
          { code: 'P2034', clientVersion: 'spec' },
        );
      }
      return run(client);
    },
    // The one write to a payment, the reversal's stamp, is one statement
    // (`writeTransactionGatewayData`), merged onto what the row holds.
    $executeRaw: executeGatewayDataWrites({
      currentGatewayData: (id) => transactions.find((t) => t.id === id)?.gatewayData,
      update: async (args) => {
        ops.push(`transaction:${args.where.id}`);
        const row = transactions.find((t) => t.id === args.where.id);
        if (row === undefined) throw new Error('fixture: unknown transaction');
        Object.assign(row, args.data);
        return row;
      },
    }),
    settings: {
      findFirst: async () => ({ referralSettings: input.referralSettings ?? {} }),
    },
    transactionItem: {
      findMany: async (args: { where: { transactionId: string } }) =>
        (input.items ?? [])
          .filter((item) => item.transactionId === args.where.transactionId)
          .map((item) => ({ planId: item.planId })),
    },
    transaction: {
      findUnique: async (args: { where: { id: string }; select?: unknown }) => {
        const row = transactions.find((t) => t.id === args.where.id);
        return row === undefined ? null : project(row as unknown as Record<string, unknown>, args.select);
      },
      // Evaluates whichever conditions the service passes, so dropping one of
      // them changes the ANSWER (and a test fails on an assertion) instead of
      // crashing the double.
      count: async (args: { where: Record<string, unknown> }) => {
        const where = args.where as {
          userId?: string;
          status?: TransactionStatus;
          amount?: { gt?: number };
          gatewayType?: { not?: PaymentGatewayType };
          id?: { not?: string };
          createdAt?: { lt?: Date };
        };
        return transactions.filter(
          (t) =>
            (where.userId === undefined || t.userId === where.userId) &&
            (where.status === undefined || t.status === where.status) &&
            (where.amount?.gt === undefined || t.amount > where.amount.gt) &&
            (where.gatewayType?.not === undefined || t.gatewayType !== where.gatewayType.not) &&
            (where.id?.not === undefined || t.id !== where.id.not) &&
            (where.createdAt?.lt === undefined || t.createdAt.getTime() < where.createdAt.lt.getTime()),
        ).length;
      },
    },
    referral: {
      findUnique: async (args: { where: { referredId: string }; select?: unknown }) => {
        const row = referrals.find((r) => r.referredId === args.where.referredId);
        return row === undefined ? null : project(row as unknown as Record<string, unknown>, args.select);
      },
      findFirst: async (args: { where: { qualifiedTransactionId: string }; select?: unknown }) => {
        const row = referrals.find((r) => r.qualifiedTransactionId === args.where.qualifiedTransactionId);
        return row === undefined ? null : project(row as unknown as Record<string, unknown>, args.select);
      },
      update: async (args: { where: { id: string }; data: Partial<ReferralRow> }) => {
        ops.push(`referral:${args.where.id}`);
        const row = referrals.find((r) => r.id === args.where.id);
        if (row === undefined) throw new Error('fixture: unknown referral');
        Object.assign(row, args.data);
        return row;
      },
    },
    partner: {
      findUnique: async (args: { where: { userId: string } }) =>
        (input.activePartners ?? []).includes(args.where.userId) ? { isActive: true } : null,
    },
    referralReward: {
      create: async (args: { data: Partial<RewardRow>; select?: unknown }) => {
        if (args.data.sourceKey && rewards.some((r) => r.sourceKey === args.data.sourceKey)) {
          throw Object.assign(new Error('Unique constraint failed on source_key'), { code: 'P2002' });
        }
        const row: RewardRow = {
          id: `reward-${++rewardSeq}`,
          referralId: '',
          userId: '',
          type: ReferralRewardType.POINTS,
          amount: 0,
          isIssued: false,
          issuedAt: null,
          issuedBy: null,
          grantedBy: null,
          sourceKey: null,
          revokedAt: null,
          revokeReason: null,
          createdAt: tick(),
          ...args.data,
        };
        rewards.push(row);
        return project(row as unknown as Record<string, unknown>, args.select);
      },
      count: async (args: { where: Record<string, unknown> }) =>
        rewards.filter((r) => rewardMatches(r, args.where)).length,
      // No ORDER BY means no order: newest first here, so a caller that relies
      // on rows coming back in insertion order is caught.
      findMany: async (args: { where: Record<string, unknown>; select?: unknown }) =>
        rewards
          .filter((r) => rewardMatches(r, args.where))
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .map((r) => project(r as unknown as Record<string, unknown>, args.select)),
      findFirst: async (args: { where: Record<string, unknown>; select?: unknown }) => {
        const row = rewards
          .filter((r) => rewardMatches(r, args.where))
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
        return row === undefined ? null : project(row as unknown as Record<string, unknown>, args.select);
      },
      update: async (args: { where: { id: string }; data: Partial<RewardRow> }) => {
        const row = rewards.find((r) => r.id === args.where.id);
        if (row === undefined) throw new Error('fixture: unknown reward');
        Object.assign(row, args.data);
        return row;
      },
    },
    user: {
      findUnique: async (args: { where: { id: string }; select?: unknown }) => {
        const row = users.find((u) => u.id === args.where.id);
        return row === undefined ? null : project(row as unknown as Record<string, unknown>, args.select);
      },
      updateMany: async (args: {
        where: { id: string; points?: number | { gte?: number } };
        data: { points: { increment?: number; decrement?: number } };
      }) => {
        ops.push(`wallet:${args.where.id}`);
        const row = users.find((u) => u.id === args.where.id);
        if (row === undefined) return { count: 0 };
        const cond = args.where.points;
        if (typeof cond === 'number' && row.points !== cond) return { count: 0 };
        if (typeof cond === 'object' && cond.gte !== undefined && row.points < cond.gte) return { count: 0 };
        row.points += (args.data.points.increment ?? 0) - (args.data.points.decrement ?? 0);
        return { count: 1 };
      },
    },
    pointsLedgerEntry: {
      findUnique: async (args: {
        where: { source_referenceKey: { source: PointsLedgerSource; referenceKey: string } };
      }) => {
        const key = args.where.source_referenceKey;
        const row = ledger.find((l) => l.source === key.source && l.referenceKey === key.referenceKey);
        return row === undefined ? null : { id: row.id };
      },
      create: async (args: { data: Omit<LedgerRow, 'id'> }) => {
        const row = { id: `ledger-${ledger.length + 1}`, ...args.data };
        ledger.push(row);
        return { id: row.id };
      },
    },
    subscription: {
      findFirst: async (args: { where: { userId: string; status: SubscriptionStatus } }) => {
        const row = subscriptions
          .filter((s) => s.userId === args.where.userId && s.status === args.where.status && s.expiresAt !== null)
          .sort((a, b) => (b.expiresAt?.getTime() ?? 0) - (a.expiresAt?.getTime() ?? 0))[0];
        return row === undefined ? null : { id: row.id };
      },
      findUnique: async (args: { where: { id: string }; select?: unknown }) => {
        const row = subscriptions.find((s) => s.id === args.where.id);
        return row === undefined ? null : project(row as unknown as Record<string, unknown>, args.select);
      },
      update: async (args: { where: { id: string }; data: Partial<SubscriptionRow> }) => {
        ops.push(`subscription:${args.where.id}`);
        const row = subscriptions.find((s) => s.id === args.where.id);
        if (row === undefined) throw new Error('fixture: unknown subscription');
        Object.assign(row, args.data);
        return row;
      },
    },
    profileSyncJob: {
      create: async (args: { data: { subscriptionId: string; action: string; payload: Record<string, unknown> } }) => {
        const row = { id: `sync-${syncJobs.length + 1}`, ...args.data };
        syncJobs.push(row);
        return { id: row.id };
      },
      findFirst: async (args: { where: { payload: { path: string[]; equals: unknown } }; select?: unknown }) => {
        const { path, equals } = args.where.payload;
        const row = syncJobs.find((job) => job.payload[path[0] ?? ''] === equals);
        return row === undefined ? null : project(row as unknown as Record<string, unknown>, args.select);
      },
    },
  };

  const service = new ReferralQualificationService(
    client as never,
    {
      info: (type: string, _category: string, _message: string, meta: Record<string, unknown>) =>
        events.push({ type, meta }),
    } as never,
    new PointsWalletService(),
    {
      enqueue: async (id: string) => {
        if (input.enqueueFails === true) throw new Error('redis is down');
        enqueued.push(id);
      },
    } as never,
  );

  const user = (id: string): UserRow => {
    const row = users.find((u) => u.id === id);
    if (row === undefined) throw new Error(`fixture: no user ${id}`);
    return row;
  };
  const referral = (id: string): ReferralRow => {
    const row = referrals.find((r) => r.id === id);
    if (row === undefined) throw new Error(`fixture: no referral ${id}`);
    return row;
  };

  return { service, transactions, referrals, rewards, users, subscriptions, ledger, syncJobs, enqueued, events, ops, user, referral };
}

const POINTS_50_10 = { rewardType: 'POINTS', level1Reward: 50, level2Reward: 10 } as const;

// ── Automatic issue ───────────────────────────────────────────────────────────

describe('ReferralQualificationService — a friend pays, the reward arrives', () => {
  it('issues POINTS at both levels in the payment itself, through the wallet', async () => {
    const world = makeWorld({ referralSettings: POINTS_50_10, transactions: [{}] });

    const outcome = await world.service.qualifyReferralAfterPurchase('tx-1');

    assert.equal(world.user('inviter').points, 50);
    assert.equal(world.user('ancestor').points, 10);
    assert.deepStrictEqual(
      world.rewards.map((r) => [r.userId, r.amount, r.isIssued, r.issuedBy, r.sourceKey]),
      [
        ['inviter', 50, true, null, referralPaymentRewardSourceKey('tx-1', 1)],
        ['ancestor', 10, true, null, referralPaymentRewardSourceKey('tx-1', 2)],
      ],
    );
    assert.ok(world.rewards.every((r) => r.issuedAt instanceof Date));
    assert.deepStrictEqual(
      world.ledger.map((l) => [l.userId, l.delta, l.balanceAfter, l.source, l.referenceKey]),
      [
        ['inviter', 50, 50, PointsLedgerSource.REFERRAL_REWARD, world.rewards[0]?.id],
        ['ancestor', 10, 10, PointsLedgerSource.REFERRAL_REWARD, world.rewards[1]?.id],
      ],
    );
    assert.equal(world.referral('ref-friend').qualifiedTransactionId, 'tx-1');
    assert.deepStrictEqual(outcome?.issued.map((r) => [r.userId, r.amount]), [
      ['inviter', 50],
      ['ancestor', 10],
    ]);
    assert.deepStrictEqual(outcome?.pending, []);
  });

  it('announces the issue with the keys the cabinet projects for the earner', async () => {
    const world = makeWorld({ referralSettings: POINTS_50_10, transactions: [{}] });

    await world.service.qualifyReferralAfterPurchase('tx-1');

    assert.deepStrictEqual(world.events.map((e) => e.type), [
      'referral.qualified',
      'referral.reward_issued',
      'referral.reward_issued',
    ]);
    const issuedToInviter = world.events[1]?.meta;
    assert.equal(issuedToInviter?.['referrerId'], 'inviter');
    assert.equal(issuedToInviter?.['userId'], 'inviter');
    assert.equal(issuedToInviter?.['rewardType'], ReferralRewardType.POINTS);
    assert.equal(issuedToInviter?.['rewardValue'], 50);
    assert.equal(issuedToInviter?.['issuedBy'], null);
    assert.equal(issuedToInviter?.['transactionId'], 'tx-1');
  });

  it('extends the inviter subscription for EXTRA_DAYS and pushes the sync after commit', async () => {
    const expiresAt = new Date(Date.now() + 5 * DAY_MS);
    const world = makeWorld({
      referralSettings: { rewardType: 'EXTRA_DAYS', level1Reward: 7 },
      transactions: [{}],
      users: [{ id: 'inviter', currentSubscriptionId: 'sub-inviter' }, { id: 'ancestor' }, { id: 'friend' }],
      subscriptions: [{ id: 'sub-inviter', userId: 'inviter', expiresAt }],
    });

    const outcome = await world.service.qualifyReferralAfterPurchase('tx-1');

    const extended = world.subscriptions[0]?.expiresAt?.getTime() ?? 0;
    assert.equal(extended, expiresAt.getTime() + 7 * DAY_MS);
    assert.deepStrictEqual(world.syncJobs.map((j) => j.subscriptionId), ['sub-inviter']);
    assert.deepStrictEqual(world.enqueued, ['sync-1']);
    assert.equal(world.rewards[0]?.isIssued, true);
    assert.equal(outcome?.issued[0]?.syncJobId, 'sync-1');
  });

  it('leaves EXTRA_DAYS pending for an inviter with nothing to extend, and keeps the qualification', async () => {
    const world = makeWorld({
      referralSettings: { rewardType: 'EXTRA_DAYS', level1Reward: 7 },
      transactions: [{}],
    });

    const outcome = await world.service.qualifyReferralAfterPurchase('tx-1');

    assert.equal(world.rewards.length, 1);
    assert.equal(world.rewards[0]?.isIssued, false, 'nothing was granted, so nothing is marked issued');
    assert.equal(world.rewards[0]?.sourceKey, referralPaymentRewardSourceKey('tx-1', 1));
    assert.equal(world.referral('ref-friend').qualifiedTransactionId, 'tx-1', 'the payment still qualified');
    assert.deepStrictEqual(outcome?.issued, []);
    assert.deepStrictEqual(outcome?.pending.map((r) => r.refusal.kind), ['NO_ACTIVE_FINITE_SUBSCRIPTION']);
    assert.deepStrictEqual(world.events.map((e) => e.type), ['referral.qualified']);
  });

  it('does not undo an issue when the sync cannot be enqueued', async () => {
    const world = makeWorld({
      referralSettings: { rewardType: 'EXTRA_DAYS', level1Reward: 7 },
      transactions: [{}],
      subscriptions: [{ id: 'sub-inviter', userId: 'inviter' }],
      enqueueFails: true,
    });

    const outcome = await world.service.qualifyReferralAfterPurchase('tx-1');

    assert.equal(world.rewards[0]?.isIssued, true);
    assert.equal(world.syncJobs.length, 1, 'the job row is durable; the sweep re-drives it');
    assert.equal(outcome?.issued.length, 1);
    assert.deepStrictEqual(world.events.map((e) => e.type), ['referral.qualified', 'referral.reward_issued']);
  });

  it('pays nothing to an active partner, at level 1 or through him at level 2', async () => {
    const world = makeWorld({
      referralSettings: POINTS_50_10,
      transactions: [{}],
      activePartners: ['inviter'],
    });

    const outcome = await world.service.qualifyReferralAfterPurchase('tx-1');

    assert.equal(outcome, null);
    assert.deepStrictEqual(world.rewards, []);
    assert.equal(world.user('inviter').points, 0);
    assert.equal(world.user('ancestor').points, 0);
  });

  it('does nothing when the operator disabled the referral program', async () => {
    const world = makeWorld({
      referralSettings: { ...POINTS_50_10, enabled: false },
      transactions: [{}],
    });

    assert.equal(await world.service.qualifyReferralAfterPurchase('tx-1'), null);
    assert.deepStrictEqual(world.rewards, []);
    assert.equal(world.referral('ref-friend').qualifiedAt, null);
  });

  it('stays enabled when the flag is absent (existing installs are unaffected)', async () => {
    const world = makeWorld({ referralSettings: { rewardType: 'POINTS', level1Reward: 5 }, transactions: [{}] });

    await world.service.qualifyReferralAfterPurchase('tx-1');

    assert.equal(world.user('inviter').points, 5);
  });

  it('reads the legacy nested reward shape too', async () => {
    const world = makeWorld({
      referralSettings: { reward: { type: 'POINTS', strategy: 'AMOUNT', config: { FIRST: 30, SECOND: 4 } } },
      transactions: [{}],
    });

    await world.service.qualifyReferralAfterPurchase('tx-1');

    assert.equal(world.user('inviter').points, 30);
    assert.equal(world.user('ancestor').points, 4);
  });

  it('skips a plan outside eligiblePlanIds', async () => {
    const world = makeWorld({
      referralSettings: { ...POINTS_50_10, eligiblePlanIds: ['plan-vip'] },
      transactions: [{ planSnapshot: { id: 'plan-1' } }],
    });

    assert.equal(await world.service.qualifyReferralAfterPurchase('tx-1'), null);
    assert.deepStrictEqual(world.rewards, []);
  });

  it('does not let a payment that bought no plan pass a restricted eligiblePlanIds', async () => {
    // An add-on purchase has no plan id in its snapshot; the filter used to
    // compare nothing and let it through, and it then took the first-payment
    // place from the plan the operator meant.
    const world = makeWorld({
      referralSettings: { ...POINTS_50_10, accrualStrategy: 'ON_FIRST_PAYMENT', eligiblePlanIds: ['plan-vip'] },
      transactions: [
        { purchaseType: PurchaseType.ADDITIONAL, planSnapshot: { snapshotSource: 'ADDON_PURCHASE', addOnId: 'addon-devices' } },
        { planSnapshot: { id: 'plan-vip' } },
      ],
    });

    assert.equal(await world.service.qualifyReferralAfterPurchase('tx-1'), null, 'the add-on is not a VIP purchase');
    assert.equal((await world.service.qualifyReferralAfterPurchase('tx-2'))?.issued.length, 2, 'the VIP purchase still qualifies');
    assert.equal(world.referral('ref-friend').qualifiedTransactionId, 'tx-2');
  });

  it('reads the plans of a combined renewal from its items', async () => {
    const combined = { purchaseType: PurchaseType.RENEW, planSnapshot: { combinedRenewal: true, itemCount: 2 } };
    const world = makeWorld({
      referralSettings: { ...POINTS_50_10, accrualStrategy: 'ON_EACH_PAYMENT', eligiblePlanIds: ['plan-vip'] },
      transactions: [combined, combined],
      items: [
        { transactionId: 'tx-1', planId: 'plan-basic' },
        { transactionId: 'tx-1', planId: 'plan-basic-2' },
        { transactionId: 'tx-2', planId: 'plan-basic' },
        { transactionId: 'tx-2', planId: 'plan-vip' },
      ],
    });

    assert.equal(await world.service.qualifyReferralAfterPurchase('tx-1'), null, 'two basic plans renewed');
    assert.equal((await world.service.qualifyReferralAfterPurchase('tx-2'))?.issued.length, 2, 'a VIP plan among them');
  });

  it('earns nothing for a payment that is not COMPLETED or moved no money', async () => {
    for (const row of [{ status: TransactionStatus.PENDING }, { amount: 0 }]) {
      const world = makeWorld({ referralSettings: POINTS_50_10, transactions: [row] });

      assert.equal(await world.service.qualifyReferralAfterPurchase('tx-1'), null, JSON.stringify(row));
      assert.deepStrictEqual(world.rewards, [], JSON.stringify(row));
      assert.equal(world.referral('ref-friend').qualifiedAt, null, JSON.stringify(row));
    }
  });
});

// ── Exactly once per payment ─────────────────────────────────────────────────

describe('ReferralQualificationService — replays and «При каждом платеже»', () => {
  it('pays a replayed webhook of the same payment once', async () => {
    const world = makeWorld({ referralSettings: POINTS_50_10, transactions: [{}] });

    await world.service.qualifyReferralAfterPurchase('tx-1');
    const second = await world.service.qualifyReferralAfterPurchase('tx-1');

    assert.equal(second, null);
    assert.equal(world.rewards.length, 2);
    assert.equal(world.user('inviter').points, 50);
    assert.equal(world.ledger.length, 2);
  });

  it('pays a replayed webhook of a LATER payment once too', async () => {
    // The qualifying payment is also caught by `qualifiedTransactionId`; a
    // second payment under «При каждом платеже» is caught only by its keyed
    // rewards, so it needs its own replay.
    const world = makeWorld({
      referralSettings: { ...POINTS_50_10, accrualStrategy: 'ON_EACH_PAYMENT' },
      transactions: [{}, {}],
    });

    await world.service.qualifyReferralAfterPurchase('tx-1');
    await world.service.qualifyReferralAfterPurchase('tx-2');
    const replay = await world.service.qualifyReferralAfterPurchase('tx-2');

    assert.equal(replay, null);
    assert.equal(world.rewards.length, 4);
    assert.equal(world.user('inviter').points, 100);
  });

  it('does not pay again a payment that qualified before rewards were keyed', async () => {
    // The row an older build left behind: the referral names this payment and
    // its reward carries no source key. Under «При каждом платеже» nothing but
    // `qualifiedTransactionId` tells this replay from a new payment.
    const world = makeWorld({
      referralSettings: { ...POINTS_50_10, accrualStrategy: 'ON_EACH_PAYMENT' },
      transactions: [{}],
      referrals: [
        { id: 'ref-friend', referrerId: 'inviter', referredId: 'friend', qualifiedAt: new Date(), qualifiedTransactionId: 'tx-1' },
      ],
      rewards: [{ referralId: 'ref-friend', userId: 'inviter', amount: 50, isIssued: true }],
    });

    assert.equal(await world.service.qualifyReferralAfterPurchase('tx-1'), null);
    assert.equal(world.rewards.length, 1);
  });

  it('pays every payment under «При каждом платеже», without re-qualifying the referral', async () => {
    const world = makeWorld({
      referralSettings: { ...POINTS_50_10, accrualStrategy: 'ON_EACH_PAYMENT' },
      transactions: [{}, {}],
    });

    await world.service.qualifyReferralAfterPurchase('tx-1');
    const second = await world.service.qualifyReferralAfterPurchase('tx-2');

    assert.equal(world.user('inviter').points, 100);
    assert.equal(world.user('ancestor').points, 20);
    assert.deepStrictEqual(
      world.rewards.map((r) => r.sourceKey),
      [
        referralPaymentRewardSourceKey('tx-1', 1),
        referralPaymentRewardSourceKey('tx-1', 2),
        referralPaymentRewardSourceKey('tx-2', 1),
        referralPaymentRewardSourceKey('tx-2', 2),
      ],
    );
    assert.equal(world.referral('ref-friend').qualifiedTransactionId, 'tx-1', 'the first payment stays the qualifying one');
    assert.equal(second?.issued.length, 2);
    assert.equal(
      world.events.filter((e) => e.type === 'referral.qualified').length,
      1,
      'invite-friends quests count qualifications, not payments',
    );
  });

  it('reads a missing strategy as the first payment only — what the panel form shows for it', async () => {
    // The form defaults a missing `accrualStrategy` to «Только при первом
    // платеже». The engine used to read the same missing key as every payment,
    // which was invisible while a referral paid once and would now pay every
    // renewal on those installs.
    const world = makeWorld({ referralSettings: { rewardType: 'POINTS', level1Reward: 5 }, transactions: [{}, {}] });

    await world.service.qualifyReferralAfterPurchase('tx-1');
    await world.service.qualifyReferralAfterPurchase('tx-2');

    assert.equal(world.user('inviter').points, 5);
  });

  it('still pays every payment for the legacy ON_EVERY_PAYMENT spelling', async () => {
    const world = makeWorld({
      referralSettings: { rewardType: 'POINTS', level1Reward: 5, accrual_strategy: 'ON_EVERY_PAYMENT' },
      transactions: [{}, {}],
    });

    await world.service.qualifyReferralAfterPurchase('tx-1');
    await world.service.qualifyReferralAfterPurchase('tx-2');

    assert.equal(world.user('inviter').points, 10);
  });
});

// ── «Только при первом платеже» ──────────────────────────────────────────────

describe('ReferralQualificationService — «Только при первом платеже» means the first payment', () => {
  const FIRST_ONLY = { ...POINTS_50_10, accrualStrategy: 'ON_FIRST_PAYMENT' } as const;

  it('qualifies a first payment whatever it bought — a renewal, an extra subscription, an upgrade', async () => {
    // Purchase type used to decide: only NEW and UPGRADE could qualify, so a
    // friend whose first real payment renewed a promo-code subscription or
    // bought a second subscription on top of a trial earned the inviter nothing.
    for (const purchaseType of [PurchaseType.RENEW, PurchaseType.ADDITIONAL, PurchaseType.UPGRADE]) {
      const world = makeWorld({ referralSettings: FIRST_ONLY, transactions: [{ purchaseType }] });

      await world.service.qualifyReferralAfterPurchase('tx-1');

      assert.equal(world.user('inviter').points, 50, purchaseType);
    }
  });

  it('pays only the first of two payments', async () => {
    const world = makeWorld({ referralSettings: FIRST_ONLY, transactions: [{}, {}] });

    await world.service.qualifyReferralAfterPurchase('tx-1');
    const second = await world.service.qualifyReferralAfterPurchase('tx-2');

    assert.equal(second, null);
    assert.equal(world.user('inviter').points, 50);
    assert.equal(world.rewards.length, 2);
  });

  it('pays once when two payments reach the hook out of order — whichever qualifies first', async () => {
    const world = makeWorld({ referralSettings: FIRST_ONLY, transactions: [{}, {}] });

    const newerFirst = await world.service.qualifyReferralAfterPurchase('tx-2');
    const olderSecond = await world.service.qualifyReferralAfterPurchase('tx-1');

    assert.equal(newerFirst?.issued.length, 2);
    assert.equal(olderSecond, null);
    assert.equal(world.user('inviter').points, 50);
  });

  it('lets a payment that earned nothing leave the first place free — an ineligible plan, a paused program', async () => {
    // A count of earlier payments used to decide, and a payment every gate had
    // turned away still took the place for good.
    const settings: Record<string, unknown> = { ...FIRST_ONLY, eligiblePlanIds: ['plan-vip'] };
    const world = makeWorld({
      referralSettings: settings,
      transactions: [{ planSnapshot: { id: 'plan-basic' } }, { planSnapshot: { id: 'plan-vip' } }, { planSnapshot: { id: 'plan-vip' } }],
    });

    assert.equal(await world.service.qualifyReferralAfterPurchase('tx-1'), null, 'a basic plan earns nothing');
    settings['enabled'] = false;
    assert.equal(await world.service.qualifyReferralAfterPurchase('tx-2'), null, 'the program is paused');
    settings['enabled'] = true;
    const resumed = await world.service.qualifyReferralAfterPurchase('tx-3');

    assert.equal(resumed?.issued.length, 2);
    assert.equal(world.referral('ref-friend').qualifiedTransactionId, 'tx-3');
  });

  it('ignores a purchase paid from the partner balance, as the live path does', async () => {
    const world = makeWorld({
      referralSettings: FIRST_ONLY,
      transactions: [{ gatewayType: PaymentGatewayType.PARTNER_BALANCE }, {}],
    });

    assert.equal(await world.service.qualifyReferralAfterPurchase('tx-1'), null, 'the partner-balance purchase earns nothing');
    await world.service.qualifyReferralAfterPurchase('tx-2');

    assert.equal(world.user('inviter').points, 50, 'and it does not take the first place from the payment with money');
    assert.equal(world.referral('ref-friend').qualifiedTransactionId, 'tx-2');
  });

  it('does not pay the first payment of a referral imported with its donor rewards', async () => {
    const imported = { referralId: 'ref-friend', userId: 'inviter', amount: 30, isIssued: true, sourceKey: 'bedolaga:referral-reward:77' };
    const firstOnly = makeWorld({ referralSettings: FIRST_ONLY, transactions: [{ purchaseType: PurchaseType.RENEW }], rewards: [imported] });

    assert.equal(await firstOnly.service.qualifyReferralAfterPurchase('tx-1'), null);
    assert.equal(firstOnly.user('inviter').points, 0, 'the donor already paid for this referral');

    // «При каждом платеже» is about payments, not referrals: a new payment here
    // is a new payment whatever the donor paid for the old ones.
    const eachPayment = makeWorld({
      referralSettings: { ...POINTS_50_10, accrualStrategy: 'ON_EACH_PAYMENT' },
      transactions: [{}],
      rewards: [imported],
    });
    await eachPayment.service.qualifyReferralAfterPurchase('tx-1');
    assert.equal(eachPayment.user('inviter').points, 50);
  });

  it('does not let a zero-amount checkout or a failed payment take the first place', async () => {
    const world = makeWorld({
      referralSettings: FIRST_ONLY,
      transactions: [{ amount: 0 }, { status: TransactionStatus.FAILED }, {}],
    });

    await world.service.qualifyReferralAfterPurchase('tx-3');

    assert.equal(world.user('inviter').points, 50);
  });
});

// ── Refunds ──────────────────────────────────────────────────────────────────

describe('ReferralQualificationService — a refund takes back what ITS payment earned', () => {
  it('reverses the qualifying payment: its rewards at both levels, and the qualification', async () => {
    const world = makeWorld({ referralSettings: POINTS_50_10, transactions: [{}] });
    await world.service.qualifyReferralAfterPurchase('tx-1');
    // The setup really paid — otherwise every assertion below holds vacuously.
    assert.equal(world.user('inviter').points, 50);
    assert.equal(world.user('ancestor').points, 10);
    assert.equal(world.rewards.length, 2);

    await world.service.reverseQualificationForTransaction('tx-1');

    assert.equal(world.user('inviter').points, 0);
    assert.equal(world.user('ancestor').points, 0, 'the level-2 reward sits on another referral row and is found by key');
    assert.ok(world.rewards.every((r) => r.revokedAt instanceof Date));
    assert.equal(world.referral('ref-friend').qualifiedAt, null);
    assert.equal(world.referral('ref-friend').qualifiedTransactionId, null);
  });

  it('reverses a later payment without touching the first payment or the qualification', async () => {
    const world = makeWorld({
      referralSettings: { ...POINTS_50_10, accrualStrategy: 'ON_EACH_PAYMENT' },
      transactions: [{}, {}],
    });
    await world.service.qualifyReferralAfterPurchase('tx-1');
    await world.service.qualifyReferralAfterPurchase('tx-2');

    await world.service.reverseQualificationForTransaction('tx-2');

    assert.equal(world.user('inviter').points, 50);
    assert.equal(world.user('ancestor').points, 10);
    assert.deepStrictEqual(
      world.rewards.map((r) => [r.sourceKey, r.revokedAt !== null]),
      [
        [referralPaymentRewardSourceKey('tx-1', 1), false],
        [referralPaymentRewardSourceKey('tx-1', 2), false],
        [referralPaymentRewardSourceKey('tx-2', 1), true],
        [referralPaymentRewardSourceKey('tx-2', 2), true],
      ],
    );
    assert.equal(world.referral('ref-friend').qualifiedTransactionId, 'tx-1');
  });

  it('lets the next payment qualify after the first one was refunded', async () => {
    const world = makeWorld({
      referralSettings: { ...POINTS_50_10, accrualStrategy: 'ON_FIRST_PAYMENT' },
      transactions: [{}, {}],
    });
    await world.service.qualifyReferralAfterPurchase('tx-1');
    await world.service.reverseQualificationForTransaction('tx-1');
    // What both refund paths write on the payment itself.
    const refunded = world.transactions[0];
    if (refunded !== undefined) refunded.status = TransactionStatus.CANCELED;

    await world.service.qualifyReferralAfterPurchase('tx-2');

    assert.equal(world.user('inviter').points, 50);
    assert.equal(world.referral('ref-friend').qualifiedTransactionId, 'tx-2');
  });

  it('moves the qualification to the next payment that still holds its reward', async () => {
    const world = makeWorld({
      referralSettings: { ...POINTS_50_10, accrualStrategy: 'ON_EACH_PAYMENT' },
      transactions: [{}, { channel: PurchaseChannel.TELEGRAM }],
    });
    await world.service.qualifyReferralAfterPurchase('tx-1');
    await world.service.qualifyReferralAfterPurchase('tx-2');

    await world.service.reverseQualificationForTransaction('tx-1');

    const referral = world.referral('ref-friend');
    assert.equal(referral.qualifiedTransactionId, 'tx-2', 'a later payment keeps the referral qualified');
    assert.equal(referral.qualifiedPurchaseChannel, PurchaseChannel.TELEGRAM);
    assert.ok(referral.qualifiedAt instanceof Date);
    assert.equal(world.user('inviter').points, 50);
  });

  it('takes EXTRA_DAYS back from the subscription that got them, and tells Remnawave', async () => {
    const soon = new Date(Date.now() + 3 * DAY_MS);
    const later = new Date(Date.now() + 20 * DAY_MS);
    const world = makeWorld({
      referralSettings: { rewardType: 'EXTRA_DAYS', level1Reward: 7 },
      transactions: [{}],
      // The current subscription is expired, so the issue extends the fallback.
      users: [{ id: 'inviter', currentSubscriptionId: 'sub-current' }, { id: 'ancestor' }, { id: 'friend' }],
      subscriptions: [
        { id: 'sub-current', userId: 'inviter', status: SubscriptionStatus.EXPIRED, expiresAt: soon, remnawaveId: 'rw-a' },
        { id: 'sub-active', userId: 'inviter', expiresAt: later, remnawaveId: 'rw-b' },
      ],
    });
    await world.service.qualifyReferralAfterPurchase('tx-1');
    assert.equal(world.subscriptions[1]?.expiresAt?.getTime(), later.getTime() + 7 * DAY_MS, 'setup: the fallback got the days');
    const enqueuedBefore = world.enqueued.length;

    await world.service.reverseQualificationForTransaction('tx-1');

    assert.equal(world.subscriptions[1]?.expiresAt?.getTime(), later.getTime(), 'the days leave the subscription that got them');
    assert.equal(world.subscriptions[0]?.expiresAt?.getTime(), soon.getTime(), 'the current subscription is not touched');
    const reversalJob = world.syncJobs[world.syncJobs.length - 1];
    assert.equal(reversalJob?.subscriptionId, 'sub-active');
    assert.equal(reversalJob?.action, 'UPDATE');
    assert.deepStrictEqual(world.enqueued.slice(enqueuedBefore), [reversalJob?.id], 'Remnawave follows after commit');
  });

  it('locks the payer referral row before it touches any wallet or subscription', async () => {
    const world = makeWorld({ referralSettings: POINTS_50_10, transactions: [{}] });
    await world.service.qualifyReferralAfterPurchase('tx-1');
    world.ops.length = 0;

    await world.service.reverseQualificationForTransaction('tx-1');

    assert.equal(world.ops[0], 'lock:referrals:friend', JSON.stringify(world.ops));
    const firstWrite = world.ops.findIndex((op) => op.startsWith('wallet:') || op.startsWith('subscription:'));
    assert.ok(firstWrite > 0, JSON.stringify(world.ops));
    assert.deepStrictEqual(
      world.ops.filter((op) => op.startsWith('wallet:')),
      ['wallet:inviter', 'wallet:ancestor'],
      'level 1 before level 2',
    );
  });

  it('revokes rewards imported against an imported qualifying payment', async () => {
    const world = makeWorld({
      // What the Altshop importer writes: the donor's payment, marked as imported,
      // is the referral's qualifying payment.
      transactions: [{ id: 'tx-imported', planSnapshot: { importedFrom: 'altshop' } }],
      referrals: [
        { id: 'ref-friend', referrerId: 'inviter', referredId: 'friend', qualifiedAt: new Date(), qualifiedTransactionId: 'tx-imported' },
      ],
      users: [{ id: 'inviter', points: 40 }, { id: 'friend' }],
      rewards: [
        { id: 'altshop-1', referralId: 'ref-friend', userId: 'inviter', amount: 40, isIssued: true, sourceKey: 'altshop:referral-reward:9' },
      ],
    });

    await world.service.reverseQualificationForTransaction('tx-imported');

    assert.ok(world.rewards[0]?.revokedAt instanceof Date);
    assert.equal(world.user('inviter').points, 0);
  });

  it('leaves the imported donor history alone when a LOCAL payment that qualified that referral is refunded', async () => {
    // Bedolaga and Remnashop import an edge without `qualifiedAt`, so under
    // «При каждом платеже» the first payment made here becomes its qualifying
    // payment — and its refund used to take back every donor reward with it.
    const donor = { referralId: 'ref-friend', userId: 'inviter', amount: 250, isIssued: true };
    const world = makeWorld({
      referralSettings: { rewardType: 'POINTS', level1Reward: 100, accrualStrategy: 'ON_EACH_PAYMENT' },
      transactions: [{ purchaseType: PurchaseType.RENEW }],
      users: [{ id: 'inviter', points: 500 }, { id: 'ancestor' }, { id: 'friend' }],
      rewards: [
        { ...donor, id: 'donor-1', sourceKey: 'bedolaga-earning:1' },
        { ...donor, id: 'donor-2', sourceKey: 'bedolaga-earning:2' },
      ],
    });
    await world.service.qualifyReferralAfterPurchase('tx-1');
    assert.equal(world.user('inviter').points, 600, 'setup: the payment paid its own reward');
    assert.equal(world.referral('ref-friend').qualifiedTransactionId, 'tx-1', 'setup: and qualified the imported edge');

    await world.service.reverseQualificationForTransaction('tx-1');

    assert.equal(world.user('inviter').points, 500, 'only what this payment earned is taken back');
    assert.deepStrictEqual(
      world.rewards.filter((r) => r.sourceKey?.startsWith('bedolaga-earning:')).map((r) => r.revokedAt),
      [null, null],
    );
  });

  it('keeps an operator grant on the referral when the refunded payment qualified it with keyed rewards', async () => {
    const world = makeWorld({
      referralSettings: { rewardType: 'POINTS', level1Reward: 50 },
      transactions: [{}],
      users: [{ id: 'inviter', points: 20 }, { id: 'ancestor' }, { id: 'friend' }],
      rewards: [{ id: 'grant-1', referralId: 'ref-friend', userId: 'inviter', amount: 20, isIssued: true, grantedBy: 'admin-1' }],
    });
    await world.service.qualifyReferralAfterPurchase('tx-1');

    await world.service.reverseQualificationForTransaction('tx-1');

    assert.equal(world.user('inviter').points, 20);
    assert.equal(world.rewards.find((r) => r.id === 'grant-1')?.revokedAt, null);
  });

  it('pays the next payment after the first one was refunded, even though another payment came in between', async () => {
    // P1 qualified, P2 was paid while P1 held the place, then P1 was refunded.
    // A count of earlier payments counted P2 against P3 and nobody was ever paid.
    const world = makeWorld({ referralSettings: { ...POINTS_50_10, accrualStrategy: 'ON_FIRST_PAYMENT' }, transactions: [{}, {}, {}] });
    await world.service.qualifyReferralAfterPurchase('tx-1');
    assert.equal(await world.service.qualifyReferralAfterPurchase('tx-2'), null);
    await world.service.reverseQualificationForTransaction('tx-1');
    const refunded = world.transactions[0];
    if (refunded !== undefined) refunded.status = TransactionStatus.CANCELED;

    const third = await world.service.qualifyReferralAfterPurchase('tx-3');

    assert.equal(third?.issued.length, 2);
    assert.equal(world.user('inviter').points, 50);
    assert.equal(world.referral('ref-friend').qualifiedTransactionId, 'tx-3');
  });

  it('marks the payment reversed, so its own reward hook arriving after the refund issues nothing', async () => {
    // A refund reverses the referral program before it marks the payment
    // CANCELED; the success hook of the same payment can land in between.
    const world = makeWorld({ referralSettings: POINTS_50_10, transactions: [{}] });

    await world.service.reverseQualificationForTransaction('tx-1');
    assert.equal(typeof world.transactions[0]?.gatewayData?.[REFERRAL_REVERSED_AT_KEY], 'string');
    const late = await world.service.qualifyReferralAfterPurchase('tx-1');

    assert.equal(late, null);
    assert.equal(world.user('inviter').points, 0);
    assert.deepStrictEqual(world.rewards, []);
  });

  it('locks the rewards before it reads whether they were issued', async () => {
    // «Выдать» locks the reward row; a reversal that read `isIssued` first
    // revoked a reward whose issue committed a moment later, effect standing.
    const world = makeWorld({ referralSettings: POINTS_50_10, transactions: [{}] });
    await world.service.qualifyReferralAfterPurchase('tx-1');
    world.ops.length = 0;

    await world.service.reverseQualificationForTransaction('tx-1');

    const rewardLock = world.ops.findIndex((op) => op.startsWith('lock:referral_rewards:'));
    const firstWallet = world.ops.findIndex((op) => op.startsWith('wallet:'));
    assert.ok(rewardLock > 0 && rewardLock < firstWallet, JSON.stringify(world.ops));
  });

  it('still reverses the unkeyed rewards of a referral qualified before the keys existed', async () => {
    const world = makeWorld({
      referrals: [
        { id: 'ref-friend', referrerId: 'inviter', referredId: 'friend', qualifiedAt: new Date(), qualifiedTransactionId: 'tx-old' },
      ],
      users: [{ id: 'inviter', points: 50 }, { id: 'friend' }],
      rewards: [{ id: 'legacy-1', referralId: 'ref-friend', userId: 'inviter', amount: 50, isIssued: true }],
    });

    await world.service.reverseQualificationForTransaction('tx-old');

    assert.equal(world.user('inviter').points, 0);
    assert.ok(world.rewards[0]?.revokedAt instanceof Date);
    assert.equal(world.referral('ref-friend').qualifiedAt, null);
  });
});

// ── Lock order and conflicts ─────────────────────────────────────────────────

describe('ReferralQualificationService — lock order and aborted transactions', () => {
  it('locks the inviter referral row, where the level-2 reward goes, before crediting the inviter', async () => {
    // A refund of the inviter's own payment holds that row and may need his
    // wallet; locking it only at the level-2 insert, after the level-1 credit,
    // was the other half of a deadlock.
    const world = makeWorld({ referralSettings: POINTS_50_10, transactions: [{}] });

    await world.service.qualifyReferralAfterPurchase('tx-1');

    const inviterRowLock = world.ops.indexOf('lock:referrals:inviter');
    assert.ok(inviterRowLock > world.ops.indexOf('lock:referrals:friend'), JSON.stringify(world.ops));
    assert.ok(inviterRowLock < world.ops.indexOf('wallet:inviter'), JSON.stringify(world.ops));
  });

  it('runs a qualification again when PostgreSQL aborts it on a deadlock', async () => {
    const world = makeWorld({ referralSettings: POINTS_50_10, transactions: [{}], transactionConflicts: 2 });

    const outcome = await world.service.qualifyReferralAfterPurchase('tx-1');

    assert.equal(outcome?.issued.length, 2);
    assert.equal(world.ops.filter((op) => op === 'aborted:deadlock').length, 2);
  });

  it('runs a reversal again when PostgreSQL aborts it on a deadlock', async () => {
    const world = makeWorld({ referralSettings: POINTS_50_10, transactions: [{}] });
    await world.service.qualifyReferralAfterPurchase('tx-1');

    // Two aborts, then it goes through.
    const client = (world.service as unknown as {
      prismaService: { $transaction: (run: (tx: unknown) => Promise<unknown>) => Promise<unknown> };
    }).prismaService;
    const through = client.$transaction;
    let aborts = 2;
    client.$transaction = async (run) => {
      if (aborts > 0) {
        aborts -= 1;
        throw new Prisma.PrismaClientKnownRequestError('deadlock', { code: 'P2034', clientVersion: 'spec' });
      }
      return through(run);
    };

    await world.service.reverseQualificationForTransaction('tx-1');

    assert.equal(world.user('inviter').points, 0);
    assert.ok(world.rewards.every((r) => r.revokedAt instanceof Date));
  });

  it('gives up after three aborted attempts instead of looping', async () => {
    const world = makeWorld({ referralSettings: POINTS_50_10, transactions: [{}], transactionConflicts: 5 });

    await assert.rejects(() => world.service.qualifyReferralAfterPurchase('tx-1'), /deadlock/);
    assert.equal(world.ops.filter((op) => op === 'aborted:deadlock').length, 3);
  });

  it('recognises a deadlock or a serialization failure however Prisma reports it, and nothing else', () => {
    const known = (code: string, meta?: Record<string, unknown>, message = 'failed') =>
      new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion: 'spec', meta });
    // The shapes Prisma 7's pg driver adapter produced for a real deadlock on
    // PostgreSQL 17 — a model statement and a raw one. Neither is P2034.
    const adapterCause = (sqlState: string) => ({
      driverAdapterError: {
        name: 'DriverAdapterError',
        cause: { originalCode: sqlState, kind: 'postgres', code: sqlState, message: 'deadlock detected' },
      },
    });

    assert.equal(
      isRetryableTransactionConflict(known('P2039', { modelName: 'ReferralReward', ...adapterCause('40P01') }, 'Database error. Code: `40P01`. Message: `deadlock detected`')),
      true,
      'a model statement',
    );
    assert.equal(
      isRetryableTransactionConflict(known('P2010', adapterCause('40P01'), 'Raw query failed. Code: `40P01`. Message: `deadlock detected`')),
      true,
      'a raw statement',
    );
    assert.equal(isRetryableTransactionConflict(known('P2039', adapterCause('40001'))), true, 'a serialization failure');
    assert.equal(isRetryableTransactionConflict(known('P2034')), true);
    assert.equal(isRetryableTransactionConflict(known('P2039', undefined, 'Database error. Code: `40P01`. Message: `deadlock detected`')), true);
    assert.equal(isRetryableTransactionConflict(known('P2002')), false, 'a unique violation is a decision, not a conflict');
    assert.equal(isRetryableTransactionConflict(known('P2039', adapterCause('23505'))), false);
    assert.equal(isRetryableTransactionConflict(new Error('deadlock detected')), false);
  });
});

// ── The manual qualification keeps its reviewed workflow ─────────────────────

describe('ReferralQualificationService — manual qualification', () => {
  it('stages the configured rewards pending, with the admin actor and no key', async () => {
    const world = makeWorld({ referralSettings: { rewardType: 'POINTS', level1Reward: 75 } });

    const result = await world.service.qualifyReferralManually({
      referredUserId: 'friend',
      actorAdminId: 'admin-1',
    });

    assert.deepStrictEqual(result, { referralId: 'ref-friend', qualified: true, rewardsCreated: 1 });
    assert.deepStrictEqual(
      world.rewards.map((r) => [r.userId, r.amount, r.isIssued, r.grantedBy, r.sourceKey]),
      [['inviter', 75, false, 'admin-1', null]],
    );
    assert.equal(world.user('inviter').points, 0, 'the payout is the operator’s «Выдать»');
    assert.deepStrictEqual(world.events.map((e) => e.type), ['referral.qualified']);
  });
});

/**
 * THE DELETION GUARD.
 *
 * `ReferralQualificationService.issueReward` was a second, DIVERGED copy of the
 * reward effect, with no caller anywhere in `src/`, `test/` or `scripts/` — and
 * it was strictly worse on every point that matters for an `EXTRA_DAYS` reward:
 *
 *   • it only ever looked at `user.currentSubscriptionId`, where the live one
 *     falls back to the newest ACTIVE finite subscription under
 *     `SELECT … FOR UPDATE` and verifies owner and status;
 *   • finding no eligible subscription it marked the reward ISSUED and granted
 *     nothing, where the live one refuses;
 *   • it created no `ProfileSyncJob`, so the extra days would have lived in the
 *     local database and never reached the customer's real VPN profile.
 *
 * This service DOES issue rewards now (owner, 2026-09-14), and it does so
 * through the one shared implementation, `applyReferralRewardEffect` — the
 * suites above prove the subscription lock, the refusal and the sync job on
 * that path. What this guard keeps out is a private copy coming back.
 *
 * The guard is a runtime property check rather than a compile-time one on
 * purpose — a type-level assertion on a method that no longer exists is a
 * COMPILE error, and a spec that fails to compile reports zero tests instead of
 * one named failure.
 */
describe('ReferralQualificationService no longer carries a second reward issuer', () => {
  it('exposes no issueReward, on the instance or the prototype', () => {
    const { service } = makeWorld();
    const holder = service as unknown as Record<string, unknown>;

    assert.equal(
      typeof holder.issueReward,
      'undefined',
      'ReferralQualificationService.issueReward is back: issuing belongs to the shared ' +
        'applyReferralRewardEffect (referral-reward-effect.ts), which locks the subscription, ' +
        'refuses instead of marking a reward issued for nothing, and creates the ProfileSyncJob.',
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        ReferralQualificationService.prototype as object,
        'issueReward',
      ),
      false,
      'issueReward is on the prototype of ReferralQualificationService',
    );
  });

  it('still exposes the methods that DO have callers', () => {
    // The anti-vacuity control. A renamed class, a broken import or a
    // constructor that threw would make the assertion above pass against
    // nothing at all.
    //
    // Every name here is reachable from production code — `payment-reconciliation`
    // and `referral-manual-attach` for the purchase path, `payment-reconciliation`
    // for the reversal, `admin-user-management` for the manual one. Do not add a
    // name here without checking it has a caller first.
    for (const method of [
      'qualifyReferralAfterPurchase',
      'qualifyReferralManually',
      'reverseQualificationForTransaction',
    ]) {
      assert.equal(
        typeof (ReferralQualificationService.prototype as unknown as Record<string, unknown>)[
          method
        ],
        'function',
        `expected ${method} to still be a method on ReferralQualificationService`,
      );
    }
  });
});
