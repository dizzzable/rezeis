import { BadRequestException, Injectable } from '@nestjs/common';
import {
  Prisma,
  PromocodeAvailability,
  PromocodeRewardType,
  SubscriptionStatus,
} from '@prisma/client';

import { clampDiscountPercent } from '../../common/utils/discount.util';
import { PointsWalletService } from '../points/services/points-wallet.service';
import { patchSnapshotNumeric } from '../subscriptions/services/plan-inherited-limits.util';
import { buildPlanSnapshot } from '../users/utils/plan-snapshot.util';
import { RewardApplication, RewardGrant, RewardOrigin } from './reward-grant.types';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * THE ONE PLACE A REWARD IS GIVEN.
 *
 * ── Why it left the quest service ────────────────────────────────────────
 *
 * Every rule in here is subtle enough to be got wrong the second time it is
 * written, and this repository has the scars: a discount ceiling that existed
 * twice and disagreed, a traffic top-up whose snapshot had to move with its
 * column or the bonus outlived every renewal. The wheel gives the same five
 * things a quest gives, so it calls this rather than growing its own copy —
 * the copy that would drift on the first bug fix applied to only one of them.
 *
 * ── What it is NOT responsible for ───────────────────────────────────────
 *
 * Deciding WHETHER to pay. The caller owns that: the quest stamps a
 * single-winner claim and reserves a budget, the wheel consumes a spin and
 * takes a sector's last slot. By the time this runs, the right to be paid is
 * already established, and everything here is inside the caller's transaction
 * so a failure rolls that right back with it.
 *
 * It also does not enqueue the panel sync. It reports which subscription
 * needs one and the caller enqueues after the commit, because a job enqueued
 * inside a transaction announces a change a rollback then undoes.
 */
@Injectable()
export class RewardGrantService {
  public constructor(private readonly pointsWallet: PointsWalletService) {}

  public async apply(
    tx: Prisma.TransactionClient,
    input: {
      readonly userId: string;
      readonly grant: RewardGrant;
      readonly origin: RewardOrigin;
    },
  ): Promise<RewardApplication> {
    switch (input.grant.kind) {
      case 'POINTS':
        return this.applyPoints(tx, input);
      case 'DISCOUNT':
        return this.applyDiscount(tx, input);
      case 'TRAFFIC':
        return this.applyTraffic(tx, input);
      case 'DAYS':
        return this.applyDays(tx, input);
      case 'PROMOCODE':
        return {
          kind: 'PROMOCODE',
          promoCode: await this.mintPromocode(tx, input.userId, input.grant, input.origin),
          syncSubscriptionId: null,
        };
    }
  }

  /**
   * Through the wallet, keyed on the caller's own handle: the caller's
   * single-winner claim already makes this exactly-once, and the key makes the
   * journal agree with it. A zero-value reward credits nothing and writes no
   * row — the wallet refuses a movement of zero.
   */
  private async applyPoints(
    tx: Prisma.TransactionClient,
    input: { readonly userId: string; readonly grant: RewardGrant; readonly origin: RewardOrigin },
  ): Promise<RewardApplication> {
    if (input.grant.amount > 0) {
      const moved = await this.pointsWallet.apply(tx, {
        userId: input.userId,
        delta: input.grant.amount,
        source: input.origin.pointsSource,
        referenceKey: input.origin.referenceKey,
        details: input.origin.details,
      });
      if (!moved.applied) {
        throw new Error(
          `Points for ${input.origin.pointsSource}:${input.origin.referenceKey} were not credited (${moved.reason})`,
        );
      }
    }
    return { kind: 'POINTS', points: input.grant.amount, syncSubscriptionId: null };
  }

  /**
   * The PERMANENT personal discount, added to whatever the person already has.
   *
   * Clamped by the shared ceiling and not by a local `100`, which is what it
   * used to be. Pricing has capped what it APPLIES at the shared ceiling since
   * the promocode work, so a stored 100 was a number that could never be
   * spent: the column said one thing and every checkout did another. Nothing
   * changes for a customer here — only the stored figure stops lying.
   */
  private async applyDiscount(
    tx: Prisma.TransactionClient,
    input: { readonly userId: string; readonly grant: RewardGrant },
  ): Promise<RewardApplication> {
    const user = await tx.user.findUnique({
      where: { id: input.userId },
      select: { personalDiscount: true },
    });
    const next = clampDiscountPercent((user?.personalDiscount ?? 0) + input.grant.amount);
    await tx.user.update({ where: { id: input.userId }, data: { personalDiscount: next } });
    return { kind: 'DISCOUNT', discountPercent: next, syncSubscriptionId: null };
  }

  private async applyTraffic(
    tx: Prisma.TransactionClient,
    input: { readonly userId: string; readonly grant: RewardGrant },
  ): Promise<RewardApplication> {
    const subId = await resolveActiveSubscriptionId(tx, input.userId);
    if (subId === null) {
      return { kind: 'TRAFFIC', trafficGb: input.grant.amount, syncSubscriptionId: null };
    }
    // The row lock is what lets the increment below be written as an absolute
    // value. It has to be absolute: `planSnapshot` is JSON and cannot be
    // incremented, so the column and the snapshot would drift apart under two
    // concurrent payouts — and a column that no longer matches its snapshot is
    // exactly the "operator override" signal this write exists to avoid
    // raising. Same lock, same reason, as `PromocodeRewardsService` and the
    // referral points exchange.
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "subscriptions" WHERE "id" = ${subId} FOR UPDATE`);
    const sub = await tx.subscription.findUnique({
      where: { id: subId },
      // `planSnapshot` is read so the top-up can re-declare the raised value as
      // plan-given; see `patchSnapshotNumeric` just below.
      select: { trafficLimit: true, planSnapshot: true },
    });
    if (sub?.trafficLimit == null) {
      // Unlimited traffic has nothing to top up.
      return { kind: 'TRAFFIC', trafficGb: input.grant.amount, subscriptionId: subId, syncSubscriptionId: null };
    }
    const trafficLimitAfter = sub.trafficLimit + input.grant.amount;
    // The snapshot moves with the column, exactly as the promocode
    // EXTRA_TRAFFIC reward and the referral points exchange do. That leaves the
    // two in step, so `resolveInheritedPlanLimitUpdate` still reads the
    // subscription as tracking its plan and the customer's next renewal resets
    // the traffic to the plan's own limit.
    //
    // Deliberate, and the same rule for every reward path: a bonus top-up is
    // for the CURRENT period, not a permanent change to the priced good.
    // Omitting this write would silently declare an operator override and make
    // the bonus outlive every renewal for the rest of the subscription's life —
    // as a raw column bump routing around `SubscriptionEffectiveProjection`,
    // which is where a genuinely PURCHASED permanent extra belongs.
    await tx.subscription.update({
      where: { id: subId },
      data: {
        trafficLimit: trafficLimitAfter,
        planSnapshot: patchSnapshotNumeric(
          sub.planSnapshot,
          'trafficLimit',
          trafficLimitAfter,
        ) as Prisma.InputJsonValue,
      },
    });
    return {
      kind: 'TRAFFIC',
      trafficGb: input.grant.amount,
      subscriptionId: subId,
      syncSubscriptionId: subId,
    };
  }

  /**
   * Extends a bounded active subscription, or — when there is none to extend —
   * mints a code the person can use once they have one. Days that vanish
   * because the recipient happened to have no subscription are days the
   * operator paid for and nobody received.
   */
  private async applyDays(
    tx: Prisma.TransactionClient,
    input: { readonly userId: string; readonly grant: RewardGrant; readonly origin: RewardOrigin },
  ): Promise<RewardApplication> {
    const subId = await resolveBoundedSubscriptionId(tx, input.userId);
    if (subId === null) {
      return {
        kind: 'DAYS',
        days: input.grant.amount,
        promoCode: await this.mintPromocode(tx, input.userId, input.grant, input.origin),
        syncSubscriptionId: null,
      };
    }
    const sub = await tx.subscription.findUnique({
      where: { id: subId },
      select: { expiresAt: true },
    });
    // From the later of "now" and the current expiry: extending an already
    // expired subscription from its old date would give days in the past.
    const base =
      sub?.expiresAt != null && sub.expiresAt.getTime() > Date.now() ? sub.expiresAt : new Date();
    await tx.subscription.update({
      where: { id: subId },
      data: {
        expiresAt: new Date(base.getTime() + input.grant.amount * MS_PER_DAY),
        status: SubscriptionStatus.ACTIVE,
      },
    });
    return {
      kind: 'DAYS',
      days: input.grant.amount,
      subscriptionId: subId,
      syncSubscriptionId: subId,
    };
  }

  /**
   * A personal, single-use code. Written with the legacy reward columns and no
   * action rows, which `mapPromocodeActions` reads as one action — the
   * documented path for a code minted outside the panel's own editor.
   *
   * ── "Personal" is now enforced, not just claimed ─────────────────────────
   *
   * This comment said "personal" long before the row did: a code was minted
   * `availability: ALL` with a single activation, so the first person to
   * learn it could spend it — a screenshot of a win was a coupon for whoever
   * saw it. Bound to the winner's telegram id, the availability check refuses
   * everybody else, and single-use still stops the winner spending it twice.
   *
   * Somebody with no telegram id (a web-only account) cannot be bound: the
   * check has nothing to compare and would refuse the winner their own prize.
   * Those codes stay open, which is exactly what they were before.
   */
  private async mintPromocode(
    tx: Prisma.TransactionClient,
    userId: string,
    grant: RewardGrant,
    origin: RewardOrigin,
  ): Promise<string> {
    const winner = await tx.user.findUnique({
      where: { id: userId },
      select: { telegramId: true },
    });
    const binding =
      winner?.telegramId == null
        ? { availability: PromocodeAvailability.ALL }
        : {
            availability: PromocodeAvailability.ALLOWED,
            allowedTelegramIds: [winner.telegramId],
          };
    const restriction = {
      ...(grant.promo === undefined || grant.promo.allowedPlanIds.length === 0
        ? {}
        : { allowedPlanIds: [...grant.promo.allowedPlanIds] }),
      ...(grant.promo?.lifetimeDays == null ? {} : { lifetime: grant.promo.lifetimeDays }),
    };

    const code = generatePromoCode(origin.codePrefix);
    const rewardType =
      grant.promo?.rewardType ??
      (grant.planId !== null ? PromocodeRewardType.SUBSCRIPTION : PromocodeRewardType.DURATION);

    if (rewardType === PromocodeRewardType.SUBSCRIPTION) {
      if (grant.planId === null) {
        throw new BadRequestException('A subscription code needs a plan');
      }
      const plan = await tx.plan.findUnique({
        where: { id: grant.planId },
        select: {
          id: true,
          name: true,
          tag: true,
          type: true,
          icon: true,
          trafficLimit: true,
          deviceLimit: true,
          trafficLimitStrategy: true,
          internalSquads: true,
          externalSquad: true,
        },
      });
      if (plan === null) {
        throw new BadRequestException('Reward plan not found');
      }
      const snapshot = {
        ...(buildPlanSnapshot(plan) as Record<string, unknown>),
        duration: grant.amount,
      };
      await tx.promocode.create({
        data: {
          code,
          isActive: true,
          ...binding,
          rewardType: PromocodeRewardType.SUBSCRIPTION,
          reward: grant.amount,
          plan: snapshot as Prisma.InputJsonValue,
          maxActivations: 1,
          ...restriction,
        },
      });
      return code;
    }

    await tx.promocode.create({
      data: {
        code,
        isActive: true,
        ...binding,
        rewardType,
        reward: grant.amount,
        maxActivations: 1,
        ...restriction,
      },
    });
    return code;
  }
}

/**
 * Most-recent ACTIVE subscription with a bounded expiry, i.e. one that days
 * can be added to. Read through the caller's transaction, not beside it: a
 * read on the pool runs on another connection and can hand back a row this
 * transaction is about to change.
 */
async function resolveBoundedSubscriptionId(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<string | null> {
  const sub = await tx.subscription.findFirst({
    where: { userId, status: SubscriptionStatus.ACTIVE, expiresAt: { not: null } },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  return sub?.id ?? null;
}

/** Most-recent ACTIVE subscription, bounded or unlimited. */
async function resolveActiveSubscriptionId(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<string | null> {
  const sub = await tx.subscription.findFirst({
    where: { userId, status: SubscriptionStatus.ACTIVE },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  return sub?.id ?? null;
}

/** The alphabet drops the characters people mistype off a screen: I, O, 0, 1. */
function generatePromoCode(prefix: string): string {
  let code = prefix;
  for (let index = 0; index < 8; index += 1) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return code;
}
