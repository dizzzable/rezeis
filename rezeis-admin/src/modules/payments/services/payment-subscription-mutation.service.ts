import { Injectable, NotFoundException } from '@nestjs/common';
import {
  AddOnType,
  DeviceType,
  Plan,
  PlanAvailability,
  ProfileSyncJob,
  Prisma,
  PurchaseType,
  Subscription,
  SubscriptionStatus,
  SyncAction,
  SyncJobStatus,
  Transaction,
  TransactionItem,
} from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { SystemEventsService, EVENT_TYPES } from '../../../common/services/system-events.service';

@Injectable()
export class PaymentSubscriptionMutationService {
  public constructor(
    private readonly prismaService: PrismaService,
    private readonly events: SystemEventsService,
  ) {}

  public async applyCompletedTransaction(
    transaction: Transaction,
  ): Promise<{ readonly syncJobs: readonly ProfileSyncJob[] }> {
    // Combined multi-subscription renewal: the presence of line items marks
    // this as a single payment fulfilled item-by-item. Handle it before the
    // single-subscription, plan-centric branches.
    const items = await this.prismaService.transactionItem.findMany({
      where: { transactionId: transaction.id },
    });
    if (items.length > 0) {
      return this.applyCombinedRenewal(transaction, items);
    }

    // Add-on top-ups carry a marker in planSnapshot and have no plan/
    // duration — handle them before the plan-centric branches.
    if (isAddOnTransaction(transaction)) {
      const addOnResult = await this.applyAddOnTopUp(transaction);
      return { syncJobs: [addOnResult.syncJob] };
    }

    const purchasedPlan = await this.getRequiredPlan(transaction);
    const selectedDurationDays = readSelectedDurationDays(transaction);

    let result: { readonly subscription: Subscription; readonly syncJob: ProfileSyncJob };

    switch (transaction.purchaseType) {
      case PurchaseType.NEW:
      case PurchaseType.ADDITIONAL:
        result = await this.createSubscriptionFromPayment({
          transaction,
          purchasedPlan,
          selectedDurationDays,
        });
        break;
      case PurchaseType.RENEW:
        result = await this.renewSubscriptionFromPayment({
          transaction,
          purchasedPlan,
          selectedDurationDays,
        });
        break;
      case PurchaseType.UPGRADE:
        result = await this.upgradeSubscriptionFromPayment({
          transaction,
          purchasedPlan,
          selectedDurationDays,
        });
        break;
      default:
        throw new NotFoundException('Unsupported purchase type');
    }

    // Emit payment completed event
    this.events.info(EVENT_TYPES.PAYMENT_COMPLETED, 'PAYMENT', `Payment completed: ${transaction.purchaseType}`, {
      userId: transaction.userId,
      paymentId: transaction.paymentId,
      purchaseType: transaction.purchaseType,
      planName: purchasedPlan.name,
      amount: transaction.amount.toString(),
      currency: transaction.currency,
      gatewayType: transaction.gatewayType,
      subscriptionId: result.subscription.id,
    });

    return { syncJobs: [result.syncJob] };
  }

  /**
   * Fulfills a combined (multi-subscription) renewal payment. Each
   * not-yet-applied {@link TransactionItem} extends its target
   * subscription's expiry on the item's plan, enqueues a profile-sync job,
   * and is stamped with `appliedAt` — all inside a single DB transaction so
   * fulfillment is all-or-nothing. The `appliedAt` stamp makes a replayed
   * COMPLETED event idempotent (already-applied items are skipped).
   */
  private async applyCombinedRenewal(
    transaction: Transaction,
    items: readonly TransactionItem[],
  ): Promise<{ readonly syncJobs: readonly ProfileSyncJob[] }> {
    const pending = items.filter((item) => item.appliedAt === null);
    if (pending.length === 0) {
      return { syncJobs: [] };
    }

    const syncJobs = await this.prismaService.$transaction(async (transactionClient) => {
      const jobs: ProfileSyncJob[] = [];
      const now = new Date();
      for (const item of pending) {
        const plan = await transactionClient.plan.findUnique({ where: { id: item.planId } });
        if (plan === null) {
          throw new NotFoundException(`Renewal plan not found: ${item.planId}`);
        }
        const currentSubscription = await transactionClient.subscription.findUnique({
          where: { id: item.subscriptionId },
        });
        if (currentSubscription === null) {
          throw new NotFoundException(`Renewal subscription not found: ${item.subscriptionId}`);
        }
        const renewalBase =
          currentSubscription.expiresAt !== null &&
          currentSubscription.expiresAt.getTime() > now.getTime()
            ? currentSubscription.expiresAt
            : now;
        const renewedSubscription = await transactionClient.subscription.update({
          where: { id: currentSubscription.id },
          data: {
            status: SubscriptionStatus.ACTIVE,
            planSnapshot: buildItemPlanSnapshot({
              item,
              plan,
              gatewayType: transaction.gatewayType,
            }) as Prisma.InputJsonValue,
            trafficLimit: plan.trafficLimit,
            deviceLimit: plan.deviceLimit,
            internalSquads: plan.internalSquads,
            externalSquad: plan.externalSquad,
            expiresAt: calculateExpiry(renewalBase, item.durationDays),
          },
        });
        const syncJob = await transactionClient.profileSyncJob.create({
          data: {
            subscriptionId: renewedSubscription.id,
            action:
              renewedSubscription.remnawaveId === null ? SyncAction.CREATE : SyncAction.UPDATE,
            status: SyncJobStatus.PENDING,
            payload: {
              source: 'PAYMENT_COMPLETION',
              paymentId: transaction.paymentId,
              combined: true,
            } as Prisma.InputJsonObject,
          },
        });
        await transactionClient.transactionItem.update({
          where: { id: item.id },
          data: { appliedAt: now },
        });
        jobs.push(syncJob);
      }
      return jobs;
    });

    this.events.info(
      EVENT_TYPES.PAYMENT_COMPLETED,
      'PAYMENT',
      `Payment completed: RENEW x${pending.length}`,
      {
        userId: transaction.userId,
        paymentId: transaction.paymentId,
        purchaseType: transaction.purchaseType,
        itemCount: pending.length,
        amount: transaction.amount.toString(),
        currency: transaction.currency,
        gatewayType: transaction.gatewayType,
      },
    );

    return { syncJobs };
  }

  /**
   * Fulfills a completed add-on purchase: raises the target
   * subscription's traffic (GB) or device-slot cap and enqueues a
   * Remnawave UPDATE sync so the panel profile reflects the new limit.
   *
   * Idempotent against webhook retries: the target id is read from
   * `planSnapshot` and stamped onto `transaction.subscriptionId` at the
   * end, so a replayed COMPLETED event won't re-apply (the
   * reconciliation guard only fulfills when `subscriptionId === null`).
   */
  private async applyAddOnTopUp(
    transaction: Transaction,
  ): Promise<{ readonly subscription: Subscription; readonly syncJob: ProfileSyncJob }> {
    const marker = readAddOnMarker(transaction);
    if (marker === null) {
      throw new NotFoundException('Add-on marker not found on transaction');
    }

    const result = await this.prismaService.$transaction(async (tx) => {
      const subscription = await tx.subscription.findUnique({
        where: { id: marker.targetSubscriptionId },
      });
      if (subscription === null) {
        throw new NotFoundException('Target subscription not found');
      }
      if (subscription.status === SubscriptionStatus.DELETED) {
        throw new NotFoundException('Target subscription is deleted');
      }

      let updatedSubscription: Subscription;
      if (marker.addOnType === AddOnType.EXTRA_TRAFFIC) {
        if (subscription.trafficLimit === null) {
          // Unlimited — nothing to raise. Still record fulfillment so the
          // transaction is not re-processed.
          updatedSubscription = subscription;
        } else {
          updatedSubscription = await tx.subscription.update({
            where: { id: subscription.id },
            data: { trafficLimit: { increment: marker.addOnValue } },
          });
        }
      } else {
        updatedSubscription = await tx.subscription.update({
          where: { id: subscription.id },
          data: { deviceLimit: { increment: marker.addOnValue } },
        });
      }

      const syncJob = await tx.profileSyncJob.create({
        data: {
          subscriptionId: updatedSubscription.id,
          action:
            updatedSubscription.remnawaveId === null ? SyncAction.CREATE : SyncAction.UPDATE,
          status: SyncJobStatus.PENDING,
          payload: {
            source: 'ADDON_PURCHASE',
            paymentId: transaction.paymentId,
            addOnType: marker.addOnType,
            addOnValue: marker.addOnValue,
          } as Prisma.InputJsonObject,
        },
      });

      await tx.transaction.update({
        where: { id: transaction.id },
        data: { subscriptionId: updatedSubscription.id },
      });

      return { subscription: updatedSubscription, syncJob };
    });

    this.events.info(EVENT_TYPES.PAYMENT_COMPLETED, 'PAYMENT', 'Payment completed: ADD_ON', {
      userId: transaction.userId,
      paymentId: transaction.paymentId,
      purchaseType: transaction.purchaseType,
      addOnType: marker.addOnType,
      addOnValue: marker.addOnValue,
      amount: transaction.amount.toString(),
      currency: transaction.currency,
      gatewayType: transaction.gatewayType,
      subscriptionId: result.subscription.id,
    });

    return result;
  }

  private async createSubscriptionFromPayment(input: {
    readonly transaction: Transaction;
    readonly purchasedPlan: Plan;
    readonly selectedDurationDays: number;
  }): Promise<{ readonly subscription: Subscription; readonly syncJob: ProfileSyncJob }> {
    // A paid trial is a NEW purchase of a TRIAL-availability plan. Mark the
    // resulting subscription as a trial so it counts against the user's
    // claim limit and renders with the trial badge, and stamp the
    // TrialGrant ledger exactly like the free grant does.
    const isTrialPurchase = input.purchasedPlan.availability === PlanAvailability.TRIAL;
    const result = await this.prismaService.$transaction(async (transactionClient) => {
      const now = new Date();
      const createdSubscription = await transactionClient.subscription.create({
        data: {
          userId: input.transaction.userId,
          status: SubscriptionStatus.ACTIVE,
          isTrial: isTrialPurchase,
          planSnapshot: buildPlanSnapshot({
            transaction: input.transaction,
            purchasedPlan: input.purchasedPlan,
            selectedDurationDays: input.selectedDurationDays,
          }) as Prisma.InputJsonValue,
          trafficLimit: input.purchasedPlan.trafficLimit,
          deviceLimit: input.purchasedPlan.deviceLimit,
          internalSquads: input.purchasedPlan.internalSquads,
          externalSquad: input.purchasedPlan.externalSquad,
          deviceType: resolveDeviceType(input.transaction.deviceTypes),
          startedAt: now,
          expiresAt: calculateExpiry(now, input.selectedDurationDays),
        },
      });
      if (isTrialPurchase) {
        // `TrialGrant.userId` is unique — upsert so a paid trial records the
        // claim without colliding with a prior (free or paid) grant. The
        // real per-user limiter is the `isTrial` subscription count.
        await transactionClient.trialGrant.upsert({
          where: { userId: input.transaction.userId },
          create: { userId: input.transaction.userId, planId: input.purchasedPlan.id },
          update: { planId: input.purchasedPlan.id, grantedAt: now },
        });
      }
      const syncJob = await transactionClient.profileSyncJob.create({
        data: {
          subscriptionId: createdSubscription.id,
          action: SyncAction.CREATE,
          status: SyncJobStatus.PENDING,
          payload: {
            source: 'PAYMENT_COMPLETION',
            paymentId: input.transaction.paymentId,
          },
        },
      });
      await transactionClient.transaction.update({
        where: { id: input.transaction.id },
        data: {
          subscriptionId: createdSubscription.id,
        },
      });
      return {
        subscription: createdSubscription,
        syncJob,
      };
    });

    return result;
  }

  private async renewSubscriptionFromPayment(input: {
    readonly transaction: Transaction;
    readonly purchasedPlan: Plan;
    readonly selectedDurationDays: number;
  }): Promise<{ readonly subscription: Subscription; readonly syncJob: ProfileSyncJob }> {
    if (input.transaction.subscriptionId === null) {
      throw new NotFoundException('Source subscription not found');
    }
    return this.prismaService.$transaction(async (transactionClient) => {
      const currentSubscription = await transactionClient.subscription.findUnique({
        where: { id: input.transaction.subscriptionId! },
      });
      if (currentSubscription === null) {
        throw new NotFoundException('Source subscription not found');
      }
      const now = new Date();
      const renewalBase =
        currentSubscription.expiresAt !== null && currentSubscription.expiresAt.getTime() > now.getTime()
          ? currentSubscription.expiresAt
          : now;
      const renewedSubscription = await transactionClient.subscription.update({
        where: { id: currentSubscription.id },
        data: {
          status: SubscriptionStatus.ACTIVE,
          planSnapshot: buildPlanSnapshot({
            transaction: input.transaction,
            purchasedPlan: input.purchasedPlan,
            selectedDurationDays: input.selectedDurationDays,
          }) as Prisma.InputJsonValue,
          trafficLimit: input.purchasedPlan.trafficLimit,
          deviceLimit: input.purchasedPlan.deviceLimit,
          internalSquads: input.purchasedPlan.internalSquads,
          externalSquad: input.purchasedPlan.externalSquad,
          expiresAt: calculateExpiry(renewalBase, input.selectedDurationDays),
        },
      });
      const syncJob = await transactionClient.profileSyncJob.create({
        data: {
          subscriptionId: renewedSubscription.id,
          action: renewedSubscription.remnawaveId === null ? SyncAction.CREATE : SyncAction.UPDATE,
          status: SyncJobStatus.PENDING,
          payload: {
            source: 'PAYMENT_COMPLETION',
            paymentId: input.transaction.paymentId,
          },
        },
      });
      return {
        subscription: renewedSubscription,
        syncJob,
      };
    });
  }

  private async upgradeSubscriptionFromPayment(input: {
    readonly transaction: Transaction;
    readonly purchasedPlan: Plan;
    readonly selectedDurationDays: number;
  }): Promise<{ readonly subscription: Subscription; readonly syncJob: ProfileSyncJob }> {
    if (input.transaction.subscriptionId === null) {
      throw new NotFoundException('Source subscription not found');
    }
    return this.prismaService.$transaction(async (transactionClient) => {
      const currentSubscription = await transactionClient.subscription.findUnique({
        where: { id: input.transaction.subscriptionId! },
      });
      if (currentSubscription === null) {
        throw new NotFoundException('Source subscription not found');
      }
      const now = new Date();
      const upgradedSubscription = await transactionClient.subscription.update({
        where: { id: currentSubscription.id },
        data: {
          status: SubscriptionStatus.ACTIVE,
          planSnapshot: buildPlanSnapshot({
            transaction: input.transaction,
            purchasedPlan: input.purchasedPlan,
            selectedDurationDays: input.selectedDurationDays,
          }) as Prisma.InputJsonValue,
          trafficLimit: input.purchasedPlan.trafficLimit,
          deviceLimit: input.purchasedPlan.deviceLimit,
          internalSquads: input.purchasedPlan.internalSquads,
          externalSquad: input.purchasedPlan.externalSquad,
          startedAt: now,
          expiresAt: calculateExpiry(now, input.selectedDurationDays),
        },
      });
      const syncJob = await transactionClient.profileSyncJob.create({
        data: {
          subscriptionId: upgradedSubscription.id,
          action: upgradedSubscription.remnawaveId === null ? SyncAction.CREATE : SyncAction.UPDATE,
          status: SyncJobStatus.PENDING,
          payload: {
            source: 'PAYMENT_COMPLETION',
            paymentId: input.transaction.paymentId,
          },
        },
      });
      return {
        subscription: upgradedSubscription,
        syncJob,
      };
    });
  }

  private async getRequiredPlan(transaction: Transaction): Promise<Plan> {
    const planId = readPlanId(transaction);
    const plan = await this.prismaService.plan.findUnique({
      where: { id: planId },
    });
    if (plan === null) {
      throw new NotFoundException('Purchased plan not found');
    }
    return plan;
  }
}

function buildPlanSnapshot(input: {
  readonly transaction: Transaction;
  readonly purchasedPlan: Plan;
  readonly selectedDurationDays: number;
}): Record<string, unknown> {
  return {
    id: input.purchasedPlan.id,
    name: input.purchasedPlan.name,
    description: input.purchasedPlan.description,
    tag: input.purchasedPlan.tag,
    type: input.purchasedPlan.type,
    trafficLimit: input.purchasedPlan.trafficLimit,
    deviceLimit: input.purchasedPlan.deviceLimit,
    trafficLimitStrategy: input.purchasedPlan.trafficLimitStrategy,
    internalSquads: input.purchasedPlan.internalSquads,
    externalSquad: input.purchasedPlan.externalSquad,
    selectedDurationDays: input.selectedDurationDays,
    purchaseType: input.transaction.purchaseType,
    gatewayType: input.transaction.gatewayType,
    amount: input.transaction.amount.toString(),
    currency: input.transaction.currency,
    snapshotSource: 'PAYMENT_COMPLETION',
  };
}

/**
 * Builds a subscription `planSnapshot` for one combined-renewal line item.
 * Mirrors {@link buildPlanSnapshot} but draws the duration/amount/currency
 * from the per-item record rather than the parent transaction (whose amount
 * is the combined total).
 */
function buildItemPlanSnapshot(input: {
  readonly item: TransactionItem;
  readonly plan: Plan;
  readonly gatewayType: Transaction['gatewayType'];
}): Record<string, unknown> {
  return {
    id: input.plan.id,
    name: input.plan.name,
    description: input.plan.description,
    tag: input.plan.tag,
    type: input.plan.type,
    trafficLimit: input.plan.trafficLimit,
    deviceLimit: input.plan.deviceLimit,
    trafficLimitStrategy: input.plan.trafficLimitStrategy,
    internalSquads: input.plan.internalSquads,
    externalSquad: input.plan.externalSquad,
    selectedDurationDays: input.item.durationDays,
    purchaseType: PurchaseType.RENEW,
    gatewayType: input.gatewayType,
    amount: input.item.amount.toString(),
    currency: input.item.currency,
    snapshotSource: 'PAYMENT_COMPLETION',
  };
}

interface AddOnMarker {
  readonly addOnId: string;
  readonly addOnType: AddOnType;
  readonly addOnValue: number;
  readonly targetSubscriptionId: string;
}

function isAddOnTransaction(transaction: Transaction): boolean {
  return readAddOnMarker(transaction) !== null;
}

function readAddOnMarker(transaction: Transaction): AddOnMarker | null {
  const snapshot =
    typeof transaction.planSnapshot === 'object' &&
    transaction.planSnapshot !== null &&
    !Array.isArray(transaction.planSnapshot)
      ? (transaction.planSnapshot as Record<string, unknown>)
      : {};
  if (snapshot['snapshotSource'] !== 'ADDON_PURCHASE') {
    return null;
  }
  const addOnId = snapshot['addOnId'];
  const addOnTypeRaw = snapshot['addOnType'];
  const addOnValue = snapshot['addOnValue'];
  const targetSubscriptionId = snapshot['targetSubscriptionId'];
  if (
    typeof addOnId !== 'string' ||
    typeof targetSubscriptionId !== 'string' ||
    typeof addOnValue !== 'number' ||
    (addOnTypeRaw !== AddOnType.EXTRA_TRAFFIC && addOnTypeRaw !== AddOnType.EXTRA_DEVICES)
  ) {
    return null;
  }
  return {
    addOnId,
    addOnType: addOnTypeRaw,
    addOnValue,
    targetSubscriptionId,
  };
}

function readPlanId(transaction: Transaction): string {
  const planSnapshot =
    typeof transaction.planSnapshot === 'object' &&
    transaction.planSnapshot !== null &&
    !Array.isArray(transaction.planSnapshot)
      ? (transaction.planSnapshot as Record<string, unknown>)
      : {};
  const planId = planSnapshot.id;
  if (typeof planId !== 'string' || planId.length === 0) {
    throw new NotFoundException('Purchased plan not found');
  }
  return planId;
}

function readSelectedDurationDays(transaction: Transaction): number {
  const planSnapshot =
    typeof transaction.planSnapshot === 'object' &&
    transaction.planSnapshot !== null &&
    !Array.isArray(transaction.planSnapshot)
      ? (transaction.planSnapshot as Record<string, unknown>)
      : {};
  const selectedDurationDays = planSnapshot.selectedDurationDays;
  if (typeof selectedDurationDays !== 'number' || !Number.isInteger(selectedDurationDays)) {
    throw new NotFoundException('Purchased duration not found');
  }
  return selectedDurationDays;
}

function calculateExpiry(baseDate: Date, durationDays: number): Date | null {
  if (durationDays === -1) {
    return null;
  }
  const expiresAt = new Date(baseDate);
  expiresAt.setUTCDate(expiresAt.getUTCDate() + durationDays);
  return expiresAt;
}

/**
 * Maps the transaction's recorded device-type hint (first entry) to the
 * `DeviceType` enum. Returns `null` for missing/unknown values so the
 * subscription's `deviceType` stays absent rather than throwing.
 */
function resolveDeviceType(deviceTypes: readonly string[]): DeviceType | null {
  const first = deviceTypes[0];
  if (typeof first !== 'string') {
    return null;
  }
  const upper = first.toUpperCase();
  return (Object.values(DeviceType) as string[]).includes(upper)
    ? (upper as DeviceType)
    : null;
}
