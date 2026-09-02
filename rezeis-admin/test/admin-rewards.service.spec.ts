import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  ReferralRewardType,
  SubscriptionStatus,
  SyncAction,
  SyncJobStatus,
} from '@prisma/client';

import { EVENT_TYPES } from '../src/common/services/system-events.service';
import { PointsWalletService } from '../src/modules/points/services/points-wallet.service';
import { AdminRewardsService } from '../src/modules/referrals/services/admin-rewards.service';

/**
 * `AdminRewardsService.issue` + the module-private `applyRewardEffect` are the
 * ONLY implementation of reward issuance in this repository. Until this file
 * existed their bodies had never been executed by a test: the sole coverage was
 * `test/referrals.controllers.spec.ts`, which asserts that the CONTROLLER
 * delegates to a mocked `rewardsService.issue(rewardId, adminId)` — a test of
 * the delegation, not of what issuing does.
 *
 * The second, diverged copy (`ReferralQualificationService.issueReward`) has
 * been deleted, so nothing else in the tree does this any more. Its specific
 * failures are what most of the assertions below exist to keep caught:
 *
 *   • it targeted `user.currentSubscriptionId` alone, so an `EXTRA_DAYS` reward
 *     for a user whose pointer was null granted nothing;
 *   • finding no eligible subscription it marked the reward ISSUED and granted
 *     nothing — the worst shape a payout bug can take, because the row then
 *     says the customer was paid;
 *   • it created no `ProfileSyncJob`, so the days lived in the local database
 *     and never reached the customer's real VPN profile.
 *
 * ── How the fake Prisma client here is built, and why ─────────────────────────
 *
 * It HONOURS `select` and `include` (see `project`). A mock that answers with a
 * whole fixture row regardless of what was asked for cannot tell a service that
 * dropped a column from one that still reads it — `remnawaveId` decides CREATE
 * vs UPDATE on the sync job, and the identity columns decide whether an
 * operator sees a name or a dash. It also evaluates `where` and `orderBy` for
 * the subscription fallback rather than returning a canned row, so "resolve the
 * newest ACTIVE finite subscription" is really resolved here.
 *
 * NO ABSOLUTE DATE LITERALS. Every instant is derived from a base the test
 * captures itself. A `2026-03-01` fixture in this repository was live when it
 * was written and had silently become an "expired subscription" assertion five
 * months later, with thirty tests asserting the defect while staying green.
 * `expiresAt` is directly in this file's path.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const ADMIN = 'admin-7';

/**
 * What `extractRequestMetadata(req)` hands the service from the two issue
 * routes. Every field is a distinct non-null value on purpose: the audit row
 * puts `remoteAddress` and `userAgent` in COLUMNS and `requestId` in the
 * metadata JSON, and three nulls would make swapping two of them invisible.
 */
const META = {
  requestId: 'req-9f2c',
  remoteAddress: '198.51.100.7',
  userAgent: 'rezeis-panel/0.9.7 (spec)',
} as const;

// ── Fixtures ─────────────────────────────────────────────────────────────────

interface UserFixture {
  readonly id: string;
  readonly currentSubscriptionId: string | null;
  readonly telegramId: bigint | null;
  readonly points: number;
}

interface SubscriptionFixture {
  readonly id: string;
  readonly userId: string;
  readonly status: SubscriptionStatus;
  readonly expiresAt: Date | null;
  readonly remnawaveId: string | null;
}

interface RewardUserFixture {
  readonly id: string;
  readonly username: string | null;
  readonly name: string;
  readonly telegramId: bigint | null;
  readonly email: string | null;
  readonly webAccount: { readonly login: string | null; readonly email: string | null } | null;
  readonly createdAt: Date;
}

interface RewardFixture {
  readonly id: string;
  readonly referralId: string;
  readonly userId: string;
  readonly type: ReferralRewardType;
  readonly amount: number;
  readonly isIssued: boolean;
  readonly issuedAt: Date | null;
  readonly issuedBy: string | null;
  readonly grantedBy: string | null;
  readonly revokedAt: Date | null;
  readonly revokeReason: string | null;
  readonly createdAt: Date;
  readonly user: RewardUserFixture;
}

function makeRewardUser(overrides: Partial<RewardUserFixture> = {}): RewardUserFixture {
  return {
    id: 'earner-1',
    username: 'earner',
    name: 'Earner One',
    telegramId: 4242n,
    email: null,
    webAccount: null,
    createdAt: new Date(Date.now() - 90 * DAY_MS),
    ...overrides,
  };
}

function makeReward(overrides: Partial<RewardFixture> = {}): RewardFixture {
  return {
    id: 'reward-1',
    referralId: 'referral-1',
    userId: 'earner-1',
    type: ReferralRewardType.EXTRA_DAYS,
    amount: 7,
    isIssued: false,
    issuedAt: null,
    issuedBy: null,
    grantedBy: null,
    revokedAt: null,
    revokeReason: null,
    createdAt: new Date(Date.now() - 7 * DAY_MS),
    user: makeRewardUser(),
    ...overrides,
  };
}

function makeSubscription(overrides: Partial<SubscriptionFixture> = {}): SubscriptionFixture {
  return {
    id: 'sub-1',
    userId: 'earner-1',
    status: SubscriptionStatus.ACTIVE,
    expiresAt: new Date(Date.now() + 30 * DAY_MS),
    remnawaveId: 'rw-1',
    ...overrides,
  };
}

// ── A fake that honours the shape the service asks for ───────────────────────

interface PrismaArgs {
  readonly where?: Record<string, unknown>;
  readonly data?: Record<string, unknown>;
  readonly select?: Record<string, unknown>;
  readonly include?: Record<string, unknown>;
  readonly orderBy?: ReadonlyArray<Record<string, unknown>>;
  readonly take?: number;
  readonly skip?: number;
}

/**
 * Answer with exactly the columns the caller selected, recursing into a nested
 * `{ select }` (that is how `REWARD_USER_SELECT` reaches `webAccount`).
 *
 * A selected key the fixture does not model is an ERROR rather than an
 * `undefined`: silently answering `undefined` is how a mock ends up proving a
 * column exists when it does not.
 */
function project(
  row: Record<string, unknown>,
  select: Record<string, unknown> | undefined,
  where: string,
): Record<string, unknown> {
  if (select === undefined) return { ...row };
  const out: Record<string, unknown> = {};
  for (const [key, wanted] of Object.entries(select)) {
    if (!(key in row)) {
      throw new Error(
        `${where}: the service selected "${key}", which this fixture does not model. ` +
          'Add it to the fixture — do not answer undefined.',
      );
    }
    const value = row[key];
    if (wanted === true) {
      out[key] = value;
      continue;
    }
    const nested = wanted as { readonly select?: Record<string, unknown> };
    if (typeof nested !== 'object' || nested === null || nested.select === undefined) {
      throw new Error(`${where}: unsupported select for "${key}"`);
    }
    out[key] =
      value === null || value === undefined
        ? null
        : project(value as Record<string, unknown>, nested.select, `${where}.${key}`);
  }
  return out;
}

function shapeReward(row: RewardFixture, args: PrismaArgs, where: string): Record<string, unknown> {
  const full = row as unknown as Record<string, unknown>;
  if (args.select !== undefined) return project(full, args.select, where);
  const { user, ...scalars } = row;
  if (args.include === undefined) return { ...scalars };
  const include = args.include as { readonly user?: { readonly select?: Record<string, unknown> } };
  if (include.user === undefined) {
    throw new Error(`${where}: this fixture models only \`include: { user: … }\``);
  }
  return {
    ...scalars,
    user: project(user as unknown as Record<string, unknown>, include.user.select, `${where}.user`),
  };
}

function matchesRewardWhere(row: RewardFixture, where: Record<string, unknown> | undefined): boolean {
  if (where === undefined) return true;
  for (const [key, value] of Object.entries(where)) {
    if (key === 'revokedAt') {
      if (value !== null) throw new Error(`reward where: unsupported revokedAt ${String(value)}`);
      if (row.revokedAt !== null) return false;
      continue;
    }
    if (key === 'id' && typeof value === 'object' && value !== null) {
      const list = (value as { readonly in?: readonly string[] }).in ?? [];
      if (!list.includes(row.id)) return false;
      continue;
    }
    if (key === 'id' || key === 'userId' || key === 'referralId' || key === 'type') {
      if (row[key] !== value) return false;
      continue;
    }
    if (key === 'isIssued') {
      if (row.isIssued !== value) return false;
      continue;
    }
    throw new Error(`reward where: unsupported filter "${key}"`);
  }
  return true;
}

function matchesSubscriptionWhere(
  row: SubscriptionFixture,
  where: Record<string, unknown> | undefined,
): boolean {
  if (where === undefined) return true;
  for (const [key, value] of Object.entries(where)) {
    if (key === 'userId') {
      if (row.userId !== value) return false;
      continue;
    }
    if (key === 'status') {
      if (row.status !== value) return false;
      continue;
    }
    if (key === 'expiresAt') {
      const filter = value as { readonly not?: unknown };
      if (typeof filter !== 'object' || filter === null || !('not' in filter) || filter.not !== null) {
        throw new Error('subscription where: only `expiresAt: { not: null }` is modelled');
      }
      if (row.expiresAt === null) return false;
      continue;
    }
    if (key === 'id') {
      if (row.id !== value) return false;
      continue;
    }
    throw new Error(`subscription where: unsupported filter "${key}"`);
  }
  return true;
}

function subscriptionComparator(
  orderBy: ReadonlyArray<Record<string, unknown>> | undefined,
): (a: SubscriptionFixture, b: SubscriptionFixture) => number {
  const clauses = orderBy ?? [];
  return (a, b): number => {
    for (const clause of clauses) {
      const [field, direction] = Object.entries(clause)[0] ?? [];
      let delta: number;
      if (field === 'expiresAt') {
        delta = (a.expiresAt?.getTime() ?? 0) - (b.expiresAt?.getTime() ?? 0);
      } else if (field === 'id') {
        delta = a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      } else {
        throw new Error(`subscription orderBy: unsupported field "${String(field)}"`);
      }
      if (delta !== 0) return direction === 'desc' ? -delta : delta;
    }
    return 0;
  };
}

interface Recorded {
  readonly steps: string[];
  readonly locks: { readonly sql: string; readonly values: readonly unknown[] }[];
  readonly rewardUpdates: unknown[];
  readonly rewardCreates: unknown[];
  readonly rewardFindManyArgs: unknown[];
  readonly rewardCountArgs: unknown[];
  readonly userUpdates: unknown[];
  readonly ledgerCreates: unknown[];
  readonly subscriptionUpdates: unknown[];
  readonly subscriptionFindFirstArgs: unknown[];
  readonly syncJobCreates: unknown[];
  readonly auditCreates: unknown[];
  readonly enqueued: unknown[];
  readonly events: unknown[][];
  readonly warnings: string[];
}

interface WorldInput {
  readonly rewards?: readonly RewardFixture[];
  readonly user?: UserFixture | null;
  readonly subscriptions?: readonly SubscriptionFixture[];
  readonly referral?: { readonly id: string; readonly referrerId: string; readonly referredId: string } | null;
  readonly syncJobIds?: readonly string[];
  readonly enqueueError?: Error;
  /** Thrown AFTER the transaction callback resolves — a commit that failed. */
  readonly commitError?: Error;
}

interface World {
  readonly service: AdminRewardsService;
  readonly recorded: Recorded;
  readonly rewards: Map<string, RewardFixture>;
  readonly subscriptions: SubscriptionFixture[];
}

function makeWorld(input: WorldInput = {}): World {
  const recorded: Recorded = {
    steps: [],
    locks: [],
    rewardUpdates: [],
    rewardCreates: [],
    rewardFindManyArgs: [],
    rewardCountArgs: [],
    userUpdates: [],
    ledgerCreates: [],
    subscriptionUpdates: [],
    subscriptionFindFirstArgs: [],
    syncJobCreates: [],
    auditCreates: [],
    enqueued: [],
    events: [],
    warnings: [],
  };

  const rewards = new Map<string, RewardFixture>(
    (input.rewards ?? []).map((reward) => [reward.id, reward]),
  );
  const subscriptions: SubscriptionFixture[] = [...(input.subscriptions ?? [])];
  const user = input.user === undefined ? null : input.user;
  const syncJobIds = [...(input.syncJobIds ?? [])];
  let syncJobSeq = 0;

  const model = {
    $queryRaw: async (statement: unknown): Promise<unknown[]> => {
      const sql = statement as { readonly sql?: string; readonly values?: readonly unknown[] };
      recorded.steps.push('$queryRaw');
      recorded.locks.push({ sql: sql.sql ?? String(statement), values: sql.values ?? [] });
      return [];
    },
    referralReward: {
      findUnique: async (args: PrismaArgs): Promise<unknown> => {
        recorded.steps.push('referralReward.findUnique');
        const id = args.where?.['id'];
        const row = typeof id === 'string' ? rewards.get(id) : undefined;
        return row === undefined ? null : shapeReward(row, args, 'referralReward.findUnique');
      },
      update: async (args: PrismaArgs): Promise<unknown> => {
        recorded.steps.push('referralReward.update');
        recorded.rewardUpdates.push(args);
        const id = args.where?.['id'];
        const row = typeof id === 'string' ? rewards.get(id) : undefined;
        if (row === undefined) throw new Error('fixture: update of an unknown reward');
        const next = { ...row, ...(args.data ?? {}) } as RewardFixture;
        rewards.set(next.id, next);
        return shapeReward(next, args, 'referralReward.update');
      },
      create: async (args: PrismaArgs): Promise<unknown> => {
        recorded.steps.push('referralReward.create');
        recorded.rewardCreates.push(args);
        const next = makeReward({ ...(args.data ?? {}), id: 'reward-created' } as Partial<RewardFixture>);
        rewards.set(next.id, next);
        return shapeReward(next, args, 'referralReward.create');
      },
      findMany: async (args: PrismaArgs): Promise<unknown[]> => {
        recorded.steps.push('referralReward.findMany');
        recorded.rewardFindManyArgs.push(args);
        const matched = [...rewards.values()].filter((row) => matchesRewardWhere(row, args.where));
        const page = matched.slice(args.skip ?? 0, (args.skip ?? 0) + (args.take ?? matched.length));
        return page.map((row) => shapeReward(row, args, 'referralReward.findMany'));
      },
      count: async (args: PrismaArgs): Promise<number> => {
        recorded.steps.push('referralReward.count');
        recorded.rewardCountArgs.push(args);
        return [...rewards.values()].filter((row) => matchesRewardWhere(row, args.where)).length;
      },
    },
    referral: {
      findUnique: async (args: PrismaArgs): Promise<unknown> => {
        recorded.steps.push('referral.findUnique');
        if (input.referral === undefined || input.referral === null) return null;
        return project(
          input.referral as unknown as Record<string, unknown>,
          args.select,
          'referral.findUnique',
        );
      },
    },
    user: {
      findUnique: async (args: PrismaArgs): Promise<unknown> => {
        recorded.steps.push('user.findUnique');
        if (user === null) return null;
        const byTelegram = args.where?.['telegramId'];
        if (byTelegram !== undefined) {
          if (user.telegramId === null || user.telegramId !== byTelegram) return null;
          return project(user as unknown as Record<string, unknown>, args.select, 'user.findUnique');
        }
        if (args.where?.['id'] !== user.id) return null;
        return project(user as unknown as Record<string, unknown>, args.select, 'user.findUnique');
      },
      update: async (args: PrismaArgs): Promise<unknown> => {
        recorded.steps.push('user.update');
        recorded.userUpdates.push(args);
        return { id: args.where?.['id'] };
      },
      /**
       * The POINTS payout goes through the wallet, whose balance write is a
       * conditional `updateMany`. Recorded in `userUpdates` like the `update`
       * it replaced — the assertions read "the one write to the user row" —
       * and applied to the fixture so the wallet's read-back sees the result.
       */
      updateMany: async (args: PrismaArgs): Promise<unknown> => {
        recorded.steps.push('user.updateMany');
        recorded.userUpdates.push(args);
        if (user === null || args.where?.['id'] !== user.id) return { count: 0 };
        const cond = args.where?.['points'] as number | { gte?: number } | undefined;
        if (typeof cond === 'number' && user.points !== cond) return { count: 0 };
        if (typeof cond === 'object' && cond?.gte !== undefined && user.points < cond.gte) {
          return { count: 0 };
        }
        const points = args.data?.['points'] as { increment?: number; decrement?: number } | undefined;
        (user as { points: number }).points += (points?.increment ?? 0) - (points?.decrement ?? 0);
        return { count: 1 };
      },
    },
    pointsLedgerEntry: {
      findUnique: async (): Promise<unknown> => {
        recorded.steps.push('pointsLedgerEntry.findUnique');
        return null;
      },
      create: async (args: PrismaArgs): Promise<unknown> => {
        recorded.steps.push('pointsLedgerEntry.create');
        recorded.ledgerCreates.push(args);
        return { id: `ledger-${recorded.ledgerCreates.length}` };
      },
    },
    subscription: {
      findFirst: async (args: PrismaArgs): Promise<unknown> => {
        recorded.steps.push('subscription.findFirst');
        recorded.subscriptionFindFirstArgs.push(args);
        const matched = subscriptions
          .filter((row) => matchesSubscriptionWhere(row, args.where))
          .sort(subscriptionComparator(args.orderBy));
        const first = matched[0];
        return first === undefined
          ? null
          : project(
              first as unknown as Record<string, unknown>,
              args.select,
              'subscription.findFirst',
            );
      },
      findUnique: async (args: PrismaArgs): Promise<unknown> => {
        recorded.steps.push('subscription.findUnique');
        const row = subscriptions.find((candidate) => candidate.id === args.where?.['id']);
        return row === undefined
          ? null
          : project(
              row as unknown as Record<string, unknown>,
              args.select,
              'subscription.findUnique',
            );
      },
      update: async (args: PrismaArgs): Promise<unknown> => {
        recorded.steps.push('subscription.update');
        recorded.subscriptionUpdates.push(args);
        const index = subscriptions.findIndex((row) => row.id === args.where?.['id']);
        if (index === -1) throw new Error('fixture: update of an unknown subscription');
        const merged = { ...subscriptions[index], ...(args.data ?? {}) } as SubscriptionFixture;
        subscriptions[index] = merged;
        return merged;
      },
    },
    profileSyncJob: {
      create: async (args: PrismaArgs): Promise<{ readonly id: string }> => {
        recorded.steps.push('profileSyncJob.create');
        recorded.syncJobCreates.push(args);
        const id = syncJobIds[syncJobSeq] ?? `sync-job-${syncJobSeq + 1}`;
        syncJobSeq += 1;
        return { id };
      },
    },
    // `issue()` writes one `referral.reward.issued` row per reward it pays —
    // see the «audit row» describe block. This model was wired in before that
    // existed and deliberately left un-asserted, so closing the gap needed no
    // test to be un-pinned first; now it records the `data` those assertions
    // compare against.
    adminAuditLog: {
      create: async (args: PrismaArgs): Promise<unknown> => {
        recorded.steps.push('adminAuditLog.create');
        recorded.auditCreates.push(args);
        return { id: 'audit-1' };
      },
    },
  };

  const client = {
    ...model,
    $transaction: async (fn: (tx: unknown) => Promise<unknown>): Promise<unknown> => {
      const result = await fn(model);
      if (input.commitError !== undefined) throw input.commitError;
      return result;
    },
  };

  const queue = {
    enqueue: async (syncJobId: string): Promise<void> => {
      recorded.enqueued.push(syncJobId);
      if (input.enqueueError !== undefined) throw input.enqueueError;
    },
  };

  const events = {
    info: (...args: unknown[]): void => {
      recorded.events.push(args);
    },
    warn: (...args: unknown[]): void => {
      recorded.events.push(args);
    },
    error: (...args: unknown[]): void => {
      recorded.events.push(args);
    },
  };

  const service = new AdminRewardsService(client as never, queue as never, events as never, new PointsWalletService());
  // Silence (and capture) the Nest logger: the enqueue-failure path warns, and
  // «logs and does not throw» is half of what that case asserts.
  (service as unknown as { logger: unknown }).logger = {
    log: (): void => undefined,
    warn: (message: string): void => {
      recorded.warnings.push(message);
    },
    error: (): void => undefined,
    debug: (): void => undefined,
    verbose: (): void => undefined,
  };

  return { service, recorded, rewards, subscriptions };
}

/** The one `subscription.update` this transaction wrote. */
function soleSubscriptionUpdate(recorded: Recorded): { where: { id: string }; data: { expiresAt: Date } } {
  assert.equal(
    recorded.subscriptionUpdates.length,
    1,
    'expected exactly one subscription.update from an EXTRA_DAYS issue',
  );
  return recorded.subscriptionUpdates[0] as { where: { id: string }; data: { expiresAt: Date } };
}

// ── The lock and the lookup ──────────────────────────────────────────────────

describe('AdminRewardsService.issue — the row lock and the lookup', () => {
  it('takes the referral_rewards FOR UPDATE lock before reading the reward', async () => {
    const world = makeWorld({
      rewards: [makeReward({ type: ReferralRewardType.POINTS, amount: 100 })],
      user: { id: 'earner-1', currentSubscriptionId: null, telegramId: 4242n, points: 0 },
    });

    await world.service.issue('reward-1', ADMIN, META);

    // Order, not merely presence: reading first and locking afterwards leaves
    // the window this lock exists to close.
    assert.deepStrictEqual(
      world.recorded.steps.slice(0, 2),
      ['$queryRaw', 'referralReward.findUnique'],
      'the reward must be locked BEFORE it is read',
    );
    assert.equal(world.recorded.locks.length, 1);
    assert.match(world.recorded.locks[0].sql, /referral_rewards/);
    assert.match(world.recorded.locks[0].sql, /FOR UPDATE/);
    assert.deepStrictEqual(world.recorded.locks[0].values, ['reward-1']);
  });

  it('throws NotFoundException for an unknown reward and writes nothing', async () => {
    const world = makeWorld({ rewards: [makeReward()] });

    await assert.rejects(world.service.issue('reward-missing', ADMIN, META), NotFoundException);

    assert.deepStrictEqual(world.recorded.rewardUpdates, []);
    assert.deepStrictEqual(world.recorded.events, []);
    // Inertness control: the same world DOES record an update for a reward that
    // exists, so the empty arrays above are a real zero.
    await world.service.issue('reward-1', ADMIN, META).catch((): void => undefined);
    assert.equal(world.recorded.steps.filter((step) => step === '$queryRaw').length, 2);
  });

  it('refuses a revoked reward and applies no effect', async () => {
    const world = makeWorld({
      rewards: [
        makeReward({ revokedAt: new Date(Date.now() - DAY_MS), revokeReason: 'duplicate' }),
        makeReward({ id: 'reward-2', type: ReferralRewardType.POINTS, amount: 50 }),
      ],
      user: { id: 'earner-1', currentSubscriptionId: null, telegramId: 4242n, points: 0 },
    });

    await assert.rejects(world.service.issue('reward-1', ADMIN, META), BadRequestException);

    assert.deepStrictEqual(world.recorded.rewardUpdates, [], 'a revoked reward must not be marked issued');
    assert.deepStrictEqual(world.recorded.userUpdates, [], 'no points for a revoked reward');
    assert.deepStrictEqual(world.recorded.events, []);

    // Inertness control on the SAME recorder: a pending reward does fill them.
    await world.service.issue('reward-2', ADMIN, META);
    assert.equal(world.recorded.rewardUpdates.length, 1);
    assert.equal(world.recorded.userUpdates.length, 1);
    assert.equal(world.recorded.events.length, 1);
  });
});

// ── EXTRA_DAYS ───────────────────────────────────────────────────────────────

describe('AdminRewardsService.issue — EXTRA_DAYS', () => {
  it('extends the newest ACTIVE finite subscription when currentSubscriptionId is null', async () => {
    // THE regression from the deleted copy: it looked at `currentSubscriptionId`
    // and nothing else, so this user — whose pointer is null but who plainly has
    // a live subscription — was granted nothing.
    const now = Date.now();
    const winner = makeSubscription({ id: 'sub-far', expiresAt: new Date(now + 40 * DAY_MS) });
    const world = makeWorld({
      rewards: [makeReward({ amount: 7 })],
      user: { id: 'earner-1', currentSubscriptionId: null, telegramId: 4242n, points: 0 },
      subscriptions: [
        makeSubscription({ id: 'sub-near', expiresAt: new Date(now + 10 * DAY_MS) }),
        winner,
        // Neither of these is eligible, and both would win the ordering if the
        // eligibility filter were dropped.
        makeSubscription({
          id: 'sub-disabled',
          status: SubscriptionStatus.DISABLED,
          expiresAt: new Date(now + 90 * DAY_MS),
        }),
        makeSubscription({ id: 'sub-perpetual', expiresAt: null }),
      ],
    });

    const result = await world.service.issue('reward-1', ADMIN, META);

    const update = soleSubscriptionUpdate(world.recorded);
    assert.deepStrictEqual(update.where, { id: 'sub-far' });
    assert.deepStrictEqual(Object.keys(update.data), ['expiresAt']);
    assert.equal(
      update.data.expiresAt.getTime(),
      (winner.expiresAt as Date).getTime() + 7 * DAY_MS,
      'seven days added to the resolved subscription’s own expiry',
    );
    assert.equal(result.isIssued, true);
  });

  it('asks Prisma for the fallback with the eligibility filter and the ordering', async () => {
    const world = makeWorld({
      rewards: [makeReward()],
      user: { id: 'earner-1', currentSubscriptionId: null, telegramId: 4242n, points: 0 },
      subscriptions: [makeSubscription()],
    });

    await world.service.issue('reward-1', ADMIN, META);

    assert.deepStrictEqual(world.recorded.subscriptionFindFirstArgs, [
      {
        where: {
          userId: 'earner-1',
          status: SubscriptionStatus.ACTIVE,
          expiresAt: { not: null },
        },
        select: { id: true },
        orderBy: [{ expiresAt: 'desc' }, { id: 'desc' }],
      },
    ]);
  });

  it('prefers currentSubscriptionId over the fallback when it is eligible', async () => {
    const now = Date.now();
    const pointed = makeSubscription({ id: 'sub-current', expiresAt: new Date(now + 5 * DAY_MS) });
    const world = makeWorld({
      rewards: [makeReward({ amount: 3 })],
      user: { id: 'earner-1', currentSubscriptionId: 'sub-current', telegramId: 4242n, points: 0 },
      subscriptions: [pointed, makeSubscription({ id: 'sub-later', expiresAt: new Date(now + 60 * DAY_MS) })],
    });

    await world.service.issue('reward-1', ADMIN, META);

    const update = soleSubscriptionUpdate(world.recorded);
    assert.deepStrictEqual(update.where, { id: 'sub-current' });
    assert.equal(update.data.expiresAt.getTime(), (pointed.expiresAt as Date).getTime() + 3 * DAY_MS);
  });

  it('ignores a currentSubscriptionId that belongs to someone else', async () => {
    // The pointer is validated after the lock — owner, status and a finite end
    // date — so a stale or cross-user pointer falls through to the fallback
    // instead of extending a stranger's subscription.
    const now = Date.now();
    const mine = makeSubscription({ id: 'sub-mine', expiresAt: new Date(now + 20 * DAY_MS) });
    const world = makeWorld({
      rewards: [makeReward({ amount: 1 })],
      user: { id: 'earner-1', currentSubscriptionId: 'sub-theirs', telegramId: 4242n, points: 0 },
      subscriptions: [
        makeSubscription({ id: 'sub-theirs', userId: 'someone-else', expiresAt: new Date(now + 99 * DAY_MS) }),
        mine,
      ],
    });

    await world.service.issue('reward-1', ADMIN, META);

    const update = soleSubscriptionUpdate(world.recorded);
    assert.deepStrictEqual(update.where, { id: 'sub-mine' });
  });

  it('locks the subscription row before reading it', async () => {
    const world = makeWorld({
      rewards: [makeReward()],
      user: { id: 'earner-1', currentSubscriptionId: null, telegramId: 4242n, points: 0 },
      subscriptions: [makeSubscription({ id: 'sub-only' })],
    });

    await world.service.issue('reward-1', ADMIN, META);

    assert.equal(world.recorded.locks.length, 2, 'the reward lock and the subscription lock');
    assert.match(world.recorded.locks[1].sql, /subscriptions/);
    assert.match(world.recorded.locks[1].sql, /FOR UPDATE/);
    assert.deepStrictEqual(world.recorded.locks[1].values, ['sub-only']);
    const lockIndex = world.recorded.steps.lastIndexOf('$queryRaw');
    const readIndex = world.recorded.steps.indexOf('subscription.findUnique');
    assert.ok(lockIndex < readIndex, 'the subscription must be locked before it is read');
  });

  it('extends from now, not from a lapsed expiry, when the ACTIVE row is already past due', async () => {
    // `Math.max(expiresAt, Date.now())`. Extending from a past date would hand
    // the customer days that are already spent.
    const world = makeWorld({
      rewards: [makeReward({ amount: 10 })],
      user: { id: 'earner-1', currentSubscriptionId: null, telegramId: 4242n, points: 0 },
      subscriptions: [
        makeSubscription({ id: 'sub-lapsed', expiresAt: new Date(Date.now() - 5 * DAY_MS) }),
      ],
    });

    const before = Date.now();
    await world.service.issue('reward-1', ADMIN, META);
    const after = Date.now();

    const written = soleSubscriptionUpdate(world.recorded).data.expiresAt.getTime();
    assert.ok(
      written >= before + 10 * DAY_MS && written <= after + 10 * DAY_MS,
      `expected ten days from now, got ${new Date(written).toISOString()}`,
    );
  });

  it('throws BadRequestException and does NOT mark the reward issued with no eligible subscription', async () => {
    // The deleted copy's worst behaviour: it marked the reward ISSUED and
    // granted nothing, so the row claimed the customer had been paid. Both
    // halves are asserted — the throw, and the absence of the write.
    const world = makeWorld({
      rewards: [makeReward()],
      user: { id: 'earner-1', currentSubscriptionId: null, telegramId: 4242n, points: 0 },
      subscriptions: [
        makeSubscription({ id: 'sub-expired', status: SubscriptionStatus.EXPIRED }),
        makeSubscription({ id: 'sub-perpetual', expiresAt: null }),
      ],
    });

    await assert.rejects(world.service.issue('reward-1', ADMIN, META), BadRequestException);

    assert.deepStrictEqual(world.recorded.rewardUpdates, [], 'reward must stay unissued');
    assert.deepStrictEqual(world.recorded.subscriptionUpdates, []);
    assert.deepStrictEqual(world.recorded.syncJobCreates, []);
    assert.deepStrictEqual(world.recorded.enqueued, []);
    assert.deepStrictEqual(world.recorded.events, []);
    assert.equal(world.rewards.get('reward-1')?.isIssued, false);
    // The world really ran: the reward was locked and the fallback was queried.
    assert.equal(world.recorded.locks.length, 1);
    assert.equal(world.recorded.subscriptionFindFirstArgs.length, 1);

    // Inertness control on the SAME recorder — give the user an eligible
    // subscription and every array above fills.
    world.subscriptions.push(makeSubscription({ id: 'sub-good' }));
    const issued = await world.service.issue('reward-1', ADMIN, META);
    assert.equal(issued.isIssued, true);
    assert.equal(world.recorded.rewardUpdates.length, 1);
    assert.equal(world.recorded.subscriptionUpdates.length, 1);
    assert.equal(world.recorded.syncJobCreates.length, 1);
    assert.equal(world.recorded.enqueued.length, 1);
    assert.equal(world.recorded.events.length, 1);
  });

  it('creates an UPDATE ProfileSyncJob for a linked profile and enqueues THAT job id', async () => {
    // Without the job the extra days live in the local database only and never
    // reach the customer's real VPN profile.
    const world = makeWorld({
      rewards: [makeReward({ amount: 14 })],
      user: { id: 'earner-1', currentSubscriptionId: null, telegramId: 4242n, points: 0 },
      subscriptions: [makeSubscription({ id: 'sub-linked', remnawaveId: 'rw-99' })],
      syncJobIds: ['sync-job-abc'],
    });

    await world.service.issue('reward-1', ADMIN, META);

    assert.deepStrictEqual(world.recorded.syncJobCreates, [
      {
        data: {
          subscriptionId: 'sub-linked',
          action: SyncAction.UPDATE,
          status: SyncJobStatus.PENDING,
          payload: {
            source: 'REFERRAL_EXTRA_DAYS_REWARD',
            userId: 'earner-1',
            days: 14,
          },
        },
      },
    ]);
    assert.deepStrictEqual(
      world.recorded.enqueued,
      ['sync-job-abc'],
      'the queue must be handed the id of the job that was just created',
    );
  });

  it('creates a CREATE ProfileSyncJob when the subscription has no remnawaveId yet', async () => {
    // This is also the select guard: `remnawaveId` is what decides CREATE vs
    // UPDATE, and the fake answers only the columns the service selected. Drop
    // it from the select and this reads `undefined === null` → false → UPDATE.
    const world = makeWorld({
      rewards: [makeReward({ amount: 2 })],
      user: { id: 'earner-1', currentSubscriptionId: null, telegramId: 4242n, points: 0 },
      subscriptions: [makeSubscription({ id: 'sub-unlinked', remnawaveId: null })],
    });

    await world.service.issue('reward-1', ADMIN, META);

    assert.equal(world.recorded.syncJobCreates.length, 1);
    const created = world.recorded.syncJobCreates[0] as { data: { action: SyncAction } };
    assert.equal(created.data.action, SyncAction.CREATE);
  });

  it('returns the issued reward when the enqueue fails, and warns instead of throwing', async () => {
    // The PENDING row is already committed and the sweep re-drives it, so a
    // dead Redis must not roll the grant back or surface as a 500.
    const world = makeWorld({
      rewards: [makeReward({ amount: 5 })],
      user: { id: 'earner-1', currentSubscriptionId: null, telegramId: 4242n, points: 0 },
      subscriptions: [makeSubscription({ id: 'sub-only' })],
      syncJobIds: ['sync-job-orphan'],
      enqueueError: new Error('redis is down'),
    });

    const result = await world.service.issue('reward-1', ADMIN, META);

    assert.equal(result.isIssued, true, 'the reward is issued regardless of the queue');
    assert.equal(result.issuedBy, ADMIN);
    assert.deepStrictEqual(world.recorded.enqueued, ['sync-job-orphan']);
    assert.equal(world.recorded.syncJobCreates.length, 1, 'the PENDING row the sweep will find');
    assert.equal(world.recorded.warnings.length, 1);
    assert.match(world.recorded.warnings[0], /redis is down/);
    assert.match(world.recorded.warnings[0], /sweep/);
  });
});

// ── POINTS ───────────────────────────────────────────────────────────────────

describe('AdminRewardsService.issue — POINTS', () => {
  it('increments User.points by the reward amount and creates no sync job', async () => {
    const world = makeWorld({
      rewards: [
        makeReward({ id: 'reward-points', type: ReferralRewardType.POINTS, amount: 250 }),
        makeReward({ id: 'reward-days', amount: 1 }),
      ],
      user: { id: 'earner-1', currentSubscriptionId: null, telegramId: 4242n, points: 10 },
      subscriptions: [makeSubscription({ id: 'sub-only' })],
    });

    await world.service.issue('reward-points', ADMIN, META);

    assert.deepStrictEqual(world.recorded.userUpdates, [
      { where: { id: 'earner-1' }, data: { points: { increment: 250 } } },
    ]);
    assert.deepStrictEqual(world.recorded.subscriptionUpdates, [], 'POINTS touches no subscription');
    // The credit went through the wallet: one ledger row keyed on the reward,
    // carrying the balance the fixture holds after the write (10 + 250).
    assert.deepStrictEqual(
      (world.recorded.ledgerCreates as Array<{ data: Record<string, unknown> }>).map((c) => [
        c.data['userId'], c.data['delta'], c.data['balanceAfter'], c.data['source'], c.data['referenceKey'],
      ]),
      [['earner-1', 250, 260, 'REFERRAL_REWARD', 'reward-points']],
    );
    assert.deepStrictEqual(world.recorded.syncJobCreates, [], 'POINTS needs no panel sync');
    assert.deepStrictEqual(world.recorded.enqueued, []);

    // Inertness control on the SAME recorder: the EXTRA_DAYS reward in this
    // world does produce a job and an enqueue, so the two zeros are real.
    await world.service.issue('reward-days', ADMIN, META);
    assert.equal(world.recorded.syncJobCreates.length, 1);
    assert.equal(world.recorded.enqueued.length, 1);
  });

  it('branches on every ReferralRewardType the enum currently has', () => {
    // WHAT THIS STILL GUARDS, now that `applyRewardEffect` ends in
    // `refuseUnhandledRewardType(reward.type)` instead of a bare
    // `return { syncJobId: null }`.
    //
    // It is no longer the payout lie. That one is now impossible twice over:
    // the `never` parameter makes a new enum member a COMPILE error at that
    // call (`tsc -p tsconfig.json`, which does compile `src/`), and if a value
    // gets there anyway the guard throws — see «refuses a reward type it has no
    // branch for» below, which exercises the runtime half.
    //
    // What survives is the DECISION. A member added to `ReferralRewardType`
    // with a branch bolted on to make the build green is a member whose payout
    // semantics nobody argued about, and the two members below are the ones the
    // POINTS/EXTRA_DAYS assertions in this file describe. So this fails on enum
    // growth and says where to look: the branch list, the tests that pin what
    // each branch grants, and the refusal that catches the rest. Without it the
    // compile error is fixable by adding an empty case that returns
    // `{ syncJobId: null }` — green build, green suite, nothing granted.
    assert.deepStrictEqual(
      Object.keys(ReferralRewardType).sort(),
      ['EXTRA_DAYS', 'POINTS'],
      'ReferralRewardType gained a member: give it a branch in applyRewardEffect ' +
        '(admin-rewards.service.ts), decide what issuing it GRANTS, and pin that here — ' +
        'the never-typed refusal will otherwise leave those rewards permanently unissuable',
    );
  });

  it('refuses a reward type it has no branch for, and marks nothing issued', async () => {
    // The runtime half of the guard, reached the way it can actually be reached
    // in production: not by a developer widening the enum (the compiler stops
    // that one), but by a ROW whose `type` column holds something this build's
    // enum does not — an older or newer deployment, a migration in flight, a
    // hand-written insert. `reward.type` is read out of that column, so the
    // compiled enum is only a belief about it.
    //
    // Before the guard existed this was the deleted copy's worst failure,
    // reproduced exactly: `applyRewardEffect` fell through to
    // `return { syncJobId: null }`, `issue()` marked the row ISSUED on it, and
    // the reward claimed the customer had been paid while nothing was granted.
    const world = makeWorld({
      rewards: [
        makeReward({
          id: 'reward-alien',
          // Deliberately NOT a `ReferralRewardType` member — that is the point.
          type: 'STORE_CREDIT' as ReferralRewardType,
          amount: 500,
        }),
        makeReward({ id: 'reward-points', type: ReferralRewardType.POINTS, amount: 500 }),
      ],
      user: { id: 'earner-1', currentSubscriptionId: null, telegramId: 4242n, points: 0 },
      subscriptions: [makeSubscription({ id: 'sub-only' })],
    });

    await assert.rejects(
      world.service.issue('reward-alien', ADMIN, META),
      (error: unknown) =>
        error instanceof BadRequestException && /STORE_CREDIT/.test((error as Error).message),
      'the refusal must name the type it could not grant',
    );

    assert.deepStrictEqual(world.recorded.rewardUpdates, [], 'the reward must stay unissued');
    assert.equal(world.rewards.get('reward-alien')?.isIssued, false);
    assert.deepStrictEqual(world.recorded.userUpdates, [], 'no points granted');
    assert.deepStrictEqual(world.recorded.subscriptionUpdates, [], 'no days granted');
    assert.deepStrictEqual(world.recorded.syncJobCreates, []);
    assert.deepStrictEqual(world.recorded.enqueued, []);
    assert.deepStrictEqual(world.recorded.auditCreates, [], 'nothing to audit — nothing happened');
    assert.deepStrictEqual(world.recorded.events, []);
    // The world really ran: the reward was locked and read before the refusal.
    assert.equal(world.recorded.locks.length, 1);

    // Inertness control on the SAME recorder: a reward this service DOES have a
    // branch for fills every array above, so the zeros are real zeros.
    await world.service.issue('reward-points', ADMIN, META);
    assert.equal(world.recorded.rewardUpdates.length, 1);
    assert.equal(world.recorded.userUpdates.length, 1);
    assert.equal(world.recorded.auditCreates.length, 1);
    assert.equal(world.recorded.events.length, 1);
  });
});

// ── The already-issued short circuit ─────────────────────────────────────────

describe('AdminRewardsService.issue — already issued', () => {
  it('applies no effect, writes nothing and returns the reward unchanged', async () => {
    const issuedAt = new Date(Date.now() - 2 * DAY_MS);
    const world = makeWorld({
      rewards: [
        makeReward({ isIssued: true, issuedAt, issuedBy: 'admin-earlier' }),
        makeReward({ id: 'reward-pending', type: ReferralRewardType.POINTS, amount: 5 }),
      ],
      user: { id: 'earner-1', currentSubscriptionId: null, telegramId: 4242n, points: 0 },
      subscriptions: [makeSubscription()],
    });

    const result = await world.service.issue('reward-1', ADMIN, META);

    assert.equal(result.isIssued, true);
    assert.equal(result.issuedBy, 'admin-earlier', 'the original actor is not overwritten');
    assert.equal(result.issuedAt, issuedAt.toISOString());
    assert.deepStrictEqual(world.recorded.rewardUpdates, [], 'no second write');
    assert.deepStrictEqual(world.recorded.subscriptionUpdates, [], 'no second grant');
    assert.deepStrictEqual(world.recorded.userUpdates, []);
    assert.deepStrictEqual(world.recorded.syncJobCreates, []);
    assert.deepStrictEqual(world.recorded.enqueued, []);

    // Inertness control on the SAME recorder.
    await world.service.issue('reward-pending', ADMIN, META);
    assert.equal(world.recorded.rewardUpdates.length, 1);
    assert.equal(world.recorded.userUpdates.length, 1);
  });
});

// ── The operator trail ───────────────────────────────────────────────────────

describe('AdminRewardsService.issue — the operator trail', () => {
  it('leaves a durable trail naming the acting admin', async () => {
    // The DOMAIN half of the trail: `ReferralReward.issuedBy` + `issuedAt`,
    // written in the same transaction as the grant, plus the post-commit
    // system event below. The AUDIT half — the `referral.reward.issued` row on
    // `admin_audit_log`, which is where an operator actually looks — has its
    // own describe block further down. Both are asserted; neither replaces the
    // other, because they answer different questions ("is this reward paid,
    // and by whom" vs "what did operators do today").
    const world = makeWorld({
      rewards: [makeReward({ type: ReferralRewardType.POINTS, amount: 40 })],
      user: { id: 'earner-1', currentSubscriptionId: null, telegramId: 4242n, points: 0 },
    });

    const before = Date.now();
    const result = await world.service.issue('reward-1', ADMIN, META);
    const after = Date.now();

    assert.equal(world.recorded.rewardUpdates.length, 1);
    const update = world.recorded.rewardUpdates[0] as {
      where: { id: string };
      data: { isIssued: boolean; issuedAt: Date; issuedBy: string | null };
    };
    assert.deepStrictEqual(update.where, { id: 'reward-1' });
    assert.equal(update.data.isIssued, true);
    assert.equal(update.data.issuedBy, ADMIN);
    assert.ok(update.data.issuedAt instanceof Date);
    const stamped = update.data.issuedAt.getTime();
    assert.ok(stamped >= before && stamped <= after, 'issuedAt is stamped at issue time');

    assert.equal(result.issuedBy, ADMIN);
    assert.equal(result.issuedAt, update.data.issuedAt.toISOString());
    // …and the event carries the same actor, so the feed can answer "who".
    const metadata = world.recorded.events[0][3] as Record<string, unknown>;
    assert.equal(metadata['issuedBy'], ADMIN);
  });

  it('records the actor it was given, on the domain row and on the audit row', async () => {
    // This replaces «records a null actor as null rather than inventing one».
    // `issue()` no longer ACCEPTS a null actor: it writes an
    // `admin_audit_log` row, `buildAdminAuditLogData` connects a real
    // `AdminUser`, and keeping the parameter nullable would put a branch on the
    // audit write for a case no caller can produce — the only route is behind
    // `AdminJwtAuthGuard` — which is how an audit write quietly stops
    // happening. `issue(id, null, META)` is now a compile error, so the
    // property worth keeping is the one that test was really guarding:
    // whatever actor the caller names is the actor recorded, everywhere,
    // with nothing invented or substituted in between.
    const other = 'admin-other-3';
    const world = makeWorld({
      rewards: [makeReward({ type: ReferralRewardType.POINTS, amount: 1 })],
      user: { id: 'earner-1', currentSubscriptionId: null, telegramId: 4242n, points: 0 },
    });

    const result = await world.service.issue('reward-1', other, META);

    const update = world.recorded.rewardUpdates[0] as { data: { issuedBy: string | null } };
    assert.equal(update.data.issuedBy, other);
    assert.equal(result.issuedBy, other);
    assert.deepStrictEqual(
      (world.recorded.auditCreates[0] as { data: { adminUser: unknown } }).data.adminUser,
      { connect: { id: other } },
      'the audit row names the same operator the reward row does',
    );
    assert.equal((world.recorded.events[0][3] as Record<string, unknown>)['issuedBy'], other);
  });

  it('names a web-only earner from the joined WebAccount', async () => {
    // `REWARD_USER_SELECT` exists so the rewards table can print the same label
    // as the other referral screens. A web sign-up has `name: ''`, no username
    // and no telegramId; drop `webAccount` from that select and this operator
    // sees the raw cuid instead of a login.
    const world = makeWorld({
      rewards: [
        makeReward({
          type: ReferralRewardType.POINTS,
          amount: 1,
          user: makeRewardUser({
            name: '',
            username: null,
            telegramId: null,
            email: null,
            webAccount: { login: 'web-earner', email: 'web@example.test' },
          }),
        }),
      ],
      user: { id: 'earner-1', currentSubscriptionId: null, telegramId: null, points: 0 },
    });

    const result = await world.service.issue('reward-1', ADMIN, META);

    assert.equal(result.user.displayName, 'web-earner');
    assert.equal(result.user.name, null, 'an empty name is reported as absent, not as ""');
    assert.equal(result.userTelegramId, null);
  });
});

// ── The admin_audit_log row ──────────────────────────────────────────────────

/**
 * The audit surface, as opposed to the domain trail above and the operator feed
 * below. `ReferralReward.issuedBy` answers "is this reward paid, and by whom";
 * `admin_audit_log` answers "what did operators do", and until now it answered
 * that question with silence for the one admin act on this controller that pays
 * customers. Its money-moving neighbours — `partner.balance.adjusted`,
 * `referral.attached`, the refund path — all write one.
 */
describe('AdminRewardsService.issue — the referral.reward.issued audit row', () => {
  it('writes exactly one row, with the exact data handed to Prisma', async () => {
    const world = makeWorld({
      rewards: [makeReward({ type: ReferralRewardType.POINTS, amount: 40 })],
      user: { id: 'earner-1', currentSubscriptionId: null, telegramId: 4242n, points: 0 },
    });

    await world.service.issue('reward-1', ADMIN, META);

    // The whole `data`, not a spy count and not a field at a time: this is the
    // object Prisma is asked to insert, so a renamed action, a metadata key
    // dropped on the way through, or an ip landing in the user-agent column all
    // fail here rather than in production six months later.
    assert.deepStrictEqual(world.recorded.auditCreates, [
      {
        data: {
          // ONE action name for both controls. The origin lives in
          // `metadata.source` — see the bulk test below.
          action: 'referral.reward.issued',
          // Columns, not metadata: this is what `buildAdminAuditLogData` does
          // with the request, and what the audit screen filters on.
          ipAddress: META.remoteAddress,
          userAgent: META.userAgent,
          metadata: {
            requestId: META.requestId,
            source: 'single',
            rewardId: 'reward-1',
            referralId: 'referral-1',
            userId: 'earner-1',
            rewardType: ReferralRewardType.POINTS,
            amount: 40,
            syncJobId: null,
          },
          adminUser: { connect: { id: ADMIN } },
        },
      },
    ]);
  });

  it('carries the reward type, the amount and the sync job for an EXTRA_DAYS grant', async () => {
    // `syncJobId` is the link from the audit row to the job that pushes the new
    // expiry to Remnawave — the row says days were granted, this says which
    // job was supposed to deliver them.
    const world = makeWorld({
      rewards: [makeReward({ id: 'reward-days', amount: 21 })],
      user: { id: 'earner-1', currentSubscriptionId: null, telegramId: 4242n, points: 0 },
      subscriptions: [makeSubscription({ id: 'sub-only' })],
      syncJobIds: ['sync-job-audited'],
    });

    await world.service.issue('reward-days', ADMIN, META);

    assert.equal(world.recorded.auditCreates.length, 1);
    const { metadata } = (world.recorded.auditCreates[0] as {
      data: { metadata: Record<string, unknown> };
    }).data;
    assert.equal(metadata['rewardType'], ReferralRewardType.EXTRA_DAYS);
    assert.equal(metadata['amount'], 21);
    assert.equal(metadata['syncJobId'], 'sync-job-audited');
    assert.equal(metadata['rewardId'], 'reward-days');
  });

  it('writes the row INSIDE the transaction that grants, not after the commit', async () => {
    // This pins the PLACEMENT, and it is the mirror image of the event test
    // further down. The transaction callback runs to completion and only the
    // COMMIT fails: an audit write placed after `$transaction` resolves never
    // runs here, so a row recorded in this world can only have been written by
    // the callback itself — inside the transaction, where a rollback takes the
    // row and the grant away together.
    //
    // Outside it, the two can disagree: the grant commits, the process dies
    // before the second write, and money has moved with nothing naming who
    // moved it. That is the failure this placement exists to prevent, and the
    // opposite of the event's — which stays OUTSIDE precisely so it cannot
    // announce points a rollback took back.
    const world = makeWorld({
      rewards: [makeReward({ type: ReferralRewardType.POINTS, amount: 60 })],
      user: { id: 'earner-1', currentSubscriptionId: null, telegramId: 4242n, points: 0 },
      commitError: new Error('could not serialize access due to concurrent update'),
    });

    await assert.rejects(world.service.issue('reward-1', ADMIN, META), /concurrent update/);

    assert.equal(world.recorded.rewardUpdates.length, 1, 'the callback ran and wrote');
    assert.equal(
      world.recorded.auditCreates.length,
      1,
      'the audit row must be written by the transaction callback, not after the commit',
    );
    // …and after the grant it describes, not before it.
    const grantStep = world.recorded.steps.indexOf('referralReward.update');
    const auditStep = world.recorded.steps.indexOf('adminAuditLog.create');
    assert.ok(grantStep !== -1, 'the grant step is recorded');
    assert.ok(auditStep > grantStep, 'the audit row describes a grant that already happened');
    // The event still waits for the commit — the two placements are different
    // on purpose, and this world proves both at once.
    assert.deepStrictEqual(world.recorded.events, []);
  });

  it('writes no row when the grant fails', async () => {
    // An audit row for a payout that threw would say the customer was paid.
    const world = makeWorld({
      rewards: [makeReward({ amount: 7 })],
      user: { id: 'earner-1', currentSubscriptionId: null, telegramId: 4242n, points: 0 },
      subscriptions: [makeSubscription({ id: 'sub-perpetual', expiresAt: null })],
    });

    await assert.rejects(world.service.issue('reward-1', ADMIN, META), BadRequestException);

    assert.deepStrictEqual(world.recorded.auditCreates, []);
    assert.deepStrictEqual(world.recorded.rewardUpdates, []);

    // Inertness control on the SAME recorder: give the user an eligible
    // subscription and the row appears.
    world.subscriptions.push(makeSubscription({ id: 'sub-good' }));
    await world.service.issue('reward-1', ADMIN, META);
    assert.equal(world.recorded.auditCreates.length, 1);
  });

  it('writes no row for the already-issued short circuit', async () => {
    // A second click on an issued reward pays nobody; a row for it would
    // double-count the payout on the audit surface.
    const world = makeWorld({
      rewards: [
        makeReward({ id: 'reward-done', isIssued: true, issuedAt: new Date(), issuedBy: 'admin-earlier' }),
        makeReward({ id: 'reward-open', type: ReferralRewardType.POINTS, amount: 5 }),
      ],
      user: { id: 'earner-1', currentSubscriptionId: null, telegramId: 4242n, points: 0 },
    });

    await world.service.issue('reward-done', ADMIN, META);

    assert.deepStrictEqual(world.recorded.auditCreates, []);

    // Inertness control on the SAME recorder.
    await world.service.issue('reward-open', ADMIN, META);
    assert.equal(world.recorded.auditCreates.length, 1);
  });
});

// ── The REFERRAL_REWARD_ISSUED system event ──────────────────────────────────

describe('AdminRewardsService.issue — the REFERRAL_REWARD_ISSUED event', () => {
  it('emits exactly one registered event identifying the reward, the earner and the admin', async () => {
    const world = makeWorld({
      rewards: [makeReward({ type: ReferralRewardType.POINTS, amount: 120 })],
      user: { id: 'earner-1', currentSubscriptionId: null, telegramId: 4242n, points: 0 },
    });

    await world.service.issue('reward-1', ADMIN, META);

    assert.equal(world.recorded.events.length, 1, 'one issue, one card');
    const [type, category, message, metadata] = world.recorded.events[0];
    assert.equal(
      type,
      EVENT_TYPES.REFERRAL_REWARD_ISSUED,
      'emit the registered constant — a bare literal cannot be ticked in `selected` mode',
    );
    assert.equal(category, 'REFERRAL');
    assert.equal(typeof message, 'string');
    assert.deepStrictEqual(metadata, {
      rewardId: 'reward-1',
      referralId: 'referral-1',
      userId: 'earner-1',
      referrerId: 'earner-1',
      rewardType: ReferralRewardType.POINTS,
      rewardValue: 120,
      issuedBy: ADMIN,
      syncJobId: null,
    });
  });

  it('carries the keys the user-facing realtime projection matches on', async () => {
    // `USER_EVENT_WHITELIST['referral.reward_issued']` in
    // `user-realtime-event.interface.ts` reads `referrerId` to decide whose
    // socket the event belongs to and returns null when it is missing — so
    // dropping that one key silently stops telling the earner anything, while
    // the admin feed keeps looking healthy. `rewardType`/`rewardValue` are the
    // two fields it projects to the client.
    const world = makeWorld({
      rewards: [makeReward({ amount: 21 })],
      user: { id: 'earner-1', currentSubscriptionId: null, telegramId: 4242n, points: 0 },
      subscriptions: [makeSubscription({ id: 'sub-only' })],
      syncJobIds: ['sync-job-xyz'],
    });

    await world.service.issue('reward-1', ADMIN, META);

    const metadata = world.recorded.events[0][3] as Record<string, unknown>;
    assert.equal(metadata['referrerId'], 'earner-1', 'without this the earner is told nothing');
    assert.equal(metadata['rewardType'], ReferralRewardType.EXTRA_DAYS);
    assert.equal(metadata['rewardValue'], 21);
    assert.equal(metadata['syncJobId'], 'sync-job-xyz');
  });

  it('does not fire for the already-issued short circuit', async () => {
    const world = makeWorld({
      rewards: [
        makeReward({ id: 'reward-done', isIssued: true, issuedAt: new Date(), issuedBy: 'admin-earlier' }),
        makeReward({ id: 'reward-open', type: ReferralRewardType.POINTS, amount: 5 }),
      ],
      user: { id: 'earner-1', currentSubscriptionId: null, telegramId: 4242n, points: 0 },
    });

    await world.service.issue('reward-done', ADMIN, META);

    assert.deepStrictEqual(world.recorded.events, [], 'a no-op must not appear in the feed');

    // Inertness control on the SAME recorder.
    await world.service.issue('reward-open', ADMIN, META);
    assert.equal(world.recorded.events.length, 1);
  });

  it('does not fire when the commit fails after the callback ran', async () => {
    // This pins the PLACEMENT, not merely that an emit happens. The transaction
    // callback runs to completion here and only the commit fails; an emit
    // inside the callback would already have fired. The reward update below is
    // the proof that the callback did run — so the empty feed is a real zero.
    const world = makeWorld({
      rewards: [makeReward({ type: ReferralRewardType.POINTS, amount: 60 })],
      user: { id: 'earner-1', currentSubscriptionId: null, telegramId: 4242n, points: 0 },
      commitError: new Error('could not serialize access due to concurrent update'),
    });

    await assert.rejects(world.service.issue('reward-1', ADMIN, META), /concurrent update/);

    assert.equal(world.recorded.rewardUpdates.length, 1, 'the callback ran and wrote');
    assert.equal(world.recorded.userUpdates.length, 1, 'the callback ran and granted');
    assert.deepStrictEqual(
      world.recorded.events,
      [],
      'an event emitted inside the transaction would announce points a rollback took back',
    );
    assert.deepStrictEqual(world.recorded.enqueued, []);
  });

  it('still fires when the sync enqueue fails', async () => {
    const world = makeWorld({
      rewards: [makeReward({ amount: 4 })],
      user: { id: 'earner-1', currentSubscriptionId: null, telegramId: 4242n, points: 0 },
      subscriptions: [makeSubscription({ id: 'sub-only' })],
      enqueueError: new Error('redis is down'),
    });

    await world.service.issue('reward-1', ADMIN, META);

    assert.equal(
      world.recorded.events.length,
      1,
      'the grant committed; a dead queue does not un-issue it',
    );
  });
});

// ── revoke ───────────────────────────────────────────────────────────────────

describe('AdminRewardsService.revoke', () => {
  it('stamps revokedAt and the reason on a pending reward', async () => {
    const world = makeWorld({ rewards: [makeReward()] });

    const before = Date.now();
    const result = await world.service.revoke('reward-1', 'granted in error', ADMIN);
    const after = Date.now();

    assert.equal(world.recorded.rewardUpdates.length, 1);
    const update = world.recorded.rewardUpdates[0] as {
      where: { id: string };
      data: { revokedAt: Date; revokeReason: string | null };
    };
    assert.deepStrictEqual(update.where, { id: 'reward-1' });
    assert.equal(update.data.revokeReason, 'granted in error');
    const stamped = update.data.revokedAt.getTime();
    assert.ok(stamped >= before && stamped <= after);
    assert.equal(result.id, 'reward-1');
    assert.deepStrictEqual(world.recorded.locks.length, 1, 'revoke takes the same row lock');
  });

  it('refuses to revoke an already-issued reward', async () => {
    const world = makeWorld({
      rewards: [makeReward({ isIssued: true, issuedAt: new Date(), issuedBy: ADMIN })],
    });

    await assert.rejects(world.service.revoke('reward-1', null, ADMIN), BadRequestException);
    assert.deepStrictEqual(world.recorded.rewardUpdates, [], 'balance reversal is the refund flow');
  });

  it('refuses a second revoke', async () => {
    const world = makeWorld({
      rewards: [makeReward({ revokedAt: new Date(Date.now() - DAY_MS) })],
    });

    await assert.rejects(world.service.revoke('reward-1', null, ADMIN), BadRequestException);
    assert.deepStrictEqual(world.recorded.rewardUpdates, []);
  });
});

// ── bulkIssue ────────────────────────────────────────────────────────────────

describe('AdminRewardsService.bulkIssue', () => {
  it('preloads the eligibility snapshot for the unique ids in ONE query', async () => {
    const world = makeWorld({
      rewards: [makeReward({ id: 'r-1', type: ReferralRewardType.POINTS, amount: 1 })],
      user: { id: 'earner-1', currentSubscriptionId: null, telegramId: 4242n, points: 0 },
    });

    await world.service.bulkIssue(['r-1', 'r-1'], ADMIN, META);

    assert.deepStrictEqual(world.recorded.rewardFindManyArgs, [
      {
        where: { id: { in: ['r-1'] } },
        select: { id: true, isIssued: true, revokedAt: true },
      },
    ]);
  });

  it('issues the pending ones, skips issued and revoked, and reports NOT_FOUND', async () => {
    const world = makeWorld({
      rewards: [
        makeReward({ id: 'r-open', type: ReferralRewardType.POINTS, amount: 30 }),
        makeReward({ id: 'r-done', type: ReferralRewardType.POINTS, amount: 5, isIssued: true, issuedAt: new Date() }),
        makeReward({ id: 'r-revoked', type: ReferralRewardType.POINTS, amount: 5, revokedAt: new Date() }),
      ],
      user: { id: 'earner-1', currentSubscriptionId: null, telegramId: 4242n, points: 0 },
    });

    const result = await world.service.bulkIssue(
      ['r-open', 'r-done', 'r-revoked', 'r-ghost'],
      ADMIN,
      META,
    );

    assert.deepStrictEqual(result, {
      issued: 1,
      skipped: 2,
      failed: 1,
      errors: [{ id: 'r-ghost', error: 'NOT_FOUND' }],
    });
    // Counts alone would pass against a service that issued nothing, so assert
    // the write: exactly one reward moved and it was the pending one.
    assert.deepStrictEqual(world.recorded.userUpdates, [
      { where: { id: 'earner-1' }, data: { points: { increment: 30 } } },
    ]);
    assert.equal(world.recorded.rewardUpdates.length, 1);
    assert.deepStrictEqual(
      (world.recorded.rewardUpdates[0] as { where: { id: string } }).where,
      { id: 'r-open' },
    );
    assert.equal(world.recorded.events.length, 1, 'one event for the one reward actually issued');
  });

  it('does not issue the same id twice within one request', async () => {
    const world = makeWorld({
      rewards: [makeReward({ id: 'r-1', type: ReferralRewardType.POINTS, amount: 15 })],
      user: { id: 'earner-1', currentSubscriptionId: null, telegramId: 4242n, points: 0 },
    });

    const result = await world.service.bulkIssue(['r-1', 'r-1', 'r-1'], ADMIN, META);

    assert.deepStrictEqual(result, { issued: 1, skipped: 2, failed: 0, errors: [] });
    assert.equal(world.recorded.userUpdates.length, 1, 'points must not be granted three times');
  });

  it('counts an ineligible EXTRA_DAYS reward as failed and leaves it unissued', async () => {
    const world = makeWorld({
      rewards: [makeReward({ id: 'r-days' })],
      user: { id: 'earner-1', currentSubscriptionId: null, telegramId: 4242n, points: 0 },
      subscriptions: [],
    });

    const result = await world.service.bulkIssue(['r-days'], ADMIN, META);

    assert.equal(result.issued, 0);
    assert.equal(result.failed, 1);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].id, 'r-days');
    assert.deepStrictEqual(world.recorded.rewardUpdates, []);
    assert.equal(world.rewards.get('r-days')?.isIssued, false);
  });

  it('writes ONE audit row per reward paid, tagged `bulk`, and none for the one that failed', async () => {
    // GRANULARITY. `AdminAuditLog` has no entity columns, so "who issued THIS
    // reward" is `metadata->>'rewardId' = $1` — a query that has to find the
    // bulk issuance too, or it answers "nobody" about a reward a bulk click
    // paid out. A single row naming the requested ids would also CLAIM payouts
    // that did not happen: this batch is not atomic, and `r-days` below fails.
    // Per reward, the row exists exactly when the money moved, because it is
    // written by the very transaction that moved it.
    const world = makeWorld({
      rewards: [
        makeReward({ id: 'r-a', referralId: 'referral-a', type: ReferralRewardType.POINTS, amount: 10 }),
        makeReward({ id: 'r-b', referralId: 'referral-b', type: ReferralRewardType.POINTS, amount: 20 }),
        // EXTRA_DAYS with no eligible subscription — refused mid-batch.
        makeReward({ id: 'r-days', amount: 3 }),
        makeReward({ id: 'r-done', type: ReferralRewardType.POINTS, amount: 99, isIssued: true, issuedAt: new Date() }),
      ],
      user: { id: 'earner-1', currentSubscriptionId: null, telegramId: 4242n, points: 0 },
      subscriptions: [],
    });

    const result = await world.service.bulkIssue(['r-a', 'r-days', 'r-b', 'r-done'], ADMIN, META);

    assert.equal(result.issued, 2);
    assert.equal(result.failed, 1);
    assert.equal(result.skipped, 1);

    const rows = world.recorded.auditCreates.map(
      (row) => (row as { data: { metadata: Record<string, unknown> } }).data.metadata,
    );
    assert.equal(world.recorded.auditCreates.length, 2, 'one row per reward that actually moved');
    assert.deepStrictEqual(
      rows.map((metadata) => metadata['rewardId']),
      ['r-a', 'r-b'],
      'the refused reward and the already-issued one contribute no row',
    );
    // Each row carries ITS OWN reward, not the batch's first or last: a shared
    // payload built once outside the loop would repeat one id twice here.
    assert.deepStrictEqual(rows.map((metadata) => metadata['referralId']), ['referral-a', 'referral-b']);
    assert.deepStrictEqual(rows.map((metadata) => metadata['amount']), [10, 20]);
    // The surface is in `metadata.source`, not in a second action name.
    assert.deepStrictEqual(
      world.recorded.auditCreates.map((row) => (row as { data: { action: string } }).data.action),
      ['referral.reward.issued', 'referral.reward.issued'],
    );
    assert.deepStrictEqual(rows.map((metadata) => metadata['source']), ['bulk', 'bulk']);
    assert.deepStrictEqual(rows.map((metadata) => metadata['requestId']), [META.requestId, META.requestId]);
  });
});

// ── list ─────────────────────────────────────────────────────────────────────

describe('AdminRewardsService.list', () => {
  it('reads `issued=false` as false, never as true', async () => {
    // The query-string boolean trap this repository has been bitten by: a
    // `Boolean('false')` or a `!== undefined` reading here flips the filter and
    // the "pending rewards" screen shows the issued ones instead.
    const world = makeWorld({
      rewards: [
        makeReward({ id: 'r-open' }),
        makeReward({ id: 'r-done', isIssued: true, issuedAt: new Date() }),
      ],
    });

    const result = await world.service.list({ issued: 'false' });

    assert.deepStrictEqual(world.recorded.rewardFindManyArgs, [
      {
        where: { revokedAt: null, isIssued: false },
        include: { user: { select: {
          id: true,
          username: true,
          name: true,
          telegramId: true,
          email: true,
          webAccount: { select: { login: true, email: true } },
          createdAt: true,
        } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 100,
        skip: 0,
      },
    ]);
    assert.deepStrictEqual(
      result.items.map((item) => item.id),
      ['r-open'],
    );
    assert.equal(result.total, 1);
  });

  it('reads `issued=true` as true', async () => {
    const world = makeWorld({
      rewards: [
        makeReward({ id: 'r-open' }),
        makeReward({ id: 'r-done', isIssued: true, issuedAt: new Date() }),
      ],
    });

    const result = await world.service.list({ issued: 'true' });

    assert.deepStrictEqual(
      result.items.map((item) => item.id),
      ['r-done'],
    );
  });

  it('hides revoked rewards even when no filter is given', async () => {
    const world = makeWorld({
      rewards: [
        makeReward({ id: 'r-open' }),
        makeReward({ id: 'r-revoked', revokedAt: new Date(Date.now() - DAY_MS) }),
      ],
    });

    const result = await world.service.list({});

    const where = (world.recorded.rewardFindManyArgs[0] as { where: Record<string, unknown> }).where;
    assert.deepStrictEqual(where, { revokedAt: null }, 'no `issued` key when none was asked for');
    assert.deepStrictEqual(
      result.items.map((item) => item.id),
      ['r-open'],
    );
    assert.deepStrictEqual(world.recorded.rewardCountArgs, [{ where: { revokedAt: null } }]);
  });
});

// ── grant ────────────────────────────────────────────────────────────────────

describe('AdminRewardsService.grant', () => {
  it('refuses a user who is on neither end of the referral edge', async () => {
    const world = makeWorld({
      referral: { id: 'referral-1', referrerId: 'earner-1', referredId: 'referred-1' },
    });

    await assert.rejects(
      world.service.grant(
        { referralId: 'referral-1', userId: 'stranger-9', type: ReferralRewardType.POINTS, amount: 10 },
        ADMIN,
      ),
      BadRequestException,
    );
    assert.deepStrictEqual(world.recorded.rewardCreates, []);
  });

  it('refuses an unknown referral edge before anything else', async () => {
    const world = makeWorld({ referral: null });

    await assert.rejects(
      world.service.grant(
        { referralId: 'referral-missing', userId: 'earner-1', type: ReferralRewardType.POINTS, amount: 10 },
        ADMIN,
      ),
      NotFoundException,
    );
    assert.deepStrictEqual(world.recorded.rewardCreates, []);
  });

  it('stamps the granting admin on a reward for a party to the edge', async () => {
    const world = makeWorld({
      referral: { id: 'referral-1', referrerId: 'earner-1', referredId: 'referred-1' },
    });

    await world.service.grant(
      { referralId: 'referral-1', userId: 'referred-1', type: ReferralRewardType.EXTRA_DAYS, amount: 3 },
      ADMIN,
    );

    assert.equal(world.recorded.rewardCreates.length, 1);
    assert.deepStrictEqual(
      (world.recorded.rewardCreates[0] as { data: Record<string, unknown> }).data,
      {
        referralId: 'referral-1',
        userId: 'referred-1',
        type: ReferralRewardType.EXTRA_DAYS,
        amount: 3,
        grantedBy: ADMIN,
      },
    );
    assert.deepStrictEqual(
      world.recorded.rewardUpdates,
      [],
      'granting stages a reward — it does not issue it',
    );
  });
});
