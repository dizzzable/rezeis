import { Injectable } from '@nestjs/common';
import {
  AdPlacementStatus,
  AdSignupBonusType,
  ContestStatus,
  Prisma,
  PromocodeRewardType,
  QuestRewardType,
  SubscriptionStatus,
  SubscriptionTermStatus,
  TransactionStatus,
  TrialClaimStatus,
  WheelSectorKind,
} from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { normalizeReferralSettings } from '../../referrals/services/referral-qualification.service';

/**
 * WHAT STILL USES A PLAN — ONE ANSWER FOR EVERY CALLER.
 *
 * Three places ask it: the delete dialog (`GET /admin/plans/:planId/references`),
 * the delete itself (removed for good, or hidden), and the nightly
 * `RetiredPlanSweeperService` (may the hidden row go yet). Before this service
 * there were two hand-written hold lists — two checks in the plan validators,
 * seven in the sweeper — and they had drifted apart without either being
 * complete: the sweeper's own comment claimed it protected promocodes that grant
 * the plan while its query only looked at `allowed_plan_ids`. One guard is the
 * only way the dialog, the delete and the sweep can never disagree.
 *
 * ── WHAT COUNTS, AND WHY (research: plan-delete/research.md) ─────────────────
 *
 * A kind is listed when losing the plan ROW would break something that is
 * already promised: money taken with nothing delivered, a prize that fails for
 * ever, a setting the operator cannot save any more. History that only NAMES a
 * plan (settled payments, audit rows, statistics, deleted subscriptions,
 * restriction lists such as `promocodes.allowed_plan_ids` — refused cleanly, not
 * used up) is not a reference and is deliberately absent.
 *
 *   subscriptions        a non-DELETED subscription whose snapshot names it
 *                        (`id`, or `planId` as re-imports write it)
 *   scheduledTerms       a SCHEDULED term on it — a paid future period
 *   unsettledPayments    a single purchase PENDING, or COMPLETED but not yet
 *                        fulfilled: fulfilment reads the LIVE plan row
 *   recentCheckouts      a CANCELED/FAILED single purchase from the last 7 days,
 *                        which a late provider webhook can still revive
 *   renewalItems         an unapplied combined-renewal line whose payment is
 *                        PENDING or COMPLETED
 *   trialReservations    a RESERVED paid-trial claim
 *   promocodes           an unarchived code granting it (legacy `plan` column
 *                        or a SUBSCRIPTION action); a paused code can be resumed
 *   quests               a DAYS or PROMOCODE reward naming it
 *   contests             a DRAFT/ACTIVE contest with a subscription code prize
 *                        on it (counted per contest)
 *   wheelSectors         a subscription code sector on it
 *   addOns               an add-on sold against it — its editor re-sends the
 *                        list and refuses an unknown id on every save
 *   adPlacements         an unarchived placement whose TARIFF signup bonus is it
 *   referralGift         the points-exchange gift subscription is it
 *   referralEligibility  it is the last live plan left in the referral program's
 *                        eligible plan list — without it every purchase is skipped
 *   transitions          another plan names it as an upgrade or replacement
 *                        target. The delete strips these first, so a transition
 *                        alone never keeps a plan — but the dialog lists them,
 *                        because those plans change.
 *
 * "Subscription code" means reward type SUBSCRIPTION or NULL: a PROMOCODE prize
 * with no reward type is minted as a SUBSCRIPTION code when it names a plan
 * (`RewardGrantService.mintPromocode`), and any other type never reads the plan.
 *
 * ── THE ORDER IS A WIRE CONTRACT ─────────────────────────────────────────────
 *
 * `PLAN_REFERENCE_KINDS` is the order the endpoint reports kinds in, and the
 * panel SPA pins the same list (`web/src/features/plans/plan-delete.ts`).
 * Appending a kind is safe — the SPA renders an unknown kind with a generic
 * label and treats it as keeping the plan. Renaming or reordering one is not.
 */
export const PLAN_REFERENCE_KINDS = [
  'subscriptions',
  'scheduledTerms',
  'unsettledPayments',
  'recentCheckouts',
  'renewalItems',
  'trialReservations',
  'promocodes',
  'quests',
  'contests',
  'wheelSectors',
  'addOns',
  'adPlacements',
  'referralGift',
  'referralEligibility',
  'transitions',
] as const;

export type PlanReferenceKind = (typeof PLAN_REFERENCE_KINDS)[number];

export type PlanReferenceCounts = Readonly<Record<PlanReferenceKind, number>>;

export interface PlanReferenceInterface {
  readonly kind: PlanReferenceKind;
  readonly count: number;
}

/**
 * How long a CANCELED or FAILED checkout counts as revivable.
 *
 * `PaymentReconciliationService` lets a late SUCCESS webhook bring a cancelled
 * transaction back, and our own 30-minute timer cancels non-YooKassa checkouts
 * while the provider may still accept payment. No per-provider horizon can be
 * read from the code, so the owner decided on seven days (research, table A).
 */
export const RECENT_CHECKOUT_REVIVAL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** What the guard reads through: the service's own client, or a transaction's. */
export type PlanReferenceClient = Pick<
  Prisma.TransactionClient,
  | 'subscription'
  | 'subscriptionTerm'
  | 'transaction'
  | 'transactionItem'
  | 'trialClaim'
  | 'promocode'
  | 'quest'
  | 'contestPrize'
  | 'wheelSector'
  | 'addOn'
  | 'adPlacement'
  | 'settings'
  | 'plan'
>;

/** A subscription-code prize: the reward types that make the payout read the plan. */
const SUBSCRIPTION_CODE_PRIZE = [
  { promoRewardType: PromocodeRewardType.SUBSCRIPTION },
  { promoRewardType: null },
] as const;

@Injectable()
export class PlanReferenceGuardService {
  public constructor(private readonly prismaService: PrismaService) {}

  /**
   * Every kind's count, for each plan id. Kinds that are cheap to batch are one
   * query for all ids; the JSON-path kinds are one COUNT per plan, because a
   * JSON path cannot be grouped on — which is what the sweeper did already, one
   * probe per retired plan.
   */
  public async countReferences(
    planIds: readonly string[],
    options: { readonly client?: PlanReferenceClient; readonly now?: Date } = {},
  ): Promise<ReadonlyMap<string, PlanReferenceCounts>> {
    const client: PlanReferenceClient = options.client ?? this.prismaService;
    const now = options.now ?? new Date();
    const ids = [...new Set(planIds)];
    const result = new Map<string, Record<PlanReferenceKind, number>>();
    for (const id of ids) {
      result.set(id, emptyCounts());
    }
    if (ids.length === 0) {
      return result;
    }
    const add = (planId: string | null, kind: PlanReferenceKind, count: number): void => {
      if (planId === null) return;
      const counts = result.get(planId);
      if (counts !== undefined) counts[kind] += count;
    };

    for (const planId of ids) {
      add(
        planId,
        'subscriptions',
        await client.subscription.count({
          where: {
            status: { not: SubscriptionStatus.DELETED },
            OR: [
              { planSnapshot: { path: ['id'], equals: planId } },
              { planSnapshot: { path: ['planId'], equals: planId } },
            ],
          },
        }),
      );
      add(
        planId,
        'unsettledPayments',
        await client.transaction.count({
          where: {
            planSnapshot: { path: ['id'], equals: planId },
            OR: [
              { status: TransactionStatus.PENDING },
              { status: TransactionStatus.COMPLETED, fulfilledAt: null },
            ],
          },
        }),
      );
      add(
        planId,
        'recentCheckouts',
        await client.transaction.count({
          where: {
            planSnapshot: { path: ['id'], equals: planId },
            status: { in: [TransactionStatus.CANCELED, TransactionStatus.FAILED] },
            createdAt: { gt: new Date(now.getTime() - RECENT_CHECKOUT_REVIVAL_WINDOW_MS) },
          },
        }),
      );
      add(
        planId,
        'promocodes',
        await client.promocode.count({
          where: {
            archivedAt: null,
            OR: [
              { plan: { path: ['id'], equals: planId } },
              {
                actions: {
                  some: {
                    type: PromocodeRewardType.SUBSCRIPTION,
                    payload: { path: ['plan', 'id'], equals: planId },
                  },
                },
              },
            ],
          },
        }),
      );
      add(
        planId,
        'adPlacements',
        await client.adPlacement.count({
          where: {
            signupBonusType: AdSignupBonusType.TARIFF,
            status: { not: AdPlacementStatus.ARCHIVED },
            signupBonus: { path: ['tariffPlanId'], equals: planId },
          },
        }),
      );
    }

    const terms = await client.subscriptionTerm.groupBy({
      by: ['planId'],
      where: { planId: { in: ids }, status: SubscriptionTermStatus.SCHEDULED },
      _count: { _all: true },
    });
    for (const row of terms) add(row.planId, 'scheduledTerms', row._count._all);

    const items = await client.transactionItem.groupBy({
      by: ['planId'],
      where: {
        planId: { in: ids },
        appliedAt: null,
        transaction: {
          status: { in: [TransactionStatus.PENDING, TransactionStatus.COMPLETED] },
        },
      },
      _count: { _all: true },
    });
    for (const row of items) add(row.planId, 'renewalItems', row._count._all);

    const reservations = await client.trialClaim.groupBy({
      by: ['planId'],
      where: { planId: { in: ids }, status: TrialClaimStatus.RESERVED },
      _count: { _all: true },
    });
    for (const row of reservations) add(row.planId, 'trialReservations', row._count._all);

    const quests = await client.quest.groupBy({
      by: ['rewardPlanId'],
      where: {
        rewardPlanId: { in: ids },
        rewardType: { in: [QuestRewardType.DAYS, QuestRewardType.PROMOCODE] },
      },
      _count: { _all: true },
    });
    for (const row of quests) add(row.rewardPlanId, 'quests', row._count._all);

    const prizes = await client.contestPrize.findMany({
      where: {
        promoPlanId: { in: ids },
        kind: WheelSectorKind.PROMOCODE,
        OR: [...SUBSCRIPTION_CODE_PRIZE],
        contest: { status: { in: [ContestStatus.DRAFT, ContestStatus.ACTIVE] } },
      },
      select: { promoPlanId: true, contestId: true },
    });
    const contestsByPlan = new Map<string, Set<string>>();
    for (const prize of prizes) {
      if (prize.promoPlanId === null) continue;
      const contests = contestsByPlan.get(prize.promoPlanId) ?? new Set<string>();
      contests.add(prize.contestId);
      contestsByPlan.set(prize.promoPlanId, contests);
    }
    for (const [planId, contests] of contestsByPlan) add(planId, 'contests', contests.size);

    const sectors = await client.wheelSector.groupBy({
      by: ['promoPlanId'],
      where: {
        promoPlanId: { in: ids },
        kind: WheelSectorKind.PROMOCODE,
        OR: [...SUBSCRIPTION_CODE_PRIZE],
      },
      _count: { _all: true },
    });
    for (const row of sectors) add(row.promoPlanId, 'wheelSectors', row._count._all);

    const addOns = await client.addOn.findMany({
      where: { applicablePlanIds: { hasSome: ids } },
      select: { applicablePlanIds: true },
    });
    for (const addOn of addOns) {
      for (const planId of new Set(addOn.applicablePlanIds)) add(planId, 'addOns', 1);
    }

    const referencing = await client.plan.findMany({
      where: {
        OR: [{ upgradeToPlanIds: { hasSome: ids } }, { replacementPlanIds: { hasSome: ids } }],
      },
      select: { id: true, upgradeToPlanIds: true, replacementPlanIds: true },
    });
    for (const plan of referencing) {
      const targets = new Set([...plan.upgradeToPlanIds, ...plan.replacementPlanIds]);
      for (const planId of targets) {
        if (planId !== plan.id) add(planId, 'transitions', 1);
      }
    }

    await this.countReferralSettings(client, ids, add);

    return result;
  }

  /** The kinds that use one plan, count above zero, in contract order. */
  public async listReferences(
    planId: string,
    options: { readonly client?: PlanReferenceClient; readonly now?: Date } = {},
  ): Promise<readonly PlanReferenceInterface[]> {
    const counts = (await this.countReferences([planId], options)).get(planId) ?? emptyCounts();
    return presentReferences(counts);
  }

  private async countReferralSettings(
    client: PlanReferenceClient,
    ids: readonly string[],
    add: (planId: string | null, kind: PlanReferenceKind, count: number) => void,
  ): Promise<void> {
    const settings = await client.settings.findFirst({ select: { referralSettings: true } });
    if (settings === null) return;

    const giftPlanId = readReferralGiftPlanId(settings.referralSettings);
    if (giftPlanId !== null && ids.includes(giftPlanId)) add(giftPlanId, 'referralGift', 1);

    const eligible = normalizeReferralSettings(settings.referralSettings).eligible_plan_ids ?? [];
    const named = ids.filter((planId) => eligible.includes(planId));
    if (named.length === 0) return;
    // "Live" = a row that exists and is not soft-deleted. A list whose every
    // other entry is dead would skip every purchase once this plan is gone.
    const live = await client.plan.findMany({
      where: { id: { in: [...new Set(eligible)] }, deletedAt: null },
      select: { id: true },
    });
    const liveIds = new Set(live.map((plan) => plan.id));
    for (const planId of named) {
      const anotherLive = eligible.some((id) => id !== planId && liveIds.has(id));
      if (!anotherLive) add(planId, 'referralEligibility', 1);
    }
  }
}

function emptyCounts(): Record<PlanReferenceKind, number> {
  const counts = {} as Record<PlanReferenceKind, number>;
  for (const kind of PLAN_REFERENCE_KINDS) counts[kind] = 0;
  return counts;
}

/** Kinds with a count above zero, in contract order. */
export function presentReferences(counts: PlanReferenceCounts): PlanReferenceInterface[] {
  return PLAN_REFERENCE_KINDS.filter((kind) => counts[kind] > 0).map((kind) => ({
    kind,
    count: counts[kind],
  }));
}

/** True when no kind at all references the plan — the only state it may be removed in. */
export function isUnreferenced(counts: PlanReferenceCounts): boolean {
  return PLAN_REFERENCE_KINDS.every((kind) => counts[kind] === 0);
}

/**
 * The points-exchange gift plan, read the way `ReferralPointsExchangeService`
 * reads it: `pointsExchange` or `points_exchange`, then `giftSubscription` or
 * `gift_subscription`, then `giftPlanId` or `gift_plan_id`; the first object /
 * the first non-empty string wins.
 *
 * A COPY of a private loader, which is the kind of thing that drifts — so
 * `test/plan-reference-guard.spec.ts` drives the real exchange with the same
 * settings and asserts it asks for the plan this function names.
 */
export function readReferralGiftPlanId(referralSettings: unknown): string | null {
  const root = asRecord(referralSettings);
  const exchange = firstRecord(root, ['pointsExchange', 'points_exchange']);
  const gift = firstRecord(exchange, ['giftSubscription', 'gift_subscription']);
  for (const key of ['giftPlanId', 'gift_plan_id']) {
    const value = gift[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function firstRecord(parent: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  for (const key of keys) {
    const value = parent[key];
    if (value !== null && typeof value === 'object') return value as Record<string, unknown>;
  }
  return {};
}
