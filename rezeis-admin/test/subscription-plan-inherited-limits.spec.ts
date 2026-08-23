import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PaymentSubscriptionMutationService } from '../src/modules/payments/services/payment-subscription-mutation.service';
import {
  PLAN_INHERITED_LIMIT_KEYS,
  resolveInheritedPlanLimitUpdate,
} from '../src/modules/subscriptions/services/plan-inherited-limits.util';
import { buildPlanSnapshot as buildAdminPlanSnapshot } from '../src/modules/users/utils/plan-snapshot.util';

const DAY_MS = 24 * 60 * 60 * 1000;
const GIB = 1024n * 1024n * 1024n;

/** What the LAST projection recompute recorded as the live add-on share. */
interface RecordedContribution {
  readonly activeTrafficContributionBytes: bigint;
  readonly activeDeviceContribution: number;
}

// ───────────────────────────────────────────────────────────────────────────
// Part A — the resolver itself
// ───────────────────────────────────────────────────────────────────────────

const PLAN_LIMITS = {
  trafficLimit: 2048,
  deviceLimit: 7,
  internalSquads: ['squad-new-a', 'squad-new-b'],
  externalSquad: 'ext-new',
} as const;

const ASSIGNED_LIMITS = {
  trafficLimit: 1024,
  deviceLimit: 3,
  internalSquads: ['squad-a', 'squad-b'],
  externalSquad: 'ext-1',
} as const;

function snapshotOf(limits: {
  trafficLimit: number | null;
  deviceLimit: number;
  internalSquads: readonly string[];
  externalSquad: string | null;
}): Record<string, unknown> {
  return {
    id: 'plan-1',
    name: 'Plan',
    trafficLimit: limits.trafficLimit,
    deviceLimit: limits.deviceLimit,
    internalSquads: [...limits.internalSquads],
    externalSquad: limits.externalSquad,
  };
}

describe('resolveInheritedPlanLimitUpdate', () => {
  it('refreshes every field whose column still equals the snapshot', () => {
    const update = resolveInheritedPlanLimitUpdate({
      current: { ...ASSIGNED_LIMITS, internalSquads: [...ASSIGNED_LIMITS.internalSquads] },
      planSnapshot: snapshotOf(ASSIGNED_LIMITS),
      plan: { ...PLAN_LIMITS, internalSquads: [...PLAN_LIMITS.internalSquads] },
    });

    assert.deepStrictEqual(update, {
      trafficLimit: 2048,
      deviceLimit: 7,
      internalSquads: ['squad-new-a', 'squad-new-b'],
      externalSquad: 'ext-new',
    });
  });

  it('omits only the overridden field and still refreshes the other three', () => {
    const update = resolveInheritedPlanLimitUpdate({
      current: {
        ...ASSIGNED_LIMITS,
        deviceLimit: 25,
        internalSquads: [...ASSIGNED_LIMITS.internalSquads],
      },
      planSnapshot: snapshotOf(ASSIGNED_LIMITS),
      plan: { ...PLAN_LIMITS, internalSquads: [...PLAN_LIMITS.internalSquads] },
    });

    assert.equal('deviceLimit' in update, false, 'an operator-set deviceLimit must not be rewritten');
    assert.deepStrictEqual(update, {
      trafficLimit: 2048,
      internalSquads: ['squad-new-a', 'squad-new-b'],
      externalSquad: 'ext-new',
    });
  });

  it('treats a reordered internalSquads array as inherited, not as an override', () => {
    // Comparing by reference or by JSON string would freeze this column for
    // the rest of the subscription's life after a harmless reordering.
    const update = resolveInheritedPlanLimitUpdate({
      current: { ...ASSIGNED_LIMITS, internalSquads: ['squad-b', 'squad-a'] },
      planSnapshot: snapshotOf(ASSIGNED_LIMITS),
      plan: { ...PLAN_LIMITS, internalSquads: [...PLAN_LIMITS.internalSquads] },
    });

    assert.deepStrictEqual(update.internalSquads, ['squad-new-a', 'squad-new-b']);
  });

  it('treats a different squad membership as an override', () => {
    const update = resolveInheritedPlanLimitUpdate({
      current: { ...ASSIGNED_LIMITS, internalSquads: ['squad-a', 'squad-b', 'squad-extra'] },
      planSnapshot: snapshotOf(ASSIGNED_LIMITS),
      plan: { ...PLAN_LIMITS, internalSquads: [...PLAN_LIMITS.internalSquads] },
    });

    assert.equal('internalSquads' in update, false);
  });

  it('compares the nullable fields by value, so null === null is inherited', () => {
    const nulled = {
      trafficLimit: null,
      deviceLimit: 3,
      internalSquads: [] as string[],
      externalSquad: null,
    };
    const update = resolveInheritedPlanLimitUpdate({
      current: { ...nulled },
      planSnapshot: snapshotOf(nulled),
      plan: { ...PLAN_LIMITS, internalSquads: [...PLAN_LIMITS.internalSquads] },
    });

    assert.deepStrictEqual(update, {
      trafficLimit: 2048,
      deviceLimit: 7,
      internalSquads: ['squad-new-a', 'squad-new-b'],
      externalSquad: 'ext-new',
    });
  });

  it('treats null-vs-number and null-vs-string as overrides on the nullable fields', () => {
    const update = resolveInheritedPlanLimitUpdate({
      current: {
        trafficLimit: null,
        deviceLimit: 3,
        internalSquads: [...ASSIGNED_LIMITS.internalSquads],
        externalSquad: null,
      },
      planSnapshot: snapshotOf(ASSIGNED_LIMITS),
      plan: { ...PLAN_LIMITS, internalSquads: [...PLAN_LIMITS.internalSquads] },
    });

    assert.equal('trafficLimit' in update, false, 'unlimited-by-hand must survive a limited plan');
    assert.equal('externalSquad' in update, false);
    assert.deepStrictEqual(update.deviceLimit, 7);
  });

  for (const [name, snapshot] of [
    ['an empty object', {}],
    ['null', null],
    ['an array', [1, 2, 3]],
    ['a string', 'not-json-object'],
    ['a number', 7],
  ] as const) {
    it(`preserves every column when the snapshot is ${name}`, () => {
      const update = resolveInheritedPlanLimitUpdate({
        current: { ...ASSIGNED_LIMITS, internalSquads: [...ASSIGNED_LIMITS.internalSquads] },
        planSnapshot: snapshot,
        plan: { ...PLAN_LIMITS, internalSquads: [...PLAN_LIMITS.internalSquads] },
      });

      assert.deepStrictEqual(update, {}, 'undecidable must write nothing at all');
    });
  }

  it('preserves per field when the snapshot carries the wrong type for that field', () => {
    const update = resolveInheritedPlanLimitUpdate({
      current: { ...ASSIGNED_LIMITS, internalSquads: [...ASSIGNED_LIMITS.internalSquads] },
      planSnapshot: {
        trafficLimit: '1024',
        deviceLimit: 3,
        internalSquads: 'squad-a,squad-b',
        externalSquad: 42,
      },
      plan: { ...PLAN_LIMITS, internalSquads: [...PLAN_LIMITS.internalSquads] },
    });

    // Only the one well-typed, matching field is refreshed.
    assert.deepStrictEqual(update, { deviceLimit: 7 });
  });

  it('preserves a field the snapshot simply predates', () => {
    const update = resolveInheritedPlanLimitUpdate({
      current: { ...ASSIGNED_LIMITS, internalSquads: [...ASSIGNED_LIMITS.internalSquads] },
      planSnapshot: { id: 'plan-1', name: 'Plan', deviceLimit: 3 },
      plan: { ...PLAN_LIMITS, internalSquads: [...PLAN_LIMITS.internalSquads] },
    });

    assert.deepStrictEqual(update, { deviceLimit: 7 });
  });

  it('copies the squad array instead of aliasing the plan row', () => {
    const plan = { ...PLAN_LIMITS, internalSquads: [...PLAN_LIMITS.internalSquads] };
    const update = resolveInheritedPlanLimitUpdate({
      current: { ...ASSIGNED_LIMITS, internalSquads: [...ASSIGNED_LIMITS.internalSquads] },
      planSnapshot: snapshotOf(ASSIGNED_LIMITS),
      plan,
    });

    assert.notEqual(update.internalSquads, plan.internalSquads);
    assert.deepStrictEqual(update.internalSquads, plan.internalSquads);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Part B — the renewal paths
// ───────────────────────────────────────────────────────────────────────────

interface SubState {
  id: string;
  status: string;
  isTrial: boolean;
  expiresAt: Date | null;
  remnawaveId: string | null;
  planSnapshot: unknown;
  trafficLimit: number | null;
  deviceLimit: number;
  internalSquads: string[];
  externalSquad: string | null;
}

interface PlanRow {
  id: string;
  name: string;
  description: string | null;
  tag: string | null;
  type: string;
  icon: string | null;
  availability: string;
  trafficLimit: number | null;
  deviceLimit: number;
  trafficLimitStrategy: string;
  internalSquads: string[];
  externalSquad: string | null;
}

function makeSubscription(overrides: Partial<SubState> = {}): SubState {
  return {
    id: 'sub-1',
    status: 'ACTIVE',
    isTrial: false,
    expiresAt: new Date(Date.now() + 10 * DAY_MS),
    remnawaveId: 'rw-1',
    planSnapshot: snapshotOf(ASSIGNED_LIMITS),
    trafficLimit: ASSIGNED_LIMITS.trafficLimit,
    deviceLimit: ASSIGNED_LIMITS.deviceLimit,
    internalSquads: [...ASSIGNED_LIMITS.internalSquads],
    externalSquad: ASSIGNED_LIMITS.externalSquad,
    ...overrides,
  };
}

function makePlan(overrides: Partial<PlanRow> = {}): PlanRow {
  return {
    id: 'plan-1',
    name: 'Plan',
    description: null,
    tag: null,
    type: 'BOTH',
    icon: null,
    availability: 'ALL',
    trafficLimit: PLAN_LIMITS.trafficLimit,
    deviceLimit: PLAN_LIMITS.deviceLimit,
    trafficLimitStrategy: 'NO_RESET',
    internalSquads: [...PLAN_LIMITS.internalSquads],
    externalSquad: PLAN_LIMITS.externalSquad,
    ...overrides,
  };
}

interface RenewalOutcome {
  /** The row as it stands after the renewal transaction commits. */
  readonly row: SubState;
  /**
   * The row exactly as it stood when `profileSyncJob.create` ran — i.e. what
   * `ProfileSyncProcessor` will read and push into the Remnawave panel. The
   * database row alone is not enough: the push is where the harm lands.
   */
  readonly syncJobView: SubState;
  readonly updateData: Record<string, unknown>;
  readonly termCreated: boolean;
  /** How many times the renewal asked for the recorded add-on contribution. */
  readonly projectionReads: number;
}

function assertForUpdate(query: unknown): void {
  const statement =
    typeof query === 'object' && query !== null && 'sql' in query
      ? String((query as { readonly sql: unknown }).sql)
      : String(query);
  assert.match(statement.replace(/\s+/g, ' '), /\bFOR\s+UPDATE\b/i);
}

/**
 * Shared transaction double for both renewal shapes. Mutates one in-memory row
 * so the sequencing between `subscription.update` and `profileSyncJob.create`
 * is observable.
 */
function createTxDouble(
  state: SubState,
  plan: PlanRow,
  durableTerm: boolean,
  recorded: RecordedContribution | null,
) {
  const captured = {
    updateData: null as Record<string, unknown> | null,
    syncJobView: null as SubState | null,
    termCreated: false,
    projectionReads: 0,
  };
  const snapshotRow = (): SubState => ({ ...state, internalSquads: [...state.internalSquads] });
  const tx = {
    $queryRaw: async (query: unknown) => {
      assertForUpdate(query);
      return [{ id: state.id, status: state.status }];
    },
    subscriptionTerm: {
      findFirst: async (query: { where?: { status?: unknown } }) => {
        if (!durableTerm) return null;
        if (query?.where?.status === 'ACTIVE') return { id: 'term-active' };
        return { id: 'term-active', status: 'ACTIVE', generation: 1, endsAt: state.expiresAt };
      },
    },
    // The add-on share the LAST recompute recorded. `null` is a subscription
    // with no projection row at all, which is the `?? 0` the renewal falls back
    // to — never a hard zero invented at the call site.
    subscriptionEffectiveProjection: {
      findUnique: async () => {
        captured.projectionReads += 1;
        return recorded;
      },
    },
    plan: { findUnique: async () => plan },
    subscription: {
      findUnique: async () => snapshotRow(),
      update: async ({ data }: { data: Record<string, unknown> }) => {
        captured.updateData = data;
        Object.assign(state, data);
        return snapshotRow();
      },
    },
    profileSyncJob: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        captured.syncJobView = snapshotRow();
        return { id: 'job-1', ...data };
      },
    },
    transaction: { update: async () => ({}) },
  };
  return { tx, captured, snapshotRow };
}

function makeService(prisma: unknown, termCreated: { value: boolean }) {
  return new PaymentSubscriptionMutationService(
    prisma as never,
    { info: () => undefined, warn: () => undefined } as never,
    {} as never,
    {} as never,
    {
      createScheduledInTransaction: async () => {
        termCreated.value = true;
        return { id: 'term-2', generation: 2, status: 'SCHEDULED' };
      },
    } as never,
  );
}

async function withShadowFlag<T>(enabled: boolean, run: () => Promise<T>): Promise<T> {
  const previous = process.env.ADDON_ENTITLEMENT_SHADOW;
  if (enabled) process.env.ADDON_ENTITLEMENT_SHADOW = 'true';
  else delete process.env.ADDON_ENTITLEMENT_SHADOW;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.ADDON_ENTITLEMENT_SHADOW;
    else process.env.ADDON_ENTITLEMENT_SHADOW = previous;
  }
}

/** Drives `renewSubscriptionFromPayment` — the single-subscription renewal. */
async function runSingleRenewal(input: {
  subscription: SubState;
  plan: PlanRow;
  durableTerm: boolean;
  durationDays?: number;
  recorded?: RecordedContribution;
}): Promise<RenewalOutcome> {
  const durationDays = input.durationDays ?? 30;
  const state = { ...input.subscription, internalSquads: [...input.subscription.internalSquads] };
  const { tx, captured } = createTxDouble(
    state,
    input.plan,
    input.durableTerm,
    input.recorded ?? null,
  );
  const termCreated = { value: false };
  const prisma = { $transaction: async (cb: (client: unknown) => unknown) => cb(tx) };
  const service = makeService(prisma, termCreated);
  const renew = (
    service as unknown as {
      renewSubscriptionFromPayment(payload: {
        transaction: unknown;
        purchasedPlan: unknown;
        selectedDurationDays: number;
      }): Promise<unknown>;
    }
  ).renewSubscriptionFromPayment.bind(service);

  await withShadowFlag(input.durableTerm, () =>
    renew({
      transaction: {
        id: 'tx-1',
        paymentId: 'pay-1',
        userId: 'user-1',
        subscriptionId: state.id,
        purchaseType: 'RENEW',
        gatewayType: 'YOOKASSA',
        currency: 'USD',
        amount: { toString: () => '10' },
        planSnapshot: { id: input.plan.id, availability: 'ALL', selectedDurationDays: durationDays },
      },
      purchasedPlan: input.plan,
      selectedDurationDays: durationDays,
    }),
  );

  assert.notEqual(captured.updateData, null, 'the renewal must have written the subscription');
  assert.notEqual(captured.syncJobView, null, 'the renewal must have enqueued a profile sync job');
  return {
    row: state,
    syncJobView: captured.syncJobView!,
    updateData: captured.updateData!,
    termCreated: termCreated.value,
    projectionReads: captured.projectionReads,
  };
}

function renewalDraftSnapshot(plan: PlanRow, durationDays: number): Record<string, unknown> {
  return {
    snapshotVersion: 1,
    snapshotSource: 'RENEWAL_DRAFT',
    purchaseType: 'RENEW',
    id: plan.id,
    name: plan.name,
    description: plan.description,
    tag: plan.tag,
    type: plan.type,
    icon: plan.icon,
    trafficLimit: plan.trafficLimit,
    deviceLimit: plan.deviceLimit,
    trafficLimitStrategy: plan.trafficLimitStrategy,
    internalSquads: [...plan.internalSquads],
    externalSquad: plan.externalSquad,
    selectedDurationDays: durationDays,
    gatewayType: 'YOOKASSA',
    amount: '10',
    currency: 'USD',
  };
}

/** Drives `applyCompletedTransaction` down the combined multi-item renewal. */
async function runCombinedRenewal(input: {
  subscription: SubState;
  plan: PlanRow;
  durableTerm: boolean;
  durationDays?: number;
  recorded?: RecordedContribution;
}): Promise<RenewalOutcome> {
  const durationDays = input.durationDays ?? 30;
  const state = { ...input.subscription, internalSquads: [...input.subscription.internalSquads] };
  const { tx, captured } = createTxDouble(
    state,
    input.plan,
    input.durableTerm,
    input.recorded ?? null,
  );
  const termCreated = { value: false };
  const item = {
    id: 'item-1',
    subscriptionId: state.id,
    planId: input.plan.id,
    durationDays,
    appliedAt: null as Date | null,
    amount: '10',
    currency: 'USD',
    addOnLines: null,
    planSnapshot: renewalDraftSnapshot(input.plan, durationDays),
  };
  const txWithItems = {
    ...tx,
    transactionItem: {
      updateMany: async () => ({ count: 1 }),
      findUnique: async () => item,
      update: async () => item,
    },
  };
  const prisma = {
    transactionItem: { findMany: async () => [item] },
    user: { updateMany: async () => ({ count: 0 }) },
    $transaction: async (cb: (client: unknown) => unknown) => cb(txWithItems),
  };
  const service = makeService(prisma, termCreated);

  await withShadowFlag(input.durableTerm, () =>
    service.applyCompletedTransaction({
      id: 'tx-1',
      paymentId: 'pay-1',
      userId: 'user-1',
      subscriptionId: null,
      purchaseType: 'RENEW',
      gatewayType: 'YOOKASSA',
      currency: 'USD',
      amount: { toString: () => '10' },
      planSnapshot: { combinedRenewal: true, snapshotVersion: 1 },
    } as never),
  );

  assert.notEqual(captured.updateData, null, 'the renewal must have written the subscription');
  assert.notEqual(captured.syncJobView, null, 'the renewal must have enqueued a profile sync job');
  return {
    row: state,
    syncJobView: captured.syncJobView!,
    updateData: captured.updateData!,
    termCreated: termCreated.value,
    projectionReads: captured.projectionReads,
  };
}

const RENEWAL_PATHS = [
  { name: 'single-subscription renewal', run: runSingleRenewal },
  { name: 'combined multi-subscription renewal', run: runCombinedRenewal },
] as const;

describe('renewal preserves operator overrides and refreshes inherited limits', () => {
  for (const path of RENEWAL_PATHS) {
    for (const durableTerm of [false, true]) {
      const label = `${path.name} (durable term ${durableTerm ? 'ON' : 'OFF'})`;

      it(`${label}: an operator-raised deviceLimit survives the renewal`, async () => {
        const outcome = await path.run({
          subscription: makeSubscription({ deviceLimit: 25 }),
          plan: makePlan(),
          durableTerm,
        });

        assert.equal(outcome.row.deviceLimit, 25, 'the operator override must not be reverted');
        assert.notEqual(
          outcome.row.deviceLimit,
          PLAN_LIMITS.deviceLimit,
          'the plan value must not have been re-applied',
        );
      });

      it(`${label}: the profile sync job carries the PRESERVED deviceLimit, not the plan value`, async () => {
        const outcome = await path.run({
          subscription: makeSubscription({ deviceLimit: 25 }),
          plan: makePlan(),
          durableTerm,
        });

        // The push is where the harm lands: a test that stopped at the row
        // would pass even if the job had been enqueued before the update.
        assert.equal(outcome.syncJobView.deviceLimit, 25);
        assert.notEqual(outcome.syncJobView.deviceLimit, PLAN_LIMITS.deviceLimit);
      });

      it(`${label}: an operator-raised trafficLimit and hand-picked squads survive`, async () => {
        const outcome = await path.run({
          subscription: makeSubscription({
            trafficLimit: 99999,
            internalSquads: ['squad-hand-picked'],
            externalSquad: 'ext-hand-picked',
          }),
          plan: makePlan(),
          durableTerm,
        });

        assert.equal(outcome.row.trafficLimit, 99999);
        assert.deepStrictEqual(outcome.row.internalSquads, ['squad-hand-picked']);
        assert.equal(outcome.row.externalSquad, 'ext-hand-picked');
        assert.equal(outcome.syncJobView.trafficLimit, 99999);
        assert.deepStrictEqual(outcome.syncJobView.internalSquads, ['squad-hand-picked']);
        assert.equal(outcome.syncJobView.externalSquad, 'ext-hand-picked');
      });

      it(`${label}: a plan edit still reaches a subscription that was never adjusted`, async () => {
        // Pins the OTHER direction. Without this, freezing every column would
        // also pass the override tests above.
        const outcome = await path.run({
          subscription: makeSubscription(),
          plan: makePlan(),
          durableTerm,
        });

        assert.equal(outcome.row.deviceLimit, PLAN_LIMITS.deviceLimit);
        assert.equal(outcome.row.trafficLimit, PLAN_LIMITS.trafficLimit);
        assert.deepStrictEqual(outcome.row.internalSquads, [...PLAN_LIMITS.internalSquads]);
        assert.equal(outcome.row.externalSquad, PLAN_LIMITS.externalSquad);
        assert.equal(outcome.syncJobView.deviceLimit, PLAN_LIMITS.deviceLimit);
        assert.equal(outcome.syncJobView.trafficLimit, PLAN_LIMITS.trafficLimit);
      });

      it(`${label}: a reordered squad list still tracks the plan`, async () => {
        const outcome = await path.run({
          subscription: makeSubscription({
            internalSquads: [...ASSIGNED_LIMITS.internalSquads].reverse(),
          }),
          plan: makePlan(),
          durableTerm,
        });

        assert.deepStrictEqual(outcome.row.internalSquads, [...PLAN_LIMITS.internalSquads]);
      });

      for (const [name, planSnapshot] of [
        ['empty', {}],
        ['missing the limit keys', { id: 'plan-1', name: 'Plan' }],
        ['malformed', 'not-an-object'],
      ] as const) {
        it(`${label}: an undecidable (${name}) snapshot PRESERVES the columns`, async () => {
          const outcome = await path.run({
            subscription: makeSubscription({
              planSnapshot,
              trafficLimit: 555,
              deviceLimit: 9,
              internalSquads: ['squad-legacy'],
              externalSquad: 'ext-legacy',
            }),
            plan: makePlan(),
            durableTerm,
          });

          assert.equal(outcome.row.trafficLimit, 555, 'wiping is the destructive direction');
          assert.equal(outcome.row.deviceLimit, 9);
          assert.deepStrictEqual(outcome.row.internalSquads, ['squad-legacy']);
          assert.equal(outcome.row.externalSquad, 'ext-legacy');
          assert.equal(outcome.syncJobView.deviceLimit, 9);
          assert.deepStrictEqual(outcome.syncJobView.internalSquads, ['squad-legacy']);
        });
      }

      it(`${label}: the renewal still extends the expiry`, async () => {
        // Anchors the harness: if the renewal stopped running at all, the
        // preservation assertions above would pass vacuously.
        const expiresAt = new Date(Date.now() + 10 * DAY_MS);
        const outcome = await path.run({
          subscription: makeSubscription({ expiresAt, deviceLimit: 25 }),
          plan: makePlan(),
          durableTerm,
        });

        assert.equal(outcome.row.expiresAt!.getTime(), expiresAt.getTime() + 30 * DAY_MS);
        assert.equal(outcome.termCreated, durableTerm, 'the durable-term branch must be exercised');
      });
    }

    it(`${path.name}: both term branches produce identical limit columns`, async () => {
      // The add-on rollout flag decides whether a durable term exists. It must
      // NOT be able to decide what happens to these four columns.
      for (const subscription of [
        makeSubscription({ deviceLimit: 25 }),
        makeSubscription(),
        makeSubscription({ planSnapshot: {}, deviceLimit: 9 }),
        makeSubscription({ trafficLimit: null, externalSquad: null }),
      ]) {
        const withoutTerm = await path.run({ subscription, plan: makePlan(), durableTerm: false });
        const withTerm = await path.run({ subscription, plan: makePlan(), durableTerm: true });

        assert.equal(withoutTerm.termCreated, false);
        assert.equal(withTerm.termCreated, true, 'the two runs must differ in the term, and only there');
        assert.deepStrictEqual(
          {
            trafficLimit: withTerm.row.trafficLimit,
            deviceLimit: withTerm.row.deviceLimit,
            internalSquads: withTerm.row.internalSquads,
            externalSquad: withTerm.row.externalSquad,
          },
          {
            trafficLimit: withoutTerm.row.trafficLimit,
            deviceLimit: withoutTerm.row.deviceLimit,
            internalSquads: withoutTerm.row.internalSquads,
            externalSquad: withoutTerm.row.externalSquad,
          },
        );
      }
    });

    for (const [shape, planSnapshot] of [
      ['no snapshot object at all', null],
      ['a snapshot with none of the keys', {}],
    ] as const) {
      it(`${path.name}: preserves even when the paid plan is MORE generous (${shape})`, async () => {
        // The accepted cost of resolving UNDECIDABLE toward preserving. This
        // row carries no readable baseline, so nothing says whether its
        // smaller columns were inherited or hand-set — and the renewal it is
        // paying for grants MORE. It still keeps what it has.
        //
        // Deliberate, not an oversight: rows without a readable snapshot are
        // the imported/legacy ones an operator is most likely to have
        // hand-tuned, and applying the plan to them would silently take
        // service away from whoever WAS adjusted. Both shapes are covered
        // because they take different branches — `null` hits the
        // `snapshot === null` early return, `{}` hits the per-field
        // `decided` checks. If the owner decides a renewal should raise a
        // snapshot-less row to the plan it is paying for, those are the
        // branches to flip and this test is what must change with them.
        const generousPlan = makePlan({ trafficLimit: null, deviceLimit: -1 });
        for (const durableTerm of [false, true]) {
          const outcome = await path.run({
            subscription: makeSubscription({
              planSnapshot,
              trafficLimit: 100,
              deviceLimit: 2,
            }),
            plan: generousPlan,
            durableTerm,
          });

          assert.equal(outcome.row.trafficLimit, 100, 'the unlimited plan must NOT have been applied');
          assert.equal(outcome.row.deviceLimit, 2);
          assert.equal(outcome.syncJobView.trafficLimit, 100);
          assert.equal(outcome.syncJobView.deviceLimit, 2);
        }
      });
    }
  }
});

// ───────────────────────────────────────────────────────────────────────────
// Part C — divergence guard for the three planSnapshot writers
// ───────────────────────────────────────────────────────────────────────────

describe('planSnapshot writers keep the inherited-limit keys', () => {
  it('exposes exactly the four keys override detection depends on', () => {
    assert.deepStrictEqual([...PLAN_INHERITED_LIMIT_KEYS], [
      'trafficLimit',
      'deviceLimit',
      'internalSquads',
      'externalSquad',
    ]);
  });

  function assertCarriesInheritedLimits(written: unknown, plan: PlanRow, writer: string): void {
    assert.ok(
      written !== null && typeof written === 'object' && !Array.isArray(written),
      `${writer} must write a JSON object`,
    );
    const snapshot = written as Record<string, unknown>;
    for (const key of PLAN_INHERITED_LIMIT_KEYS) {
      assert.ok(
        key in snapshot,
        `${writer} dropped "${key}"; resolveInheritedPlanLimitUpdate then freezes that column forever`,
      );
    }
    assert.equal(snapshot['trafficLimit'], plan.trafficLimit);
    assert.equal(snapshot['deviceLimit'], plan.deviceLimit);
    assert.deepStrictEqual(snapshot['internalSquads'], [...plan.internalSquads]);
    assert.equal(snapshot['externalSquad'], plan.externalSquad);
  }

  it('users/utils/plan-snapshot.util.ts buildPlanSnapshot', () => {
    const plan = makePlan();
    assertCarriesInheritedLimits(
      buildAdminPlanSnapshot(plan),
      plan,
      'buildPlanSnapshot (users/utils/plan-snapshot.util.ts)',
    );
  });

  it('payment-subscription-mutation.service.ts buildPlanSnapshot (single renewal)', async () => {
    const plan = makePlan();
    const outcome = await runSingleRenewal({
      subscription: makeSubscription(),
      plan,
      durableTerm: false,
    });
    assertCarriesInheritedLimits(
      outcome.updateData['planSnapshot'],
      plan,
      'buildPlanSnapshot (payment-subscription-mutation.service.ts)',
    );
  });

  it('payment-subscription-mutation.service.ts buildItemPlanSnapshot (combined renewal)', async () => {
    const plan = makePlan();
    const outcome = await runCombinedRenewal({
      subscription: makeSubscription(),
      plan,
      durableTerm: false,
    });
    assertCarriesInheritedLimits(
      outcome.updateData['planSnapshot'],
      plan,
      'buildItemPlanSnapshot (payment-subscription-mutation.service.ts)',
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Part D — the snapshot has to move WITH the columns
// ───────────────────────────────────────────────────────────────────────────
//
// `resolveInheritedPlanLimitUpdate` refreshes a column only while the stored
// snapshot still agrees with it. So a renewal that writes the plan's new value
// into the column and leaves the snapshot on the old one makes the row it just
// corrected read as OVERRIDDEN from then on — and the NEXT plan edit never
// reaches it.
//
// That is invisible on the FIRST edit: the column ends up equal to the new
// term's baseline and everything looks right. It only shows on the SECOND,
// which is why every case here renews TWICE. The single-renewal cases in Part B
// pass either way.

/** The plan after the operator's FIRST limit edit (the Part B plan). */
function editOne(): PlanRow {
  return makePlan();
}

/** ...and after a SECOND edit, with every one of the four keys moved again. */
function editTwo(): PlanRow {
  return makePlan({
    trafficLimit: 4096,
    deviceLimit: 11,
    internalSquads: ['squad-newer'],
    externalSquad: 'ext-newer',
  });
}

function readSnapshot(value: unknown): Record<string, unknown> {
  assert.ok(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'expected a readable planSnapshot object',
  );
  return value as Record<string, unknown>;
}

describe('a plan edit keeps reaching a never-adjusted subscriber across renewals', () => {
  for (const path of RENEWAL_PATHS) {
    for (const durableTerm of [false, true]) {
      const label = `${path.name} (durable term ${durableTerm ? 'ON' : 'OFF'})`;

      it(`${label}: a SECOND plan edit still reaches a never-adjusted subscriber`, async () => {
        const first = await path.run({
          subscription: makeSubscription(),
          plan: editOne(),
          durableTerm,
        });
        // Harness anchor: without it the assertions below could pass because
        // nothing ever ran.
        assert.equal(
          first.row.deviceLimit,
          PLAN_LIMITS.deviceLimit,
          'the FIRST plan edit must land — the harness is not exercising the renewal',
        );
        assert.equal(first.termCreated, durableTerm);

        const second = await path.run({
          subscription: first.row,
          plan: editTwo(),
          durableTerm,
        });

        assert.equal(
          second.row.deviceLimit,
          11,
          'the SECOND plan edit did not reach a subscriber who was never individually adjusted. ' +
            'The renewal refreshed the column from the plan but left planSnapshot on the previous ' +
            "plan's value, so the row now reads OVERRIDDEN and no later edit will ever touch it.",
        );
        assert.equal(second.row.trafficLimit, 4096, 'the SECOND edit must reach trafficLimit too');
        assert.deepStrictEqual(second.row.internalSquads, ['squad-newer']);
        assert.equal(second.row.externalSquad, 'ext-newer');
        // The row alone is not the harm — the push is. A job enqueued from a
        // stale view would still send the old numbers to the panel.
        assert.equal(second.syncJobView.deviceLimit, 11);
        assert.equal(second.syncJobView.trafficLimit, 4096);
        assert.deepStrictEqual(second.syncJobView.internalSquads, ['squad-newer']);
      });

      it(`${label}: the renewal leaves a snapshot recording the plan it just applied`, async () => {
        // The mechanism behind the case above, asserted directly: whatever else
        // the write does, the keys it moved must be re-declared as plan-given or
        // the next comparison misreads them.
        const outcome = await path.run({
          subscription: makeSubscription(),
          plan: editOne(),
          durableTerm,
        });

        const snapshot = readSnapshot(outcome.row.planSnapshot);
        assert.equal(snapshot['trafficLimit'], PLAN_LIMITS.trafficLimit);
        assert.equal(snapshot['deviceLimit'], PLAN_LIMITS.deviceLimit);
        assert.deepStrictEqual(snapshot['internalSquads'], [...PLAN_LIMITS.internalSquads]);
        assert.equal(snapshot['externalSquad'], PLAN_LIMITS.externalSquad);
        for (const key of PLAN_INHERITED_LIMIT_KEYS) {
          assert.equal(
            snapshot[key as string] === undefined,
            false,
            `the renewal left "${key}" out of the snapshot; that column is now frozen forever`,
          );
        }
      });
    }

    it(`${path.name}: an operator override is not laundered into the snapshot (durable term ON)`, async () => {
      // The other direction, and it is not optional: moving all four keys
      // unconditionally would satisfy the cases above and be just as wrong.
      // Writing an OPERATOR's 25 into the snapshot re-declares it as plan-given,
      // and the NEXT renewal would then read the row as inherited and reset the
      // column to the plan — deleting the operator's configuration one renewal
      // later, in the one place the whole override rule reads.
      const first = await path.run({
        subscription: makeSubscription({ deviceLimit: 25 }),
        plan: editOne(),
        durableTerm: true,
      });

      const snapshot = readSnapshot(first.row.planSnapshot);
      assert.equal(
        snapshot['deviceLimit'],
        ASSIGNED_LIMITS.deviceLimit,
        'an overridden key must keep the value the plan gave AT ASSIGNMENT — not the column, and ' +
          'not the plan the customer just renewed onto',
      );
      // The inherited keys in the same row still moved.
      assert.equal(snapshot['trafficLimit'], PLAN_LIMITS.trafficLimit);

      const second = await path.run({
        subscription: first.row,
        plan: editTwo(),
        durableTerm: true,
      });
      assert.equal(
        second.row.deviceLimit,
        25,
        'the operator override must survive the SECOND renewal as well',
      );
      assert.equal(second.syncJobView.deviceLimit, 25);
      // ...while the keys that were inherited keep tracking the plan.
      assert.equal(second.row.trafficLimit, 4096);
    });

    it(`${path.name}: patching the limit keys touches nothing else (durable term ON)`, async () => {
      // The freeze is deliberately asymmetric: `name` / `tag` / `type` /
      // `trafficLimitStrategy` mirror the LIVE plan through
      // `PlanSnapshotSyncService`, `icon` is frozen at purchase, and the
      // per-purchase facts describe the term the customer is CURRENTLY on — the
      // renewal's term is only SCHEDULED. A renewal that rebuilt the whole
      // snapshot here would claim the customer had already moved onto it.
      const outcome = await path.run({
        subscription: makeSubscription(),
        plan: makePlan({ name: 'Renamed', tag: 'new-tag', trafficLimitStrategy: 'MONTH' }),
        durableTerm: true,
      });

      const snapshot = readSnapshot(outcome.row.planSnapshot);
      assert.equal(snapshot['name'], 'Plan', 'the renewal must not mirror display keys');
      assert.equal(snapshot['id'], 'plan-1');
      assert.equal('tag' in snapshot, false, 'a key the stored snapshot never had must not appear');
      assert.equal('trafficLimitStrategy' in snapshot, false);
      assert.equal('selectedDurationDays' in snapshot, false);
      assert.equal('snapshotSource' in snapshot, false);
    });

    it(`${path.name}: an undecidable snapshot is left exactly as it was (durable term ON)`, async () => {
      // Nothing was refreshed, so nothing may be declared. Writing `{}` — or a
      // fragment holding only the patched keys — would DESTROY the rest of the
      // JSON on precisely the imported rows this whole rule exists to protect.
      const stored = { id: 'plan-1', name: 'Legacy' };
      const outcome = await path.run({
        subscription: makeSubscription({
          planSnapshot: stored,
          trafficLimit: 555,
          deviceLimit: 9,
        }),
        plan: editOne(),
        durableTerm: true,
      });

      assert.deepStrictEqual(outcome.row.planSnapshot, stored);
      assert.equal(
        'planSnapshot' in outcome.updateData,
        false,
        'with nothing to declare the write must not carry a planSnapshot key at all',
      );
      assert.equal(outcome.row.trafficLimit, 555);
      assert.equal(outcome.row.deviceLimit, 9);
    });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// Part E — the customer who paid extra
// ───────────────────────────────────────────────────────────────────────────
//
// `Subscription.trafficLimit` / `deviceLimit` MIRROR the projection's desired
// state — `base + every ACTIVE add-on` — because every writer that touches a
// projection mirrors it back into those columns. So on a subscription holding a
// live add-on the column is NOT the plan's value, and comparing it raw reads the
// row as OVERRIDDEN on every renewal: from the first add-on a customer bought,
// no plan edit ever reached them again. Permanently, and for exactly the
// customers who had paid extra.
//
// The repair is to hand the renewal the contribution the PREVIOUS projection row
// recorded, so the resolver can take it back out before comparing. That splits
// the answer into TWO fragments which are NOT interchangeable, and the cases
// below pin both halves separately so a swap cannot pass:
//
//   columns  = plan value + recorded contribution → the mirrored COLUMN
//   snapshot = the plan's raw value               → the stored planSnapshot
//
// Putting `snapshot` in the columns deletes the customer's paid add-on from the
// mirror AND makes the next projection recompute subtract the contribution a
// second time, pinning the operator baseline lower for good. Putting `columns`
// in the snapshot makes the next comparison subtract a contribution that is
// already out, so the row reads OVERRIDDEN forever — the very defect this part
// exists to close, merely relocated.

/** +2 devices and +50 GB, live, as the last recompute recorded them. */
const HELD_ADD_ONS: RecordedContribution = {
  activeTrafficContributionBytes: 50n * GIB,
  activeDeviceContribution: 2,
};

/**
 * A subscriber who was never individually adjusted but HAS bought add-ons: the
 * snapshot still records what the plan gave at assignment, while the columns
 * carry that plus the live contribution, exactly as the projection mirrored
 * them.
 */
function makeAddOnHolder(overrides: Partial<SubState> = {}): SubState {
  return makeSubscription({
    trafficLimit: ASSIGNED_LIMITS.trafficLimit + 50,
    deviceLimit: ASSIGNED_LIMITS.deviceLimit + 2,
    ...overrides,
  });
}

describe('a plan edit still reaches a subscriber holding a paid add-on', () => {
  for (const path of RENEWAL_PATHS) {
    for (const durableTerm of [false, true]) {
      const label = `${path.name} (durable term ${durableTerm ? 'ON' : 'OFF'})`;

      it(`${label}: the plan edit lands and the paid add-on is still on top of it`, async () => {
        const outcome = await path.run({
          subscription: makeAddOnHolder(),
          plan: makePlan(),
          durableTerm,
          recorded: HELD_ADD_ONS,
        });

        assert.equal(
          outcome.row.deviceLimit,
          PLAN_LIMITS.deviceLimit + 2,
          'the plan edit did not reach a customer holding an add-on. Their column mirrors ' +
            '`base + active add-ons`, so comparing it raw reads them as individually overridden and ' +
            'freezes their limits for the rest of the subscription — for exactly the customers who ' +
            'paid extra.',
        );
        assert.equal(
          outcome.row.trafficLimit,
          PLAN_LIMITS.trafficLimit + 50,
          'the traffic column must be the edited plan PLUS the recorded contribution',
        );
        assert.notEqual(
          outcome.row.deviceLimit,
          PLAN_LIMITS.deviceLimit,
          'writing the plan value alone into the column silently deletes the paid add-on from the ' +
            'mirror, and the next projection recompute then subtracts the contribution a SECOND ' +
            'time — pinning the operator baseline that much lower, permanently',
        );
        assert.notEqual(outcome.row.trafficLimit, PLAN_LIMITS.trafficLimit);
        // The push is where it lands: the panel gets what the column says.
        assert.equal(outcome.syncJobView.deviceLimit, PLAN_LIMITS.deviceLimit + 2);
        assert.equal(outcome.syncJobView.trafficLimit, PLAN_LIMITS.trafficLimit + 50);
        assert.ok(
          outcome.projectionReads >= 1,
          'the recorded contribution must be READ, never assumed to be zero',
        );
      });

      it(`${label}: the snapshot records the plan's own value, not the mirrored column`, async () => {
        const outcome = await path.run({
          subscription: makeAddOnHolder(),
          plan: makePlan(),
          durableTerm,
          recorded: HELD_ADD_ONS,
        });

        const snapshot = readSnapshot(outcome.row.planSnapshot);
        assert.equal(
          snapshot['deviceLimit'],
          PLAN_LIMITS.deviceLimit,
          'the stored snapshot is the PLAN baseline the next comparison runs against. Writing the ' +
            'column into it (plan + contribution) makes that comparison subtract a contribution ' +
            'that is already out, so the row reads OVERRIDDEN from here on and no later plan edit ' +
            'ever reaches it again.',
        );
        assert.equal(snapshot['trafficLimit'], PLAN_LIMITS.trafficLimit);
        assert.notEqual(snapshot['deviceLimit'], outcome.row.deviceLimit);
        assert.notEqual(snapshot['trafficLimit'], outcome.row.trafficLimit);
      });

      it(`${label}: a SECOND plan edit still reaches the add-on holder`, async () => {
        // The two fragments only prove themselves over two renewals: swapping
        // them is invisible on the first, exactly like the snapshot-freeze
        // defect in Part D.
        const first = await path.run({
          subscription: makeAddOnHolder(),
          plan: editOne(),
          durableTerm,
          recorded: HELD_ADD_ONS,
        });
        assert.equal(
          first.row.deviceLimit,
          PLAN_LIMITS.deviceLimit + 2,
          'the FIRST plan edit must land — the harness is not exercising the renewal',
        );

        const second = await path.run({
          subscription: first.row,
          plan: editTwo(),
          durableTerm,
          recorded: HELD_ADD_ONS,
        });

        assert.equal(second.row.deviceLimit, 11 + 2);
        assert.equal(second.row.trafficLimit, 4096 + 50);
        assert.equal(second.syncJobView.deviceLimit, 11 + 2);
      });

      it(`${label}: an operator override on an add-on holder still survives`, async () => {
        // The other direction, and it is not optional: subtracting the
        // contribution must not turn a hand-set column into an inherited one.
        // 25 is the operator's number; +2 is the live add-on mirrored on top.
        const outcome = await path.run({
          subscription: makeAddOnHolder({ deviceLimit: 25 + 2 }),
          plan: makePlan(),
          durableTerm,
          recorded: HELD_ADD_ONS,
        });

        assert.equal(
          outcome.row.deviceLimit,
          25 + 2,
          'an operator-set limit on an add-on holder must survive the renewal untouched',
        );
        // ...while the field they did NOT touch keeps tracking the plan.
        assert.equal(outcome.row.trafficLimit, PLAN_LIMITS.trafficLimit + 50);
      });

      it(`${label}: an expired add-on releases the column back onto the plan`, async () => {
        // The contribution is read from the PREVIOUS projection row on purpose.
        // Once the add-on is gone that row records nothing, the stale share is
        // no longer removed from the column, the remainder no longer matches the
        // snapshot, and the column is PRESERVED rather than rewritten — the safe
        // direction, and the one a later recompute can still correct.
        const outcome = await path.run({
          subscription: makeAddOnHolder(),
          plan: makePlan(),
          durableTerm,
          recorded: { activeTrafficContributionBytes: 0n, activeDeviceContribution: 0 },
        });

        assert.equal(
          outcome.row.deviceLimit,
          ASSIGNED_LIMITS.deviceLimit + 2,
          'with nothing recorded the column no longer decomposes to the snapshot, so it reads as ' +
            'an override and is preserved',
        );
      });
    }
  }
});
