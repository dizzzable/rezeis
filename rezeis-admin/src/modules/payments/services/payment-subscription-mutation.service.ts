import { Injectable, Logger, NotFoundException, ConflictException } from '@nestjs/common';
import {
  AddOnLifetime,
  AddOnType,
  AddOnEntitlementActorType,
  AddOnEntitlementState,
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
  TransactionStatus,
} from '@prisma/client';

import { TrafficResetService } from '../../add-ons/services/traffic-reset.service';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { SystemEventsService, EVENT_TYPES } from '../../../common/services/system-events.service';
import { readJsonObject } from '../../../common/utils/read-json-object.util';
import { resolveAddOnRolloutFlags, resolveResetCapabilities } from '../../add-on-entitlements/add-on-rollout.config';
import { GIB_BYTES } from '../../add-on-entitlements/domain/cutover-baseline';
import {
  getResetCapability,
  provisionalResetAnchor,
  ResetStrategy,
} from '../../add-on-entitlements/domain/reset-cycle-policy';
import { AddOnEntitlementService } from '../../add-on-entitlements/services/add-on-entitlement.service';
import {
  isBaselineExtendable,
  resolveConfiguredEntitlementBaseline,
  resolveRecordedAddOnContribution,
} from '../../add-on-entitlements/services/configured-baseline.util';
import { ensureLiveResetEpoch } from '../../add-on-entitlements/services/reset-epoch.util';
import { EffectiveProjectionService } from '../../add-on-entitlements/services/effective-projection.service';
import { SubscriptionTermService } from '../../add-on-entitlements/services/subscription-term.service';
import { readTrialSettings } from '../../plans/utils/trial-settings.util';
import {
  patchSnapshotNumeric,
  resolveInheritedPlanLimitRefresh,
  type PlanInheritedLimitUpdate,
} from '../../subscriptions/services/plan-inherited-limits.util';
import {
  consumePaidTrialClaim,
  countCommittedTrialClaimUnits,
} from '../../subscriptions/services/trial-claim-ledger.util';

/**
 * One operator card per identical `subscriptionId:termId:addOnType` per hour —
 * the same window `AntiFraudService`'s `NOTIFY_COOLDOWN_MS` uses.
 *
 * NOT per transaction: one bulk renewal is many lines, and an operator mistake
 * on one term is ONE thing to look at. NOT global either: two subscriptions are
 * two things to look at, and a global window would hide the second in silence.
 *
 * The window is PROCESS-LOCAL, which is where it differs from the anti-fraud
 * one — that reads its floor back out of `FraudSignal` rows, so a restart does
 * not hand everyone a fresh allowance. There is no row to read here and a
 * dedupe window does not justify minting one, so the cost is stated instead: a
 * restart, or a second worker replica, can produce one extra card per
 * signature. For a card about money that has already moved, duplicated is the
 * safe direction and suppressed is not.
 */
const DORMANT_ADD_ON_CARD_COOLDOWN_MS = 60 * 60 * 1000;

/**
 * A paid renewal add-on line whose capture-time baseline absorbs it, held until
 * the fulfillment transaction COMMITS.
 *
 * The verdict is reached inside the `$transaction` that captures the line, and
 * `SystemEventsService.emit` is fire-and-forget — it writes the audit row,
 * pushes the realtime frame and sends the Telegram card the instant it is
 * called, with no knowledge of the surrounding transaction. Announced in place
 * it would report a capture that a rollback then undoes, and the webhook's
 * retry would report it a second time. So the line is buffered, and the hourly
 * signature check is deferred with it: consuming the window on an attempt that
 * never committed would SUPPRESS the card for the attempt that did.
 */
interface DormantRenewalAddOnLine {
  readonly subscriptionId: string;
  readonly termId: string;
  readonly type: AddOnType;
  readonly sourceLineKey: string;
  readonly addOnId: string;
  readonly receiptName: string;
  readonly value: number;
  readonly unitAmount: string;
  readonly currency: string;
  readonly userId: string;
  readonly paymentId: string;
  readonly transactionId: string;
  readonly baseTrafficLimitBytes: bigint | null;
  readonly baseDeviceLimit: number | null;
  readonly overriddenKeys: readonly string[];
}

/**
 * An upgrade that kept the previous term baseline because a SCHEDULED term
 * carries paid entitlements — buffered past the commit for exactly the reason
 * {@link DormantRenewalAddOnLine} is.
 */
interface UpgradeTermDeferral {
  readonly subscriptionId: string;
  readonly planId: string;
  readonly scheduledTermIds: readonly string[];
  readonly boundEntitlements: number;
}

@Injectable()
export class PaymentSubscriptionMutationService {
  private readonly logger = new Logger(PaymentSubscriptionMutationService.name);
  /**
   * `subscriptionId:termId:addOnType` → when its card last went out. Read and
   * written ONLY after a fulfillment transaction has committed; see
   * {@link announceDormantRenewalAddOns}.
   */
  private readonly dormantAddOnCardWindow = new Map<string, number>();

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly events: SystemEventsService,
    private readonly addOnEntitlementService: AddOnEntitlementService,
    private readonly effectiveProjectionService: EffectiveProjectionService,
    private readonly subscriptionTermService: SubscriptionTermService,
    private readonly trafficResetService: TrafficResetService,
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
      if (
        transaction.purchaseType !== PurchaseType.RENEW ||
        !isCombinedRenewalTransaction(transaction)
      ) {
        throw new ConflictException('Combined renewal transaction marker is invalid');
      }
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

    // ── MONEY TAKEN FROM SOMEBODY WE ARE REFUSING TO SERVE ────────────────
    //
    // `assertPurchaserNotBlocked` gates checkout CREATION. It cannot gate this:
    // the invoice was created while the customer was in good standing, the
    // block landed afterwards, and by the time this webhook arrives the
    // provider has already captured the money.
    //
    // Refusing to fulfil here would be the worst of the three options — we
    // would keep the money AND record nothing, so an operator who later
    // unblocks the customer has no trace of what they paid for. Fulfilment is
    // safe on its own terms: the profile comes up DISABLED because
    // `handleCreate` and `handleUpdate` both read the flag at execution time,
    // so no service is handed over.
    //
    // What was missing is the operator knowing. A refund is a judgement nobody
    // can make from a payment row alone, and a payment that silently completes
    // for a banned account is one nobody ever looks at.
    const purchaserBlocked = await this.prismaService.user
      .findUnique({ where: { id: transaction.userId }, select: { isBlocked: true } })
      .then((row) => row?.isBlocked === true)
      .catch(() => false);
    if (purchaserBlocked) {
      this.events.warn(
        EVENT_TYPES.PAYMENT_COMPLETED,
        'PAYMENT',
        `Payment completed for a BLOCKED customer: ${transaction.purchaseType}`,
        {
          userId: transaction.userId,
          paymentId: transaction.paymentId,
          amount: transaction.amount.toString(),
          currency: transaction.currency,
          gatewayType: transaction.gatewayType,
          // Spelled out because this is the operator's decision, not ours: the
          // subscription exists and the VPN profile is disabled, so the
          // customer has paid for something they cannot use until unblocked.
          note:
            'The invoice was created before the block and paid after it. The subscription was ' +
            'recorded and the VPN profile is DISABLED. Decide whether to refund.',
        },
      );
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

    const committed = await this.prismaService.$transaction(async (transactionClient) => {
      // Operator cards this fulfillment wants to raise, held until it COMMITS —
      // see {@link DormantRenewalAddOnLine}. Declared INSIDE the callback so a
      // re-driven attempt starts from an empty buffer and cannot inherit the
      // lines of an attempt that was rolled back.
      const dormantAddOnLines: DormantRenewalAddOnLine[] = [];
      // Lock the transaction items inside the fulfillment transaction and claim
      // each row conditionally. The caller's pre-transaction snapshot is only
      // a candidate list; it is never authoritative under concurrent replay.
      const claimedItems: TransactionItem[] = [];
      for (const candidate of pending) {
        const claimed = await transactionClient.transactionItem.updateMany({
          where: { id: candidate.id, appliedAt: null },
          data: { appliedAt: new Date() },
        });
        if (claimed.count === 1) {
          const fresh = await transactionClient.transactionItem.findUnique({ where: { id: candidate.id } });
          if (fresh !== null) claimedItems.push(fresh);
        }
      }
      if (claimedItems.length === 0) {
        return { jobs: [] as ProfileSyncJob[], dormantAddOnLines };
      }
      const jobs: ProfileSyncJob[] = [];
      const now = new Date();
      for (const item of claimedItems) {
        // A legacy in-flight draft (no snapshotVersion) can't be snapshot-verified;
        // fall back to the live plan row, exactly as fulfillment did before strict
        // verification shipped — so paid money is never stranded.
        const livePlan = await transactionClient.plan.findUnique({ where: { id: item.planId } });
        const plan =
          parsePaidRenewalPlanSnapshot(item.planSnapshot, item, transaction.gatewayType) ??
          livePlan;
        if (plan === null) {
          throw new NotFoundException(`Renewal plan not found: ${item.planId}`);
        }
        const currentSubscription = await this.lockRenewalSubscriptionInTransaction(
          transactionClient,
          item.subscriptionId,
        );
        assertRenewalFulfillmentPolicy(
          currentSubscription,
          readPersistedPlanAvailability(item.planSnapshot),
        );

        const addOnLines = readRenewalAddOnLines(item.addOnLines);
        const durableTermRequired =
          resolveAddOnRolloutFlags().entitlementShadow || addOnLines.length > 0;
        const term = durableTermRequired
          ? await this.scheduleRenewalTermInTransaction(transactionClient, {
              subscriptionId: currentSubscription.id,
              plan,
              durationDays: item.durationDays,
            })
          : null;
        if (addOnLines.length > 0 && term === null) {
          throw new ConflictException(
            `Renewal add-ons require a durable term for subscription ${currentSubscription.id}`,
          );
        }

        const lockedSubscription =
          (term !== null
            ? await transactionClient.subscription.findUnique({ where: { id: currentSubscription.id } })
            : currentSubscription);
        if (lockedSubscription === null) {
          throw new NotFoundException(`Renewal subscription not found: ${currentSubscription.id}`);
        }
        const renewalBase =
          lockedSubscription.expiresAt !== null &&
          lockedSubscription.expiresAt.getTime() > now.getTime()
            ? lockedSubscription.expiresAt
            : now;
        // Individual configuration and billing are separate concerns: this
        // renewal bills the tariff plan, but it must not silently undo a limit
        // an operator set on this ONE subscription. Only fields whose column
        // still matches what the stored snapshot says the plan gave them are
        // refreshed from the plan; a hand-set value is left alone.
        //
        // Resolved from `lockedSubscription` BEFORE the update below replaces
        // the snapshot, and deliberately OUTSIDE the `term` branch:
        // `durableTermRequired` is an add-on rollout concern and must not be
        // able to change what happens to these four columns. Both branches now
        // receive the identical fragment.
        //
        // A legacy row whose `planSnapshot` is absent, empty, malformed, or
        // predates one of these keys is UNDECIDABLE. The resolver then returns
        // nothing for that field and the column is PRESERVED — the safe
        // direction, because wiping is what reaches the customer, through the
        // `profileSyncJob` created a few lines below.
        //
        // That cuts both ways and the trade-off is accepted knowingly: on a
        // snapshot-less row a customer can renew onto a MORE generous plan and
        // keep the smaller column. Preserving still wins, because the rows
        // without a readable snapshot are the imported/legacy ones an operator
        // is most likely to have hand-tuned. The full argument, and the single
        // branch to flip if the owner decides otherwise, is on
        // `resolvePlanLimitOwnership`.
        //
        // ── THE COLUMN IS THE MIRROR, NOT THE BASE ───────────────────────
        //
        // `trafficLimit` / `deviceLimit` mirror the projection's DESIRED state
        // (`base + every ACTIVE add-on`), so on a subscription holding a live
        // add-on the column is NOT the plan's value. Comparing it raw read
        // every add-on holder as OVERRIDDEN: from the first add-on a customer
        // bought, no plan edit ever reached them again — permanently, and for
        // exactly the customers who had paid extra. So the contribution the
        // PREVIOUS projection row recorded is handed to the resolver, which
        // subtracts it before comparing. It is READ through
        // `resolveRecordedAddOnContribution` and never re-derived here; a
        // second derivation of that number is the failure the shared reader
        // exists to prevent.
        //
        // ── TWO FRAGMENTS, AND THEY ARE NOT INTERCHANGEABLE ──────────────
        //
        // `snapshot` carries the PLAN's raw values — that is what a stored
        // `planSnapshot` means, and it is the baseline the NEXT comparison
        // runs against. `columns` carries the same fields with the recorded
        // contribution added back on, because the columns mirror desired
        // state. Writing one where the other belongs is permanent corruption,
        // not cosmetics: `columns` in the snapshot makes the next comparison
        // subtract a contribution that is already out, so the row reads
        // OVERRIDDEN forever; `snapshot` in the columns silently drops the
        // customer's paid add-on from the mirrored column AND makes the next
        // projection recompute subtract the contribution a SECOND time,
        // pinning the operator baseline that much lower for good.
        const inheritedLimitRefresh = resolveInheritedPlanLimitRefresh({
          current: lockedSubscription,
          planSnapshot: lockedSubscription.planSnapshot,
          plan,
          recorded: await resolveRecordedAddOnContribution(
            transactionClient,
            currentSubscription.id,
          ),
        });
        // THE SNAPSHOT MOVES WITH THE COLUMNS. `inheritedLimitRefresh` writes
        // the plan's value into a column precisely because the stored snapshot
        // still agreed with it; leaving the snapshot behind makes the very row
        // this refresh just corrected read as OVERRIDDEN from here on, and the
        // NEXT plan edit never reaches it. Benign-looking on the first edit —
        // the column happens to equal the new term's baseline — and it silently
        // removes exactly the population the snapshot freeze exists to serve:
        // subscribers who were never individually adjusted, the ones the plan
        // editor promises limit changes will reach on renewal.
        //
        // Only the keys actually refreshed move, via
        // `patchSnapshotInheritedLimits`. The display keys (`name`, `tag`,
        // `type`, `icon`) and `trafficLimitStrategy` are NOT touched here: they
        // mirror the LIVE plan through `PlanSnapshotSyncService` and are not
        // part of the override comparison.
        const planSnapshotWrite =
          term === null
            ? buildItemPlanSnapshot({ item, plan, gatewayType: transaction.gatewayType })
            : patchSnapshotInheritedLimits(
                lockedSubscription.planSnapshot,
                inheritedLimitRefresh.snapshot,
              );
        const renewedSubscription = await transactionClient.subscription.update({
          where: { id: currentSubscription.id },
          data: {
            status: SubscriptionStatus.ACTIVE,
            expiresAt: calculateExpiry(renewalBase, item.durationDays),
            ...(planSnapshotWrite === undefined
              ? {}
              : { planSnapshot: planSnapshotWrite as Prisma.InputJsonValue }),
            ...inheritedLimitRefresh.columns,
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
              // Same rule as the single renewal below, and it has to be the
              // same rule: a combined payment renews several subscriptions at
              // once, and each of them bought a fresh period. Omitting it here
              // would make "renew three at once" behave differently from
              // renewing the same three one by one.
              ...(renewedSubscription.remnawaveId === null ? {} : { resetTraffic: true }),
            } as Prisma.InputJsonObject,
          },
        });
        await transactionClient.transactionItem.updateMany({
          where: { id: item.id, appliedAt: null },
          data: { appliedAt: now },
        });
        jobs.push(syncJob);

        // Persisted add-on lines are already-paid goods. They bind only to the
        // distinct term appended for THIS renewal line; the current rollout flag
        // may gate intake but never fulfillment.
        if (addOnLines.length > 0) {
          if (term === null) {
            throw new ConflictException(
              `Renewal add-ons require a durable term for subscription ${renewedSubscription.id}`,
            );
          }
          // ── Capture-time baseline, and what it is allowed to do ───────────
          //
          // Eligibility is the ONLY gate a renewal add-on ever passes, and it
          // ran at QUOTE time. Between the quote and this capture an operator
          // can set this ONE customer's limit to unlimited, or the plan the
          // renewal term is minted from can change: unlimited is absorbing, so
          // the line would then add nothing and the customer would be charged
          // for it anyway. So the same reader the offer, the checkout and the
          // projection use answers the question again, HERE, against the term
          // that was just appended (`term.base*`), the subscription as this
          // renewal left it, and the contribution the previous projection row
          // recorded.
          //
          // The window is a genuine TOCTOU and the answer may legitimately have
          // changed. What follows is the deliberate choice about a line that is
          // ALREADY PAID:
          //
          //   * NOT refusing the capture. This line rides on a RENEWAL
          //     transaction. Throwing rolls the whole combined fulfillment back
          //     — every subscription on the payment loses the time it paid for
          //     — and the webhook then retries the same deterministic failure
          //     forever. The blast radius of the smaller wrong is unbounded.
          //   * NOT a recorded no-op. `recordAddOnLedgerNoOp` is the DIRECT
          //     purchase's instrument and is wrong here: it stamps
          //     `transaction.fulfilledAt` and `subscriptionId` and creates its
          //     own sync job, none of which a per-item combined renewal may do.
          //     More importantly, skipping the entitlement would leave the paid
          //     line with NO durable record at all — the transaction would look
          //     like an ordinary fulfilled renewal and a refund would be
          //     undiscoverable. That is exactly "silently dropping a paid line".
          //   * CAPTURE AND FLAG. The entitlement is created as quoted, and the
          //     capture-time verdict is written into its `applicabilitySnapshot`
          //     — immutable, per line, and sitting on the row a refund decision
          //     is made against.
          //
          // The decisive asymmetry with the direct-purchase path is WHEN the
          // goods land. A renewal entitlement is PENDING and activates at
          // `term.startsAt`, days or weeks out; the baseline here is a
          // PREDICTION of what will be true then, and an operator may well put
          // the limit back before it. Refusing to create the entitlement on a
          // prediction would destroy value the customer paid for. A direct
          // purchase activates immediately, so there the capture-time answer IS
          // the verdict and the no-op is right — see `applyAddOnViaLedger`.
          const capturedBaseline = await resolveConfiguredEntitlementBaseline(transactionClient, {
            subscriptionId: renewedSubscription.id,
            term,
            subscription: renewedSubscription,
          });
          for (const addOn of addOnLines) {
            const totalValue =
              addOn.type === AddOnType.EXTRA_TRAFFIC
                ? BigInt(addOn.value) * GIB_BYTES
                : BigInt(addOn.value);
            const extendable = isBaselineExtendable(addOn.type, capturedBaseline);
            if (!extendable) {
              // BUFFERED, NOT ANNOUNCED — this is inside the fulfillment
              // `$transaction`. `SystemEventsService.emit` is fire-and-forget
              // and lands the instant it is called (audit row, realtime frame,
              // Telegram card), so a card raised here announces a capture that
              // a rollback then undoes, and the webhook's retry announces it
              // again. The hourly signature check waits with it for the same
              // reason: burning the window on an attempt that never committed
              // would SUPPRESS the card for the attempt that did. The
              // `logger.warn` moved out with it — a log line is cheap, but a
              // log claiming a capture that was rolled back is still false in
              // the one place an operator goes to reconstruct what happened.
              dormantAddOnLines.push({
                subscriptionId: renewedSubscription.id,
                termId: term.id,
                type: addOn.type,
                sourceLineKey: addOn.sourceLineKey,
                addOnId: addOn.addOnId,
                receiptName: addOn.receiptName,
                value: addOn.value,
                unitAmount: addOn.unitAmount,
                currency: item.currency,
                userId: transaction.userId,
                paymentId: transaction.paymentId,
                transactionId: transaction.id,
                baseTrafficLimitBytes: capturedBaseline.baseTrafficLimitBytes,
                baseDeviceLimit: capturedBaseline.baseDeviceLimit,
                overriddenKeys: [...capturedBaseline.overriddenKeys],
              });
            }
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
              // Written for EVERY line, not only the diverged ones: a field that
              // appears only when something is wrong cannot distinguish "this
              // was checked and was fine" from "this was never checked".
              // `baseTrafficLimitBytes` is stringified because JSON has no
              // bigint. The whole object is part of the entitlement's immutable
              // snapshot; it is safe to derive because the item is claimed
              // (`appliedAt`) in this same transaction, so a replay never
              // reaches a second derivation of it.
              applicabilitySnapshot: {
                source: 'RENEWAL_CAPTURE',
                baselineTermId: term.id,
                extendable,
                baseTrafficLimitBytes: capturedBaseline.baseTrafficLimitBytes?.toString() ?? null,
                baseDeviceLimit: capturedBaseline.baseDeviceLimit,
                overriddenKeys: [...capturedBaseline.overriddenKeys],
              },
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
        }
      }
      // Stamp the transaction-level idempotency flag atomically
      // applications so the webhook reconciler treats the combined renewal as
      // fulfilled (its per-item `appliedAt` still guards partial re-runs).
      await transactionClient.transaction.update({
        where: { id: transaction.id },
        data: { fulfilledAt: now },
      });
      return { jobs, dormantAddOnLines };
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

    // After the completion card, and only now that the capture is durable: the
    // paid lines this renewal recorded as adding nothing at their baseline.
    this.announceDormantRenewalAddOns(committed.dormantAddOnLines);

    return { syncJobs: committed.jobs };
  }

  /**
   * Announces, once the fulfillment transaction has COMMITTED, every paid
   * renewal add-on line whose captured baseline absorbs it.
   *
   * SEVERITY IS `WARNING`, NOT `ERROR`, and that is a decision rather than a
   * default. The renewal entitlement is PENDING until `term.startsAt`, days or
   * weeks out, so the capture-time verdict is a PREDICTION an operator can
   * still make right by restoring the finite limit before then — nothing has
   * failed. `isErrorEvent` also routes ERROR through the incident-card
   * formatter (fixed header, build info, a `.txt` attachment), which is the
   * shape for a fault in the system, not for a commercial fact awaiting a human
   * decision before a known deadline.
   *
   * The LOG line is written for every line while the CARD is collapsed to one
   * per signature per hour: the container log stays the complete record, the
   * operator's feed stays readable. An event stream nobody can read is the same
   * as no event.
   */
  private announceDormantRenewalAddOns(lines: readonly DormantRenewalAddOnLine[]): void {
    if (lines.length === 0) return;
    const now = Date.now();
    this.pruneDormantAddOnCardWindow(now);
    for (const line of lines) {
      this.logger.warn(
        `Renewal add-on line ${line.sourceLineKey} was quoted against a finite limit but captured ` +
          `against an unlimited one (subscription ${line.subscriptionId}, term ${line.termId}, ` +
          `payment ${line.paymentId}); the paid line is still captured, flagged in its ` +
          'applicabilitySnapshot as adding nothing at this baseline',
      );
      const signature = `${line.subscriptionId}:${line.termId}:${line.type}`;
      const announcedAt = this.dormantAddOnCardWindow.get(signature);
      if (announcedAt !== undefined && now - announcedAt < DORMANT_ADD_ON_CARD_COOLDOWN_MS) {
        continue;
      }
      this.dormantAddOnCardWindow.set(signature, now);
      this.events.warn(
        EVENT_TYPES.PAYMENT_ADDON_ADDS_NOTHING,
        'PAYMENT',
        'A paid renewal add-on will add nothing at the baseline captured for it',
        {
          code: 'RENEWAL_ADDON_ADDS_NOTHING',
          subscriptionId: line.subscriptionId,
          termId: line.termId,
          addOnId: line.addOnId,
          addOnType: line.type,
          receiptName: line.receiptName,
          // The ledger key a refund decision is made against: the entitlement
          // was still created, and this is what finds it.
          sourceLineKey: line.sourceLineKey,
          value: line.value,
          unitAmount: line.unitAmount,
          currency: line.currency,
          userId: line.userId,
          paymentId: line.paymentId,
          transactionId: line.transactionId,
          // Stringified for the same reason `applicabilitySnapshot` stringifies
          // it: the metadata is persisted as JSON, which has no bigint.
          baseTrafficLimitBytes: line.baseTrafficLimitBytes?.toString() ?? null,
          baseDeviceLimit: line.baseDeviceLimit,
          overriddenKeys: line.overriddenKeys,
        },
      );
    }
  }

  /**
   * Drops signatures whose hour has passed, so the window cannot grow without
   * bound in a long-lived worker. Only expired entries go: an entry still
   * inside its window is the whole point of the map.
   */
  private pruneDormantAddOnCardWindow(now: number): void {
    for (const [signature, announcedAt] of this.dormantAddOnCardWindow) {
      if (now - announcedAt >= DORMANT_ADD_ON_CARD_COOLDOWN_MS) {
        this.dormantAddOnCardWindow.delete(signature);
      }
    }
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

    // Set inside the transaction, acted on after it commits. A local flag
    // rather than a second return shape: this method's contract is read by the
    // whole capture path, and widening it to carry an outcome that has no
    // subscription-limit change would make every caller handle a case that
    // does not concern them.
    let resetTarget: { readonly subscriptionId: string; readonly addOnId: string } | null = null;

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

      // ── A RESET IS NOT A GRANT, SO IT LEAVES BEFORE THE GRANT MACHINERY ──
      //
      // Everything below this point exists to record a value somebody now
      // owns: an entitlement row, a projection recompute, a mirrored limit
      // column. A reset owns nothing — it zeroes CONSUMED traffic and is over.
      // Running it through the ledger would mint an entitlement whose value,
      // expiry and revocation are all meaningless, and mirroring it into a
      // limit column would ADD traffic the operator never sold.
      //
      // It also must not touch the reset epoch or any entitlement's expiry:
      // extra gigabytes the customer already paid for live out their term. The
      // customer who buys 50 GB and then a reset keeps both.
      //
      // The reset itself is performed AFTER this transaction commits, by the
      // caller — a panel round trip inside a fulfilment transaction would hold
      // a write lock open across the network.
      if (marker.addOnType === AddOnType.RESET_TRAFFIC) {
        resetTarget = { subscriptionId: subscription.id, addOnId: marker.addOnId };
        // No limit changed, so nothing to push — but a sync job is still queued
        // so the profile is re-read afterwards and the panel's own counter and
        // ours cannot silently disagree about what just happened.
        const syncJob = await tx.profileSyncJob.create({
          data: {
            subscriptionId: subscription.id,
            action:
              subscription.remnawaveId === null ? SyncAction.CREATE : SyncAction.UPDATE,
            status: SyncJobStatus.PENDING,
            payload: {
              source: 'ADDON_PURCHASE',
              paymentId: transaction.paymentId,
              addOnType: marker.addOnType,
            } as Prisma.InputJsonObject,
          },
        });
        // Stamped here, exactly as every other branch does before returning.
        // Skipping it is not cosmetic: a ZERO-PRICE add-on never pre-claims
        // `fulfilledAt` (the webhook paths do), so the recovery sweeper would
        // find this row COMPLETED-but-unfulfilled a quarter of an hour later,
        // claim it, and reset the customer's traffic a SECOND time. Linking the
        // subscription is what puts the purchase in that subscription's history.
        await tx.transaction.update({
          where: { id: transaction.id },
          data: { subscriptionId: subscription.id, fulfilledAt: new Date() },
        });
        return { subscription, syncJob };
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
      //
      // Every branch here writes a RAW column with no baseline resolution, so
      // it is the last place an incoherent add-on value can reach the database.
      // {@link isCoherentAddOnValue} refuses one before either branch: a
      // negative EXTRA_TRAFFIC value can land `trafficLimit` on exactly `0`,
      // and the panel has no encoding for zero bytes — it decodes an upstream
      // `0` back to `null`, canonical UNLIMITED — so the customer we recorded
      // as entitled to nothing would receive everything, and the projection
      // would report drift on every sweep forever. The device side is the
      // mirror: a negative value takes a finite cap down to `0`, which the
      // product reads as unlimited devices.
      //
      // An incoherent value is REFUSED, not clamped, and refusing means the
      // same thing the two unlimited branches below already mean: record
      // fulfillment, touch no column. The customer receives nothing, which is
      // the honest outcome for a product an operator configured to add nothing
      // — and it is recoverable (an operator can fix the catalog row and grant
      // the add-on again), where a `0` column is not. `AdminAddOnCreateDto` /
      // `AdminAddOnUpdateDto` now make such a row un-authorable in the first
      // place; this guards the rows that already exist and any marker written
      // before that bound landed.
      let updatedSubscription: Subscription;
      if (!isCoherentAddOnValue(marker.addOnValue)) {
        this.logger.warn(
          `Add-on ${marker.addOnId} carries an incoherent value ${marker.addOnValue} for subscription ` +
            `${subscription.id} (payment ${transaction.paymentId}); the limit column is left untouched`,
        );
        updatedSubscription = subscription;
      } else if (marker.addOnType === AddOnType.EXTRA_TRAFFIC) {
        // A whole positive increment onto a non-negative column can never
        // produce `0`. The extra `< 1` test covers the one way it still could:
        // a column that is ALREADY negative, which is a data anomaly
        // `deriveCutoverBaseline` also flags rather than trusts.
        const next =
          subscription.trafficLimit === null ? null : subscription.trafficLimit + marker.addOnValue;
        if (next === null || next < 1) {
          // Unlimited — nothing to raise. Still record fulfillment so the
          // transaction is not re-processed.
          updatedSubscription = subscription;
        } else {
          updatedSubscription = await tx.subscription.update({
            where: { id: subscription.id },
            // Still a relational `increment`, not the computed `next`: the row
            // was read without `FOR UPDATE`, so an absolute write would lose a
            // concurrent increment. `next` only decides WHETHER to write.
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

    // ── The reset happens HERE, after the transaction has committed ──────
    //
    // Deliberately outside it: a panel round trip inside a fulfilment
    // transaction holds a write lock open across the network, and this is the
    // most contended transaction in the system. The purchase is already
    // recorded, so a panel that refuses leaves a paid-for reset the operator
    // can re-drive — not a rollback of somebody's money.
    if (resetTarget !== null) {
      const target: { readonly subscriptionId: string; readonly addOnId: string } = resetTarget;
      const termId = await this.trafficResetService.currentTermId(target.subscriptionId);
      const performed = await this.trafficResetService.perform({
        subscriptionId: target.subscriptionId,
        termId,
        addOnId: target.addOnId,
        transactionId: transaction.id,
      });
      if (!performed.ok) {
        // LOGGED, NOT THROWN. The money is captured and the purchase recorded;
        // throwing here would roll nothing back and would make the webhook
        // retry a capture that already succeeded. An operator can re-drive the
        // reset; a customer cannot un-pay.
        this.logger.error(
          `Paid traffic reset for subscription ${target.subscriptionId} was not applied: ` +
            `${performed.reason ?? 'unknown reason'}`,
        );
      }
    }

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
    // An incoherent value cannot be turned into a ledger row at all — the
    // `BigInt(marker.addOnValue)` below throws a raw `RangeError` on a
    // fractional one and mints a NEGATIVE `totalValue` on a negative one, which
    // `addTrafficLimit`/`addDeviceLimit` then reject deep inside the projection
    // recompute. Falling back to the legacy path instead keeps the outcome to
    // ONE shape: the guard there records fulfillment and touches no column.
    if (!isCoherentAddOnValue(marker.addOnValue)) return null;

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

    // ── Capture-time baseline: the same reader the offer and checkout use ──
    //
    // This used to test the RAW term (`term.baseTrafficLimitBytes` /
    // `term.baseDeviceLimit` `=== null`), which is the term the customer BOUGHT
    // and not what this ONE subscription is entitled to. An operator setting the
    // COLUMN to unlimited between the draft and this capture left the term's
    // finite number in place, so the no-op branch was skipped and a charged
    // entitlement was created that `EffectiveProjectionService` — which does
    // resolve the override — then absorbed into an unlimited desired state. The
    // customer paid and received nothing, with a ledger row saying otherwise.
    //
    // Unlike the renewal capture above, a direct purchase activates IMMEDIATELY
    // (`scheduledActivationAt` is the transaction's creation instant and the
    // ACTIVATE transition happens a few lines below), so the answer here is the
    // verdict, not a prediction about a future term start. That is why this path
    // keeps the recorded no-op — fulfillment IS stamped, no ledger row is
    // created, and the whole transaction is the add-on, so the transaction row
    // itself remains the durable record a refund is made against.
    const baseline = await resolveConfiguredEntitlementBaseline(tx, {
      subscriptionId: subscription.id,
      term,
      subscription,
    });
    if (!isBaselineExtendable(marker.addOnType, baseline)) {
      this.logger.warn(
        `Add-on ${marker.addOnId} captured against an unlimited baseline for subscription ` +
          `${subscription.id} (payment ${transaction.paymentId}); fulfillment recorded as a no-op`,
      );
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
      //
      // The map below is `resolveResetCapabilities()` — the FLAG-PURE one —
      // not `resolveIntakeResetCapabilities()`, even though fulfilment is a
      // selling side. The two hold the same value HERE, and only here: this
      // method's single call site sits behind `flags.directPurchase` in
      // `applyAddOnTopUp`, and that flag is the one condition by which the
      // intake map narrows the flag-pure one. Remove or widen that guard, or
      // give the intake resolver a second condition, and the offer can quote
      // an `expiresAt` this line then refuses — see the note on
      // `resolveResetCapabilities` for what that costs.
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
    // A paid trial is a NEW purchase whose checkout-time plan availability was
    // TRIAL. Prefer the persisted snapshot so a later catalog edit cannot turn
    // a paid trial into a renewable regular subscription (or vice versa).
    // Legacy drafts without the field retain their original live-plan behavior.
    const checkoutAvailability = readPersistedPlanAvailability(input.transaction.planSnapshot);
    const isTrialPurchase =
      (checkoutAvailability ?? input.purchasedPlan.availability) === PlanAvailability.TRIAL;
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
      let lateSuccessOverCap: { readonly usedUnits: number; readonly maxClaims: number } | null = null;
      if (isTrialPurchase) {
        const consumed = await consumePaidTrialClaim(transactionClient, {
          userId: input.transaction.userId,
          planId: input.purchasedPlan.id,
          transactionId: input.transaction.id,
          subscriptionId: createdSubscription.id,
          now,
        });
        if (consumed.revivedReleased) {
          const usedUnits = await countCommittedTrialClaimUnits(
            transactionClient,
            input.transaction.userId,
          );
          const maxClaims = readTrialSettings(
            readPersistedTrialSettings(input.transaction.planSnapshot),
          ).maxClaims;
          if (usedUnits > maxClaims) {
            lateSuccessOverCap = { usedUnits, maxClaims };
          }
        }
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
          status: TransactionStatus.COMPLETED,
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
        lateSuccessOverCap,
      };
    });

    if (result.lateSuccessOverCap !== null) {
      const metadata = {
        code: 'TRIAL_CLAIM_LATE_SUCCESS_OVER_CAP',
        userId: input.transaction.userId,
        transactionId: input.transaction.id,
        paymentId: input.transaction.paymentId,
        planId: input.purchasedPlan.id,
        subscriptionId: result.subscription.id,
        usedUnits: result.lateSuccessOverCap.usedUnits,
        maxClaims: result.lateSuccessOverCap.maxClaims,
      };
      this.logger.warn(
        `TRIAL_CLAIM_LATE_SUCCESS_OVER_CAP transaction=${input.transaction.id} ` +
          `used=${metadata.usedUnits} max=${metadata.maxClaims}`,
      );
      this.events.warn(
        EVENT_TYPES.TRIAL_CLAIM_LATE_SUCCESS_OVER_CAP,
        'PAYMENT',
        'Late paid-trial success fulfilled after its released quota slot was reused',
        metadata,
      );
    }

    return { subscription: result.subscription, syncJob: result.syncJob };
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
      const currentSubscription = await this.lockRenewalSubscriptionInTransaction(
        transactionClient,
        input.transaction.subscriptionId!,
      );
      assertRenewalFulfillmentPolicy(
        currentSubscription,
        readPersistedPlanAvailability(input.transaction.planSnapshot),
      );
      const term = resolveAddOnRolloutFlags().entitlementShadow
        ? await this.scheduleRenewalTermInTransaction(transactionClient, {
            subscriptionId: currentSubscription.id,
            plan: input.purchasedPlan,
            durationDays: input.selectedDurationDays,
          })
        : null;
      const now = new Date();
      const lockedSubscription =
        term !== null
          ? await transactionClient.subscription.findUnique({ where: { id: currentSubscription.id } })
          : currentSubscription;
      if (lockedSubscription === null) {
        throw new NotFoundException('Source subscription not found');
      }
      const renewalBase =
        lockedSubscription.expiresAt !== null && lockedSubscription.expiresAt.getTime() > now.getTime()
          ? lockedSubscription.expiresAt
          : now;
      // Same rule as the combined renewal above, and it has to be the same
      // rule: this is the single-subscription renewal of an EXISTING row, not a
      // first purchase, so an operator's individual limit must survive it. See
      // `resolvePlanLimitOwnership` for the per-field comparison, for why an
      // unreadable snapshot PRESERVES the column instead of wiping it, and for
      // the accepted cost of that choice (a snapshot-less row can renew onto a
      // more generous plan and keep the smaller column).
      //
      // Resolved outside the `term` branch so the add-on rollout flag cannot
      // change the outcome for these four columns.
      //
      // `recorded` and the two fragments are not optional here either, and for
      // the identical reason spelled out at the combined call site: the limit
      // COLUMNS mirror `base + active add-ons`, so an add-on holder compared
      // raw reads OVERRIDDEN on every renewal and plan edits stop reaching the
      // customers who paid extra. `columns` (plan value + contribution) goes to
      // the row, `snapshot` (the plan's raw value) goes to the stored snapshot;
      // swapping them corrupts the baseline permanently in one direction or the
      // other.
      const inheritedLimitRefresh = resolveInheritedPlanLimitRefresh({
        current: lockedSubscription,
        planSnapshot: lockedSubscription.planSnapshot,
        plan: input.purchasedPlan,
        recorded: await resolveRecordedAddOnContribution(
          transactionClient,
          currentSubscription.id,
        ),
      });
      // Same rule, same reason as the combined renewal above: a column that is
      // refreshed from the plan must say so in the snapshot, or this row reads
      // OVERRIDDEN from now on and the SECOND plan edit never reaches it. See
      // `patchSnapshotInheritedLimits` for which keys move and which are
      // deliberately left mirroring the live plan.
      const planSnapshotWrite =
        term === null
          ? buildPlanSnapshot({
              transaction: input.transaction,
              purchasedPlan: input.purchasedPlan,
              selectedDurationDays: input.selectedDurationDays,
            })
          : patchSnapshotInheritedLimits(
              lockedSubscription.planSnapshot,
              inheritedLimitRefresh.snapshot,
            );
      const renewedSubscription = await transactionClient.subscription.update({
        where: { id: currentSubscription.id },
        data: {
          status: SubscriptionStatus.ACTIVE,
          expiresAt: calculateExpiry(renewalBase, input.selectedDurationDays),
          ...(planSnapshotWrite === undefined
            ? {}
            : { planSnapshot: planSnapshotWrite as Prisma.InputJsonValue }),
          ...inheritedLimitRefresh.columns,
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
            // The customer paid for a new period, so the period's traffic
            // allowance starts over. `PATCH /api/users` cannot express that —
            // it carries the limit and never the usage — so the sync processor
            // makes the separate reset call when it sees this flag. Without it
            // a subscriber who hit their cap renews into a profile Remnawave
            // still reads as LIMITED: paid, active, and passing nothing.
            //
            // Set only on the RENEW path. A first purchase provisions a fresh
            // profile whose counter is already zero, and an add-on top-up
            // RAISES the limit rather than starting a period — resetting there
            // would hand out the traffic already used this period for free.
            ...(renewedSubscription.remnawaveId === null ? {} : { resetTraffic: true }),
          },
        },
      });
      await transactionClient.transaction.update({
        where: { id: input.transaction.id },
        data: { fulfilledAt: now, status: TransactionStatus.COMPLETED },
      });
      return {
        subscription: renewedSubscription,
        syncJob,
      };
    });

    return result;
  }

  /**
   * Locks and then re-reads the renewal source inside the fulfillment
   * transaction. The row lock is unconditional (also when durable terms are
   * disabled), so a concurrent disable/trial mutation cannot be overwritten by
   * the later ACTIVE renewal update.
   */
  private async lockRenewalSubscriptionInTransaction(
    tx: Prisma.TransactionClient,
    subscriptionId: string,
  ): Promise<Subscription> {
    const locked = await tx.$queryRaw<readonly { readonly id: string }[]>(Prisma.sql`
      SELECT "id"
      FROM "subscriptions"
      WHERE "id" = ${subscriptionId}
      FOR UPDATE
    `);
    if (locked.length !== 1) {
      throw new NotFoundException(`Renewal subscription not found: ${subscriptionId}`);
    }
    const subscription = await tx.subscription.findUnique({ where: { id: subscriptionId } });
    if (subscription === null) {
      throw new NotFoundException(`Renewal subscription not found: ${subscriptionId}`);
    }
    return subscription;
  }

  /**
   * Appends one distinct SCHEDULED durable term for this fulfilled renewal.
   * The subscription row is locked before reading the tail, so concurrent
   * payments serialize generation/window allocation. Existing SCHEDULED terms
   * are never reused: each paid renewal owns its own term and entitlements.
   *
   * The created term's `base*` limits are RETURNED, not just written: the
   * renewal's add-on lines bind to this very term, and the capture-time
   * baseline check has to read the baseline that was actually persisted. Having
   * the caller re-derive `plan.trafficLimit → bytes` / `plan.deviceLimit <= 0`
   * would be a second copy of the mapping four lines below it.
   */
  private async scheduleRenewalTermInTransaction(
    tx: Prisma.TransactionClient,
    input: { readonly subscriptionId: string; readonly plan: Plan; readonly durationDays: number },
  ): Promise<{
    readonly id: string;
    readonly startsAt: Date;
    readonly endsAt: Date | null;
    readonly baseTrafficLimitBytes: bigint | null;
    readonly baseDeviceLimit: number | null;
  } | null> {
    const parent = await tx.$queryRaw<Array<{ id: string; status: SubscriptionStatus }>>(Prisma.sql`
      SELECT "id", "status"::text AS "status"
      FROM "subscriptions"
      WHERE "id" = ${input.subscriptionId}
      FOR UPDATE
    `);
    if (parent.length !== 1 || parent[0]!.status === SubscriptionStatus.DELETED) {
      throw new ConflictException('Cannot append a renewal term to a missing or deleted subscription');
    }

    const activeTerm = await tx.subscriptionTerm.findFirst({
      where: { subscriptionId: input.subscriptionId, status: SubscriptionTermStatus.ACTIVE },
      orderBy: { generation: 'desc' },
      select: { id: true },
    });
    if (activeTerm === null) return null; // durable model not applicable (no cutover)

    const tail = await tx.subscriptionTerm.findFirst({
      where: {
        subscriptionId: input.subscriptionId,
        status: { in: [SubscriptionTermStatus.ACTIVE, SubscriptionTermStatus.SCHEDULED] },
      },
      orderBy: { generation: 'desc' },
      select: { id: true, status: true, generation: true, endsAt: true },
    });
    if (tail === null) return null;
    if (tail.endsAt === null) {
      throw new ConflictException('Cannot append a renewal term after an open-ended term');
    }

    const now = new Date();
    const startsAt =
      tail.status === SubscriptionTermStatus.SCHEDULED || tail.endsAt.getTime() > now.getTime()
        ? tail.endsAt
        : now;
    const endsAt = calculateExpiry(startsAt, input.durationDays);
    const baseTrafficLimitBytes =
      input.plan.trafficLimit === null ? null : BigInt(input.plan.trafficLimit) * GIB_BYTES;
    const baseDeviceLimit = input.plan.deviceLimit <= 0 ? null : input.plan.deviceLimit;
    const created = await this.subscriptionTermService.createScheduledInTransaction(tx, {
      subscriptionId: input.subscriptionId,
      planId: input.plan.id,
      planSnapshot: {
        id: input.plan.id,
        name: input.plan.name,
        description: input.plan.description,
        tag: input.plan.tag,
        type: input.plan.type,
        icon: input.plan.icon ?? null,
        trafficLimit: input.plan.trafficLimit,
        deviceLimit: input.plan.deviceLimit,
        trafficLimitStrategy: input.plan.trafficLimitStrategy,
        internalSquads: input.plan.internalSquads,
        externalSquad: input.plan.externalSquad,
        selectedDurationDays: input.durationDays,
        snapshotSource: 'RENEWAL_TERM',
      } as Prisma.InputJsonValue,
      startsAt,
      endsAt,
      baseTrafficLimitBytes,
      baseDeviceLimit,
      trafficResetStrategy: input.plan.trafficLimitStrategy,
      resetAnchorAt: provisionalResetAnchor(input.plan.trafficLimitStrategy, startsAt),
    });
    return { id: created.id, startsAt, endsAt, baseTrafficLimitBytes, baseDeviceLimit };
  }

  /**
   * Opens the durable term for a fulfilled PLAN CHANGE (`PurchaseType.UPGRADE`).
   *
   * A term's `baseTrafficLimitBytes` / `baseDeviceLimit` are "what the customer
   * bought for THIS term": written once by
   * {@link SubscriptionTermService.createScheduledInTransaction} and never
   * mutated afterwards (every other `subscriptionTerm` write touches only
   * `status`, `endedAt` or `resetAnchorAt`), with add-on entitlements layering
   * on top in {@link EffectiveProjectionService}. So a plan change cannot edit
   * the baseline in place; it ends the current term and starts a new one, the
   * same move {@link scheduleRenewalTermInTransaction} makes for a renewal.
   *
   * It differs from renewal in WHEN the new term starts. A renewal buys time at
   * the tail, so its term is SCHEDULED at `tail.endsAt`. An upgrade resets the
   * window to `now` (the `UPGRADE_RESETS_EXPIRY` quote warning), so its term
   * starts NOW and is activated immediately — `activateInTransaction` ends the
   * outgoing ACTIVE term as part of the same claim.
   *
   * Returns `null` when the durable model does not apply (no ACTIVE term, i.e.
   * no cutover has run), leaving the caller on the legacy column-only path.
   */
  private async startUpgradeTermInTransaction(
    tx: Prisma.TransactionClient,
    input: {
      /** Collects reports that must not be announced until the tx commits. */
      readonly deferrals: UpgradeTermDeferral[];
      readonly subscriptionId: string;
      readonly plan: Plan;
      readonly durationDays: number;
      readonly startsAt: Date;
      readonly endsAt: Date | null;
    },
  ): Promise<{ readonly id: string } | null> {
    const parent = await tx.$queryRaw<Array<{ id: string; status: SubscriptionStatus }>>(Prisma.sql`
      SELECT "id", "status"::text AS "status"
      FROM "subscriptions"
      WHERE "id" = ${input.subscriptionId}
      FOR UPDATE
    `);
    if (parent.length !== 1 || parent[0]!.status === SubscriptionStatus.DELETED) {
      throw new ConflictException('Cannot start an upgrade term on a missing or deleted subscription');
    }

    const activeTerm = await tx.subscriptionTerm.findFirst({
      where: { subscriptionId: input.subscriptionId, status: SubscriptionTermStatus.ACTIVE },
      orderBy: { generation: 'desc' },
      select: { id: true },
    });
    if (activeTerm === null) return null; // durable model not applicable (no cutover)

    // A queued SCHEDULED tail was allocated inside the expiry window this
    // upgrade has just discarded, so its window is already void — and it also
    // blocks activation outright, because `activateInTransaction` only ever
    // activates the LOWEST scheduled generation while the term minted below is
    // always the highest. Left alone it would activate later and reinstate a
    // superseded plan's baseline: the very reversion this method exists to
    // stop, merely deferred. So cancel it.
    //
    // Never when it carries entitlements, though. Stranding goods the customer
    // has already paid for is worse than a stale baseline, and the entitlement
    // state machine has no CANCEL command to retire them with (`REVERSE` is a
    // compensating financial reversal, not a cancellation). That case keeps
    // today's behaviour and is reported rather than silently resolved.
    const scheduled = await tx.subscriptionTerm.findMany({
      where: { subscriptionId: input.subscriptionId, status: SubscriptionTermStatus.SCHEDULED },
      select: { id: true },
    });
    if (scheduled.length > 0) {
      const scheduledIds = scheduled.map((term) => term.id);
      const boundEntitlements = await tx.addOnEntitlement.count({
        where: {
          termId: { in: scheduledIds },
          state: {
            in: [
              AddOnEntitlementState.PENDING_ACTIVATION,
              AddOnEntitlementState.ACTIVE,
              AddOnEntitlementState.EXPIRING,
            ],
          },
        },
      });
      if (boundEntitlements > 0) {
        // Buffered past the commit for the same reason the renewal's
        // dead-line card is (see {@link DormantRenewalAddOnLine}): this runs
        // inside `upgradeSubscriptionFromPayment`'s `$transaction`, so a card
        // raised here reports an upgrade outcome that a rollback further down
        // erases — and the webhook then retries into the identical
        // deterministic condition and reports it again.
        input.deferrals.push({
          subscriptionId: input.subscriptionId,
          planId: input.plan.id,
          scheduledTermIds: scheduledIds,
          boundEntitlements,
        });
        return null;
      }
      await tx.subscriptionTerm.updateMany({
        where: { id: { in: scheduledIds }, status: SubscriptionTermStatus.SCHEDULED },
        data: { status: SubscriptionTermStatus.CANCELED, endedAt: input.startsAt },
      });
    }

    const created = await this.subscriptionTermService.createScheduledInTransaction(tx, {
      subscriptionId: input.subscriptionId,
      planId: input.plan.id,
      planSnapshot: {
        id: input.plan.id,
        name: input.plan.name,
        description: input.plan.description,
        tag: input.plan.tag,
        type: input.plan.type,
        icon: input.plan.icon ?? null,
        trafficLimit: input.plan.trafficLimit,
        deviceLimit: input.plan.deviceLimit,
        trafficLimitStrategy: input.plan.trafficLimitStrategy,
        internalSquads: input.plan.internalSquads,
        externalSquad: input.plan.externalSquad,
        selectedDurationDays: input.durationDays,
        snapshotSource: 'UPGRADE_TERM',
      } as Prisma.InputJsonValue,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      baseTrafficLimitBytes:
        input.plan.trafficLimit === null ? null : BigInt(input.plan.trafficLimit) * GIB_BYTES,
      baseDeviceLimit: input.plan.deviceLimit <= 0 ? null : input.plan.deviceLimit,
      trafficResetStrategy: input.plan.trafficLimitStrategy,
      resetAnchorAt: provisionalResetAnchor(input.plan.trafficLimitStrategy, input.startsAt),
    });
    await this.subscriptionTermService.activateInTransaction(tx, created.id, input.startsAt);
    return { id: created.id };
  }

  private async upgradeSubscriptionFromPayment(input: {
    readonly transaction: Transaction;
    readonly purchasedPlan: Plan;
    readonly selectedDurationDays: number;
  }): Promise<{ readonly subscription: Subscription; readonly syncJob: ProfileSyncJob }> {
    if (input.transaction.subscriptionId === null) {
      throw new NotFoundException('Source subscription not found');
    }
    const deferrals: UpgradeTermDeferral[] = [];
    const committed = await this.prismaService.$transaction(async (transactionClient) => {
      const currentSubscription = await transactionClient.subscription.findUnique({
        where: { id: input.transaction.subscriptionId! },
      });
      if (currentSubscription === null) {
        throw new NotFoundException('Source subscription not found');
      }
      const now = new Date();
      const expiresAt = calculateExpiry(now, input.selectedDurationDays);
      // Move the term baseline onto the purchased plan BEFORE the column write.
      // Without this the ACTIVE term keeps the superseded plan's baseline, and
      // any later versioned job recomputes `old_base + active add-ons` and
      // pushes it to the panel — silently undoing the plan change the customer
      // just paid for. Same gate as the renewal path, so a deployment with the
      // durable model off is untouched.
      const term = resolveAddOnRolloutFlags().entitlementShadow
        ? await this.startUpgradeTermInTransaction(transactionClient, {
            subscriptionId: currentSubscription.id,
            plan: input.purchasedPlan,
            durationDays: input.selectedDurationDays,
            startsAt: now,
            endsAt: expiresAt,
            deferrals,
          })
        : null;
      // With a durable term the projection owns the effective limits, so the
      // legacy columns mirror it instead of the raw plan — otherwise add-on
      // entitlements still ACTIVE across the plan change would be dropped from
      // the columns and taken back by the legacy sync path. Matches every other
      // projection-aware writer (`applyAddOnViaLedger`, the boundary sweep,
      // `forceReconcile`). Renewal defers instead because its term is SCHEDULED,
      // not active yet; an upgrade's term starts now.
      const projection =
        term === null
          ? null
          : await this.effectiveProjectionService.recomputeInTransaction(transactionClient, {
              subscriptionId: currentSubscription.id,
              mode: 'ACTIVE',
            });
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
          trafficLimit:
            projection === null
              ? input.purchasedPlan.trafficLimit
              : projection.desiredTrafficLimitBytes === null
                ? null
                : Number(projection.desiredTrafficLimitBytes / GIB_BYTES),
          deviceLimit:
            projection === null
              ? input.purchasedPlan.deviceLimit
              : projection.desiredDeviceLimit === null
                ? 0
                : projection.desiredDeviceLimit,
          internalSquads: input.purchasedPlan.internalSquads,
          externalSquad: input.purchasedPlan.externalSquad,
          startedAt: now,
          expiresAt,
        },
      });
      const syncJob = await transactionClient.profileSyncJob.create({
        data: {
          subscriptionId: upgradedSubscription.id,
          action: upgradedSubscription.remnawaveId === null ? SyncAction.CREATE : SyncAction.UPDATE,
          status: SyncJobStatus.PENDING,
          // Versioned only when a projection backs it: `tryVersionedDesiredStateWrite`
          // requires both `aggregateKey` and `desiredRevision`, and a job carrying
          // neither stays on the legacy absolute update exactly as before.
          ...(projection === null
            ? {}
            : {
                aggregateKey: upgradedSubscription.id,
                desiredRevision: projection.desiredRevision,
                cause: 'PLAN_CHANGE',
              }),
          payload: {
            source: 'PAYMENT_COMPLETION',
            paymentId: input.transaction.paymentId,
          },
        },
      });
      await transactionClient.transaction.update({
        where: { id: input.transaction.id },
        data: { fulfilledAt: now, status: TransactionStatus.COMPLETED },
      });
      return {
        subscription: upgradedSubscription,
        syncJob,
      };
    });

    for (const deferral of deferrals) {
      this.logger.warn(
        `UPGRADE_TERM_DEFERRED_SCHEDULED_ENTITLEMENTS subscription=${deferral.subscriptionId} ` +
          `scheduledTerms=${deferral.scheduledTermIds.length} entitlements=${deferral.boundEntitlements}`,
      );
      this.events.warn(
        EVENT_TYPES.SYSTEM_ERROR,
        'SYSTEM',
        'Upgrade kept the previous term baseline: a scheduled term carries paid entitlements',
        {
          code: 'UPGRADE_TERM_DEFERRED_SCHEDULED_ENTITLEMENTS',
          subscriptionId: deferral.subscriptionId,
          planId: deferral.planId,
          scheduledTermIds: [...deferral.scheduledTermIds],
          boundEntitlements: deferral.boundEntitlements,
        },
      );
    }

    return committed;
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

/**
 * The stored `planSnapshot` with exactly the inherited-limit keys a renewal
 * just refreshed from the plan re-declared as plan-given — or `undefined` when
 * it refreshed none, in which case the JSON is left untouched.
 *
 * ── Why a renewal has to do this at all ───────────────────────────────────
 *
 * `resolveInheritedPlanLimitUpdate` refreshes a column ONLY when the stored
 * snapshot still agrees with it (INHERITED). Writing the plan's new value into
 * the column and leaving the snapshot on the old one therefore makes the very
 * row that was just corrected read as OVERRIDDEN on every later comparison —
 * so the SECOND plan edit never reaches it. That is precisely the promise the
 * snapshot freeze in `PlanSnapshotSyncService` was built to restore, and the
 * plan editor states it to the operator while they are typing
 * (`web/src/i18n/en.ts` → `plans.form.limitScope`).
 *
 * It is invisible on the FIRST edit, because the column then happens to equal
 * the freshly-minted term's baseline, which is why it survived: nothing looks
 * wrong until a second edit silently does nothing.
 *
 * ── Which keys move, and which deliberately do not ────────────────────────
 *
 * MOVES: only the keys PRESENT in `refreshed` — a subset of
 * `PLAN_INHERITED_LIMIT_KEYS`. A key the resolver withheld (OVERRIDDEN or
 * UNDECIDABLE) left the column alone, so re-declaring it as plan-given would
 * erase an operator's individual configuration in the one place the whole
 * override rule reads.
 *
 * STAYS: `name`, `tag`, `type` and `trafficLimitStrategy` mirror the LIVE plan
 * through `PlanSnapshotSyncService.syncPlanSnapshotMetadata` and are no part of
 * the override comparison; `icon` is frozen at purchase so a customer's card
 * does not change glyph when the operator restyles the plan. Also untouched:
 * `id`, `selectedDurationDays`, `amount`, `currency`, `gatewayType`,
 * `snapshotSource` — with a durable term the subscription's snapshot still
 * describes the term the customer is CURRENTLY on, and the renewal's term is
 * only SCHEDULED. Rewriting those here would claim the customer had already
 * moved onto it.
 *
 * The numeric keys go through `patchSnapshotNumeric`
 * (`subscriptions/services/plan-inherited-limits.util.ts`) — the same helper
 * every other "and this is still what the plan gave them" writer uses (the
 * promocode, quest and referral top-ups, and the Remnawave mirror). The squad
 * keys have no numeric helper and are merged directly; `internalSquads` is
 * copied rather than aliased so the fragment cannot be mutated through the
 * snapshot. An unreadable snapshot never reaches either branch: the resolver
 * returns an empty fragment for one, so this returns `undefined` first.
 */
function patchSnapshotInheritedLimits(
  snapshot: unknown,
  refreshed: PlanInheritedLimitUpdate,
): Record<string, unknown> | undefined {
  let patched: Record<string, unknown> | undefined;
  if (refreshed.trafficLimit !== undefined) {
    patched = patchSnapshotNumeric(patched ?? snapshot, 'trafficLimit', refreshed.trafficLimit);
  }
  if (refreshed.deviceLimit !== undefined) {
    patched = patchSnapshotNumeric(patched ?? snapshot, 'deviceLimit', refreshed.deviceLimit);
  }
  if (refreshed.internalSquads !== undefined) {
    patched = {
      ...(patched ?? readJsonObject(snapshot)),
      internalSquads: [...refreshed.internalSquads],
    };
  }
  if (refreshed.externalSquad !== undefined) {
    patched = { ...(patched ?? readJsonObject(snapshot)), externalSquad: refreshed.externalSquad };
  }
  return patched;
}

/**
 * Builds a subscription `planSnapshot` for a single-subscription purchase,
 * renewal, or upgrade.
 *
 * NOT the same function as `buildPlanSnapshot` in
 * `src/modules/users/utils/plan-snapshot.util.ts`, which shares its name and is
 * used by the admin/give-subscription paths. The two legitimately differ (this
 * one also freezes the payment's duration, amount, currency and gateway) and
 * are deliberately NOT merged — but both, and `buildItemPlanSnapshot` below,
 * MUST keep writing `trafficLimit`, `deviceLimit`, `internalSquads` and
 * `externalSquad`. `resolveInheritedPlanLimitUpdate` derives "did an operator
 * override this field?" from exactly those keys, so dropping one silently
 * freezes that column for every subscription this function touches.
 * `test/subscription-plan-inherited-limits.spec.ts` guards all three.
 */
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
    icon: input.purchasedPlan.icon ?? null,
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
 *
 * Third writer of the same four inherited-limit keys, alongside the local
 * {@link buildPlanSnapshot} and the same-named function in
 * `src/modules/users/utils/plan-snapshot.util.ts`. See the note on
 * {@link buildPlanSnapshot}: `trafficLimit`, `deviceLimit`, `internalSquads`
 * and `externalSquad` are load-bearing for override detection and must not be
 * dropped from any of the three.
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
    icon: input.plan.icon ?? null,
    trafficLimit: input.plan.trafficLimit,
    deviceLimit: input.plan.deviceLimit,
    trafficLimitStrategy: input.plan.trafficLimitStrategy,
    internalSquads: input.plan.internalSquads,
    externalSquad: input.plan.externalSquad,
    selectedDurationDays: input.item.durationDays,
    snapshotVersion: 1,
    purchaseType: PurchaseType.RENEW,
    gatewayType: input.gatewayType,
    amount: input.item.amount.toString(),
    currency: input.item.currency,
    snapshotSource: 'RENEWAL_DRAFT',
  };
}

/**
 * Exhaustive over `AddOnType` BY CONSTRUCTION: adding a member to the enum
 * without adding it here fails to compile, because the record must have a key
 * for every member. A boolean allow-list written as a chain of `!==` comparisons
 * cannot do that, and its silence cost a whole payment path.
 */
const KNOWN_ADD_ON_TYPES: Readonly<Record<AddOnType, true>> = {
  [AddOnType.EXTRA_TRAFFIC]: true,
  [AddOnType.EXTRA_DEVICES]: true,
  [AddOnType.RESET_TRAFFIC]: true,
};

function isKnownAddOnType(value: unknown): value is AddOnType {
  return typeof value === 'string' && value in KNOWN_ADD_ON_TYPES;
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
    // EVERY add-on type belongs here. This allow-list is what decides whether a
    // paid transaction is an add-on at all, and a type missing from it is not a
    // disabled feature — it is a captured payment that falls through to the
    // renewal path, throws "Purchased plan not found", and is retried by the
    // webhook job forever while the recovery sweeper skips it for the same
    // reason. RESET_TRAFFIC shipped missing from it; hence the exhaustive form.
    !isKnownAddOnType(addOnTypeRaw)
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

/**
 * Does this add-on marker carry a coherent number of units?
 *
 * WHOLE and POSITIVE, for both resources. `readRenewalAddOnLines` below already
 * enforces exactly this on persisted renewal lines
 * (`Number.isInteger(value) && value > 0`); the DIRECT-purchase marker never
 * was, because `readAddOnMarker` only tests `typeof addOnValue === 'number'`.
 *
 * A fractional value cannot survive `BigInt()` — it throws a raw `RangeError`
 * inside a money transaction. A negative value is worse, because it succeeds:
 * on the legacy path it can drive `Subscription.trafficLimit` to exactly `0`,
 * an encoding the panel cannot express and decodes back to `null` (canonical
 * UNLIMITED), and on the device side it can drive a finite cap to `0`, which
 * the product also reads as unlimited.
 */
function isCoherentAddOnValue(value: number): boolean {
  return Number.isInteger(value) && value >= 1;
}

/** One parsed renewal add-on line persisted on a {@link TransactionItem}. */
interface RenewalAddOnLine {
  readonly addOnId: string;
  readonly catalogRevision: number;
  readonly type: AddOnType;
  readonly value: number;
  readonly lifetime: AddOnLifetime;
  readonly sourceLineKey: string;
  readonly unitAmount: string;
  readonly receiptName: string;
}

/**
 * Strictly decodes persisted PAID renewal add-on lines. `null` and `[]` mean
 * that checkout sold no add-ons. Every other payload is commercial evidence:
 * one malformed/duplicate entry invalidates the whole transaction so the
 * surrounding fulfillment transaction rolls back for retry/remediation.
 */
function readRenewalAddOnLines(raw: Prisma.JsonValue | null): readonly RenewalAddOnLine[] {
  if (raw === null) return [];
  const malformed = (): never => {
    throw new ConflictException('Persisted renewal add-on lines are malformed');
  };
  if (!Array.isArray(raw)) return malformed();

  const lines: RenewalAddOnLine[] = [];
  const sourceLineKeys = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return malformed();
    const record = entry as Record<string, unknown>;
    const addOnId = record['addOnId'];
    const catalogRevision = record['catalogRevision'];
    const type = record['type'];
    const value = record['value'];
    const lifetime = record['lifetime'];
    const activation = record['activation'];
    const sourceLineKey = record['sourceLineKey'];
    const unitAmount = record['unitAmount'];
    const receiptName = record['receiptName'];

    if (
      typeof addOnId !== 'string' ||
      addOnId.trim().length === 0 ||
      typeof catalogRevision !== 'number' ||
      !Number.isInteger(catalogRevision) ||
      catalogRevision <= 0 ||
      (type !== AddOnType.EXTRA_TRAFFIC && type !== AddOnType.EXTRA_DEVICES) ||
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value <= 0 ||
      (lifetime !== AddOnLifetime.UNTIL_NEXT_RESET &&
        lifetime !== AddOnLifetime.UNTIL_SUBSCRIPTION_END) ||
      activation !== 'TERM_START' ||
      typeof sourceLineKey !== 'string' ||
      sourceLineKey.trim().length === 0 ||
      typeof unitAmount !== 'string' ||
      unitAmount.trim().length === 0 ||
      typeof receiptName !== 'string' ||
      receiptName.trim().length === 0 ||
      sourceLineKeys.has(sourceLineKey)
    ) {
      return malformed();
    }

    let amount: Prisma.Decimal;
    try {
      amount = new Prisma.Decimal(unitAmount);
    } catch {
      return malformed();
    }
    if (!amount.isFinite() || amount.isNegative()) return malformed();

    sourceLineKeys.add(sourceLineKey);
    lines.push({
      addOnId,
      catalogRevision,
      type,
      value,
      lifetime,
      sourceLineKey,
      unitAmount,
      receiptName,
    });
  }
  return lines;
}

function isCombinedRenewalTransaction(transaction: Transaction): boolean {
  if (
    typeof transaction.planSnapshot !== 'object' ||
    transaction.planSnapshot === null ||
    Array.isArray(transaction.planSnapshot)
  ) {
    return false;
  }
  const marker = transaction.planSnapshot as Record<string, unknown>;
  // Legacy in-flight drafts wrote the marker without snapshotVersion; treat a
  // missing version as v1 so a combined renewal paid across the deploy is still
  // recognized and fulfilled (item-level fallback handles its partial snapshot).
  return (
    marker['combinedRenewal'] === true &&
    (marker['snapshotVersion'] === 1 || marker['snapshotVersion'] === undefined)
  );
}

function assertRenewalFulfillmentPolicy(
  subscription: Pick<Subscription, 'status' | 'isTrial'>,
  persistedTargetAvailability: PlanAvailability | null,
): void {
  if (subscription.isTrial) {
    throw new ConflictException('TRIAL_NOT_RENEWABLE');
  }
  if (subscription.status === SubscriptionStatus.DISABLED) {
    throw new ConflictException('SUBSCRIPTION_DISABLED_NOT_RENEWABLE');
  }
  if (subscription.status === SubscriptionStatus.DELETED) {
    throw new ConflictException('RENEWAL_SUBSCRIPTION_NOT_RENEWABLE');
  }
  if (persistedTargetAvailability === PlanAvailability.TRIAL) {
    throw new ConflictException('TRIAL_PLAN_NOT_RENEWAL_TARGET');
  }
}

function readPersistedPlanAvailability(raw: Prisma.JsonValue): PlanAvailability | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null;
  }
  const availability = raw['availability'];
  return (Object.values(PlanAvailability) as unknown[]).includes(availability)
    ? (availability as PlanAvailability)
    : null;
}

function readPersistedTrialSettings(raw: Prisma.JsonValue): Prisma.JsonValue | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null;
  }
  return (raw['trialSettings'] as Prisma.JsonValue | undefined) ?? null;
}
/**
 * Verifies a paid renewal item's plan snapshot against the transaction item.
 *
 * Returns `null` for a legacy in-flight draft — one persisted before this
 * strict-snapshot verification shipped, recognizable by a missing
 * `snapshotVersion`. Those drafts were written with a partial snapshot (no
 * `type`/`trafficLimitStrategy`/`deviceLimit`/squads) and were always fulfilled
 * by reading the live plan row, so the caller must fall back to
 * `plan.findUnique` for them. Failing them here would strand paid money on an
 * unfulfillable transaction (the reconciler retries forever). Version 1
 * snapshots are verified strictly to pin pricing/limits against mutable
 * catalog state. Version 2 additionally pins target availability so a later
 * catalog edit cannot invalidate an already-paid renewal.
 */
function parsePaidRenewalPlanSnapshot(
  raw: Prisma.JsonValue,
  item: Pick<TransactionItem, 'planId' | 'durationDays' | 'amount' | 'currency'>,
  transactionGatewayType: Transaction['gatewayType'],
): Plan | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConflictException('Paid renewal plan snapshot is malformed');
  }
  const snapshot = raw as Record<string, unknown>;
  if (snapshot['snapshotVersion'] === undefined) {
    return null;
  }
  const strategies = ['NO_RESET', 'DAY', 'WEEK', 'MONTH', 'MONTH_ROLLING'];
  const planTypes = ['TRAFFIC', 'DEVICES', 'BOTH', 'UNLIMITED'];
  const requiredStrings = ['id', 'name', 'type', 'description', 'tag'];
  if (
    (snapshot['snapshotVersion'] !== 1 && snapshot['snapshotVersion'] !== 2) ||
    snapshot['snapshotSource'] !== 'RENEWAL_DRAFT' ||
    snapshot['purchaseType'] !== PurchaseType.RENEW ||
    requiredStrings.some((key) =>
      key === 'description' || key === 'tag'
        ? !(snapshot[key] === null || typeof snapshot[key] === 'string')
        : typeof snapshot[key] !== 'string' || (snapshot[key] as string).length === 0,
    ) ||
    !planTypes.includes(String(snapshot['type'])) ||
    snapshot['id'] !== item.planId ||
    snapshot['selectedDurationDays'] !== item.durationDays ||
    snapshot['gatewayType'] !== transactionGatewayType ||
    snapshot['currency'] !== item.currency ||
    new Prisma.Decimal(String(snapshot['amount'])).comparedTo(item.amount) !== 0 ||
    // `null` is unlimited and stays legal. A FINITE limit must be at least 1
    // GB: a stored `0` is a state that must never exist, because the panel has
    // no encoding for zero bytes and decodes an upstream `0` back to `null` —
    // canonical UNLIMITED. Accepting `0` here casts it straight onto
    // `Plan.trafficLimit` at the bottom of this function, from where the
    // renewal writes it into `Subscription.trafficLimit` and mints a row that
    // reads as "entitled to nothing" locally while receiving everything
    // upstream, with the projection reporting drift on every sweep forever.
    // "May move no traffic" is `status: DISABLED`, which the panel can express.
    //
    // Refusing throws with every other shape violation in this validator and
    // rolls the fulfillment back for retry/remediation. That is the deliberate
    // contract of this function — a malformed paid draft is commercial evidence
    // we will not act on — and it is the right side to be on here: the money is
    // held and recoverable, whereas an unlimited panel profile handed out by
    // mistake is not.
    !(
      snapshot['trafficLimit'] === null ||
      (typeof snapshot['trafficLimit'] === 'number' &&
        Number.isInteger(snapshot['trafficLimit']) &&
        snapshot['trafficLimit'] >= 1)
    ) ||
    typeof snapshot['deviceLimit'] !== 'number' ||
    !Number.isInteger(snapshot['deviceLimit']) ||
    typeof snapshot['trafficLimitStrategy'] !== 'string' ||
    !strategies.includes(snapshot['trafficLimitStrategy']) ||
    !Array.isArray(snapshot['internalSquads']) ||
    snapshot['internalSquads'].some((value) => typeof value !== 'string') ||
    (snapshot['externalSquad'] !== null && typeof snapshot['externalSquad'] !== 'string') ||
    (snapshot['snapshotVersion'] === 2 &&
      !(Object.values(PlanAvailability) as unknown[]).includes(snapshot['availability']))
  ) {
    throw new ConflictException('Paid renewal plan snapshot does not match transaction item');
  }
  return {
    id: snapshot['id'] as string,
    name: snapshot['name'] as string,
    description: typeof snapshot['description'] === 'string' ? snapshot['description'] : null,
    tag: typeof snapshot['tag'] === 'string' ? snapshot['tag'] : null,
    // Carried through so the renewal keeps the plan icon frozen at draft time.
    // Legacy drafts predate the field — absent → `null`, and the card falls
    // back to the status glyph exactly as it did before.
    icon: typeof snapshot['icon'] === 'string' ? snapshot['icon'] : null,
    availability:
      snapshot['snapshotVersion'] === 2
        ? (snapshot['availability'] as PlanAvailability)
        : PlanAvailability.ALL,
    type: snapshot['type'] as Plan['type'],
    trafficLimit: snapshot['trafficLimit'] as number | null,
    deviceLimit: snapshot['deviceLimit'] as number,
    trafficLimitStrategy: snapshot['trafficLimitStrategy'] as Plan['trafficLimitStrategy'],
    internalSquads: snapshot['internalSquads'] as string[],
    externalSquad: snapshot['externalSquad'] as string | null,
  } as Plan;
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
