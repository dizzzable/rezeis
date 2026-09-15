import {
  ArchivedPlanRenewMode,
  Prisma,
  PurchaseType,
  SubscriptionStatus,
  SubscriptionTermStatus,
  TransactionStatus,
} from '@prisma/client';

import {
  resolveRecordedAddOnContribution,
  type ProjectionReader,
} from '../../add-on-entitlements/services/configured-baseline.util';
import type { RecordedAddOnContribution } from '../../subscriptions/services/plan-inherited-limits.util';
import { TRANSITION_TARGET_WHERE } from '../../subscriptions/services/subscription-quote.service';
import { RECENT_CHECKOUT_REVIVAL_WINDOW_MS } from '../services/plan-reference-guard.service';
import { isPlanSoftDeleted } from '../utils/plan-deletion.util';
import { PLAN_INCLUDE } from '../utils/plan-record.util';
import { PLAN_MIGRATION_READ_CHUNK } from './plan-migration.constants';
import type { MigrationTargetPlan } from './plan-migration-compute.util';

/**
 * THE FACTS ABOUT A SUBSCRIPTION THAT DECIDE HOW IT MOVES, READ IN BULK.
 *
 * The listing and the preview read these for many rows at once; the move reads
 * the same facts for one row under its lock. Where a rule is a decision rather
 * than a read — which terms block a move — it is a pure function here that both
 * call, so the preview's "will be skipped" and the move's skip are one rule.
 */

/** What a migration reads off a subscription row. */
export const MIGRATION_SUBJECT_SELECT = {
  id: true,
  userId: true,
  status: true,
  isTrial: true,
  remnawaveId: true,
  trafficLimit: true,
  deviceLimit: true,
  internalSquads: true,
  externalSquad: true,
  planSnapshot: true,
  expiresAt: true,
  user: { select: { id: true, name: true, username: true, telegramId: true, email: true } },
} as const satisfies Prisma.SubscriptionSelect;

export type MigrationSubjectRow = Prisma.SubscriptionGetPayload<{
  select: typeof MIGRATION_SUBJECT_SELECT;
}>;

/** The user block of every wire row that names a subscription. */
export interface MigrationUserView {
  readonly id: string;
  readonly name: string | null;
  readonly username: string | null;
  readonly telegramId: string | null;
  readonly email: string | null;
}

export function toMigrationUserView(user: MigrationSubjectRow['user'] | null | undefined): MigrationUserView | null {
  if (user === null || user === undefined) return null;
  return {
    id: user.id,
    name: user.name === '' ? null : user.name,
    username: user.username,
    telegramId: user.telegramId === null ? null : user.telegramId.toString(),
    email: user.email,
  };
}

/** The target plan as the computation reads it, plus what renewability needs. */
export const MIGRATION_TARGET_SELECT = {
  id: true,
  name: true,
  deletedAt: true,
  description: true,
  tag: true,
  type: true,
  icon: true,
  availability: true,
  trialSettings: true,
  trafficLimit: true,
  deviceLimit: true,
  trafficLimitStrategy: true,
  internalSquads: true,
  externalSquad: true,
} as const satisfies Prisma.PlanSelect;

export type MigrationTargetRow = Prisma.PlanGetPayload<{ select: typeof MIGRATION_TARGET_SELECT }>;

export function toMigrationTarget(row: MigrationTargetRow): MigrationTargetPlan {
  return row;
}

export interface MigrationTermFact {
  readonly status: SubscriptionTermStatus;
  readonly planId: string | null;
}

/**
 * Whether the subscription's durable terms stop a move — SKIPPED
 * `SCHEDULED_TERM`. Two shapes, and both are PAID future periods the move may
 * not cancel:
 *
 *   1. A SCHEDULED term on the source plan. When it activates it writes the
 *      source plan's snapshot and squads back onto the row
 *      (`EntitlementBoundaryService.activateDueScheduledTerm`) — the move would
 *      be silently undone on the day the paid period starts.
 *   2. Any SCHEDULED term while an ACTIVE one exists. Moving a subscription
 *      with an ACTIVE term means rotating that term onto the target, and a new
 *      term can only be activated when it is the LOWEST scheduled generation
 *      (`SubscriptionTermService.activateInTransaction`); an existing scheduled
 *      term is always lower. Not rotating is not an option either: the ACTIVE
 *      term keeps the source plan's baseline and the next projection recompute
 *      pushes it back to the panel.
 *
 * The paid upgrade cancels scheduled terms that carry no add-ons; a move does
 * not, because nobody paid for the move. Rare by construction: durable terms
 * are behind a rollout flag, and a scheduled term exists only between an early
 * renewal and the end of the current period.
 */
export function scheduledTermBlocksMove(
  terms: readonly MigrationTermFact[],
  sourcePlanId: string,
): boolean {
  const scheduled = terms.filter((term) => term.status === SubscriptionTermStatus.SCHEDULED);
  if (scheduled.length === 0) return false;
  if (scheduled.some((term) => term.planId === sourcePlanId)) return true;
  return terms.some((term) => term.status === SubscriptionTermStatus.ACTIVE);
}

export interface MigrationSubjectFacts {
  readonly recorded: RecordedAddOnContribution;
  readonly hasActiveTerm: boolean;
  readonly scheduledTermBlocks: boolean;
  readonly pendingRenewalForSource: boolean;
  readonly sharedPanelProfile: boolean;
}

type FactsClient = Pick<
  Prisma.TransactionClient,
  'subscriptionEffectiveProjection' | 'subscriptionTerm' | 'transaction' | 'transactionItem' | 'subscription'
>;

/**
 * The facts for many subscriptions, in a handful of queries per chunk.
 *
 * The recorded add-on share goes through `resolveRecordedAddOnContribution` —
 * the one reader of that number — over the rows this function already fetched,
 * so its `?? 0` for a subscription with no projection is the same one the move
 * applies under its lock.
 */
export async function loadMigrationSubjectFacts(
  client: FactsClient,
  sourcePlanId: string,
  subjects: ReadonlyArray<{ readonly id: string; readonly remnawaveId: string | null }>,
  now: Date = new Date(),
): Promise<Map<string, MigrationSubjectFacts>> {
  const facts = new Map<string, MigrationSubjectFacts>();
  for (let offset = 0; offset < subjects.length; offset += PLAN_MIGRATION_READ_CHUNK) {
    const chunk = subjects.slice(offset, offset + PLAN_MIGRATION_READ_CHUNK);
    const ids = chunk.map((subject) => subject.id);

    const projections = await client.subscriptionEffectiveProjection.findMany({
      where: { subscriptionId: { in: ids } },
      select: {
        subscriptionId: true,
        activeTrafficContributionBytes: true,
        activeDeviceContribution: true,
      },
    });
    const projectionById = new Map(projections.map((row) => [row.subscriptionId, row]));
    // Only `findUnique` is ever called on it, answered from the rows above.
    const preloaded = {
      subscriptionEffectiveProjection: {
        findUnique: async (args: { readonly where: { readonly subscriptionId: string } }) =>
          projectionById.get(args.where.subscriptionId) ?? null,
      },
    } as unknown as ProjectionReader;

    const terms = await client.subscriptionTerm.findMany({
      where: {
        subscriptionId: { in: ids },
        status: { in: [SubscriptionTermStatus.ACTIVE, SubscriptionTermStatus.SCHEDULED] },
      },
      select: { subscriptionId: true, status: true, planId: true },
    });
    const termsById = new Map<string, MigrationTermFact[]>();
    for (const term of terms) {
      const list = termsById.get(term.subscriptionId) ?? [];
      list.push({ status: term.status, planId: term.planId });
      termsById.set(term.subscriptionId, list);
    }

    const pending = await readPendingRenewals(client, ids, now);
    const shared = await readSharedPanelProfiles(
      client,
      chunk.map((subject) => subject.remnawaveId).filter((value): value is string => value !== null),
    );

    for (const subject of chunk) {
      const subjectTerms = termsById.get(subject.id) ?? [];
      facts.set(subject.id, {
        recorded: await resolveRecordedAddOnContribution(preloaded, subject.id),
        hasActiveTerm: subjectTerms.some((term) => term.status === SubscriptionTermStatus.ACTIVE),
        scheduledTermBlocks: scheduledTermBlocksMove(subjectTerms, sourcePlanId),
        pendingRenewalForSource: pending.has(subject.id),
        sharedPanelProfile: subject.remnawaveId !== null && shared.has(subject.remnawaveId),
      });
    }
  }
  return facts;
}

/**
 * Subscriptions with a renewal still in flight — decision 10 moves them anyway
 * and the late payment extends them on the new plan; the flag is informational.
 *
 * Any renewal of the subscription, whatever plan it was priced for. The
 * subscription is on the source plan, so every renewal of it in flight was
 * priced before the move — for the source plan, or, when that plan is archived
 * and renews onto a replacement, for the replacement or the plan the subscriber
 * chose — and the fulfilment guard keeps each of them on the new plan alike
 * (`findLatePlanMigrationRenewal`). Matching the source plan's id here, as this
 * once did, left a renewal priced for the replacement unflagged.
 *
 * "In flight" is the reference guard's own reading of a payment that can still
 * be fulfilled: PENDING, COMPLETED but not fulfilled (or not applied, for a
 * combined-renewal line), or CANCELED/FAILED inside the window in which a late
 * provider webhook can revive it (`RECENT_CHECKOUT_REVIVAL_WINDOW_MS`). Unlike
 * the reference guard it counts a revivable COMBINED renewal too, because
 * fulfilment revives those through the same path.
 */
async function readPendingRenewals(
  client: Pick<Prisma.TransactionClient, 'transaction' | 'transactionItem'>,
  subscriptionIds: readonly string[],
  now: Date,
): Promise<Set<string>> {
  const revivableSince = new Date(now.getTime() - RECENT_CHECKOUT_REVIVAL_WINDOW_MS);
  const single = await client.transaction.findMany({
    where: {
      subscriptionId: { in: [...subscriptionIds] },
      purchaseType: PurchaseType.RENEW,
      OR: [
        { status: TransactionStatus.PENDING },
        { status: TransactionStatus.COMPLETED, fulfilledAt: null },
        {
          status: { in: [TransactionStatus.CANCELED, TransactionStatus.FAILED] },
          createdAt: { gt: revivableSince },
        },
      ],
    },
    select: { subscriptionId: true },
  });
  const combined = await client.transactionItem.findMany({
    where: {
      subscriptionId: { in: [...subscriptionIds] },
      appliedAt: null,
      transaction: {
        OR: [
          { status: { in: [TransactionStatus.PENDING, TransactionStatus.COMPLETED] } },
          {
            status: { in: [TransactionStatus.CANCELED, TransactionStatus.FAILED] },
            createdAt: { gt: revivableSince },
          },
        ],
      },
    },
    select: { subscriptionId: true },
  });
  const ids = new Set<string>();
  for (const row of single) if (row.subscriptionId !== null) ids.add(row.subscriptionId);
  for (const row of combined) ids.add(row.subscriptionId);
  return ids;
}

/** Remnawave ids that more than one live (non-DELETED) subscription carries. */
async function readSharedPanelProfiles(
  client: Pick<Prisma.TransactionClient, 'subscription'>,
  remnawaveIds: readonly string[],
): Promise<Set<string>> {
  const unique = [...new Set(remnawaveIds)];
  if (unique.length === 0) return new Set();
  const grouped = await client.subscription.groupBy({
    by: ['remnawaveId'],
    where: { remnawaveId: { in: unique }, status: { not: SubscriptionStatus.DELETED } },
    _count: { _all: true },
  });
  return new Set(
    grouped
      .filter((row) => row.remnawaveId !== null && row._count._all > 1)
      .map((row) => row.remnawaveId as string),
  );
}

/**
 * Whether a subscription moved onto each plan could be renewed — false raises
 * `TARGET_NOT_RENEWABLE` on the preview.
 *
 * ── Where the rule comes from ────────────────────────────────────────────────
 *
 * The renewal decides it per subscription inside private methods
 * (`SubscriptionRenewalService.quoteSubscriptionRenewal` and
 * `SubscriptionQuoteService.getSourceSelection`) that read the subscription's
 * CURRENT snapshot — which names the source plan until the move commits, so they
 * cannot be asked about the target. What they decide for a regular subscription
 * whose snapshot names Q is built here from the SAME exported pieces they read:
 *
 *   1. Q gone (row missing or soft-deleted, `isPlanSoftDeleted`) → the renewal
 *      requires a plan choice (`renewalPlanIsGone`).
 *   2. Q archived with REPLACE_ON_RENEW and no replacement on sale by
 *      `TRANSITION_TARGET_WHERE` (the quote's own definition, exported for
 *      exactly this question) → a plan choice again; autopay stops. With a
 *      replacement on sale the renewal lands on the first one in the quote's
 *      order, and that plan is the one whose prices count.
 *   3. The landing plan has no duration priced in the currency of an active
 *      gateway → `resolveDuration` returns nothing or `calculateQuotePrice`
 *      finds no price, and the item is not renewable.
 *
 * `plan-migration-postgres.spec.ts` drives the real `SubscriptionRenewalService`
 * over subscriptions moved onto each of these shapes and requires it to agree,
 * which is what keeps this reading from drifting from the code it describes.
 *
 * Plan-level, not per subscription: the one per-row input the renewal adds — the
 * nearest duration to `selectedDurationDays` — only matters when a plan prices
 * some durations and not others, which the plan editor does not produce.
 */
export async function resolveTargetRenewability(
  client: Pick<Prisma.TransactionClient, 'plan' | 'paymentGateway'>,
  planIds: readonly string[],
): Promise<Map<string, boolean>> {
  const result = new Map<string, boolean>();
  const unique = [...new Set(planIds)];
  if (unique.length === 0) return result;

  const gateways = await client.paymentGateway.findMany({
    where: { isActive: true },
    select: { currency: true },
  });
  const payable = new Set(gateways.map((gateway) => gateway.currency));
  const priced = (plan: { readonly durations: ReadonlyArray<{ readonly prices: ReadonlyArray<{ readonly currency: string }> }> }) =>
    plan.durations.some((duration) => duration.prices.some((price) => payable.has(price.currency as never)));

  const plans = await client.plan.findMany({ where: { id: { in: unique } }, include: PLAN_INCLUDE });
  const byId = new Map(plans.map((plan) => [plan.id, plan]));
  for (const planId of unique) {
    const plan = byId.get(planId);
    if (plan === undefined || isPlanSoftDeleted(plan)) {
      result.set(planId, false);
      continue;
    }
    if (plan.isArchived && plan.archivedRenewMode === ArchivedPlanRenewMode.REPLACE_ON_RENEW) {
      const replacement = await client.plan.findFirst({
        where: { id: { in: plan.replacementPlanIds }, ...TRANSITION_TARGET_WHERE },
        include: PLAN_INCLUDE,
        orderBy: [{ orderIndex: 'asc' }, { createdAt: 'asc' }],
      });
      result.set(planId, replacement !== null && priced(replacement));
      continue;
    }
    result.set(planId, priced(plan));
  }
  return result;
}
