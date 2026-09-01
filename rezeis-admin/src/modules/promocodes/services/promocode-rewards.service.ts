import { Injectable, Logger } from '@nestjs/common';
import {
  Prisma,
  PromocodeRewardType,
  SubscriptionStatus,
  SyncAction,
  SyncJobStatus,
} from '@prisma/client';

import { clampDiscountPercent } from '../../../common/utils/discount.util';
import { patchSnapshotNumeric } from '../../subscriptions/services/plan-inherited-limits.util';
import {
  PromocodeActionInput,
  PromocodeInterface,
  PromocodePlanSnapshotInterface,
} from '../interfaces/promocode.interface';
import { isUnmintableSnapshotTrafficLimit } from '../utils/promocode-mappers.util';

/**
 * Donor: `src/services/promocode_rewards.py`.
 *
 * The rewards service contains the pure mutation rules that turn an
 * activated promocode into concrete database changes. Each method works on
 * an already-opened Prisma transaction client so the caller (lifecycle
 * service) can wrap validation + activation + reward application into a
 * single atomic step. A failure here MUST roll back the activation row.
 *
 * The current first slice intentionally does NOT trigger Remnawave panel
 * synchronization. Donor parity for that orchestration moves into a
 * separate `ProfileSyncJob` row created elsewhere — keeping this service
 * deterministic and easy to reason about under transaction control.
 */
@Injectable()
export class PromocodeRewardsService {
  private readonly logger = new Logger(PromocodeRewardsService.name);

  /**
   * Applies the resolved reward to the matching aggregate. Returns `true`
   * when the reward was applied so the lifecycle service can finalize the
   * activation; returns `false` to signal a soft failure that should roll
   * back the activation. Hard errors are re-thrown.
   */
  public async applyReward(input: {
    readonly transactionClient: Prisma.TransactionClient;
    readonly promocode: PromocodeInterface;
    readonly userId: string;
    readonly targetSubscriptionId: string | null;
  }): Promise<{
    readonly applied: boolean;
    readonly rewardValue: number;
    readonly syncJobId?: string;
  }> {
    const { promocode } = input;
    // The legacy single-reward entry point. It now describes the promocode's
    // FIRST action and delegates, so nothing that still calls it has to change
    // while the panel and the cabinet are on different versions.
    return this.applyAction({
      ...input,
      action: {
        type: promocode.rewardType,
        value: promocode.reward,
        plan: promocode.plan,
        discountAllowedPlanIds: [],
        discountValidForDays: null,
      },
    });
  }

  /**
   * Applies ONE action of a promocode.
   *
   * ── Why the switch moved here unchanged ───────────────────────────────────
   *
   * A promocode used to do exactly one thing, and this switch was reached once
   * per activation. Now it is reached once per action, and everything else
   * about it is the same: it runs inside the caller's transaction, it returns
   * `applied: false` for a soft failure that must roll the activation back, and
   * it never decides on its own what to do about that.
   *
   * The conditions still come from the PROMOCODE — which subscription may be
   * targeted is a property of the code, not of one of its actions. Only the
   * magnitude and the action-specific extras come from the action.
   */
  public async applyAction(input: {
    readonly transactionClient: Prisma.TransactionClient;
    readonly promocode: PromocodeInterface;
    readonly userId: string;
    readonly targetSubscriptionId: string | null;
    readonly action: PromocodeActionInput;
  }): Promise<{
    readonly applied: boolean;
    readonly rewardValue: number;
    readonly syncJobId?: string;
    /**
     * The subscription this action ended up working on, when it CREATED one.
     *
     * A SUBSCRIPTION action with no target creates a subscription, and every
     * action after it in the same activation has to land on that one. Without
     * this the loop kept passing the pre-transaction target — `null` — so a
     * code granting a subscription AND extra days failed on the days and rolled
     * the new subscription back with it.
     */
    readonly createdSubscriptionId?: string;
  }> {
    const { promocode, action } = input;
    const reward = action.value ?? 0;

    switch (action.type) {
      case PromocodeRewardType.PERSONAL_DISCOUNT:
        return this.applyDiscount({
          transactionClient: input.transactionClient,
          userId: input.userId,
          field: 'personalDiscount',
          value: clampDiscountPercent(reward),
        });
      case PromocodeRewardType.PURCHASE_DISCOUNT:
        return this.applyPurchaseDiscount({
          transactionClient: input.transactionClient,
          userId: input.userId,
          value: clampDiscountPercent(reward),
          allowedPlanIds: action.discountAllowedPlanIds,
          validForDays: action.discountValidForDays,
          sourcePromocodeId: promocode.id,
        });
      case PromocodeRewardType.DURATION:
        return this.applyDurationReward({
          transactionClient: input.transactionClient,
          promocode,
          userId: input.userId,
          targetSubscriptionId: input.targetSubscriptionId,
          days: reward,
        });
      case PromocodeRewardType.TRAFFIC:
        return this.applyTrafficReward({
          transactionClient: input.transactionClient,
          promocode,
          userId: input.userId,
          targetSubscriptionId: input.targetSubscriptionId,
          additionalGigabytes: reward,
        });
      case PromocodeRewardType.DEVICES:
        return this.applyDevicesReward({
          transactionClient: input.transactionClient,
          promocode,
          userId: input.userId,
          targetSubscriptionId: input.targetSubscriptionId,
          additionalDevices: reward,
        });
      case PromocodeRewardType.SUBSCRIPTION:
        return this.applySubscriptionReward({
          transactionClient: input.transactionClient,
          promocode,
          userId: input.userId,
          targetSubscriptionId: input.targetSubscriptionId,
          plan: action.plan,
        });
      default:
        return { applied: false, rewardValue: 0 };
    }
  }

  /**
   * Enqueue a Remnawave sync for a subscription that a reward just mutated
   * locally (expiry / traffic / device limit / new subscription). Without
   * this the change only lives in the local DB and the user's real VPN
   * profile is never updated — the "promocode activated but nothing
   * happened" class of bug. Created inside the activation transaction; the
   * lifecycle caller enqueues it to BullMQ after commit, and the
   * profile-sync sweep recovers it within 5 min if the enqueue is missed.
   */
  private async enqueueSubscriptionSync(input: {
    readonly transactionClient: Prisma.TransactionClient;
    readonly subscriptionId: string;
    readonly remnawaveId: string | null;
    readonly promocode: PromocodeInterface;
  }): Promise<string> {
    const syncJob = await input.transactionClient.profileSyncJob.create({
      data: {
        subscriptionId: input.subscriptionId,
        action: input.remnawaveId === null ? SyncAction.CREATE : SyncAction.UPDATE,
        status: SyncJobStatus.PENDING,
        payload: {
          source: 'PROMOCODE_REWARD',
          promocodeId: input.promocode.id,
          code: input.promocode.code,
          rewardType: input.promocode.rewardType,
        } as Prisma.InputJsonObject,
      },
    });
    return syncJob.id;
  }

  private async lockSubscription(
    transactionClient: Prisma.TransactionClient,
    subscriptionId: string,
  ): Promise<void> {
    await transactionClient.$queryRaw(
      Prisma.sql`SELECT "id" FROM "subscriptions" WHERE "id" = ${subscriptionId} FOR UPDATE`,
    );
  }

  private isEligibleTarget(
    subscription: {
      readonly userId: string;
      readonly status: SubscriptionStatus;
      readonly planSnapshot: Prisma.JsonValue;
    },
    userId: string,
    promocode: PromocodeInterface,
  ): boolean {
    if (subscription.userId !== userId || subscription.status !== SubscriptionStatus.ACTIVE) {
      return false;
    }
    if (promocode.allowedPlanIds.length === 0) return true;
    const planId = readPlanId(subscription.planSnapshot);
    return planId !== null && promocode.allowedPlanIds.includes(planId);
  }

  /**
   * Donor parity helper exposed to the portal layer so it can decorate
   * activation responses with a stable i18n key per reward type.
   */
  public getSuccessMessageKey(rewardType: PromocodeRewardType): string {
    switch (rewardType) {
      case PromocodeRewardType.DURATION:
        return 'ntf-promocode-activated-duration';
      case PromocodeRewardType.TRAFFIC:
        return 'ntf-promocode-activated-traffic';
      case PromocodeRewardType.DEVICES:
        return 'ntf-promocode-activated-devices';
      case PromocodeRewardType.SUBSCRIPTION:
        return 'ntf-promocode-activated-subscription';
      case PromocodeRewardType.PERSONAL_DISCOUNT:
        return 'ntf-promocode-activated-personal-discount';
      case PromocodeRewardType.PURCHASE_DISCOUNT:
        return 'ntf-promocode-activated-purchase-discount';
      default:
        return 'ntf-promocode-activated';
    }
  }

  /**
   * Donor parity helper used when the reward magnitude is implicit. Callers
   * pass `Promocode.reward` first and fall back to `Promocode.plan.duration`
   * for SUBSCRIPTION rewards that store the duration inside the snapshot.
   */
  public resolveActivationRewardValue(promocode: PromocodeInterface): number {
    if (promocode.reward !== null && promocode.reward !== 0) {
      return promocode.reward;
    }
    if (
      promocode.rewardType === PromocodeRewardType.SUBSCRIPTION &&
      promocode.plan !== null &&
      typeof promocode.plan.duration === 'number'
    ) {
      return promocode.plan.duration;
    }
    return 0;
  }

  /**
   * Grants a one-time purchase discount.
   *
   * ── Why this writes in two places ─────────────────────────────────────────
   *
   * `user.purchaseDiscount` is the original bare percentage, and it is still
   * read by an older half of the system and still written by donor imports. It
   * keeps being set so nothing that reads it starts seeing zero.
   *
   * The GRANT beside it is what makes "-20%, but only on the six-month plan"
   * expressible at all. The promocode's own plan restriction is checked when
   * the CODE is activated, and the discount is spent at whatever purchase comes
   * next — possibly weeks later, on a different plan — so a restriction that
   * does not travel with the discount has no bearing on where it is spent.
   *
   * Both are settled together at checkout; see `consumePurchaseDiscount`.
   */
  private async applyPurchaseDiscount(input: {
    readonly transactionClient: Prisma.TransactionClient;
    readonly userId: string;
    readonly value: number;
    readonly allowedPlanIds: readonly string[];
    readonly validForDays: number | null;
    readonly sourcePromocodeId: string;
  }): Promise<{ readonly applied: boolean; readonly rewardValue: number }> {
    // ── THE COLUMN MIRRORS ONLY AN UNRESTRICTED GRANT ────────────────────
    //
    // `user.purchaseDiscount` is a bare percentage with nowhere to put a plan
    // list or an expiry. Mirroring a RESTRICTED grant into it hands every
    // reader a way around the restriction: the column applies to any purchase,
    // so "-20% only on six months" came off a one-month order through the
    // fallback path, which is the exact thing grants exist to prevent.
    //
    // An unrestricted grant is still mirrored, because an older half of the
    // system reads only the column and would otherwise see no discount at all.
    const restricted =
      input.allowedPlanIds.length > 0 ||
      (input.validForDays !== null && input.validForDays > 0);
    if (!restricted) {
      await input.transactionClient.user.update({
        where: { id: input.userId },
        data: { purchaseDiscount: input.value },
      });
    }
    await input.transactionClient.userPendingDiscount.create({
      data: {
        userId: input.userId,
        percent: input.value,
        allowedPlanIds: [...input.allowedPlanIds],
        expiresAt:
          input.validForDays === null || input.validForDays <= 0
            ? null
            : new Date(Date.now() + input.validForDays * 24 * 60 * 60 * 1000),
        sourcePromocodeId: input.sourcePromocodeId,
      },
    });
    return { applied: true, rewardValue: input.value };
  }

  private async applyDiscount(input: {
    readonly transactionClient: Prisma.TransactionClient;
    readonly userId: string;
    readonly field: 'personalDiscount' | 'purchaseDiscount';
    readonly value: number;
  }): Promise<{ readonly applied: boolean; readonly rewardValue: number }> {
    await input.transactionClient.user.update({
      where: { id: input.userId },
      data: { [input.field]: input.value },
    });
    return { applied: true, rewardValue: input.value };
  }

  private async applyDurationReward(input: {
    readonly transactionClient: Prisma.TransactionClient;
    readonly promocode: PromocodeInterface;
    readonly userId: string;
    readonly targetSubscriptionId: string | null;
    readonly days: number;
  }): Promise<{
    readonly applied: boolean;
    readonly rewardValue: number;
    readonly syncJobId?: string;
  }> {
    if (input.targetSubscriptionId === null || input.days <= 0) {
      return { applied: false, rewardValue: 0 };
    }
    await this.lockSubscription(input.transactionClient, input.targetSubscriptionId);
    const subscription = await input.transactionClient.subscription.findUnique({
      where: { id: input.targetSubscriptionId },
      select: {
        expiresAt: true,
        status: true,
        remnawaveId: true,
        userId: true,
        planSnapshot: true,
      },
    });
    if (
      subscription === null ||
      !this.isEligibleTarget(subscription, input.userId, input.promocode) ||
      subscription.expiresAt === null
    ) {
      return { applied: false, rewardValue: 0 };
    }
    const baseExpiry = new Date(Math.max(subscription.expiresAt.getTime(), Date.now()));
    const nextExpiry = new Date(baseExpiry.getTime() + input.days * 24 * 60 * 60 * 1000);
    await input.transactionClient.subscription.update({
      where: { id: input.targetSubscriptionId },
      data: { expiresAt: nextExpiry },
    });
    const syncJobId = await this.enqueueSubscriptionSync({
      transactionClient: input.transactionClient,
      subscriptionId: input.targetSubscriptionId,
      remnawaveId: subscription.remnawaveId,
      promocode: input.promocode,
    });
    return { applied: true, rewardValue: input.days, syncJobId };
  }

  private async applyTrafficReward(input: {
    readonly transactionClient: Prisma.TransactionClient;
    readonly promocode: PromocodeInterface;
    readonly userId: string;
    readonly targetSubscriptionId: string | null;
    readonly additionalGigabytes: number;
  }): Promise<{
    readonly applied: boolean;
    readonly rewardValue: number;
    readonly syncJobId?: string;
  }> {
    if (input.targetSubscriptionId === null || input.additionalGigabytes <= 0) {
      return { applied: false, rewardValue: 0 };
    }
    await this.lockSubscription(input.transactionClient, input.targetSubscriptionId);
    const subscription = await input.transactionClient.subscription.findUnique({
      where: { id: input.targetSubscriptionId },
      select: {
        trafficLimit: true,
        status: true,
        planSnapshot: true,
        remnawaveId: true,
        userId: true,
      },
    });
    if (
      subscription === null ||
      !this.isEligibleTarget(subscription, input.userId, input.promocode) ||
      subscription.trafficLimit === null
    ) {
      return { applied: false, rewardValue: 0 };
    }
    const nextLimit = subscription.trafficLimit + input.additionalGigabytes;
    const nextSnapshot = patchSnapshotNumeric(
      subscription.planSnapshot,
      'trafficLimit',
      nextLimit,
    ) as Prisma.InputJsonValue;
    await input.transactionClient.subscription.update({
      where: { id: input.targetSubscriptionId },
      data: {
        trafficLimit: nextLimit,
        planSnapshot: nextSnapshot,
      },
    });
    const syncJobId = await this.enqueueSubscriptionSync({
      transactionClient: input.transactionClient,
      subscriptionId: input.targetSubscriptionId,
      remnawaveId: subscription.remnawaveId,
      promocode: input.promocode,
    });
    return { applied: true, rewardValue: input.additionalGigabytes, syncJobId };
  }

  private async applyDevicesReward(input: {
    readonly transactionClient: Prisma.TransactionClient;
    readonly promocode: PromocodeInterface;
    readonly userId: string;
    readonly targetSubscriptionId: string | null;
    readonly additionalDevices: number;
  }): Promise<{
    readonly applied: boolean;
    readonly rewardValue: number;
    readonly syncJobId?: string;
  }> {
    if (input.targetSubscriptionId === null || input.additionalDevices <= 0) {
      return { applied: false, rewardValue: 0 };
    }
    await this.lockSubscription(input.transactionClient, input.targetSubscriptionId);
    const subscription = await input.transactionClient.subscription.findUnique({
      where: { id: input.targetSubscriptionId },
      select: {
        deviceLimit: true,
        status: true,
        planSnapshot: true,
        remnawaveId: true,
        userId: true,
      },
    });
    if (
      subscription === null ||
      !this.isEligibleTarget(subscription, input.userId, input.promocode) ||
      subscription.deviceLimit <= 0
    ) {
      return { applied: false, rewardValue: 0 };
    }
    const nextLimit = subscription.deviceLimit + input.additionalDevices;
    const nextSnapshot = patchSnapshotNumeric(
      subscription.planSnapshot,
      'deviceLimit',
      nextLimit,
    ) as Prisma.InputJsonValue;
    await input.transactionClient.subscription.update({
      where: { id: input.targetSubscriptionId },
      data: {
        deviceLimit: nextLimit,
        planSnapshot: nextSnapshot,
      },
    });
    const syncJobId = await this.enqueueSubscriptionSync({
      transactionClient: input.transactionClient,
      subscriptionId: input.targetSubscriptionId,
      remnawaveId: subscription.remnawaveId,
      promocode: input.promocode,
    });
    return { applied: true, rewardValue: input.additionalDevices, syncJobId };
  }

  private async applySubscriptionReward(input: {
    readonly transactionClient: Prisma.TransactionClient;
    readonly promocode: PromocodeInterface;
    readonly userId: string;
    readonly targetSubscriptionId: string | null;
    readonly plan: PromocodePlanSnapshotInterface | null;
  }): Promise<{
    readonly applied: boolean;
    readonly rewardValue: number;
    readonly syncJobId?: string;
    readonly createdSubscriptionId?: string;
  }> {
    // The ACTION's plan first: with a list, the mirror column describes only
    // the first action, so a SUBSCRIPTION action that is not first would have
    // read somebody else's plan — or none.
    const plan = input.plan ?? input.promocode.plan;
    if (plan === null) {
      this.logger.warn(
        `Promocode ${input.promocode.code} has rewardType=SUBSCRIPTION but no plan snapshot`,
      );
      return { applied: false, rewardValue: 0 };
    }
    const days = plan.duration ?? 0;

    if (input.targetSubscriptionId !== null) {
      // Extend an existing eligible subscription by the snapshot duration.
      if (days <= 0) {
        return { applied: false, rewardValue: 0 };
      }
      await this.lockSubscription(input.transactionClient, input.targetSubscriptionId);
      const subscription = await input.transactionClient.subscription.findUnique({
        where: { id: input.targetSubscriptionId },
        select: {
          expiresAt: true,
          status: true,
          remnawaveId: true,
          userId: true,
          planSnapshot: true,
        },
      });
      if (
        subscription === null ||
        !this.isEligibleTarget(subscription, input.userId, input.promocode) ||
        subscription.expiresAt === null
      ) {
        return { applied: false, rewardValue: 0 };
      }
      const baseExpiry = new Date(Math.max(subscription.expiresAt.getTime(), Date.now()));
      const nextExpiry = new Date(baseExpiry.getTime() + days * 24 * 60 * 60 * 1000);
      await input.transactionClient.subscription.update({
        where: { id: input.targetSubscriptionId },
        data: { expiresAt: nextExpiry },
      });
      const syncJobId = await this.enqueueSubscriptionSync({
        transactionClient: input.transactionClient,
        subscriptionId: input.targetSubscriptionId,
        remnawaveId: subscription.remnawaveId,
        promocode: input.promocode,
      });
      return { applied: true, rewardValue: days, syncJobId };
    }

    // THE PRODUCT DECISION, taken deliberately and reversible in one line —
    // read `isUnmintableSnapshotTrafficLimit` in `promocode-mappers.util.ts`
    // for the full reasoning before changing it.
    //
    // The stored snapshot is copied VERBATIM into `Subscription.trafficLimit`
    // three lines below; nothing between here and the column clamps, converts
    // or re-derives it. `@Min(1)` on the snapshot DTO only closed the write
    // side, and only as of now — it was `@Min(0)` and the create/update path
    // writes `dto.plan` into the JSON column unchanged, so promocodes authored
    // earlier can still be carrying a `0`. There is no migration to sweep them.
    //
    // A `0` here is not a small cap. Remnawave spells unlimited traffic as `0`
    // bytes and cannot express "zero bytes allowed" at all, so minting it hands
    // the customer UNLIMITED upstream while the row says the opposite, and the
    // sync job then reports drift on every sweep for the life of the row.
    //
    // Refusing rather than rewriting, because both rewrites are guesses that
    // succeed silently: `0 → null` gives away unlimited, `0 → 1` invents a cap
    // nobody chose. This refusal is soft and NON-DESTRUCTIVE — `applied: false`
    // makes the lifecycle service roll the activation row back, so the customer
    // keeps the promocode and it works the moment an operator fixes the
    // snapshot — and it is loud, because the log line below is the only thing
    // that distinguishes it from the half-dozen ordinary `REWARD_NOT_APPLICABLE`
    // outcomes.
    if (isUnmintableSnapshotTrafficLimit(plan.trafficLimit)) {
      this.logger.error(
        `Promocode ${input.promocode.code} refused: plan snapshot ${plan.id} carries ` +
          `trafficLimit=${String(plan.trafficLimit)}, which Remnawave cannot express — its 0 is ` +
          'UNLIMITED, so minting this would uncap the customer upstream and report drift on ' +
          'every sync forever. The activation was rolled back and the promocode is still ' +
          'redeemable; edit the snapshot to a whole number of gigabytes >= 1, or to null for ' +
          'unlimited.',
      );
      return { applied: false, rewardValue: 0 };
    }

    // Create a brand-new subscription from the plan snapshot, then enqueue a
    // Remnawave CREATE so the user actually gets a working profile. Both the
    // local row and the sync job are written in the same transaction; the
    // caller enqueues the job to BullMQ after commit (and the profile-sync
    // sweep recovers it within 5 min if the enqueue is missed).
    const startedAt = new Date();
    const expiresAt = days > 0 ? new Date(startedAt.getTime() + days * 24 * 60 * 60 * 1000) : null;
    const createdSubscription = await input.transactionClient.subscription.create({
      data: {
        userId: input.userId,
        status: SubscriptionStatus.ACTIVE,
        isTrial: false,
        planSnapshot: plan as unknown as Prisma.InputJsonValue,
        trafficLimit: plan.trafficLimit ?? null,
        deviceLimit: plan.deviceLimit,
        internalSquads: [...plan.internalSquads],
        externalSquad: plan.externalSquad,
        startedAt,
        expiresAt,
      },
    });
    // Backfill the user's "current subscription" pointer when unset, so
    // referral EXTRA_DAYS rewards and points-exchange (days / traffic) have a
    // target (matches the importer / payment backfill pattern).
    await input.transactionClient.user.updateMany({
      where: { id: input.userId, currentSubscriptionId: null },
      data: { currentSubscriptionId: createdSubscription.id },
    });
    const syncJobId = await this.enqueueSubscriptionSync({
      transactionClient: input.transactionClient,
      subscriptionId: createdSubscription.id,
      remnawaveId: null,
      promocode: input.promocode,
    });
    // The id travels back so every later action in this activation lands on
    // the subscription that was just created, instead of the `null` target the
    // activation started with.
    return {
      applied: true,
      rewardValue: days,
      syncJobId,
      createdSubscriptionId: createdSubscription.id,
    };
  }
}

function readPlanId(snapshot: Prisma.JsonValue): string | null {
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
  const id = (snapshot as Record<string, unknown>).id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}


// `patchSnapshotNumeric` used to be defined here. It now lives beside the
// reader that gives it meaning — `resolveInheritedPlanLimitUpdate` in
// `plan-inherited-limits.util.ts` — so every caller that moves a limit column
// makes the same explicit choice about whether the change outlives a renewal.
