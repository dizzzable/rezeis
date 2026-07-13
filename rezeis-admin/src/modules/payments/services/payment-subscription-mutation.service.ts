import { Injectable, Logger, NotFoundException, ConflictException } from '@nestjs/common';
import {
  AddOnLifetime,
  AddOnType,
  AddOnEntitlementActorType,
  DeviceType,
  Plan,
  PlanAvailability,
  ProfileSyncJob,
  Prisma,
  PurchaseType,
  Subscription,
  SubscriptionStatus,
  SubscriptionTermStatus,
  SyncAction,
  SyncJobStatus,
  Transaction,
  TransactionItem,
} from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { SystemEventsService, EVENT_TYPES } from '../../../common/services/system-events.service';
import { resolveAddOnRolloutFlags, resolveResetCapabilities } from '../../add-on-entitlements/add-on-rollout.config';
import { GIB_BYTES } from '../../add-on-entitlements/domain/cutover-baseline';
import { getResetCapability, ResetStrategy } from '../../add-on-entitlements/domain/reset-cycle-policy';
import { AddOnEntitlementService } from '../../add-on-entitlements/services/add-on-entitlement.service';
import { ensureLiveResetEpoch } from '../../add-on-entitlements/services/reset-epoch.util';
import { EffectiveProjectionService } from '../../add-on-entitlements/services/effective-projection.service';
import { SubscriptionTermService } from '../../add-on-entitlements/services/subscription-term.service';

@Injectable()
export class PaymentSubscriptionMutationService {
  private readonly logger = new Logger(PaymentSubscriptionMutationService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly events: SystemEventsService,
    private readonly addOnEntitlementService: AddOnEntitlementService,
    private readonly effectiveProjectionService: EffectiveProjectionService,
    private readonly subscriptionTermService: SubscriptionTermService,
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
      const combined = await this.applyCombinedRenewal(transaction, items);
      // A multi-subscription renewal is a plan purchase — consume the
      // one-time "next purchase" discount once it completes.
      await this.consumePurchaseDiscount(transaction.userId);
      return combined;
    }

    // Add-on top-ups carry a marker in planSnapshot and have no plan/
    // duration — handle them before the plan-centric branches. Add-ons price
    // with purchaseDiscount = 0 (they never benefit from it), so they must
    // NOT consume the user's one-time purchase discount.
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
      planType: purchasedPlan.type,
      trafficLimitBytes:
        purchasedPlan.trafficLimit !== null ? purchasedPlan.trafficLimit * 1024 * 1024 * 1024 : undefined,
      deviceLimit: purchasedPlan.deviceLimit,
      durationDays: selectedDurationDays ?? undefined,
      amount: transaction.amount.toString(),
      currency: transaction.currency,
      gatewayType: transaction.gatewayType,
      channel: transaction.channel,
      subscriptionId: result.subscription.id,
      remnawaveId: result.subscription.remnawaveId ?? undefined,
    });

    // Consume the one-time "next purchase" discount (PURCHASE_DISCOUNT promo
    // reward) now that a plan purchase has completed. Without this it kept
    // applying to every future purchase. The permanent personalDiscount stays.
    await this.consumePurchaseDiscount(transaction.userId);

    return { syncJobs: [result.syncJob] };
  }

  /**
   * Resets `user.purchaseDiscount` to 0, but only when it is currently > 0
   * (guarded `updateMany` → no write / no throw otherwise). The PURCHASE
   * discount is a one-time "discount on next purchase"; the permanent
   * PERSONAL discount is never touched here.
   */
  private async consumePurchaseDiscount(userId: string): Promise<void> {
    // Best-effort: this runs AFTER the subscription has been committed. It must
    // never throw out of `applyCompletedTransaction`, otherwise the reconciler's
    // fulfilment claim would be released and the (already-provisioned) payment
    // re-provisioned on retry. A missed discount reset is harmless vs a double.
    try {
      await this.prismaService.user.updateMany({
        where: { id: userId, purchaseDiscount: { gt: 0 } },
        data: { purchaseDiscount: 0 },
      });
    } catch (err: unknown) {
      this.logger.warn(
        `consumePurchaseDiscount failed for ${userId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
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

    const { syncJobs, scheduling } = await this.prismaService.$transaction(async (transactionClient) => {
      const jobs: ProfileSyncJob[] = [];
      const toSchedule: Array<{ subscriptionId: string; plan: Plan; durationDays: number }> = [];
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

        // Renewal add-on composition (T-007): a PERSISTED add-on line means the
        // customer already PAID for it (intake only writes `addOnLines` when
        // `renewalAddOns` was on at checkout). Fulfillment therefore mints them
        // regardless of the CURRENT flag value — otherwise flipping the flag off
        // between checkout and the webhook would silently drop paid goods. The
        // term + PENDING entitlements are created ATOMICALLY here (never lost to
        // a best-effort failure); lines WITHOUT add-ons keep the post-commit
        // best-effort scheduling (nothing paid is at risk there).
        const addOnLines = readRenewalAddOnLines(item.addOnLines);
        if (addOnLines.length > 0) {
          const term = await this.scheduleRenewalTermInTransaction(transactionClient, {
            subscriptionId: renewedSubscription.id,
            plan,
            durationDays: item.durationDays,
          });
          if (term === null) {
            // Invariant violation: add-ons were sold for a subscription with no
            // durable term. Fail closed (roll back, reconciler retries) rather
            // than silently drop paid goods — intake only offers renewal add-ons
            // once the subscription has an active term.
            throw new ConflictException(
              `Renewal add-ons require a durable term for subscription ${renewedSubscription.id}`,
            );
          }
          for (const addOn of addOnLines) {
            const totalValue =
              addOn.type === AddOnType.EXTRA_TRAFFIC
                ? BigInt(addOn.value) * GIB_BYTES
                : BigInt(addOn.value);
            await this.addOnEntitlementService.createPendingInTransaction(transactionClient, {
              subscriptionId: renewedSubscription.id,
              termId: term.id,
              sourceTransactionId: transaction.id,
              sourceLineKey: addOn.sourceLineKey,
              addOnId: addOn.addOnId,
              catalogRevision: addOn.catalogRevision,
              receiptName: addOn.receiptName,
              type: addOn.type,
              valuePerUnit: addOn.value,
              totalValue,
              lifetime: addOn.lifetime,
              applicabilitySnapshot: {},
              unitAmount: addOn.unitAmount,
              totalAmount: addOn.unitAmount,
              currency: item.currency,
              purchasedAt: transaction.createdAt,
              // Activates at the renewed term's start (design D-4) and expires
              // at the renewed term boundary. UNTIL_NEXT_RESET refinement to the
              // term's first epoch happens at activation (T-008d/e).
              scheduledActivationAt: term.startsAt,
              expiresAt: term.endsAt,
              expiryEpochId: null,
              correlationId: `payment:${transaction.paymentId}`,
            });
          }
        } else {
          toSchedule.push({ subscriptionId: renewedSubscription.id, plan, durationDays: item.durationDays });
        }
      }
      // Stamp the transaction-level idempotency flag atomically with the item
      // applications so the webhook reconciler treats the combined renewal as
      // fulfilled (its per-item `appliedAt` still guards partial re-runs).
      await transactionClient.transaction.update({
        where: { id: transaction.id },
        data: { fulfilledAt: now },
      });
      return { syncJobs: jobs, scheduling: toSchedule };
    });

    // Durable renewal-term scheduling for each renewed line (design D-4):
    // best-effort, per line, in a SEPARATE transaction AFTER the combined
    // renewal commits — identical safety contract to the single-subscription
    // path (a shadow-model failure can never roll back a real renewal). No-op
    // unless the flag is on and the line's subscription has an active term.
    for (const line of scheduling) {
      await this.scheduleRenewalTermBestEffort(line);
    }

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
   * `planSnapshot` and the fulfillment is stamped onto
   * `transaction.fulfilledAt` (atomically, in the same tx), so a replayed
   * COMPLETED event won't re-apply (the reconciliation guard fulfils only when
   * `fulfilledAt === null`).
   */
  private async applyAddOnTopUp(
    transaction: Transaction,
  ): Promise<{ readonly subscription: Subscription; readonly syncJob: ProfileSyncJob }> {
    const marker = readAddOnMarker(transaction);
    if (marker === null) {
      throw new NotFoundException('Add-on marker not found on transaction');
    }

    const flags = resolveAddOnRolloutFlags();

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

      // ── Durable entitlement-ledger path (flag-gated) ─────────────────────
      // When direct-purchase rollout is on and the target has an active term,
      // record the purchase as an immutable entitlement, recompute the
      // effective projection and mirror it into the legacy limit columns so
      // profile-sync keeps applying the ledger-backed limit until versioned
      // sync (T-009) takes over. Falls back to the legacy increment when the
      // entitlement cannot be fully materialized here.
      if (
        flags.directPurchase &&
        subscription.status === SubscriptionStatus.ACTIVE &&
        marker.lifetime !== undefined &&
        marker.sourceLineKey !== undefined
      ) {
        const ledgered = await this.applyAddOnViaLedger(tx, transaction, marker, subscription);
        if (ledgered !== null) {
          return ledgered;
        }
      }

      // ── Legacy increment path ────────────────────────────────────────────
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
        if (subscription.deviceLimit <= 0) {
          // Unlimited device baseline (0/negative) — adding devices is a no-op
          // and must NOT turn an unlimited profile finite (the legacy `0 + N`
          // footgun). Record fulfillment without changing the limit.
          updatedSubscription = subscription;
        } else {
          updatedSubscription = await tx.subscription.update({
            where: { id: subscription.id },
            data: { deviceLimit: { increment: marker.addOnValue } },
          });
        }
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
        data: { subscriptionId: updatedSubscription.id, fulfilledAt: new Date() },
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

  /**
   * Flag-gated ledger fulfillment for a captured add-on. Returns `null` when
   * the entitlement cannot be fully materialized here (no active term, no
   * usable term window, or a reset-scoped lifetime whose expiry epoch is not
   * yet available) so the caller falls back to the legacy increment.
   */
  private async applyAddOnViaLedger(
    tx: Prisma.TransactionClient,
    transaction: Transaction,
    marker: AddOnMarker,
    subscription: Subscription,
  ): Promise<{ readonly subscription: Subscription; readonly syncJob: ProfileSyncJob } | null> {
    if (marker.lifetime === undefined || marker.sourceLineKey === undefined) return null;

    const term = await tx.subscriptionTerm.findFirst({
      where: { subscriptionId: subscription.id, status: SubscriptionTermStatus.ACTIVE },
      select: {
        id: true,
        endsAt: true,
        baseTrafficLimitBytes: true,
        baseDeviceLimit: true,
        trafficResetStrategy: true,
        resetAnchorAt: true,
      },
    });
    if (term === null) return null;

    const isTraffic = marker.addOnType === AddOnType.EXTRA_TRAFFIC;
    const baseline = isTraffic ? term.baseTrafficLimitBytes : term.baseDeviceLimit;

    // Unlimited baseline: the add-on is a no-op. Record fulfillment WITHOUT an
    // increment (the fix for the legacy `0 + N` device bug that turned an
    // unlimited profile finite) and without a ledger row.
    if (baseline === null) {
      return this.recordAddOnLedgerNoOp(tx, transaction, subscription);
    }

    const now = new Date();
    let expiresAt: Date;
    let expiryEpochId: string | null = null;
    if (marker.lifetime === AddOnLifetime.UNTIL_SUBSCRIPTION_END) {
      if (term.endsAt === null || term.endsAt.getTime() <= now.getTime()) {
        return null; // no usable term window → fall back to legacy
      }
      expiresAt = term.endsAt;
    } else {
      // UNTIL_NEXT_RESET: bind the entitlement's expiry to the term's current
      // reset epoch. Valid for BOTH traffic and devices — the reset epoch is
      // the profile's monthly refresh boundary (traffic rolls back, extra
      // devices are removed on it), so a device entitlement is expired on the
      // same cycle as a traffic one. Applies ONLY when the strategy's reset
      // capability is ENABLED (post-parity flag) AND the epoch row already
      // exists (created at term activation, T-008e). Otherwise fall back to the
      // legacy increment — this matches the eligibility quote, which OFFERS
      // this lifetime under the same capability gate. Binding to an existing
      // epoch (never creating one here) keeps the money path free of
      // reset-lifecycle guesswork.
      const strategy = term.trafficResetStrategy as ResetStrategy;
      // Find-or-create the CURRENT reset-cycle epoch (shared helper): a purchase
      // against an already-active term mints the epoch on demand so the offered
      // `expiresAt` (eligibility quotes the same computation) is always honored,
      // instead of silently degrading to the permanent legacy increment. Returns
      // null only when there is no commercial reset window (NO_RESET, capability
      // not ENABLED, or no anchor) → legacy fallback, matching eligibility.
      const epoch = await ensureLiveResetEpoch(tx, {
        termId: term.id,
        strategy,
        anchorAt: term.resetAnchorAt,
        capability: getResetCapability(strategy, resolveResetCapabilities()),
        now,
      });
      if (epoch === null) return null; // no commercial reset window → legacy fallback
      expiresAt = epoch.plannedEndsAt;
      expiryEpochId = epoch.id;
    }

    const totalValue = isTraffic ? BigInt(marker.addOnValue) * GIB_BYTES : BigInt(marker.addOnValue);
    const correlationId = `payment:${transaction.paymentId}`;

    // Bind the source transaction to its target subscription before recording
    // the entitlement: the ledger's source-line guard requires the transaction
    // to already point at the subscription (add-on drafts leave it null until
    // fulfillment). createPending re-reads it FOR UPDATE in this same tx.
    await tx.transaction.update({
      where: { id: transaction.id },
      data: { subscriptionId: subscription.id },
    });

    const created = await this.addOnEntitlementService.createPendingInTransaction(tx, {
      subscriptionId: subscription.id,
      termId: term.id,
      sourceTransactionId: transaction.id,
      sourceLineKey: marker.sourceLineKey,
      addOnId: marker.addOnId,
      catalogRevision: marker.addOnRevision ?? 1,
      receiptName: marker.name ?? marker.addOnId,
      type: marker.addOnType,
      valuePerUnit: marker.addOnValue,
      totalValue,
      lifetime: marker.lifetime,
      applicabilitySnapshot: {},
      unitAmount: transaction.amount,
      totalAmount: transaction.amount,
      currency: transaction.currency,
      purchasedAt: transaction.createdAt,
      // Deterministic per (transaction, line) so an idempotent re-apply
      // recomputes the identical immutable snapshot. Direct purchases activate
      // at capture time, which is the transaction's creation instant.
      scheduledActivationAt: transaction.createdAt,
      expiresAt,
      expiryEpochId,
      correlationId,
    });

    await this.addOnEntitlementService.transitionInTransaction(tx, {
      entitlementId: created.entitlementId,
      command: 'ACTIVATE',
      commandKey: `activate:${created.entitlementId}`,
      correlationId,
      actorType: AddOnEntitlementActorType.SYSTEM,
      reason: 'DIRECT_PURCHASE_ACTIVATION',
    });

    const projection = await this.effectiveProjectionService.recomputeInTransaction(tx, {
      subscriptionId: subscription.id,
      mode: 'ACTIVE',
    });

    // Mirror the desired effective limits into the legacy compatibility columns
    // so profile-sync keeps applying the ledger-backed limit until versioned
    // sync (T-009) reads the projection directly.
    const mirroredTraffic =
      projection.desiredTrafficLimitBytes === null
        ? null
        : Number(projection.desiredTrafficLimitBytes / GIB_BYTES);
    const mirroredDevice = projection.desiredDeviceLimit === null ? 0 : projection.desiredDeviceLimit;

    const updatedSubscription = await tx.subscription.update({
      where: { id: subscription.id },
      data: { trafficLimit: mirroredTraffic, deviceLimit: mirroredDevice },
    });

    const syncJob = await tx.profileSyncJob.create({
      data: {
        subscriptionId: updatedSubscription.id,
        action: updatedSubscription.remnawaveId === null ? SyncAction.CREATE : SyncAction.UPDATE,
        status: SyncJobStatus.PENDING,
        aggregateKey: updatedSubscription.id,
        desiredRevision: projection.desiredRevision,
        payload: {
          source: 'ADDON_PURCHASE_LEDGER',
          paymentId: transaction.paymentId,
          entitlementId: created.entitlementId,
          addOnType: marker.addOnType,
          addOnValue: marker.addOnValue,
        } as Prisma.InputJsonObject,
      },
    });

    await tx.transaction.update({
      where: { id: transaction.id },
      data: { subscriptionId: updatedSubscription.id, fulfilledAt: new Date() },
    });

    return { subscription: updatedSubscription, syncJob };
  }

  private async recordAddOnLedgerNoOp(
    tx: Prisma.TransactionClient,
    transaction: Transaction,
    subscription: Subscription,
  ): Promise<{ readonly subscription: Subscription; readonly syncJob: ProfileSyncJob }> {
    const syncJob = await tx.profileSyncJob.create({
      data: {
        subscriptionId: subscription.id,
        action: subscription.remnawaveId === null ? SyncAction.CREATE : SyncAction.UPDATE,
        status: SyncJobStatus.PENDING,
        payload: {
          source: 'ADDON_PURCHASE_LEDGER',
          paymentId: transaction.paymentId,
          note: 'UNLIMITED_NOOP',
        } as Prisma.InputJsonObject,
      },
    });
    await tx.transaction.update({
      where: { id: transaction.id },
      data: { subscriptionId: subscription.id, fulfilledAt: new Date() },
    });
    return { subscription, syncJob };
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
          fulfilledAt: now,
        },
      });
      // Backfill the user's "current subscription" pointer when they don't
      // have one yet, so referral EXTRA_DAYS rewards and points-exchange
      // (days / traffic) have a target. `currentSubscriptionId` was previously
      // only set by the importers, leaving purchase/promo users with null.
      await transactionClient.user.updateMany({
        where: { id: input.transaction.userId, currentSubscriptionId: null },
        data: { currentSubscriptionId: createdSubscription.id },
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
    const result = await this.prismaService.$transaction(async (transactionClient) => {
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
      await transactionClient.transaction.update({
        where: { id: input.transaction.id },
        data: { fulfilledAt: now },
      });
      return {
        subscription: renewedSubscription,
        syncJob,
      };
    });

    // Durable renewal-term scheduling (design D-4 early-renewal): best-effort,
    // in a SEPARATE transaction AFTER the renewal commits, so a shadow-model
    // failure can NEVER roll back a real renewal. Gated by `entitlementShadow`
    // and only when the subscription already has a durable term (cutover done).
    await this.scheduleRenewalTermBestEffort({
      subscriptionId: result.subscription.id,
      plan: input.purchasedPlan,
      durationDays: input.selectedDurationDays,
    });

    return result;
  }

  /**
   * Schedules the next durable term for a renewed subscription (design D-4):
   * `startsAt = current term end` (or `now` if it already ended), plan-derived
   * baseline, SCHEDULED status — the boundary scheduler activates it at term
   * start. Best-effort + isolated: any failure is logged and swallowed so the
   * committed renewal is never affected. No-op when the flag is off, the
   * subscription has no active term, or a scheduled term already exists.
   */
  private async scheduleRenewalTermBestEffort(input: {
    readonly subscriptionId: string;
    readonly plan: Plan;
    readonly durationDays: number;
  }): Promise<void> {
    if (!resolveAddOnRolloutFlags().entitlementShadow) return;
    try {
      await this.prismaService.$transaction((tx) => this.scheduleRenewalTermInTransaction(tx, input));
      this.logger.log(`Scheduled renewal term for subscription ${input.subscriptionId}`);
    } catch (err: unknown) {
      this.logger.warn(
        `Best-effort renewal-term scheduling failed for ${input.subscriptionId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Creates (or reuses) the next SCHEDULED durable term for a renewed
   * subscription inside the CALLER's transaction and returns its id + window.
   * `startsAt = current term end` (or `now` if it already ended), plan-derived
   * baseline, SCHEDULED status. Returns `null` when the subscription has no
   * ACTIVE term (durable model not applicable — no cutover). If a SCHEDULED
   * term already exists it is reused (never double-scheduled), so this is
   * idempotent and safe to call from both the best-effort path (no add-ons)
   * and the atomic combined-renewal path (paid add-ons bind to the term).
   */
  private async scheduleRenewalTermInTransaction(
    tx: Prisma.TransactionClient,
    input: { readonly subscriptionId: string; readonly plan: Plan; readonly durationDays: number },
  ): Promise<{ readonly id: string; readonly startsAt: Date; readonly endsAt: Date | null } | null> {
    const activeTerm = await tx.subscriptionTerm.findFirst({
      where: { subscriptionId: input.subscriptionId, status: SubscriptionTermStatus.ACTIVE },
      orderBy: { generation: 'desc' },
      select: { endsAt: true },
    });
    if (activeTerm === null) return null; // durable model not applicable (no cutover)
    const alreadyScheduled = await tx.subscriptionTerm.findFirst({
      where: { subscriptionId: input.subscriptionId, status: SubscriptionTermStatus.SCHEDULED },
      orderBy: { generation: 'desc' },
      select: { id: true, startsAt: true, endsAt: true },
    });
    if (alreadyScheduled !== null) return alreadyScheduled; // reuse; never double-schedule

    const now = new Date();
    const startsAt =
      activeTerm.endsAt !== null && activeTerm.endsAt.getTime() > now.getTime() ? activeTerm.endsAt : now;
    const endsAt = calculateExpiry(startsAt, input.durationDays);
    const created = await this.subscriptionTermService.createScheduledInTransaction(tx, {
      subscriptionId: input.subscriptionId,
      planId: input.plan.id,
      planSnapshot: {
        id: input.plan.id,
        name: input.plan.name,
        trafficLimitStrategy: input.plan.trafficLimitStrategy,
        snapshotSource: 'RENEWAL_TERM',
      } as Prisma.InputJsonValue,
      startsAt,
      endsAt,
      baseTrafficLimitBytes:
        input.plan.trafficLimit === null ? null : BigInt(input.plan.trafficLimit) * GIB_BYTES,
      baseDeviceLimit: input.plan.deviceLimit <= 0 ? null : input.plan.deviceLimit,
      trafficResetStrategy: input.plan.trafficLimitStrategy,
      resetAnchorAt: startsAt,
    });
    return { id: created.id, startsAt, endsAt };
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
          // Upgrading off a trial onto a regular plan clears the trial flag
          // (and the trial badge / "active trial" gating). Mirrors the NEW
          // path: the flag follows the purchased plan's availability.
          isTrial: input.purchasedPlan.availability === PlanAvailability.TRIAL,
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
      await transactionClient.transaction.update({
        where: { id: input.transaction.id },
        data: { fulfilledAt: now },
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
  // ── v2 entitlement-ledger fields (optional; absent on legacy markers) ──
  readonly name?: string;
  readonly addOnRevision?: number;
  readonly lifetime?: AddOnLifetime;
  readonly sourceLineKey?: string;
}

export function isAddOnTransaction(transaction: Transaction): boolean {
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
  const lifetimeRaw = snapshot['lifetime'];
  const lifetime =
    lifetimeRaw === AddOnLifetime.UNTIL_NEXT_RESET || lifetimeRaw === AddOnLifetime.UNTIL_SUBSCRIPTION_END
      ? lifetimeRaw
      : undefined;
  const addOnRevision = snapshot['addOnRevision'];
  const sourceLineKey = snapshot['sourceLineKey'];
  const name = snapshot['name'];
  return {
    addOnId,
    addOnType: addOnTypeRaw,
    addOnValue,
    targetSubscriptionId,
    name: typeof name === 'string' ? name : undefined,
    addOnRevision: typeof addOnRevision === 'number' ? addOnRevision : undefined,
    lifetime,
    sourceLineKey: typeof sourceLineKey === 'string' && sourceLineKey.length > 0 ? sourceLineKey : undefined,
  };
}

/** One parsed renewal add-on line persisted on a {@link TransactionItem}. */
interface RenewalAddOnLine {
  readonly addOnId: string | null;
  readonly catalogRevision: number;
  readonly type: AddOnType;
  readonly value: number;
  readonly lifetime: AddOnLifetime;
  readonly sourceLineKey: string;
  readonly unitAmount: string;
  readonly receiptName: string;
}

/**
 * Parses the `TransactionItem.addOnLines` JSON column into typed renewal
 * add-on lines, silently skipping malformed entries (defensive: the column is
 * operator/intake-populated). Returns `[]` for null/non-array/no valid lines.
 */
function readRenewalAddOnLines(raw: Prisma.JsonValue | null): readonly RenewalAddOnLine[] {
  if (!Array.isArray(raw)) return [];
  const lines: RenewalAddOnLine[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const type = record['type'];
    const lifetime = record['lifetime'];
    const value = record['value'];
    const catalogRevision = record['catalogRevision'];
    const sourceLineKey = record['sourceLineKey'];
    const unitAmount = record['unitAmount'];
    const receiptName = record['receiptName'];
    const addOnId = record['addOnId'];
    if (
      (type !== AddOnType.EXTRA_TRAFFIC && type !== AddOnType.EXTRA_DEVICES) ||
      (lifetime !== AddOnLifetime.UNTIL_NEXT_RESET &&
        lifetime !== AddOnLifetime.UNTIL_SUBSCRIPTION_END) ||
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      typeof sourceLineKey !== 'string' ||
      sourceLineKey.length === 0
    ) {
      continue;
    }
    lines.push({
      addOnId: typeof addOnId === 'string' && addOnId.length > 0 ? addOnId : null,
      catalogRevision:
        typeof catalogRevision === 'number' && Number.isInteger(catalogRevision) ? catalogRevision : 1,
      type,
      value,
      lifetime,
      sourceLineKey,
      unitAmount:
        typeof unitAmount === 'string'
          ? unitAmount
          : typeof unitAmount === 'number'
            ? String(unitAmount)
            : '0',
      receiptName:
        typeof receiptName === 'string' && receiptName.length > 0
          ? receiptName
          : typeof addOnId === 'string' && addOnId.length > 0
            ? addOnId
            : 'Add-on',
    });
  }
  return lines;
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
