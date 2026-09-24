import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EffectiveProjectionService } from '../src/modules/add-on-entitlements/services/effective-projection.service';
import { SubscriptionTermService } from '../src/modules/add-on-entitlements/services/subscription-term.service';
import { PaymentSubscriptionMutationService } from '../src/modules/payments/services/payment-subscription-mutation.service';
import { pinAddOnStagesOffForThisFile } from './helpers/rollout-flags';

// Written against every `ADDON_*` stage off (the legacy path): these fakes
// do not stage the durable model's reads. Stages 1, 2 and 6 default ON since
// 24.09.2026, so the file says so instead of relying on the default.
pinAddOnStagesOffForThisFile();

const GIB = 1024n * 1024n * 1024n;

/**
 * These tests wire the REAL {@link SubscriptionTermService} and
 * {@link EffectiveProjectionService} into the mutation service over an
 * in-memory store, rather than stubbing them. The point of the fix is what the
 * projection DERIVES after an upgrade, so a stubbed projection would assert our
 * own fixture back at us and stay green against the bug.
 */
interface TermRow {
  id: string;
  subscriptionId: string;
  generation: number;
  status: string;
  startsAt: Date;
  endsAt: Date | null;
  endedAt: Date | null;
  baseTrafficLimitBytes: bigint | null;
  baseDeviceLimit: number | null;
  trafficResetStrategy: string;
  resetAnchorAt: Date | null;
  planId?: string;
  planSnapshot?: unknown;
}

interface EntitlementRow {
  id: string;
  subscriptionId: string;
  termId: string;
  type: 'EXTRA_TRAFFIC' | 'EXTRA_DEVICES';
  state: string;
  totalValue: bigint;
  expiresAt?: Date | null;
  version?: number;
  expiryEpochId?: string | null;
  scheduledActivationAt?: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Anchored to now, so a fixture never changes the side of "now" it is on. */
const inDays = (days: number): Date => new Date(Date.now() + days * DAY_MS);

interface StoreOptions {
  readonly terms: readonly TermRow[];
  readonly entitlements?: readonly EntitlementRow[];
  readonly subscriptionStatus?: string;
  /** Overrides on the subscription row — its limit columns and snapshot. */
  readonly subscription?: Readonly<Record<string, unknown>>;
  /** Projection rows already on file, by subscription id. */
  readonly projections?: Readonly<Record<string, Record<string, unknown>>>;
}

/** Tracks what the fake actually served, so a silently inert fake fails loudly. */
interface StoreStats {
  activeTermProjectionQueries: number;
  termCreates: number;
  termActivations: number;
}

function createStore(options: StoreOptions) {
  const terms: TermRow[] = options.terms.map((term) => ({ ...term }));
  const entitlements: Array<Required<EntitlementRow>> = (options.entitlements ?? []).map((row) => ({
    expiresAt: null,
    version: 1,
    expiryEpochId: null,
    scheduledActivationAt: inDays(-5),
    ...row,
  }));
  const entitlementEvents: Array<Record<string, unknown>> = [];
  const projections: Record<string, Record<string, unknown>> = { ...options.projections };
  const syncJobs: Array<Record<string, unknown>> = [];
  const subscriptionUpdates: Array<Record<string, unknown>> = [];
  const stats: StoreStats = {
    activeTermProjectionQueries: 0,
    termCreates: 0,
    termActivations: 0,
  };
  const subscription = {
    id: 'sub-1',
    status: options.subscriptionStatus ?? 'ACTIVE',
    remnawaveId: 'rw-1',
    isTrial: false,
    expiresAt: new Date('2026-09-01T00:00:00.000Z'),
    trafficLimit: 100,
    deviceLimit: 3,
    planSnapshot: { id: 'plan-old' } as Record<string, unknown>,
    internalSquads: ['old-squad'],
    externalSquad: null,
    ...options.subscription,
  };

  const matches = (row: Record<string, unknown>, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([key, expected]) => {
      if (key === 'OR') return (expected as Array<Record<string, unknown>>).some((clause) => matches(row, clause));
      const actual = row[key];
      if (expected !== null && typeof expected === 'object') {
        const clause = expected as Record<string, unknown>;
        if (Array.isArray(clause.in)) return (clause.in as unknown[]).includes(actual);
        if ('not' in clause) return actual !== clause.not;
        throw new Error(`unsupported where clause: ${JSON.stringify(clause)}`);
      }
      return actual === expected;
    });

  const sortTerms = (rows: TermRow[], orderBy: unknown): TermRow[] => {
    const clauses = (Array.isArray(orderBy) ? orderBy : [orderBy]).filter(
      (clause): clause is Record<string, string> => typeof clause === 'object' && clause !== null,
    );
    return [...rows].sort((left, right) => {
      for (const clause of clauses) {
        for (const [key, direction] of Object.entries(clause)) {
          const a = left[key as keyof TermRow] as string | number;
          const b = right[key as keyof TermRow] as string | number;
          if (a === b) continue;
          return (a < b ? -1 : 1) * (direction === 'desc' ? -1 : 1);
        }
      }
      return 0;
    });
  };

  const tx = {
    $queryRaw: async (query: { readonly sql?: string }) => {
      const sql = String(query?.sql ?? query).replace(/\s+/g, ' ');
      if (sql.includes('base_traffic_limit_bytes')) {
        stats.activeTermProjectionQueries += 1;
        return terms
          .filter((term) => term.subscriptionId === subscription.id && term.status === 'ACTIVE')
          .map((term) => ({
            id: term.id,
            baseTrafficLimitBytes: term.baseTrafficLimitBytes,
            baseDeviceLimit: term.baseDeviceLimit,
          }));
      }
      if (sql.includes('"subscription_terms" AS st')) {
        // `activateInTransaction` locks the term joined to its subscription.
        const termId = String((query as { readonly values?: unknown[] }).values?.[0] ?? '');
        const term = terms.find((row) => row.id === termId);
        return term === undefined
          ? []
          : [
              {
                id: term.id,
                subscriptionId: term.subscriptionId,
                subscriptionStatus: subscription.status,
                status: term.status,
                generation: term.generation,
                startsAt: term.startsAt,
              },
            ];
      }
      assert.match(sql, /FROM "subscriptions"/, 'unexpected raw query');
      assert.match(sql, /\bFOR\s+UPDATE\b/i, 'subscription reads must lock');
      // The alignment reads the expiry under this same lock.
      return [{ id: subscription.id, status: subscription.status, expiresAt: subscription.expiresAt }];
    },
    subscription: {
      findUnique: async () => ({ ...subscription }),
      // Applied to the row: the upgrade writes the snapshot and the carried
      // columns BEFORE its recompute, and the recompute reads them back.
      update: async ({ data }: { data: Record<string, unknown> }) => {
        subscriptionUpdates.push(data);
        Object.assign(subscription, data);
        return { ...subscription, id: subscription.id, remnawaveId: subscription.remnawaveId };
      },
    },
    subscriptionTerm: {
      findFirst: async (input: { where: Record<string, unknown>; orderBy?: unknown }) => {
        const found = sortTerms(
          terms.filter((term) => matches(term as unknown as Record<string, unknown>, input.where)),
          input.orderBy,
        )[0];
        return found === undefined ? null : { ...found };
      },
      findMany: async (input: { where: Record<string, unknown> }) =>
        terms
          .filter((term) => matches(term as unknown as Record<string, unknown>, input.where))
          .map((term) => ({ ...term })),
      updateMany: async (input: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        let count = 0;
        for (const term of terms) {
          if (!matches(term as unknown as Record<string, unknown>, input.where)) continue;
          Object.assign(term, input.data);
          count += 1;
        }
        if (input.data.status === 'ACTIVE') stats.termActivations += count;
        return { count };
      },
      create: async (input: { data: Record<string, unknown> }) => {
        stats.termCreates += 1;
        const row = {
          ...(input.data as unknown as TermRow),
          id: `term-new-${stats.termCreates}`,
          endedAt: null,
        };
        terms.push(row);
        return { id: row.id, generation: row.generation, status: row.status };
      },
      update: async (input: { where: { id: string }; data: Record<string, unknown> }) => {
        const term = terms.find((row) => row.id === input.where.id);
        assert.ok(term, `update of a missing term ${input.where.id}`);
        Object.assign(term, input.data);
        return { ...term };
      },
    },
    addOnEntitlement: {
      findMany: async (input: { where: Record<string, unknown> }) =>
        entitlements
          .filter((row) => matches(row as unknown as Record<string, unknown>, input.where))
          .map((row) => ({ ...row })),
      updateMany: async (input: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        let count = 0;
        for (const row of entitlements) {
          if (!matches(row as unknown as Record<string, unknown>, input.where)) continue;
          const { version, ...rest } = input.data;
          Object.assign(row, rest);
          if (version !== undefined) row.version += 1;
          count += 1;
        }
        return { count };
      },
    },
    addOnEntitlementEvent: {
      create: async (input: { data: Record<string, unknown> }) => {
        entitlementEvents.push(input.data);
        return { id: `event-${entitlementEvents.length}` };
      },
    },
    subscriptionEffectiveProjection: {
      findUnique: async ({ where }: { where: { subscriptionId: string } }) =>
        projections[where.subscriptionId] === undefined
          ? null
          : { ...projections[where.subscriptionId], id: 'proj-1' },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        projections[String(data.subscriptionId)] = { ...data };
        return { ...data };
      },
      update: async ({
        where,
        data,
      }: {
        where: { subscriptionId: string };
        data: Record<string, unknown>;
      }) => {
        projections[where.subscriptionId] = { ...projections[where.subscriptionId], ...data };
        return { ...projections[where.subscriptionId] };
      },
    },
    profileSyncJob: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        syncJobs.push(data);
        return { id: `job-${syncJobs.length}`, ...data };
      },
    },
    transaction: {
      update: async () => undefined,
      // The paid remainder's read of the subscription's payments: none here.
      findMany: async () => [],
    },
  };

  return {
    tx,
    terms,
    entitlements,
    entitlementEvents,
    stats,
    syncJobs,
    projections,
    subscriptionUpdates,
    /** The row as the upgrade left it. */
    subscription,
    /** The last write, which is what the columns now hold. */
    get subscriptionUpdate(): Record<string, unknown> | null {
      return subscriptionUpdates[subscriptionUpdates.length - 1] ?? null;
    },
  };
}

function buildService(tx: unknown, warnings: Array<Record<string, unknown>> = []) {
  const prisma = { $transaction: async (fn: (client: unknown) => unknown) => fn(tx) };
  return new PaymentSubscriptionMutationService(
    prisma as never,
    {
      info: () => undefined,
      warn: (type: string, _category: string, message: string, metadata: Record<string, unknown> = {}) => {
        warnings.push({ type, message, ...metadata });
      },
      error: () => undefined,
    } as never,
    {} as never,
    new EffectiveProjectionService() as never,
    new SubscriptionTermService() as never,
    {} as never,
  );
}

function upgradeOf(service: PaymentSubscriptionMutationService) {
  return (
    service as unknown as {
      upgradeSubscriptionFromPayment(input: {
        transaction: unknown;
        purchasedPlan: unknown;
        selectedDurationDays: number;
      }): Promise<{ subscription: unknown; syncJob: Record<string, unknown> }>;
    }
  ).upgradeSubscriptionFromPayment.bind(service);
}

const UPGRADE_TRANSACTION = {
  id: 'tx-1',
  paymentId: 'pay-1',
  subscriptionId: 'sub-1',
  userId: 'user-1',
  purchaseType: 'UPGRADE',
  planSnapshot: { selectedDurationDays: 30 },
  gatewayType: 'YOOKASSA',
  amount: '10',
  currency: 'USD',
};

function plan(overrides: Record<string, unknown>) {
  return {
    id: 'plan-new',
    name: 'New',
    description: null,
    tag: null,
    type: 'BOTH',
    icon: null,
    availability: 'ALL',
    trafficLimit: 500,
    deviceLimit: 10,
    trafficLimitStrategy: 'NO_RESET',
    internalSquads: ['new-squad'],
    externalSquad: null,
    ...overrides,
  };
}

function activeCutoverTerm(overrides: Partial<TermRow> = {}): TermRow {
  return {
    id: 'term-old',
    subscriptionId: 'sub-1',
    generation: 1,
    status: 'ACTIVE',
    startsAt: new Date('2026-07-01T00:00:00.000Z'),
    endsAt: new Date('2026-09-01T00:00:00.000Z'),
    endedAt: null,
    baseTrafficLimitBytes: 100n * GIB,
    baseDeviceLimit: 3,
    trafficResetStrategy: 'NO_RESET',
    resetAnchorAt: null,
    ...overrides,
  };
}

/**
 * The projection row a subscription on `term-old` (100 GB / 3) carries while it
 * holds live add-ons — the row the recompute updates, and whose recorded share
 * the columns were mirrored from.
 */
function projectionOverOldTerm(recorded: { readonly trafficBytes: bigint; readonly devices: number }) {
  return {
    baselineTermId: 'term-old',
    desiredRevision: 3n,
    baseTrafficLimitBytes: 100n * GIB,
    baseDeviceLimit: 3,
    activeTrafficContributionBytes: recorded.trafficBytes,
    activeDeviceContribution: recorded.devices,
    desiredTrafficLimitBytes: 100n * GIB + recorded.trafficBytes,
    desiredDeviceLimit: 3 + recorded.devices,
    state: 'APPLIED',
  };
}

async function withShadowFlag<T>(value: string | undefined, run: () => Promise<T>): Promise<T> {
  const previous = process.env.ADDON_ENTITLEMENT_SHADOW;
  if (value === undefined) delete process.env.ADDON_ENTITLEMENT_SHADOW;
  else process.env.ADDON_ENTITLEMENT_SHADOW = value;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.ADDON_ENTITLEMENT_SHADOW;
    else process.env.ADDON_ENTITLEMENT_SHADOW = previous;
  }
}

describe('PaymentSubscriptionMutationService upgrade term baseline', () => {
  it('moves the term baseline onto the purchased plan so a later versioned recompute derives it', async () => {
    await withShadowFlag('true', async () => {
      const store = createStore({
        terms: [activeCutoverTerm()],
        // A live add-on the customer still owns: it must LAYER on the new
        // baseline, not be swallowed by it.
        entitlements: [
          {
            id: 'ent-1',
            subscriptionId: 'sub-1',
            termId: 'term-old',
            type: 'EXTRA_TRAFFIC',
            state: 'ACTIVE',
            totalValue: 50n * GIB,
          },
        ],
      });
      const service = buildService(store.tx);

      const result = await upgradeOf(service)({
        transaction: UPGRADE_TRANSACTION,
        purchasedPlan: plan({ trafficLimit: 500, deviceLimit: 10 }),
        selectedDurationDays: 30,
      });

      // The outgoing term is closed and exactly one ACTIVE term remains.
      const active = store.terms.filter((term) => term.status === 'ACTIVE');
      assert.equal(active.length, 1, 'exactly one ACTIVE term must remain after an upgrade');
      assert.equal(store.terms.find((term) => term.id === 'term-old')?.status, 'ENDED');
      assert.equal(
        active[0]!.baseTrafficLimitBytes,
        500n * GIB,
        'the ACTIVE term baseline must be the purchased plan, not the superseded one',
      );
      assert.equal(active[0]!.baseDeviceLimit, 10);

      // The defect in one assertion: a LATER versioned job recomputes from the
      // ACTIVE term. It must derive the new plan's baseline plus the live
      // add-on (500 + 50), never the superseded 100 + 50.
      const queriesBefore = store.stats.activeTermProjectionQueries;
      const later = await new EffectiveProjectionService().recomputeInTransaction(
        store.tx as never,
        { subscriptionId: 'sub-1', mode: 'ACTIVE' },
      );
      assert.equal(
        store.stats.activeTermProjectionQueries,
        queriesBefore + 1,
        'the recompute must actually read the ACTIVE term (guards an inert fake)',
      );
      assert.equal(later.baseTrafficLimitBytes, 500n * GIB);
      assert.equal(later.desiredTrafficLimitBytes, 550n * GIB);
      assert.equal(later.desiredDeviceLimit, 10);
      assert.notEqual(
        later.desiredTrafficLimitBytes,
        150n * GIB,
        'deriving 150 GiB means the stale baseline survived the upgrade',
      );

      // The fulfillment job is versioned, so `tryVersionedDesiredStateWrite`
      // can push the projection instead of falling back to the legacy update.
      assert.equal(store.syncJobs.length, 1);
      assert.equal(store.syncJobs[0]!.aggregateKey, 'sub-1');
      assert.equal(typeof store.syncJobs[0]!.desiredRevision, 'bigint');
      assert.equal(store.syncJobs[0]!.cause, 'PLAN_CHANGE');
      assert.ok(result.syncJob);

      // Legacy columns mirror the projection, so the live add-on is not taken
      // back by the non-versioned path either.
      assert.equal(store.subscriptionUpdate!.trafficLimit, 550);
      assert.equal(store.subscriptionUpdate!.deviceLimit, 10);
    });
  });

  it('starts the new term from a CHEAPER plan when the plan change is a downgrade', async () => {
    await withShadowFlag('true', async () => {
      const store = createStore({ terms: [activeCutoverTerm()] });
      const service = buildService(store.tx);

      await upgradeOf(service)({
        transaction: UPGRADE_TRANSACTION,
        // `upgradeToPlanIds` is an operator-curated list with no size or price
        // comparison, so a smaller plan is a reachable UPGRADE target.
        purchasedPlan: plan({ id: 'plan-small', trafficLimit: 20, deviceLimit: 1 }),
        selectedDurationDays: 30,
      });

      const active = store.terms.filter((term) => term.status === 'ACTIVE');
      assert.equal(active.length, 1);
      assert.equal(active[0]!.baseTrafficLimitBytes, 20n * GIB);
      assert.equal(active[0]!.baseDeviceLimit, 1);

      const later = await new EffectiveProjectionService().recomputeInTransaction(
        store.tx as never,
        { subscriptionId: 'sub-1', mode: 'ACTIVE' },
      );
      assert.equal(later.desiredTrafficLimitBytes, 20n * GIB);
      assert.equal(later.desiredDeviceLimit, 1);
    });
  });

  it('treats an unlimited purchased plan as an unlimited baseline', async () => {
    await withShadowFlag('true', async () => {
      const store = createStore({
        terms: [activeCutoverTerm()],
        entitlements: [
          {
            id: 'ent-1',
            subscriptionId: 'sub-1',
            termId: 'term-old',
            type: 'EXTRA_TRAFFIC',
            state: 'ACTIVE',
            totalValue: 50n * GIB,
          },
        ],
      });
      const service = buildService(store.tx);

      await upgradeOf(service)({
        transaction: UPGRADE_TRANSACTION,
        purchasedPlan: plan({ trafficLimit: null, deviceLimit: 0 }),
        selectedDurationDays: 30,
      });

      const active = store.terms.filter((term) => term.status === 'ACTIVE')[0]!;
      assert.equal(active.baseTrafficLimitBytes, null);
      assert.equal(active.baseDeviceLimit, null);
      // Unlimited is absorbing: the add-on must not turn the profile finite.
      assert.equal(store.subscriptionUpdate!.trafficLimit, null);
      assert.equal(store.subscriptionUpdate!.deviceLimit, 0);
    });
  });

  it('cancels a queued scheduled term so it cannot reinstate the superseded baseline', async () => {
    await withShadowFlag('true', async () => {
      // Anchored to now, and consistent: the queued renewal already extended
      // the subscription to its own end.
      const store = createStore({
        terms: [
          activeCutoverTerm({ startsAt: inDays(-20), endsAt: inDays(10) }),
          activeCutoverTerm({
            id: 'term-queued',
            generation: 2,
            status: 'SCHEDULED',
            startsAt: inDays(10),
            endsAt: inDays(40),
          }),
        ],
        subscription: { expiresAt: inDays(40) },
      });
      const service = buildService(store.tx);

      await upgradeOf(service)({
        transaction: UPGRADE_TRANSACTION,
        purchasedPlan: plan({}),
        selectedDurationDays: 30,
      });

      assert.equal(store.terms.find((term) => term.id === 'term-queued')?.status, 'CANCELED');
      const active = store.terms.filter((term) => term.status === 'ACTIVE');
      assert.equal(active.length, 1);
      assert.equal(active[0]!.baseTrafficLimitBytes, 500n * GIB);
    });
  });

  it('re-bases a queued term that carries paid add-ons onto the new plan, and starts the upgrade’s own term before it', async () => {
    // The queued term used to survive the upgrade on the OLD plan and bring its
    // snapshot, squads and limits back when it began. Now it is moved above a
    // new ACTIVE term on the new plan, re-based, and the chain ends where the
    // subscription does — its days are already in the upgrade's expiry.
    await withShadowFlag('true', async () => {
      const store = createStore({
        terms: [
          activeCutoverTerm({ startsAt: inDays(-20), endsAt: inDays(10) }),
          activeCutoverTerm({
            id: 'term-queued',
            generation: 2,
            status: 'SCHEDULED',
            startsAt: inDays(10),
            endsAt: inDays(40),
          }),
        ],
        entitlements: [
          {
            id: 'ent-queued',
            subscriptionId: 'sub-1',
            termId: 'term-queued',
            type: 'EXTRA_DEVICES',
            state: 'PENDING_ACTIVATION',
            totalValue: 2n,
            scheduledActivationAt: inDays(10),
            expiresAt: inDays(40),
          },
        ],
        subscription: { expiresAt: inDays(40) },
      });
      const service = buildService(store.tx);

      await upgradeOf(service)({
        transaction: UPGRADE_TRANSACTION,
        purchasedPlan: plan({}),
        selectedDurationDays: 30,
      });

      const expiresAt = store.subscription.expiresAt as Date;
      assert.equal(store.terms.find((term) => term.id === 'term-old')?.status, 'ENDED');
      const active = store.terms.filter((term) => term.status === 'ACTIVE');
      assert.equal(active.length, 1);
      assert.equal(active[0]!.generation, 3, 'the upgrade’s term is minted next');
      assert.equal(active[0]!.baseTrafficLimitBytes, 500n * GIB);
      const queued = store.terms.find((term) => term.id === 'term-queued')!;
      assert.equal(active[0]!.endsAt?.getTime(), queued.startsAt.getTime(), 'the new term ends where the queued one begins');
      assert.equal(queued.status, 'SCHEDULED');
      assert.equal(queued.generation, 4, 'moved above the new term, so it still activates after it');
      assert.equal(queued.planId, 'plan-new');
      assert.equal(queued.baseTrafficLimitBytes, 500n * GIB, 'no longer the old plan’s base');
      assert.equal(queued.baseDeviceLimit, 10);
      assert.equal((queued.planSnapshot as Record<string, unknown>)['snapshotSource'], 'UPGRADE_REBASED_TERM');
      assert.equal((queued.planSnapshot as Record<string, unknown>)['id'], 'plan-new');
      assert.equal(queued.endsAt?.getTime(), expiresAt.getTime(), 'the chain ends where the subscription does');
      // The add-on bought for that period still begins at its start, and keeps
      // its own end — clamped to the subscription's.
      const addOn = store.entitlements.find((row) => row.id === 'ent-queued')!;
      assert.equal(addOn.state, 'PENDING_ACTIVATION');
      assert.equal(addOn.termId, 'term-queued');
      assert.equal(addOn.expiresAt?.getTime(), expiresAt.getTime());
      assert.equal(store.syncJobs[0]!.aggregateKey, 'sub-1', 'a versioned job: the durable path ran');
    });
  });

  it('tells the operator when the upgrade ends before a paid queued term begins, and leaves that term’s add-ons alone', async () => {
    const queuedEndsAt = inDays(90);
    await withShadowFlag('true', async () => {
      const store = createStore({
        terms: [
          activeCutoverTerm({ startsAt: inDays(-20), endsAt: inDays(60) }),
          activeCutoverTerm({
            id: 'term-queued',
            generation: 2,
            status: 'SCHEDULED',
            startsAt: inDays(60),
            endsAt: queuedEndsAt,
          }),
        ],
        entitlements: [
          {
            id: 'ent-queued',
            subscriptionId: 'sub-1',
            termId: 'term-queued',
            type: 'EXTRA_DEVICES',
            state: 'PENDING_ACTIVATION',
            totalValue: 2n,
            scheduledActivationAt: inDays(60),
            expiresAt: queuedEndsAt,
          },
        ],
        // The SAME instant as the queued term's end. Two `inDays(90)` calls a
        // millisecond apart made the tail read as drifted, and the alignment
        // before the upgrade then moved it by that millisecond — a failure
        // that came and went with machine load.
        subscription: { expiresAt: queuedEndsAt },
      });
      const warnings: Array<Record<string, unknown>> = [];
      const service = buildService(store.tx, warnings);

      await upgradeOf(service)({
        transaction: UPGRADE_TRANSACTION,
        purchasedPlan: plan({}),
        selectedDurationDays: 30,
      });

      const expiresAt = store.subscription.expiresAt as Date;
      const active = store.terms.filter((term) => term.status === 'ACTIVE');
      assert.equal(active[0]!.endsAt?.getTime(), expiresAt.getTime(), 'the new term ends with the subscription');
      const queued = store.terms.find((term) => term.id === 'term-queued')!;
      assert.equal(queued.baseTrafficLimitBytes, 500n * GIB, 're-based all the same: it never brings the old plan back');
      assert.equal(queued.endsAt?.getTime(), queuedEndsAt.getTime(), 'its window is left alone');
      assert.ok(queued.startsAt.getTime() > expiresAt.getTime(), 'fixture: it begins after the new end');
      const addOn = store.entitlements.find((row) => row.id === 'ent-queued')!;
      assert.equal(addOn.version, 1, 'an add-on that cannot begin inside the subscription is not moved');
      const card = warnings.find((warning) => warning['code'] === 'UPGRADE_ENDS_BEFORE_PAID_SCHEDULED_TERM');
      assert.ok(card, 'the operator is told');
      assert.deepEqual(card['scheduledTermIds'], ['term-queued']);
      assert.equal(card['boundEntitlements'], 1);
      assert.equal(card['reason'], 'upgrade_addons_after_end');
    });
  });

  it('keeps each live add-on’s own end date, clamped to the new end, and moves it onto the new term (owner, 24.09)', async () => {
    const earlyEnd = inDays(10);
    await withShadowFlag('true', async () => {
      const store = createStore({
        terms: [activeCutoverTerm({ startsAt: inDays(-20), endsAt: inDays(60) })],
        entitlements: [
          // Ends before the new end: keeps its date.
          { id: 'ent-early', subscriptionId: 'sub-1', termId: 'term-old', type: 'EXTRA_DEVICES', state: 'ACTIVE', totalValue: 2n, expiresAt: earlyEnd },
          // Would outlive the new end: clamped to it.
          { id: 'ent-late', subscriptionId: 'sub-1', termId: 'term-old', type: 'EXTRA_TRAFFIC', state: 'ACTIVE', totalValue: 50n * GIB, expiresAt: inDays(60) },
          // Tied to a reset epoch of the old term: clamped, never moved off it.
          { id: 'ent-epoch', subscriptionId: 'sub-1', termId: 'term-old', type: 'EXTRA_TRAFFIC', state: 'ACTIVE', totalValue: 10n * GIB, expiresAt: inDays(45), expiryEpochId: 'epoch-1' },
          // Already on its way out: nothing to keep.
          { id: 'ent-expiring', subscriptionId: 'sub-1', termId: 'term-old', type: 'EXTRA_DEVICES', state: 'EXPIRING', totalValue: 1n, expiresAt: inDays(-1) },
        ],
        subscription: { expiresAt: inDays(60) },
      });
      const service = buildService(store.tx);

      await upgradeOf(service)({
        transaction: UPGRADE_TRANSACTION,
        purchasedPlan: plan({}),
        selectedDurationDays: 30,
      });

      const expiresAt = store.subscription.expiresAt as Date;
      const newTermId = store.terms.find((term) => term.status === 'ACTIVE')!.id;
      const byId = (id: string) => store.entitlements.find((row) => row.id === id)!;
      assert.equal(byId('ent-early').expiresAt?.getTime(), earlyEnd.getTime(), 'its own, earlier date stays');
      assert.ok(earlyEnd.getTime() < expiresAt.getTime(), 'fixture: it ends before the new end');
      assert.equal(byId('ent-early').termId, newTermId);
      assert.equal(byId('ent-late').expiresAt?.getTime(), expiresAt.getTime(), 'never later than the subscription');
      assert.equal(byId('ent-late').termId, newTermId);
      assert.equal(byId('ent-epoch').expiresAt?.getTime(), expiresAt.getTime());
      assert.equal(byId('ent-epoch').termId, 'term-old', 'its epoch belongs to the old term');
      assert.equal(byId('ent-expiring').version, 1);
      assert.deepEqual(
        store.entitlementEvents.map((event) => [event['entitlementId'], event['reason'], event['commandKey']]),
        [
          ['ent-early', 'UPGRADE_KEPT_OWN_END', 'upgrade-carry:v2'],
          ['ent-late', 'UPGRADE_KEPT_OWN_END', 'upgrade-carry:v2'],
          ['ent-epoch', 'UPGRADE_KEPT_OWN_END', 'upgrade-carry:v2'],
        ],
      );
      // Still counted once, on the new base: 500 + 50 + 10 GB, 10 + 2 devices.
      assert.equal(store.subscriptionUpdate!.trafficLimit, 560);
      assert.equal(store.subscriptionUpdate!.deviceLimit, 12);
    });
  });

  it('carries what sat above the old plan on the durable path too: a grandfathered 3 + 2 onto a 10-device plan is 12, not 5', async () => {
    // The cutover folded a legacy +2 into the term's base (5). The recompute
    // used to run BEFORE the new snapshot was written, compared the old
    // column with the old snapshot, read 5 as an absolute value and froze it.
    await withShadowFlag('true', async () => {
      const store = createStore({
        terms: [activeCutoverTerm({ startsAt: inDays(-20), endsAt: inDays(10), baseDeviceLimit: 5 })],
        subscription: {
          expiresAt: inDays(10),
          trafficLimit: 100,
          deviceLimit: 5,
          planSnapshot: { id: 'plan-old', trafficLimit: 100, deviceLimit: 3 },
        },
      });
      const service = buildService(store.tx);

      await upgradeOf(service)({
        transaction: UPGRADE_TRANSACTION,
        purchasedPlan: plan({ trafficLimit: 500, deviceLimit: 10 }),
        selectedDurationDays: 30,
      });

      assert.equal(store.projections['sub-1']!['desiredDeviceLimit'], 12);
      assert.equal(store.subscriptionUpdate!.deviceLimit, 12);
      assert.equal(store.subscriptionUpdate!.trafficLimit, 500);
      assert.equal(store.syncJobs[0]!.aggregateKey, 'sub-1');
    });
  });

  it('carries the live add-ons once on the durable path — 550 / 12, not 600 / 14', async () => {
    // The columns mirror the old plan's 100 GB / 3 plus the live add-ons the
    // last recompute recorded. The carry puts the recorded share back onto the
    // new plan, and the recompute takes it out again before it compares — so
    // each add-on is counted exactly once, on the new base.
    await withShadowFlag('true', async () => {
      const store = createStore({
        terms: [activeCutoverTerm({ startsAt: inDays(-20), endsAt: inDays(10) })],
        entitlements: [
          { id: 'ent-gb', subscriptionId: 'sub-1', termId: 'term-old', type: 'EXTRA_TRAFFIC', state: 'ACTIVE', totalValue: 50n * GIB, expiresAt: inDays(10) },
          { id: 'ent-dev', subscriptionId: 'sub-1', termId: 'term-old', type: 'EXTRA_DEVICES', state: 'ACTIVE', totalValue: 2n, expiresAt: inDays(10) },
        ],
        subscription: {
          expiresAt: inDays(10),
          trafficLimit: 150,
          deviceLimit: 5,
          planSnapshot: { id: 'plan-old', trafficLimit: 100, deviceLimit: 3 },
        },
        projections: { 'sub-1': projectionOverOldTerm({ trafficBytes: 50n * GIB, devices: 2 }) },
      });
      const service = buildService(store.tx);

      await upgradeOf(service)({
        transaction: UPGRADE_TRANSACTION,
        purchasedPlan: plan({ trafficLimit: 500, deviceLimit: 10 }),
        selectedDurationDays: 30,
      });

      assert.equal(store.stats.termCreates, 1, 'the durable path ran');
      assert.equal(store.subscriptionUpdate!.trafficLimit, 550, '600 would count the live add-on twice');
      assert.equal(store.subscriptionUpdate!.deviceLimit, 12, '14 would count the live add-on twice');
    });
  });

  it('does not carry an operator’s cut: the new plan plus the paid share, 550 / 12', async () => {
    // The base was cut to 80 GB / 2 devices under live add-ons of 50 GB / 2,
    // so the columns hold 130 / 4. A lowered limit does not carry; the paid
    // add-ons do, once.
    await withShadowFlag('true', async () => {
      const store = createStore({
        terms: [activeCutoverTerm({ startsAt: inDays(-20), endsAt: inDays(10) })],
        entitlements: [
          { id: 'ent-gb', subscriptionId: 'sub-1', termId: 'term-old', type: 'EXTRA_TRAFFIC', state: 'ACTIVE', totalValue: 50n * GIB, expiresAt: inDays(10) },
          { id: 'ent-dev', subscriptionId: 'sub-1', termId: 'term-old', type: 'EXTRA_DEVICES', state: 'ACTIVE', totalValue: 2n, expiresAt: inDays(10) },
        ],
        subscription: {
          expiresAt: inDays(10),
          trafficLimit: 130,
          deviceLimit: 4,
          planSnapshot: { id: 'plan-old', trafficLimit: 100, deviceLimit: 3 },
        },
        projections: { 'sub-1': projectionOverOldTerm({ trafficBytes: 50n * GIB, devices: 2 }) },
      });
      const service = buildService(store.tx);

      await upgradeOf(service)({
        transaction: UPGRADE_TRANSACTION,
        purchasedPlan: plan({ trafficLimit: 500, deviceLimit: 10 }),
        selectedDurationDays: 30,
      });

      assert.equal(store.subscriptionUpdate!.trafficLimit, 550);
      assert.equal(store.subscriptionUpdate!.deviceLimit, 12);
    });
  });

  it('follows the term ROW with the flag off: an ACTIVE term still moves onto the new plan', async () => {
    // Turning stage 1 off after terms exist used to leave the old term's base
    // in force: the next recompute — an add-on expiry — put the old plan back.
    await withShadowFlag(undefined, async () => {
      const store = createStore({
        terms: [activeCutoverTerm({ startsAt: inDays(-20), endsAt: inDays(10) })],
        entitlements: [
          { id: 'ent-1', subscriptionId: 'sub-1', termId: 'term-old', type: 'EXTRA_TRAFFIC', state: 'ACTIVE', totalValue: 50n * GIB, expiresAt: inDays(10) },
        ],
        subscription: { expiresAt: inDays(10) },
      });
      const service = buildService(store.tx);

      await upgradeOf(service)({
        transaction: UPGRADE_TRANSACTION,
        purchasedPlan: plan({}),
        selectedDurationDays: 30,
      });

      assert.equal(store.terms.find((term) => term.id === 'term-old')?.status, 'ENDED');
      const active = store.terms.filter((term) => term.status === 'ACTIVE');
      assert.equal(active.length, 1);
      assert.equal(active[0]!.baseTrafficLimitBytes, 500n * GIB);
      assert.equal(store.syncJobs[0]!.aggregateKey, 'sub-1');
      assert.equal(store.syncJobs[0]!.cause, 'PLAN_CHANGE');
      assert.equal(store.subscriptionUpdate!.trafficLimit, 550);
    });
  });

  it('stays on the columns with the flag off and no term: no term, no projection, no versioned job', async () => {
    // OFF spelled out: unset is ON since the 24.09.2026 flip.
    await withShadowFlag('false', async () => {
      const store = createStore({ terms: [] });
      const service = buildService(store.tx);

      await upgradeOf(service)({
        transaction: UPGRADE_TRANSACTION,
        purchasedPlan: plan({}),
        selectedDurationDays: 30,
      });

      assert.equal(store.stats.termCreates, 0, 'flag off must not bring it into the model');
      assert.equal(store.stats.activeTermProjectionQueries, 0, 'nothing to recompute');
      assert.deepEqual(store.projections, {});
      assert.equal(store.subscriptionUpdate!.trafficLimit, 500);
      assert.equal(store.subscriptionUpdate!.deviceLimit, 10);
      assert.equal(store.syncJobs.length, 1);
      assert.equal(store.syncJobs[0]!.aggregateKey, undefined);
      assert.equal(store.syncJobs[0]!.desiredRevision, undefined);
      assert.equal(store.syncJobs[0]!.cause, undefined);
    });
  });
});
