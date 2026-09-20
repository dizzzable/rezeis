import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Prisma } from '@prisma/client';

import { EVENT_TYPES } from '../src/common/services/system-events.service';
import { PaymentSubscriptionMutationService } from '../src/modules/payments/services/payment-subscription-mutation.service';
import {
  describeLatePlanMigrationRenewal,
  describeLatePlanMigrationRenewals,
  findLatePlanMigrationRenewal,
  LATE_PLAN_MIGRATION_RENEWAL_CODE,
  LATE_PLAN_MIGRATION_RENEWAL_MESSAGE,
  resolvePlanMigrationGuardCandidate,
  type LatePlanMigrationRenewal,
} from '../src/modules/payments/services/payment-renewal-plan-migration-guard.util';

/**
 * A RENEWAL FOR A PLAN THE SUBSCRIPTION WAS MOVED OFF (decision 10)
 * ═══════════════════════════════════════════════════════════════
 * Deleting a plan moves its subscriptions to other plans first. A renewal
 * checkout for the old plan created before that move and paid after it must
 * extend the subscription on the plan it is on NOW — without the old plan's
 * snapshot, limits or squads — keep every other effect of a renewal, and tell
 * the operator once per payment.
 *
 * Driven through the public `applyCompletedTransaction` over an in-memory
 * world. The transaction double answers the migration lookup by applying
 * exactly the predicates present in the statement it is handed, so dropping a
 * predicate from the SQL changes what it answers. What the predicates MEAN on
 * PostgreSQL is proven by `payment-plan-migration-guard-postgres.spec.ts`.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const GIB = 1024n * 1024n * 1024n;
const NOW = Date.now();
/**
 * The period every payment here buys. Deliberately NOT the 30 days the moved
 * snapshots hold, so a kept renewal that forgot to record it is visible.
 */
const PAID_DAYS = 90;

// ── Fixtures ───────────────────────────────────────────────────────────────

interface PlanRow {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly tag: string | null;
  readonly type: string;
  readonly icon: string | null;
  readonly availability: string;
  readonly trafficLimit: number | null;
  readonly deviceLimit: number;
  readonly trafficLimitStrategy: string;
  readonly internalSquads: string[];
  readonly externalSquad: string | null;
  readonly deletedAt: Date | null;
}

/** The plan being deleted. Soft-deleted, so its name carries the rename suffix. */
const OLD_PLAN: PlanRow = {
  id: 'plan-old',
  name: 'Старый (deleted plan-old)',
  description: null,
  tag: null,
  type: 'BOTH',
  icon: null,
  availability: 'ALL',
  trafficLimit: 50,
  deviceLimit: 2,
  trafficLimitStrategy: 'NO_RESET',
  internalSquads: ['squad-old'],
  externalSquad: 'ext-old',
  deletedAt: new Date(NOW - HOUR_MS / 2),
};

/** The plan the move put the subscription on. */
const CURRENT_PLAN: PlanRow = {
  id: 'plan-current',
  name: 'Новый',
  description: null,
  tag: null,
  type: 'BOTH',
  icon: null,
  availability: 'ALL',
  trafficLimit: 200,
  deviceLimit: 5,
  trafficLimitStrategy: 'NO_RESET',
  internalSquads: ['squad-current'],
  externalSquad: null,
  deletedAt: null,
};

interface SubscriptionRow {
  readonly id: string;
  readonly userId: string;
  readonly status: string;
  readonly isTrial: boolean;
  readonly expiresAt: Date | null;
  readonly remnawaveId: string | null;
  readonly planSnapshot: unknown;
  readonly trafficLimit: number | null;
  readonly deviceLimit: number;
  readonly internalSquads: string[];
  readonly externalSquad: string | null;
}

interface TransactionRow {
  readonly id: string;
  readonly paymentId: string;
  readonly userId: string;
  readonly subscriptionId: string | null;
  readonly status: string;
  readonly purchaseType: string;
  readonly channel: string;
  readonly gatewayType: string;
  readonly currency: string;
  readonly amount: Prisma.Decimal;
  readonly planSnapshot: Record<string, unknown>;
  readonly createdAt: Date;
  readonly fulfilledAt: Date | null;
}

interface MigrationItemRow {
  readonly runId: string;
  readonly subscriptionId: string;
  readonly fromPlanId: string;
  readonly toPlanId: string;
  readonly status: 'PENDING' | 'MOVED' | 'SKIPPED' | 'FAILED';
  readonly movedAt: Date | null;
}

interface ItemRow {
  readonly id: string;
  readonly transactionId: string;
  readonly subscriptionId: string;
  readonly planId: string;
  readonly planSnapshot: Record<string, unknown>;
  readonly durationDays: number;
  readonly amount: string;
  readonly currency: string;
  readonly addOnLines: unknown;
  readonly appliedAt: Date | null;
}

interface TermRow {
  readonly id: string;
  readonly subscriptionId: string;
  readonly generation: number;
  readonly status: 'ACTIVE' | 'SCHEDULED' | 'ENDED' | 'CANCELED';
  readonly planId: string | null;
  readonly startsAt: Date;
  readonly endsAt: Date | null;
}

interface GrantRow {
  readonly id: string;
  readonly percent: number;
  readonly allowedPlanIds: string[];
  readonly expiresAt: Date | null;
  readonly consumedAt: Date | null;
}

/**
 * The name a plan was sold and assigned under. The "(deleted …)" suffix is
 * written only when a later plan takes a deleted plan's name, so no snapshot
 * or draft written while the plan was on sale carries it.
 */
function shownName(plan: PlanRow): string {
  return plan.id === OLD_PLAN.id ? 'Старый' : plan.name;
}

/** The snapshot a subscription carries on `plan` — the move writes this shape. */
function snapshotOn(plan: PlanRow): Record<string, unknown> {
  return {
    id: plan.id,
    name: shownName(plan),
    description: plan.description,
    tag: plan.tag,
    type: plan.type,
    icon: plan.icon,
    trafficLimit: plan.trafficLimit,
    deviceLimit: plan.deviceLimit,
    trafficLimitStrategy: plan.trafficLimitStrategy,
    internalSquads: [...plan.internalSquads],
    externalSquad: plan.externalSquad,
    selectedDurationDays: 30,
  };
}

/** A subscription sitting on `plan` with the limits it inherited from it. */
function subscriptionOn(plan: PlanRow, overrides: Partial<SubscriptionRow> = {}): SubscriptionRow {
  return {
    id: 'sub-1',
    userId: 'user-1',
    status: 'ACTIVE',
    isTrial: false,
    expiresAt: new Date(NOW + 10 * DAY_MS),
    remnawaveId: 'rw-1',
    planSnapshot: snapshotOn(plan),
    trafficLimit: plan.trafficLimit,
    deviceLimit: plan.deviceLimit,
    internalSquads: [...plan.internalSquads],
    externalSquad: plan.externalSquad,
    ...overrides,
  };
}

/** A single renewal for the OLD plan, created two hours ago and paid now. */
function renewalForOldPlan(overrides: Partial<TransactionRow> = {}): TransactionRow {
  return {
    id: 'tx-1',
    paymentId: 'pay-1',
    userId: 'user-1',
    subscriptionId: 'sub-1',
    status: 'COMPLETED',
    purchaseType: 'RENEW',
    channel: 'WEB',
    gatewayType: 'PLATEGA',
    currency: 'RUB',
    amount: new Prisma.Decimal('199'),
    planSnapshot: { id: OLD_PLAN.id, selectedDurationDays: PAID_DAYS, availability: 'ALL' },
    createdAt: new Date(NOW - 2 * HOUR_MS),
    fulfilledAt: null,
    ...overrides,
  };
}

/** The item a migration run leaves for `subscriptionId`: moved an hour ago. */
function movedOffOldPlan(overrides: Partial<MigrationItemRow> = {}): MigrationItemRow {
  return {
    runId: 'run-1',
    subscriptionId: 'sub-1',
    fromPlanId: OLD_PLAN.id,
    toPlanId: CURRENT_PLAN.id,
    status: 'MOVED',
    movedAt: new Date(NOW - HOUR_MS),
    ...overrides,
  };
}

/** A strictly-verifiable combined renewal draft for one line. */
function renewalDraft(plan: PlanRow): Record<string, unknown> {
  return {
    snapshotVersion: 2,
    snapshotSource: 'RENEWAL_DRAFT',
    purchaseType: 'RENEW',
    availability: 'ALL',
    id: plan.id,
    name: shownName(plan),
    description: plan.description,
    tag: plan.tag,
    type: plan.type,
    icon: plan.icon,
    trafficLimit: plan.trafficLimit,
    deviceLimit: plan.deviceLimit,
    trafficLimitStrategy: plan.trafficLimitStrategy,
    internalSquads: [...plan.internalSquads],
    externalSquad: plan.externalSquad,
    selectedDurationDays: PAID_DAYS,
    gatewayType: 'PLATEGA',
    amount: '199',
    currency: 'RUB',
  };
}

// ── The world ──────────────────────────────────────────────────────────────

interface Emitted {
  readonly severity: 'INFO' | 'WARNING' | 'ERROR';
  readonly type: string;
  readonly message: string;
  readonly metadata: Record<string, unknown>;
}

interface Tables {
  subscriptions: Map<string, SubscriptionRow>;
  items: Map<string, ItemRow>;
  terms: TermRow[];
  syncJobs: Array<Record<string, unknown>>;
  subscriptionUpdates: Array<{ readonly id: string; readonly data: Record<string, unknown> }>;
  transactionUpdates: Array<{ readonly id: string; readonly data: Record<string, unknown> }>;
  termCreates: Array<Record<string, unknown>>;
  entitlementCreates: Array<Record<string, unknown>>;
}

interface RawQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

const STAGED = Symbol('staged');

/**
 * Answers the migration lookup with the predicates the statement actually
 * carries: each bound placeholder is found by the column it is compared with,
 * and a predicate that is not in the text filters nothing.
 */
function answerMigrationLookup(
  query: RawQuery,
  migrationItems: readonly MigrationItemRow[],
  transactions: ReadonlyMap<string, TransactionRow>,
): Array<{ readonly planMigrationRunId: string }> {
  const text = query.text.replace(/\s+/g, ' ');
  const bound = (pattern: RegExp): unknown => {
    const match = pattern.exec(text);
    return match === null ? undefined : query.values[Number(match[1]) - 1];
  };
  const subscriptionId = bound(/"subscription_id" = \$(\d+)/);
  const fromPlanId = bound(/"from_plan_id" = \$(\d+)/);
  const transactionId = bound(/t\."id" = \$(\d+)/);
  const onlyMoved = text.includes(`"status" = 'MOVED'`);
  const comparesMovedAt = /"moved_at" >= \(/.test(text);
  // The window subtracted from the payment's creation, as the statement writes it.
  const moveWindow = /\) - INTERVAL '(\d+) minutes'/.exec(text);
  const windowMs = moveWindow === null ? 0 : Number(moveWindow[1]) * MINUTE_MS;
  const paymentCreatedAt =
    transactionId === undefined ? undefined : transactions.get(String(transactionId))?.createdAt;
  return migrationItems
    .filter(
      (item) =>
        (subscriptionId === undefined || item.subscriptionId === subscriptionId) &&
        (fromPlanId === undefined || item.fromPlanId === fromPlanId) &&
        (!onlyMoved || item.status === 'MOVED') &&
        (!comparesMovedAt ||
          (item.movedAt !== null &&
            paymentCreatedAt !== undefined &&
            item.movedAt.getTime() >= paymentCreatedAt.getTime() - windowMs)),
    )
    .sort((left, right) => (right.movedAt?.getTime() ?? 0) - (left.movedAt?.getTime() ?? 0))
    .slice(0, 1)
    .map((item) => ({ planMigrationRunId: item.runId }));
}

function createWorld(seed: {
  readonly plans?: readonly PlanRow[];
  readonly subscriptions: readonly SubscriptionRow[];
  readonly transaction: TransactionRow;
  readonly items?: readonly ItemRow[];
  readonly migrationItems?: readonly MigrationItemRow[];
  readonly terms?: readonly TermRow[];
  readonly grants?: readonly GrantRow[];
  readonly purchaserBlocked?: boolean;
}) {
  const plans = new Map((seed.plans ?? [OLD_PLAN, CURRENT_PLAN]).map((plan) => [plan.id, plan]));
  const transactions = new Map([[seed.transaction.id, seed.transaction]]);
  let committed: Tables = {
    subscriptions: new Map(seed.subscriptions.map((row) => [row.id, structuredClone(row)])),
    items: new Map((seed.items ?? []).map((row) => [row.id, structuredClone(row)])),
    terms: (seed.terms ?? []).map((row) => structuredClone(row)),
    syncJobs: [],
    subscriptionUpdates: [],
    transactionUpdates: [],
    termCreates: [],
    entitlementCreates: [],
  };
  const events: Emitted[] = [];
  const statements: string[] = [];
  const consumedGrantIds: string[] = [];
  const grants = (seed.grants ?? []).map((grant) => ({ ...grant }));
  let pendingSyncJobFailures = 0;
  let sequence = 0;

  const stagedOf = (tx: unknown): Tables => (tx as { readonly [STAGED]: Tables })[STAGED];

  const txClient = (staged: Tables) => ({
    [STAGED]: staged,
    $queryRaw: async (query: RawQuery) => {
      const text = query.text.replace(/\s+/g, ' ').trim();
      statements.push(text);
      if (text.includes('"plan_migration_items"')) {
        return answerMigrationLookup(query, seed.migrationItems ?? [], transactions);
      }
      if (text.includes('FROM "subscriptions"') && /\bFOR UPDATE\b/.test(text)) {
        const row = staged.subscriptions.get(String(query.values[0]));
        return row === undefined ? [] : [{ id: row.id, status: row.status }];
      }
      throw new Error(`Unexpected raw statement: ${text}`);
    },
    subscription: {
      findUnique: async (args: { readonly where: { readonly id: string } }) => {
        const row = staged.subscriptions.get(args.where.id);
        return row === undefined ? null : structuredClone(row);
      },
      update: async (args: { readonly where: { readonly id: string }; readonly data: Record<string, unknown> }) => {
        const current = staged.subscriptions.get(args.where.id);
        assert.ok(current !== undefined, `update of a missing subscription ${args.where.id}`);
        const next = { ...current, ...structuredClone(args.data) } as SubscriptionRow;
        staged.subscriptions.set(args.where.id, next);
        staged.subscriptionUpdates.push({ id: args.where.id, data: structuredClone(args.data) });
        return structuredClone(next);
      },
    },
    // No projection row: none of these subscriptions holds an add-on.
    subscriptionEffectiveProjection: { findUnique: async () => null },
    subscriptionTerm: {
      findFirst: async (args: {
        readonly where: { readonly subscriptionId: string; readonly status: string | { readonly in: string[] } };
      }) => {
        const statuses =
          typeof args.where.status === 'string' ? [args.where.status] : args.where.status.in;
        const rows = staged.terms
          .filter((term) => term.subscriptionId === args.where.subscriptionId && statuses.includes(term.status))
          .sort((left, right) => right.generation - left.generation);
        return rows[0] ?? null;
      },
    },
    plan: {
      findUnique: async (args: { readonly where: { readonly id: string } }) => plans.get(args.where.id) ?? null,
    },
    profileSyncJob: {
      create: async (args: { readonly data: Record<string, unknown> }) => {
        if (pendingSyncJobFailures > 0) {
          pendingSyncJobFailures -= 1;
          throw new Error('forced sync job failure');
        }
        sequence += 1;
        const job = { id: `job-${sequence}`, ...structuredClone(args.data) };
        staged.syncJobs.push(job);
        return job;
      },
    },
    transaction: {
      update: async (args: { readonly where: { readonly id: string }; readonly data: Record<string, unknown> }) => {
        staged.transactionUpdates.push({ id: args.where.id, data: structuredClone(args.data) });
        return {};
      },
    },
    transactionItem: {
      updateMany: async (args: {
        readonly where: { readonly id: string; readonly appliedAt?: null };
        readonly data: Record<string, unknown>;
      }) => {
        const item = staged.items.get(args.where.id);
        if (item === undefined) return { count: 0 };
        if ('appliedAt' in args.where && item.appliedAt !== null) return { count: 0 };
        staged.items.set(args.where.id, { ...item, ...structuredClone(args.data) } as ItemRow);
        return { count: 1 };
      },
      findUnique: async (args: { readonly where: { readonly id: string } }) => {
        const item = staged.items.get(args.where.id);
        return item === undefined ? null : structuredClone(item);
      },
    },
  });

  const prismaService = {
    transactionItem: {
      findMany: async (args: { readonly where: { readonly transactionId: string } }) =>
        [...committed.items.values()]
          .filter((item) => item.transactionId === args.where.transactionId)
          .map((item) => structuredClone(item)),
    },
    plan: {
      findUnique: async (args: { readonly where: { readonly id: string } }) => plans.get(args.where.id) ?? null,
    },
    user: {
      // Asked for the block flag and, by the discount settlement, for the
      // legacy column. One answer serves both.
      findUnique: async () => ({ isBlocked: seed.purchaserBlocked === true, purchaseDiscount: 0 }),
      updateMany: async () => ({ count: 0 }),
    },
    userPendingDiscount: {
      findMany: async () => grants.filter((grant) => grant.consumedAt === null).map((grant) => ({ ...grant })),
      updateMany: async (args: { readonly where: { readonly id: string } }) => {
        consumedGrantIds.push(args.where.id);
        return { count: 1 };
      },
    },
    subscription: {
      findMany: async (args: { readonly where: { readonly id: { readonly in: readonly string[] } } }) =>
        args.where.id.in
          .map((id) => committed.subscriptions.get(id))
          .filter((row): row is SubscriptionRow => row !== undefined)
          .map((row) => ({ id: row.id, planSnapshot: structuredClone(row.planSnapshot) })),
    },
    $transaction: async <T>(callback: (tx: unknown) => Promise<T>): Promise<T> => {
      const staged = structuredClone(committed);
      const result = await callback(txClient(staged));
      committed = staged;
      return result;
    },
  };

  const record =
    (severity: Emitted['severity']) =>
    (type: string, _category: string, message: string, metadata: Record<string, unknown> = {}) => {
      events.push({ severity, type, message, metadata });
    };

  const service = new PaymentSubscriptionMutationService(
    prismaService as never,
    { info: record('INFO'), warn: record('WARNING'), error: record('ERROR') } as never,
    {
      createPendingInTransaction: async (tx: unknown, input: Record<string, unknown>) => {
        const staged = stagedOf(tx);
        staged.entitlementCreates.push(structuredClone(input));
        return { entitlementId: `ent-${staged.entitlementCreates.length}` };
      },
    } as never,
    {} as never,
    {
      createScheduledInTransaction: async (tx: unknown, input: Record<string, unknown>) => {
        const staged = stagedOf(tx);
        const subscriptionId = String(input['subscriptionId']);
        const generation =
          Math.max(0, ...staged.terms.filter((term) => term.subscriptionId === subscriptionId).map((term) => term.generation)) + 1;
        const id = `term-${subscriptionId}-${generation}`;
        staged.terms.push({
          id,
          subscriptionId,
          generation,
          status: 'SCHEDULED',
          planId: input['planId'] as string,
          startsAt: input['startsAt'] as Date,
          endsAt: input['endsAt'] as Date | null,
        });
        staged.termCreates.push(structuredClone(input));
        return { id, generation, status: 'SCHEDULED' };
      },
    } as never,
    {} as never,
  );

  return {
    service,
    get committed(): Tables {
      return committed;
    },
    events,
    statements,
    consumedGrantIds,
    completions: (): Emitted[] => events.filter((event) => event.type === EVENT_TYPES.PAYMENT_COMPLETED),
    askedMigrationTable: (): boolean => statements.some((statement) => statement.includes('"plan_migration_items"')),
    failNextSyncJobCreate: (): void => {
      pendingSyncJobFailures += 1;
    },
    fulfil: () => service.applyCompletedTransaction(seed.transaction as never),
  };
}

async function withDurableTerms<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.ADDON_ENTITLEMENT_SHADOW;
  process.env.ADDON_ENTITLEMENT_SHADOW = 'true';
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.ADDON_ENTITLEMENT_SHADOW;
    else process.env.ADDON_ENTITLEMENT_SHADOW = previous;
  }
}

function onlyUpdateOf(world: ReturnType<typeof createWorld>, subscriptionId: string): Record<string, unknown> {
  const updates = world.committed.subscriptionUpdates.filter((update) => update.id === subscriptionId);
  assert.equal(updates.length, 1, `expected one update of ${subscriptionId}, got ${updates.length}`);
  return updates[0]!.data;
}

/**
 * A kept renewal on the column path: status, expiry, and a snapshot that differs
 * from the one the move wrote in `selectedDurationDays` alone — the paid period,
 * which autopay renews by.
 */
function assertRecordsOnlyPaidDuration(update: Record<string, unknown>, movedSnapshot: unknown): void {
  assert.deepEqual(Object.keys(update).sort(), ['expiresAt', 'planSnapshot', 'status']);
  const before = movedSnapshot as Record<string, unknown>;
  assert.notEqual(before['selectedDurationDays'], PAID_DAYS, 'the fixture cannot show a missing duration write');
  assert.deepEqual(update['planSnapshot'], { ...before, selectedDurationDays: PAID_DAYS });
}

/** The record the operator is told about for the standard moved subscription. */
const EXPECTED_RENEWAL: LatePlanMigrationRenewal = {
  subscriptionId: 'sub-1',
  paidPlanId: OLD_PLAN.id,
  paidPlanName: 'Старый',
  currentPlanId: CURRENT_PLAN.id,
  currentPlanName: 'Новый',
  planMigrationRunId: 'run-1',
};

// ── The decision ───────────────────────────────────────────────────────────

describe('whether a renewal can have been moved off the plan it paid for', () => {
  it('asks nothing when the snapshot still names the paid plan, under either spelling', () => {
    assert.equal(resolvePlanMigrationGuardCandidate({ id: 'plan-old' }, 'plan-old'), null);
    assert.equal(resolvePlanMigrationGuardCandidate({ id: 'plan-x', planId: 'plan-old' }, 'plan-old'), null);
  });

  it('names the plan the subscription is on when it is another one', () => {
    assert.equal(resolvePlanMigrationGuardCandidate({ id: 'plan-current' }, 'plan-old'), 'plan-current');
    assert.equal(resolvePlanMigrationGuardCandidate({ planId: 'plan-current' }, 'plan-old'), 'plan-current');
    assert.equal(
      resolvePlanMigrationGuardCandidate({ id: 'plan-current', planId: 'plan-imported' }, 'plan-old'),
      'plan-current',
    );
  });

  it('names nothing for a snapshot that names no plan', () => {
    for (const snapshot of [undefined, null, [], 'plan-current', {}, { id: '   ' }, { id: 7 }]) {
      assert.equal(resolvePlanMigrationGuardCandidate(snapshot, 'plan-old'), null, JSON.stringify(snapshot));
    }
  });
});

describe('the migration lookup', () => {
  const lookupInput = {
    subscription: { id: 'sub-1', planSnapshot: snapshotOn(CURRENT_PLAN) },
    paidPlan: OLD_PLAN,
    transactionId: 'tx-1',
  };

  it('issues no statement when the snapshot still names the paid plan', async () => {
    const tx = {
      $queryRaw: async () => {
        throw new Error('the migration table must not be asked');
      },
    };
    const found = await findLatePlanMigrationRenewal(tx as never, {
      ...lookupInput,
      subscription: { id: 'sub-1', planSnapshot: snapshotOn(OLD_PLAN) },
    });
    assert.equal(found, null);
  });

  it('asks the one question the contract names, bound to this subscription and payment — not to the plan the move left', async () => {
    const seen: RawQuery[] = [];
    const tx = {
      $queryRaw: async (query: RawQuery) => {
        seen.push(query);
        return [];
      },
    };
    assert.equal(await findLatePlanMigrationRenewal(tx as never, lookupInput), null);

    assert.equal(seen.length, 1);
    const text = seen[0]!.text.replace(/\s+/g, ' ');
    assert.match(text, /FROM "plan_migration_items" AS pmi/);
    assert.match(text, /pmi\."subscription_id" = \$1/);
    assert.match(text, /pmi\."status" = 'MOVED'/);
    assert.match(
      text,
      /pmi\."moved_at" >= \( SELECT t\."created_at" FROM "transactions" AS t WHERE t\."id" = \$2 \) - INTERVAL '10 minutes'/,
    );
    // A renewal priced before the move may be for the replacement the old plan
    // renews onto, or for a plan chosen on it: the paid plan is not the plan
    // the move left, and the lookup must not ask for it to be.
    assert.doesNotMatch(text, /from_plan_id/);
    assert.deepEqual(seen[0]!.values, ['sub-1', 'tx-1']);
  });

  it('describes the renewal it keeps: the paid plan by its shown name, the current plan from the snapshot', async () => {
    const tx = { $queryRaw: async () => [{ planMigrationRunId: 'run-1' }] };
    assert.deepEqual(await findLatePlanMigrationRenewal(tx as never, lookupInput), EXPECTED_RENEWAL);
  });
});

// ── A single renewal ───────────────────────────────────────────────────────

describe('a single renewal paid after a plan migration moved its subscription', () => {
  function movedWorld(overrides: {
    readonly subscription?: Partial<SubscriptionRow>;
    readonly migrationItem?: Partial<MigrationItemRow>;
    readonly purchaserBlocked?: boolean;
    readonly grants?: readonly GrantRow[];
  } = {}) {
    return createWorld({
      subscriptions: [subscriptionOn(CURRENT_PLAN, overrides.subscription)],
      transaction: renewalForOldPlan(),
      migrationItems: [movedOffOldPlan(overrides.migrationItem)],
      purchaserBlocked: overrides.purchaserBlocked,
      grants: overrides.grants,
    });
  }

  it('extends expiry by the paid period, records that period, and leaves the plan, limits and squads as the move left them', async () => {
    const world = movedWorld();
    const before = world.committed.subscriptions.get('sub-1')!;

    await world.fulfil();

    const update = onlyUpdateOf(world, 'sub-1');
    assertRecordsOnlyPaidDuration(update, before.planSnapshot);
    assert.equal(update['status'], 'ACTIVE');
    assert.equal((update['expiresAt'] as Date).getTime(), before.expiresAt!.getTime() + PAID_DAYS * DAY_MS);
    const after = world.committed.subscriptions.get('sub-1')!;
    assert.deepEqual(after.planSnapshot, { ...snapshotOn(CURRENT_PLAN), selectedDurationDays: PAID_DAYS });
    assert.equal(after.trafficLimit, 200);
    assert.equal(after.deviceLimit, 5);
    assert.deepEqual(after.internalSquads, ['squad-current']);
    assert.equal(after.externalSquad, null);
  });

  it('keeps a renewal priced for another plan than the one the move left — the replacement that plan renewed onto', async () => {
    // The move left an archived plan whose renewals are priced for its
    // replacement; the payment was priced for that replacement (OLD_PLAN
    // here) before the move. Fulfilled as usual it would put the subscription
    // on the replacement instead of the plan the operator moved it to.
    const world = movedWorld({ migrationItem: { fromPlanId: 'plan-archived-with-replacement' } });
    const before = world.committed.subscriptions.get('sub-1')!;

    await world.fulfil();

    assert.equal(world.askedMigrationTable(), true);
    const update = onlyUpdateOf(world, 'sub-1');
    assertRecordsOnlyPaidDuration(update, before.planSnapshot);
    const after = world.committed.subscriptions.get('sub-1')!;
    assert.deepEqual(after.planSnapshot, { ...snapshotOn(CURRENT_PLAN), selectedDurationDays: PAID_DAYS });
    assert.equal(after.deviceLimit, CURRENT_PLAN.deviceLimit);
    const [completion] = world.completions();
    assert.equal(completion!.severity, 'WARNING');
    assert.equal(completion!.metadata['code'], LATE_PLAN_MIGRATION_RENEWAL_CODE);
    assert.equal(completion!.metadata['paidPlanId'], OLD_PLAN.id);
    assert.equal(completion!.metadata['currentPlanId'], CURRENT_PLAN.id);
  });

  it('brings an expired moved subscription back ACTIVE from now, still on its current plan', async () => {
    const world = movedWorld({ subscription: { status: 'EXPIRED', expiresAt: new Date(NOW - 3 * DAY_MS) } });
    const startedAt = Date.now();

    await world.fulfil();

    const update = onlyUpdateOf(world, 'sub-1');
    assertRecordsOnlyPaidDuration(update, snapshotOn(CURRENT_PLAN));
    assert.equal(update['status'], 'ACTIVE');
    const expiresAt = (update['expiresAt'] as Date).getTime();
    assert.ok(expiresAt >= startedAt + PAID_DAYS * DAY_MS && expiresAt <= Date.now() + PAID_DAYS * DAY_MS);
  });

  it('keeps every other effect of a renewal: the sync job with its traffic reset, the fulfilment stamp, the discount for the plan it was priced with', async () => {
    const grants: GrantRow[] = [
      { id: 'grant-old', percent: 10, allowedPlanIds: [OLD_PLAN.id], expiresAt: null, consumedAt: null },
      { id: 'grant-current', percent: 20, allowedPlanIds: [CURRENT_PLAN.id], expiresAt: null, consumedAt: null },
    ];
    const world = movedWorld({ grants });

    const { syncJobs } = await world.fulfil();

    assert.equal(syncJobs.length, 1);
    const [job] = world.committed.syncJobs;
    assert.equal(job!['subscriptionId'], 'sub-1');
    assert.equal(job!['action'], 'UPDATE');
    assert.equal(job!['status'], 'PENDING');
    assert.deepEqual(job!['payload'], { source: 'PAYMENT_COMPLETION', paymentId: 'pay-1', resetTraffic: true });
    assert.equal(world.committed.transactionUpdates.length, 1);
    const stamp = world.committed.transactionUpdates[0]!.data;
    assert.deepEqual(Object.keys(stamp).sort(), ['fulfilledAt', 'status']);
    assert.equal(stamp['status'], 'COMPLETED');
    assert.ok(stamp['fulfilledAt'] instanceof Date);
    assert.deepEqual(world.consumedGrantIds, ['grant-old']);
  });

  it('keeps the CREATE sync of an unlinked subscription exactly as a renewal would', async () => {
    const world = movedWorld({ subscription: { remnawaveId: null } });

    await world.fulfil();

    const [job] = world.committed.syncJobs;
    assert.equal(job!['action'], 'CREATE');
    assert.deepEqual(job!['payload'], { source: 'PAYMENT_COMPLETION', paymentId: 'pay-1' });
  });

  it('tells the operator once: the payment completion itself, raised for review', async () => {
    const world = movedWorld();

    await world.fulfil();

    // One completion for the payment, then the subscription's own card. The
    // assertion is about the first: a second `payment.completed` would be a
    // second card to reconcile against this one.
    assert.deepEqual(
      world.events.map((event) => `${event.severity} ${event.type}`),
      [`WARNING ${EVENT_TYPES.PAYMENT_COMPLETED}`, `INFO ${EVENT_TYPES.SUBSCRIPTION_RENEWED}`],
    );
    const [completion] = world.completions();
    assert.equal(completion!.message, LATE_PLAN_MIGRATION_RENEWAL_MESSAGE);
    assert.equal(completion!.metadata['code'], LATE_PLAN_MIGRATION_RENEWAL_CODE);
    assert.equal(completion!.metadata['subscriptionId'], 'sub-1');
    assert.equal(completion!.metadata['paymentId'], 'pay-1');
    assert.equal(completion!.metadata['paidPlanId'], OLD_PLAN.id);
    assert.equal(completion!.metadata['paidPlanName'], 'Старый');
    assert.equal(completion!.metadata['currentPlanId'], CURRENT_PLAN.id);
    assert.equal(completion!.metadata['currentPlanName'], 'Новый');
    assert.equal(completion!.metadata['planMigrationRunId'], 'run-1');
    // What was bought stays on the card: the payment block and the plan name.
    assert.equal(completion!.metadata['planName'], OLD_PLAN.name);
    assert.equal(completion!.metadata['amount'], '199');
    assert.equal(completion!.metadata['note'], describeLatePlanMigrationRenewal(EXPECTED_RENEWAL));
  });

  it('writes the operator text in the operator language', () => {
    const texts = [
      LATE_PLAN_MIGRATION_RENEWAL_MESSAGE,
      describeLatePlanMigrationRenewal(EXPECTED_RENEWAL),
      describeLatePlanMigrationRenewals([EXPECTED_RENEWAL, { ...EXPECTED_RENEWAL, subscriptionId: 'sub-2' }]),
    ];
    for (const text of texts) {
      // Data — ids and plan names — is the operator's own; the sentence around it is not.
      const sentence = text.replace(/sub-\d/g, '').replace(/«[^»]*»/g, '');
      assert.doesNotMatch(sentence, /[A-Za-z]{4,}/, `English left in operator text: ${text}`);
    }
  });

  it('carries both notes on the one completion when the purchaser is also blocked', async () => {
    const world = movedWorld({ purchaserBlocked: true });

    await world.fulfil();

    const completions = world.completions();
    assert.equal(completions.length, 1);
    assert.equal(completions[0]!.severity, 'WARNING');
    assert.equal(completions[0]!.message, 'Платёж получен от заблокированного пользователя');
    assert.equal(
      completions[0]!.metadata['note'],
      'Счёт создан до блокировки, а оплачен после неё. Подписка записана, VPN-профиль отключён. ' +
        `Решите, нужен ли возврат средств. ${describeLatePlanMigrationRenewal(EXPECTED_RENEWAL)}`,
    );
    assert.equal(completions[0]!.metadata['code'], LATE_PLAN_MIGRATION_RENEWAL_CODE);
  });
});

describe('a single renewal the guard must leave alone', () => {
  function assertRenewedOntoOldPlan(world: ReturnType<typeof createWorld>): void {
    const update = onlyUpdateOf(world, 'sub-1');
    assert.equal((update['planSnapshot'] as Record<string, unknown>)['id'], OLD_PLAN.id);
    assert.equal(update['trafficLimit'], OLD_PLAN.trafficLimit);
    assert.equal(update['deviceLimit'], OLD_PLAN.deviceLimit);
    assert.deepEqual(update['internalSquads'], OLD_PLAN.internalSquads);
    const completions = world.completions();
    assert.equal(completions.length, 1);
    assert.equal(completions[0]!.severity, 'INFO');
    assert.equal(completions[0]!.metadata['code'], undefined);
    assert.equal(completions[0]!.metadata['note'], undefined);
  }

  it('renews a subscription that was never moved as before, without asking the migration table', async () => {
    const world = createWorld({
      subscriptions: [subscriptionOn(OLD_PLAN)],
      transaction: renewalForOldPlan(),
    });

    await world.fulfil();

    assertRenewedOntoOldPlan(world);
    assert.equal(world.askedMigrationTable(), false);
  });

  it('does not keep a renewal created an hour after the move — the contract’s time boundary', async () => {
    // Pins `moved_at >= payment.created_at - 10 minutes`: a checkout created
    // well after the move did not price the old plan before it.
    const world = createWorld({
      subscriptions: [subscriptionOn(CURRENT_PLAN)],
      transaction: renewalForOldPlan(),
      migrationItems: [movedOffOldPlan({ movedAt: new Date(NOW - 3 * HOUR_MS) })],
    });

    await world.fulfil();

    assert.equal(world.askedMigrationTable(), true);
    assertRenewedOntoOldPlan(world);
  });

  it('does not keep a renewal created eleven minutes after the move', async () => {
    const payment = renewalForOldPlan();
    const world = createWorld({
      subscriptions: [subscriptionOn(CURRENT_PLAN)],
      transaction: payment,
      migrationItems: [movedOffOldPlan({ movedAt: new Date(payment.createdAt.getTime() - 11 * MINUTE_MS) })],
    });

    await world.fulfil();

    assertRenewedOntoOldPlan(world);
  });

  it('does not keep a renewal when only ANOTHER subscription was moved', async () => {
    // The lookup is bound to this subscription: a move of some other one says
    // nothing about this payment.
    const world = createWorld({
      subscriptions: [subscriptionOn(CURRENT_PLAN)],
      transaction: renewalForOldPlan(),
      migrationItems: [movedOffOldPlan({ subscriptionId: 'sub-other' })],
    });

    await world.fulfil();

    assert.equal(world.askedMigrationTable(), true);
    assertRenewedOntoOldPlan(world);
  });

  it('does not keep a renewal whose move never happened', async () => {
    for (const status of ['FAILED', 'SKIPPED', 'PENDING'] as const) {
      const world = createWorld({
        subscriptions: [subscriptionOn(CURRENT_PLAN)],
        transaction: renewalForOldPlan(),
        migrationItems: [movedOffOldPlan({ status, movedAt: status === 'PENDING' ? null : new Date(NOW - HOUR_MS) })],
      });

      await world.fulfil();

      assertRenewedOntoOldPlan(world);
    }
  });

  it('does not guard a paid upgrade: it applies the purchased plan and never asks the migration table', async () => {
    const world = createWorld({
      subscriptions: [subscriptionOn(CURRENT_PLAN)],
      transaction: renewalForOldPlan({ purchaseType: 'UPGRADE' }),
      migrationItems: [movedOffOldPlan()],
    });

    await world.fulfil();

    assert.equal(world.askedMigrationTable(), false);
    const update = onlyUpdateOf(world, 'sub-1');
    assert.equal((update['planSnapshot'] as Record<string, unknown>)['id'], OLD_PLAN.id);
    assert.equal(update['deviceLimit'], OLD_PLAN.deviceLimit);
    assert.equal(world.completions().length, 1);
    assert.equal(world.completions()[0]!.severity, 'INFO');
  });
});

describe('a single renewal whose draft was inserted just after the move committed', () => {
  it('is kept when created nine minutes after the move: it priced the old plan before, or the clocks disagree', async () => {
    // Checkout reads the subscription unlocked and inserts the draft a few
    // queries later; `created_at` is the application's clock and `moved_at` the
    // database's. Either puts a payment that priced the old plan after the move.
    const payment = renewalForOldPlan();
    const world = createWorld({
      subscriptions: [subscriptionOn(CURRENT_PLAN)],
      transaction: payment,
      migrationItems: [movedOffOldPlan({ movedAt: new Date(payment.createdAt.getTime() - 9 * MINUTE_MS) })],
    });

    await world.fulfil();

    assertRecordsOnlyPaidDuration(onlyUpdateOf(world, 'sub-1'), snapshotOn(CURRENT_PLAN));
    assert.equal(world.completions().length, 1);
    assert.equal(world.completions()[0]!.severity, 'WARNING');
    assert.equal(world.completions()[0]!.metadata['code'], LATE_PLAN_MIGRATION_RENEWAL_CODE);
  });
});

// ── Durable terms ──────────────────────────────────────────────────────────

describe('a kept renewal on a subscription with durable terms', () => {
  const activeTerm = (endsAt: Date): TermRow => ({
    id: 'term-active',
    subscriptionId: 'sub-1',
    generation: 1,
    status: 'ACTIVE',
    planId: CURRENT_PLAN.id,
    startsAt: new Date(NOW - 20 * DAY_MS),
    endsAt,
  });

  it('appends the current plan’s term carrying the paid period, and writes no snapshot now, as a renewal with a term does', async () => {
    const expiresAt = new Date(NOW + 10 * DAY_MS);
    const world = createWorld({
      subscriptions: [subscriptionOn(CURRENT_PLAN, { expiresAt })],
      transaction: renewalForOldPlan(),
      migrationItems: [movedOffOldPlan()],
      terms: [activeTerm(expiresAt)],
    });

    await withDurableTerms(() => world.fulfil());

    assert.equal(world.committed.termCreates.length, 1);
    const created = world.committed.termCreates[0]!;
    assert.equal(created['planId'], CURRENT_PLAN.id);
    const termSnapshot = created['planSnapshot'] as Record<string, unknown>;
    assert.equal(termSnapshot['id'], CURRENT_PLAN.id);
    // The duration rides on the term, whose snapshot replaces the
    // subscription's when it activates — before autopay next reads it.
    assert.equal(termSnapshot['selectedDurationDays'], PAID_DAYS);
    assert.equal(created['baseTrafficLimitBytes'], 200n * GIB);
    assert.equal(created['baseDeviceLimit'], 5);
    assert.equal((created['startsAt'] as Date).getTime(), expiresAt.getTime());
    assert.equal((created['endsAt'] as Date).getTime(), expiresAt.getTime() + PAID_DAYS * DAY_MS);
    const update = onlyUpdateOf(world, 'sub-1');
    assert.deepEqual(Object.keys(update).sort(), ['expiresAt', 'status']);
    assert.deepEqual(world.committed.subscriptions.get('sub-1')!.planSnapshot, snapshotOn(CURRENT_PLAN));
    assert.equal(world.completions()[0]!.severity, 'WARNING');
  });

  it('fails closed when the current plan is gone and a term chain exists: nothing written, nothing announced', async () => {
    const expiresAt = new Date(NOW + 10 * DAY_MS);
    const world = createWorld({
      plans: [OLD_PLAN],
      subscriptions: [subscriptionOn(CURRENT_PLAN, { expiresAt })],
      transaction: renewalForOldPlan(),
      migrationItems: [movedOffOldPlan()],
      terms: [activeTerm(expiresAt)],
    });

    await withDurableTerms(() =>
      assert.rejects(() => world.fulfil(), /LATE_RENEWAL_CURRENT_PLAN_NOT_FOUND/),
    );

    assert.equal(world.committed.subscriptionUpdates.length, 0);
    assert.equal(world.committed.termCreates.length, 0);
    assert.equal(world.committed.transactionUpdates.length, 0);
    assert.equal(world.committed.syncJobs.length, 0);
    assert.deepEqual(world.events, []);
  });

  it('renews on the column path when the current plan is gone and there is no term chain to extend', async () => {
    const world = createWorld({
      plans: [OLD_PLAN],
      subscriptions: [subscriptionOn(CURRENT_PLAN)],
      transaction: renewalForOldPlan(),
      migrationItems: [movedOffOldPlan()],
    });

    await withDurableTerms(() => world.fulfil());

    assert.equal(world.committed.termCreates.length, 0);
    assertRecordsOnlyPaidDuration(onlyUpdateOf(world, 'sub-1'), snapshotOn(CURRENT_PLAN));
    assert.equal(world.completions()[0]!.metadata['currentPlanName'], 'Новый');
  });
});

// ── A combined renewal ─────────────────────────────────────────────────────

describe('a combined renewal with a line whose subscription a plan migration moved', () => {
  function combinedWorld(options: {
    readonly movedAddOnLines?: unknown;
    readonly terms?: readonly TermRow[];
    readonly grants?: readonly GrantRow[];
  } = {}) {
    const transaction = renewalForOldPlan({
      id: 'tx-c',
      paymentId: 'pay-c',
      subscriptionId: null,
      planSnapshot: { combinedRenewal: true, snapshotVersion: 1 },
    });
    return createWorld({
      subscriptions: [
        subscriptionOn(CURRENT_PLAN, { id: 'sub-moved' }),
        subscriptionOn(OLD_PLAN, { id: 'sub-stayed', remnawaveId: 'rw-2' }),
      ],
      transaction,
      items: [
        {
          id: 'item-moved',
          transactionId: 'tx-c',
          subscriptionId: 'sub-moved',
          planId: OLD_PLAN.id,
          planSnapshot: renewalDraft(OLD_PLAN),
          durationDays: PAID_DAYS,
          amount: '199',
          currency: 'RUB',
          addOnLines: options.movedAddOnLines ?? null,
          appliedAt: null,
        },
        {
          id: 'item-stayed',
          transactionId: 'tx-c',
          subscriptionId: 'sub-stayed',
          planId: OLD_PLAN.id,
          planSnapshot: renewalDraft(OLD_PLAN),
          durationDays: PAID_DAYS,
          amount: '199',
          currency: 'RUB',
          addOnLines: null,
          appliedAt: null,
        },
      ],
      migrationItems: [movedOffOldPlan({ subscriptionId: 'sub-moved' })],
      terms: options.terms,
      grants: options.grants,
    });
  }

  const movedRecord: LatePlanMigrationRenewal = { ...EXPECTED_RENEWAL, subscriptionId: 'sub-moved' };

  it('keeps the moved line on its current plan and renews the other line on the paid plan', async () => {
    const world = combinedWorld();
    const movedBefore = world.committed.subscriptions.get('sub-moved')!;

    const { syncJobs } = await world.fulfil();

    const moved = onlyUpdateOf(world, 'sub-moved');
    assertRecordsOnlyPaidDuration(moved, movedBefore.planSnapshot);
    assert.equal((moved['expiresAt'] as Date).getTime(), movedBefore.expiresAt!.getTime() + PAID_DAYS * DAY_MS);
    assert.deepEqual(world.committed.subscriptions.get('sub-moved')!.planSnapshot, {
      ...snapshotOn(CURRENT_PLAN),
      selectedDurationDays: PAID_DAYS,
    });

    const stayed = onlyUpdateOf(world, 'sub-stayed');
    assert.equal((stayed['planSnapshot'] as Record<string, unknown>)['snapshotSource'], 'RENEWAL_DRAFT');
    assert.equal((stayed['planSnapshot'] as Record<string, unknown>)['id'], OLD_PLAN.id);
    assert.equal((stayed['planSnapshot'] as Record<string, unknown>)['selectedDurationDays'], PAID_DAYS);

    // Every other effect, for both lines.
    assert.equal(syncJobs.length, 2);
    for (const job of world.committed.syncJobs) {
      assert.deepEqual(job['payload'], {
        source: 'PAYMENT_COMPLETION',
        paymentId: 'pay-c',
        combined: true,
        resetTraffic: true,
      });
    }
    for (const item of world.committed.items.values()) {
      assert.ok(item.appliedAt instanceof Date, `${item.id} was not stamped applied`);
    }
    assert.deepEqual(world.committed.transactionUpdates.map((update) => Object.keys(update.data)), [['fulfilledAt']]);
  });

  it('announces the payment once, naming only the kept line', async () => {
    const world = combinedWorld();

    await world.fulfil();

    // ONE completion for the payment, and one lifecycle card per LINE — the
    // two lines this payment renewed. The point of this assertion is the
    // first: a second `payment.completed` would be a second card to reconcile
    // against the first. `subscription.renewed` answers a different question
    // (what happened to each subscription) and is ticked separately.
    assert.deepEqual(
      world.events.map((event) => `${event.severity} ${event.type}`),
      [
        `WARNING ${EVENT_TYPES.PAYMENT_COMPLETED}`,
        `INFO ${EVENT_TYPES.SUBSCRIPTION_RENEWED}`,
        `INFO ${EVENT_TYPES.SUBSCRIPTION_RENEWED}`,
      ],
    );
    const [completion] = world.completions();
    assert.equal(completion!.message, LATE_PLAN_MIGRATION_RENEWAL_MESSAGE);
    assert.equal(completion!.metadata['code'], LATE_PLAN_MIGRATION_RENEWAL_CODE);
    assert.equal(completion!.metadata['itemCount'], 2);
    assert.deepEqual(completion!.metadata['planMigrationRenewals'], [movedRecord]);
    assert.equal(completion!.metadata['note'], describeLatePlanMigrationRenewals([movedRecord]));
  });

  it('settles the one-time discount against the plan the kept line was priced with', async () => {
    // Without the override the kept line would contribute its CURRENT plan,
    // and the larger grant restricted to that plan — never applied — would be
    // burned instead of the one the price was built with.
    const world = combinedWorld({
      grants: [
        { id: 'grant-old', percent: 10, allowedPlanIds: [OLD_PLAN.id], expiresAt: null, consumedAt: null },
        { id: 'grant-current', percent: 20, allowedPlanIds: [CURRENT_PLAN.id], expiresAt: null, consumedAt: null },
      ],
    });

    await world.fulfil();

    assert.deepEqual(world.consumedGrantIds, ['grant-old']);
  });

  it('binds the kept line’s paid add-ons to the current plan’s term', async () => {
    const expiresAt = new Date(NOW + 10 * DAY_MS);
    const world = combinedWorld({
      movedAddOnLines: [
        {
          addOnId: 'addon-traffic',
          catalogRevision: 1,
          type: 'EXTRA_TRAFFIC',
          value: 10,
          lifetime: 'UNTIL_SUBSCRIPTION_END',
          activation: 'TERM_START',
          sourceLineKey: 'line-1',
          unitAmount: '50',
          receiptName: 'Трафик +10 ГБ',
        },
      ],
      terms: [
        {
          id: 'term-moved-active',
          subscriptionId: 'sub-moved',
          generation: 1,
          status: 'ACTIVE',
          planId: CURRENT_PLAN.id,
          startsAt: new Date(NOW - 20 * DAY_MS),
          endsAt: expiresAt,
        },
      ],
    });

    await world.fulfil();

    const termsForMoved = world.committed.termCreates.filter((term) => term['subscriptionId'] === 'sub-moved');
    assert.equal(termsForMoved.length, 1);
    assert.equal(termsForMoved[0]!['planId'], CURRENT_PLAN.id);
    assert.equal((termsForMoved[0]!['planSnapshot'] as Record<string, unknown>)['selectedDurationDays'], PAID_DAYS);
    // With a term the line writes no snapshot now, exactly as a normal line with a term.
    assert.deepEqual(Object.keys(onlyUpdateOf(world, 'sub-moved')).sort(), ['expiresAt', 'status']);
    const newTerm = world.committed.terms.find((term) => term.subscriptionId === 'sub-moved' && term.status === 'SCHEDULED');
    assert.ok(newTerm !== undefined);
    assert.equal(world.committed.entitlementCreates.length, 1);
    assert.equal(world.committed.entitlementCreates[0]!['termId'], newTerm.id);
    assert.equal(world.committed.entitlementCreates[0]!['subscriptionId'], 'sub-moved');
  });

  it('announces nothing for an attempt that rolled back, and once for the attempt that committed', async () => {
    const world = combinedWorld();
    world.failNextSyncJobCreate();

    await assert.rejects(() => world.fulfil(), /forced sync job failure/);
    assert.deepEqual(world.events, []);
    assert.equal(world.committed.subscriptionUpdates.length, 0);

    await world.fulfil();
    assert.equal(world.completions().length, 1);
    assert.equal(world.completions()[0]!.severity, 'WARNING');
  });
});
