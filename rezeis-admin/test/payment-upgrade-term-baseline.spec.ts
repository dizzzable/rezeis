import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EffectiveProjectionService } from '../src/modules/add-on-entitlements/services/effective-projection.service';
import { SubscriptionTermService } from '../src/modules/add-on-entitlements/services/subscription-term.service';
import { PaymentSubscriptionMutationService } from '../src/modules/payments/services/payment-subscription-mutation.service';

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
}

interface StoreOptions {
  readonly terms: readonly TermRow[];
  readonly entitlements?: readonly EntitlementRow[];
  readonly subscriptionStatus?: string;
}

/** Tracks what the fake actually served, so a silently inert fake fails loudly. */
interface StoreStats {
  activeTermProjectionQueries: number;
  termCreates: number;
  termActivations: number;
  entitlementCountQueries: number;
}

function createStore(options: StoreOptions) {
  const terms: TermRow[] = options.terms.map((term) => ({ ...term }));
  const entitlements: EntitlementRow[] = (options.entitlements ?? []).map((row) => ({ ...row }));
  const projections: Record<string, Record<string, unknown>> = {};
  const syncJobs: Array<Record<string, unknown>> = [];
  let subscriptionUpdate: Record<string, unknown> | null = null;
  const stats: StoreStats = {
    activeTermProjectionQueries: 0,
    termCreates: 0,
    termActivations: 0,
    entitlementCountQueries: 0,
  };
  const subscription = {
    id: 'sub-1',
    status: options.subscriptionStatus ?? 'ACTIVE',
    remnawaveId: 'rw-1',
    isTrial: false,
    expiresAt: new Date('2026-09-01T00:00:00.000Z'),
    trafficLimit: 100,
    deviceLimit: 3,
    planSnapshot: { id: 'plan-old' },
    internalSquads: ['old-squad'],
    externalSquad: null,
  };

  const matches = (row: Record<string, unknown>, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([key, expected]) => {
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
      return [{ id: subscription.id, status: subscription.status }];
    },
    subscription: {
      findUnique: async () => ({ ...subscription }),
      update: async ({ data }: { data: Record<string, unknown> }) => {
        subscriptionUpdate = data;
        return { ...subscription, ...data, id: subscription.id, remnawaveId: subscription.remnawaveId };
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
    },
    addOnEntitlement: {
      findMany: async (input: { where: Record<string, unknown> }) =>
        entitlements
          .filter((row) => matches(row as unknown as Record<string, unknown>, input.where))
          .map((row) => ({ type: row.type, totalValue: row.totalValue })),
      count: async (input: { where: Record<string, unknown> }) => {
        stats.entitlementCountQueries += 1;
        return entitlements.filter((row) =>
          matches(row as unknown as Record<string, unknown>, input.where),
        ).length;
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
    transaction: { update: async () => undefined },
  };

  return {
    tx,
    terms,
    stats,
    syncJobs,
    projections,
    get subscriptionUpdate() {
      return subscriptionUpdate;
    },
  };
}

function buildService(tx: unknown) {
  const prisma = { $transaction: async (fn: (client: unknown) => unknown) => fn(tx) };
  return new PaymentSubscriptionMutationService(
    prisma as never,
    { info: () => undefined, warn: () => undefined, error: () => undefined } as never,
    {} as never,
    new EffectiveProjectionService() as never,
    new SubscriptionTermService() as never,
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
      const store = createStore({
        terms: [
          activeCutoverTerm(),
          activeCutoverTerm({
            id: 'term-queued',
            generation: 2,
            status: 'SCHEDULED',
            startsAt: new Date('2026-09-01T00:00:00.000Z'),
            endsAt: new Date('2026-10-01T00:00:00.000Z'),
          }),
        ],
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

  it('keeps the previous baseline rather than stranding entitlements on a queued term', async () => {
    await withShadowFlag('true', async () => {
      const store = createStore({
        terms: [
          activeCutoverTerm(),
          activeCutoverTerm({ id: 'term-queued', generation: 2, status: 'SCHEDULED' }),
        ],
        entitlements: [
          {
            id: 'ent-queued',
            subscriptionId: 'sub-1',
            termId: 'term-queued',
            type: 'EXTRA_DEVICES',
            state: 'PENDING_ACTIVATION',
            totalValue: 2n,
          },
        ],
      });
      const service = buildService(store.tx);

      await upgradeOf(service)({
        transaction: UPGRADE_TRANSACTION,
        purchasedPlan: plan({}),
        selectedDurationDays: 30,
      });

      // Self-check: this outcome is identical to the pre-fix behaviour, so
      // without proof the guard actually ran the test would be green against
      // the bug it is meant to bound. The count query only exists in the fix.
      assert.equal(
        store.stats.entitlementCountQueries,
        1,
        'the scheduled-term entitlement guard must have been consulted',
      );
      // Paid goods survive; the fulfillment stays on the legacy column path.
      assert.equal(store.terms.find((term) => term.id === 'term-queued')?.status, 'SCHEDULED');
      assert.equal(store.stats.termCreates, 0);
      assert.equal(store.syncJobs[0]!.aggregateKey, undefined);
      assert.equal(store.subscriptionUpdate!.trafficLimit, 500);
    });
  });

  it('is inert with the durable-term flag off: no term, no projection, no versioned job', async () => {
    await withShadowFlag(undefined, async () => {
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
        purchasedPlan: plan({}),
        selectedDurationDays: 30,
      });

      assert.equal(store.stats.termCreates, 0, 'flag off must not mint a term');
      assert.equal(store.stats.activeTermProjectionQueries, 0, 'flag off must not recompute');
      assert.deepEqual(store.projections, {});
      assert.equal(store.terms.length, 1);
      assert.equal(store.terms[0]!.status, 'ACTIVE');
      assert.equal(
        store.terms[0]!.baseTrafficLimitBytes,
        100n * GIB,
        'flag off leaves the term untouched, exactly as before the fix',
      );
      // Raw plan values on the columns and a non-versioned job: the pre-fix shape.
      assert.equal(store.subscriptionUpdate!.trafficLimit, 500);
      assert.equal(store.subscriptionUpdate!.deviceLimit, 10);
      assert.equal(store.syncJobs.length, 1);
      assert.equal(store.syncJobs[0]!.aggregateKey, undefined);
      assert.equal(store.syncJobs[0]!.desiredRevision, undefined);
      assert.equal(store.syncJobs[0]!.cause, undefined);
    });
  });
});
