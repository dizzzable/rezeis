import { Prisma } from '@prisma/client';

/**
 * Enough of a Prisma client to read the plan table. The same narrow
 * `Pick<Prisma.TransactionClient, …>` shape `trial-claim-ledger.util.ts` uses,
 * so one function serves `PrismaService` and a transaction client alike.
 */
type TrialPlanClient = Pick<Prisma.TransactionClient, 'plan'>;

/** What every trial-granting path needs off the trial plan, and nothing else. */
export interface GrantableTrialPlanSelection {
  readonly id: string;
  /** Raw `Plan.trialSettings` JSON — read it with `readTrialSettings`. */
  readonly trialSettings: Prisma.JsonValue;
  /**
   * `days` from the SHORTEST duration row, or `null` when the plan carries no
   * duration at all.
   *
   * Deliberately reported rather than judged here: the cabinet path refuses
   * `null` AND `<= 0` as `TRIAL_NOT_CONFIGURED`, while the panel path answers
   * an operator with two different sentences. Folding either decision into this
   * function would change one of those surfaces as a side effect of sharing a
   * lookup.
   */
  readonly durationDays: number | null;
}

/**
 * THE TRIAL PLAN A FREE GRANT IS ABOUT — one query, one answer, every caller.
 *
 * Three call sites decide which plan a trial grant hands out: the cabinet's
 * eligibility check and its activation (both in `InternalUserEdgeService`), and
 * the panel's "grant trial" button
 * (`AdminUserSubscriptionsController.grantTrial`). Any two of them that disagree
 * hand out DIFFERENT PRODUCTS from buttons that claim to do the same thing.
 *
 * That has already happened twice:
 *   - Eligibility and activation were once two unordered `findFirst`s with
 *     different shapes, so with more than one active TRIAL plan the cabinet
 *     could show an offer about one plan while activation refused about
 *     another - the offer stayed on screen and the button failed every time.
 *     They were converged onto this ordering, with a comment on each saying it
 *     must match the other.
 *   - The panel's button was never converged at all: `findFirst` with no
 *     `orderBy` on the plan and none on `durations`, then `durations[0]`. With
 *     two active trial plans, or one plan with several durations, the panel and
 *     the cabinet granted different plans and different lengths - and, because
 *     an unordered `findFirst` is whatever the database hands back, not even
 *     reproducibly.
 *
 * A comment saying "must match" only works while someone reads it, which is
 * what the second bullet is evidence against. So the query lives here, once,
 * and the three sites call it. A fourth trial-granting surface inherits the
 * ordering by construction rather than by remembering.
 *
 * ── WHY THIS ORDERING ────────────────────────────────────────────────────────
 *
 * `orderIndex asc` is the operator's own ordering of the plan list, so "the"
 * trial plan is the one they put first. `id asc` behind it is the tie-break
 * that makes the answer TOTAL: `orderIndex` defaults to 0 and is not unique, so
 * without it two plans at index 0 leave the choice to the database again.
 * `durations` takes the SHORTEST (`days asc`) row, which is what a trial is.
 *
 * NOTE what this does NOT do: no eligibility, no claim counting, no
 * invited-only scope. Those are per-caller policy, and the panel's button
 * skipping them is a deliberate operator override, not an omission.
 */
export async function selectGrantableTrialPlan(
  client: TrialPlanClient,
): Promise<GrantableTrialPlanSelection | null> {
  const plan = await client.plan.findFirst({
    where: { availability: 'TRIAL', isActive: true, isArchived: false },
    orderBy: [{ orderIndex: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      trialSettings: true,
      durations: { take: 1, orderBy: { days: 'asc' }, select: { days: true } },
    },
  });
  if (plan === null) {
    return null;
  }
  return {
    id: plan.id,
    trialSettings: plan.trialSettings,
    durationDays: plan.durations[0]?.days ?? null,
  };
}
