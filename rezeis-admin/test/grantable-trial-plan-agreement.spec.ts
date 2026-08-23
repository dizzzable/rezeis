import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { InternalUserEdgeService } from '../src/modules/internal-user/services/internal-user-edge.service';
import { selectGrantableTrialPlan } from '../src/modules/subscriptions/services/grantable-trial-plan.util';
import { AdminUserSubscriptionsController } from '../src/modules/users/controllers/admin-user-subscriptions.controller';

/**
 * THE PANEL'S "GRANT TRIAL" BUTTON HANDED OUT A DIFFERENT PRODUCT.
 *
 * Two surfaces grant the same free trial: the cabinet's own button
 * (`InternalUserEdgeService.activateTrial`, which also decides whether to SHOW
 * the offer, in `computeTrialEligibility`) and the operator's button
 * (`AdminUserSubscriptionsController.grantTrial`). The cabinet selected with
 * `orderBy: [{ orderIndex: 'asc' }, { id: 'asc' }]` and
 * `durations: { take: 1, orderBy: { days: 'asc' } }`, under a comment saying the
 * ordering must match what eligibility uses. The panel's copy had NO `orderBy`
 * on the plan and NONE on the durations, and then took `durations[0]`.
 *
 * With more than one active TRIAL plan (a remnashop import can create them), or
 * one plan carrying several durations, the two buttons granted different plans
 * for different lengths - and an unordered `findFirst` is whatever the database
 * hands back, so not even reproducibly.
 *
 * ── WHY THE EXPECTED PRODUCT IS ASSERTED BEFORE AGREEMENT ────────────────────
 *
 * Agreement alone is satisfied by both surfaces being wrong in the same way -
 * and the obvious "fix" for this defect (delete both `orderBy`s, or copy the
 * unordered query onto the cabinet) would pass an agreement-only test. So every
 * case below names the plan id and the day count it expects FIRST; the
 * agreement case restates them and only then compares the two answers.
 *
 * ── WHAT THE FAKE PLAN TABLE MODELS ──────────────────────────────────────────
 *
 * `planTable` honours `where`, `orderBy` and the nested
 * `durations: { take, orderBy }` for real, so an ordering that is dropped
 * changes the row this returns. An UNORDERED query falls back to INSERTION
 * ORDER: real Prisma would answer arbitrarily there, and insertion order is a
 * deterministic stand-in for "arbitrary" that the fixture deliberately arranges
 * to be the WRONG answer. `honoursOrdering` below is the control proving the
 * fake is not simply ignoring `orderBy` - without it, every ordering assertion
 * here would pass against a table that sorts nothing.
 */

interface PlanRow {
  readonly id: string;
  readonly availability: string;
  readonly isActive: boolean;
  readonly isArchived: boolean;
  readonly orderIndex: number;
  readonly trialSettings: Record<string, unknown>;
  readonly durations: readonly { readonly days: number }[];
}

/** Free, unlimited-scope trial settings - this file is about SELECTION, not policy. */
const GRANTABLE: Record<string, unknown> = {
  free: true,
  maxClaims: 5,
  availabilityScope: 'ALL',
  requireTelegramLink: false,
};

/**
 * Four rows arranged so that every ordering the shared query performs is
 * LOAD-BEARING - drop any one of them and a different product comes out:
 *
 *   - `plan-00-paid` sorts first on `orderIndex` but is not a TRIAL plan, so
 *     only the `where` keeps it out.
 *   - `plan-zz-legacy` is FIRST IN INSERTION ORDER, so it is what an unordered
 *     `findFirst` hands back - the panel's old answer.
 *   - `plan-mm-import` ties with the winner on `orderIndex`, so only the
 *     `{ id: 'asc' }` tie-break separates them.
 *   - `plan-aa-current` carries its durations LONGEST FIRST, so only
 *     `orderBy: { days: 'asc' }` finds the 5-day row that a trial actually is.
 */
const PLANS: readonly PlanRow[] = [
  {
    id: 'plan-00-paid',
    availability: 'MONTHLY',
    isActive: true,
    isArchived: false,
    orderIndex: 0,
    trialSettings: GRANTABLE,
    durations: [{ days: 1 }],
  },
  {
    id: 'plan-zz-legacy',
    availability: 'TRIAL',
    isActive: true,
    isArchived: false,
    orderIndex: 7,
    trialSettings: GRANTABLE,
    durations: [{ days: 14 }],
  },
  {
    id: 'plan-mm-import',
    availability: 'TRIAL',
    isActive: true,
    isArchived: false,
    orderIndex: 1,
    trialSettings: GRANTABLE,
    durations: [{ days: 9 }],
  },
  {
    id: 'plan-aa-current',
    availability: 'TRIAL',
    isActive: true,
    isArchived: false,
    orderIndex: 1,
    trialSettings: GRANTABLE,
    durations: [{ days: 30 }, { days: 5 }],
  },
];

/** The operator's own first active trial plan, at the shortest length it offers. */
const EXPECTED_PLAN_ID = 'plan-aa-current';
const EXPECTED_DURATION_DAYS = 5;

/** What every wrong ordering resolves to instead - named so a failure reads as a diagnosis. */
const UNORDERED_PLAN_ID = 'plan-zz-legacy';
const TIE_BREAK_LOSER_PLAN_ID = 'plan-mm-import';
const LONGEST_DURATION_DAYS = 30;

type OrderSpec = readonly (readonly [string, 'asc' | 'desc'])[];

function normalizeOrder(orderBy: unknown): OrderSpec {
  if (orderBy === undefined || orderBy === null) return [];
  const clauses = Array.isArray(orderBy) ? orderBy : [orderBy];
  return clauses.flatMap((clause) =>
    Object.entries(clause as Record<string, 'asc' | 'desc'>).map(
      ([field, direction]) => [field, direction] as const,
    ),
  );
}

function stableSortBy<T extends Record<string, unknown>>(
  rows: readonly T[],
  order: OrderSpec,
): T[] {
  const copy = [...rows];
  // No `orderBy` => the order the rows arrived in. See the header: this is the
  // deterministic stand-in for Prisma's arbitrary answer.
  if (order.length === 0) return copy;
  copy.sort((left, right) => {
    for (const [field, direction] of order) {
      const a = left[field] as string | number;
      const b = right[field] as string | number;
      if (a === b) continue;
      const comparison = a < b ? -1 : 1;
      return direction === 'desc' ? -comparison : comparison;
    }
    return 0;
  });
  return copy;
}

interface PlanQuery {
  readonly where?: Record<string, unknown>;
  readonly orderBy?: unknown;
  readonly select?: Record<string, unknown>;
  readonly include?: Record<string, unknown>;
}

/**
 * `plan.findFirst` over an in-memory table, honouring `where`, `orderBy` and the
 * nested `durations: { take, orderBy }`. Every query it serves is pushed onto
 * `queries`, so a case can assert on the ARGUMENTS Prisma was handed rather than
 * on the fact that it was called.
 */
function planTable(rows: readonly PlanRow[], queries: PlanQuery[]) {
  return {
    findFirst: async (args: PlanQuery): Promise<unknown> => {
      queries.push(args);
      const where = (args.where ?? {}) as Record<string, unknown>;
      const matched = rows.filter((row) =>
        Object.entries(where).every(
          ([field, value]) => (row as unknown as Record<string, unknown>)[field] === value,
        ),
      );
      const hit = stableSortBy(
        matched as unknown as Record<string, unknown>[],
        normalizeOrder(args.orderBy),
      )[0] as unknown as PlanRow | undefined;
      if (hit === undefined) return null;
      const durationsArg = (args.select?.durations ?? args.include?.durations) as
        | { take?: number; orderBy?: unknown }
        | true
        | undefined;
      let durations: readonly { days: number }[] = hit.durations;
      if (durationsArg !== undefined && durationsArg !== true) {
        durations = stableSortBy(
          durations as unknown as Record<string, unknown>[],
          normalizeOrder(durationsArg.orderBy),
        ) as unknown as { days: number }[];
        if (typeof durationsArg.take === 'number') {
          durations = durations.slice(0, durationsArg.take);
        }
      }
      return { id: hit.id, trialSettings: hit.trialSettings, durations: [...durations] };
    },
  };
}

interface GrantCall {
  readonly userId: string;
  readonly planId: string;
  readonly durationDays: number;
}

/** The acting operator, as `@CurrentAdmin()` hands it to every audited route. */
const ACTING_ADMIN = { id: 'admin-1' } as never;

/** Enough of an express `Request` for `extractRequestMetadata`. */
const ACTING_REQUEST = {
  headers: { 'x-request-id': 'req-trial-1', 'user-agent': 'node:test' },
  ip: '10.0.0.7',
  socket: { remoteAddress: null },
} as never;

/** The panel's button: `POST /admin/users/:telegramId/grant-trial`. */
async function panelGrant(rows: readonly PlanRow[]): Promise<{
  grants: readonly GrantCall[];
  queries: readonly PlanQuery[];
}> {
  const queries: PlanQuery[] = [];
  const grants: GrantCall[] = [];
  const controller = new AdminUserSubscriptionsController(
    {
      user: { findFirst: async (): Promise<unknown> => ({ id: 'user-1', telegramId: BigInt(42) }) },
      plan: planTable(rows, queries),
      subscription: {
        findUniqueOrThrow: async (): Promise<unknown> => ({ id: 'sub-1', isTrial: true }),
      },
      adminAuditLog: { create: async (): Promise<unknown> => undefined },
    } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {
      grantTrial: async (input: GrantCall): Promise<unknown> => {
        grants.push(input);
        return { subscriptionId: 'sub-1' };
      },
    } as never,
  );

  await controller.grantTrial('42', ACTING_ADMIN, ACTING_REQUEST);
  return { grants, queries };
}

/** The cabinet's button: `InternalUserEdgeService.activateTrial`. */
async function cabinetActivate(rows: readonly PlanRow[]): Promise<{
  grants: readonly GrantCall[];
  queries: readonly PlanQuery[];
  activated: boolean;
}> {
  const queries: PlanQuery[] = [];
  const grants: GrantCall[] = [];
  const service = new InternalUserEdgeService(
    {
      user: {
        findUnique: async (args: { select?: Record<string, unknown> }): Promise<unknown> =>
          args.select !== undefined && 'telegramId' in args.select
            ? { telegramId: BigInt(42) }
            : { id: 'user-1' },
      },
      plan: planTable(rows, queries),
      subscription: { count: async (): Promise<number> => 0 },
      trialClaim: { aggregate: async (): Promise<unknown> => ({ _sum: { units: 0 } }) },
    } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );

  const result = await service.activateTrial('42', async (input: GrantCall) => {
    grants.push(input);
    return { subscriptionId: 'sub-2' };
  });
  return { grants, queries, activated: result.activated };
}

describe('the trial plan a free grant is about - one answer, both buttons', () => {
  it('the cabinet grants the operator-first trial plan at its shortest duration', async () => {
    const { grants, activated } = await cabinetActivate(PLANS);

    assert.equal(activated, true, 'fixture guard: this user must be eligible');
    // The EXPECTED product, named outright. Not "whatever the panel also picked".
    assert.deepStrictEqual(grants, [
      { userId: 'user-1', planId: EXPECTED_PLAN_ID, durationDays: EXPECTED_DURATION_DAYS },
    ]);
  });

  it('the panel button grants that same plan and that same duration', async () => {
    const { grants } = await panelGrant(PLANS);

    assert.deepStrictEqual(grants, [
      { userId: 'user-1', planId: EXPECTED_PLAN_ID, durationDays: EXPECTED_DURATION_DAYS },
    ]);
    // Spelled out, because these are exactly the two wrong answers the panel's
    // own unordered query used to produce from this table.
    assert.notEqual(grants[0].planId, UNORDERED_PLAN_ID);
    assert.notEqual(grants[0].planId, TIE_BREAK_LOSER_PLAN_ID);
    assert.notEqual(grants[0].durationDays, LONGEST_DURATION_DAYS);
  });

  it('and the two agree - restated only after each was pinned to the expected product', async () => {
    const cabinet = await cabinetActivate(PLANS);
    const panel = await panelGrant(PLANS);

    const product = (grants: readonly GrantCall[]): unknown => ({
      planId: grants[0].planId,
      durationDays: grants[0].durationDays,
    });
    const expected = { planId: EXPECTED_PLAN_ID, durationDays: EXPECTED_DURATION_DAYS };

    // Both are RIGHT...
    assert.deepStrictEqual(product(cabinet.grants), expected);
    assert.deepStrictEqual(product(panel.grants), expected);
    // ...and only then, both are the SAME. Agreement on its own is satisfied by
    // two surfaces that are wrong together, which is what deleting both
    // orderings would produce.
    assert.deepStrictEqual(product(panel.grants), product(cabinet.grants));
  });

  it('hands Prisma the identical query from both sites, ordering included', async () => {
    const cabinet = await cabinetActivate(PLANS);
    const panel = await panelGrant(PLANS);

    // The ARGUMENTS, not a call count: a shared answer reached by two different
    // queries is the divergence waiting to reopen. `computeTrialEligibility` and
    // `activateTrial` each run the query once, so the cabinet logs two.
    assert.equal(panel.queries.length, 1);
    assert.equal(cabinet.queries.length, 2);
    for (const query of [...panel.queries, ...cabinet.queries]) {
      assert.deepStrictEqual(query, {
        where: { availability: 'TRIAL', isActive: true, isArchived: false },
        orderBy: [{ orderIndex: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          trialSettings: true,
          durations: { take: 1, orderBy: { days: 'asc' }, select: { days: true } },
        },
      });
    }
  });

  /**
   * INERTNESS CONTROL for the fake, not for the code under test.
   *
   * Every assertion above about ordering is vacuous if `planTable` ignores
   * `orderBy`: an unordered query and an ordered one would return the same row
   * and the mutation "delete the orderBy" would go unnoticed. These probes drive
   * the fake directly and show each ordering actually MOVES the answer.
   */
  it('control: the fake honours orderBy, so the ordering assertions are not vacuous', async () => {
    const queries: PlanQuery[] = [];
    const table = planTable(PLANS, queries);
    const trialOnly = { availability: 'TRIAL', isActive: true, isArchived: false };
    const durations = { take: 1, orderBy: { days: 'asc' }, select: { days: true } };

    const unordered = (await table.findFirst({
      where: trialOnly,
      select: { id: true, trialSettings: true, durations },
    })) as { id: string };
    const ordered = (await table.findFirst({
      where: trialOnly,
      orderBy: [{ orderIndex: 'asc' }, { id: 'asc' }],
      select: { id: true, trialSettings: true, durations },
    })) as { id: string };
    const withoutTieBreak = (await table.findFirst({
      where: trialOnly,
      orderBy: [{ orderIndex: 'asc' }],
      select: { id: true, trialSettings: true, durations },
    })) as { id: string };
    const longestFirst = (await table.findFirst({
      where: trialOnly,
      orderBy: [{ orderIndex: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        trialSettings: true,
        durations: { take: 1, orderBy: { days: 'desc' }, select: { days: true } },
      },
    })) as { durations: { days: number }[] };
    const unorderedDurations = (await table.findFirst({
      where: trialOnly,
      orderBy: [{ orderIndex: 'asc' }, { id: 'asc' }],
      select: { id: true, trialSettings: true, durations: true },
    })) as { durations: { days: number }[] };

    assert.equal(unordered.id, UNORDERED_PLAN_ID, 'no orderBy must fall back to insertion order');
    assert.equal(ordered.id, EXPECTED_PLAN_ID);
    assert.equal(withoutTieBreak.id, TIE_BREAK_LOSER_PLAN_ID, 'the id tie-break must decide');
    assert.equal(longestFirst.durations[0].days, LONGEST_DURATION_DAYS);
    assert.equal(
      unorderedDurations.durations[0].days,
      LONGEST_DURATION_DAYS,
      'unordered durations must fall back to insertion order, which is the long one',
    );
    // And the `where` is doing work too: the row that sorts first overall is a
    // paid plan, so a lost filter would surface here rather than silently.
    const unfiltered = (await table.findFirst({
      orderBy: [{ orderIndex: 'asc' }, { id: 'asc' }],
      select: { id: true, trialSettings: true, durations },
    })) as { id: string };
    assert.equal(unfiltered.id, 'plan-00-paid');

    assert.equal(queries.length, 6, 'control: the query log records every call, so it is a real log');
  });

  /**
   * The shared function is the ONLY thing either site asks. Called directly here
   * so a future third surface has an executable statement of the contract rather
   * than two controllers to read.
   */
  it('selectGrantableTrialPlan is that one answer', async () => {
    const queries: PlanQuery[] = [];
    const selection = await selectGrantableTrialPlan({
      plan: planTable(PLANS, queries),
    } as never);

    assert.deepStrictEqual(selection, {
      id: EXPECTED_PLAN_ID,
      trialSettings: GRANTABLE,
      durationDays: EXPECTED_DURATION_DAYS,
    });
  });

  it('reports a trial plan with no duration rather than inventing one', async () => {
    // `durationDays: null` is what the two callers then answer DIFFERENTLY about
    // on purpose - the panel with a sentence for an operator, the cabinet with
    // `TRIAL_NOT_CONFIGURED` - so the shared function must report it, not judge it.
    const queries: PlanQuery[] = [];
    const selection = await selectGrantableTrialPlan({
      plan: planTable(
        [{ ...PLANS[3], durations: [] }],
        queries,
      ),
    } as never);

    assert.deepStrictEqual(selection, {
      id: EXPECTED_PLAN_ID,
      trialSettings: GRANTABLE,
      durationDays: null,
    });
  });
});
