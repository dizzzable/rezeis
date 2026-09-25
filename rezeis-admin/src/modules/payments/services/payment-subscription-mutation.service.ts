import { Injectable, Logger, NotFoundException, ConflictException, Optional } from '@nestjs/common';
import {
  AddOnLifetime,
  AddOnType,
  AddOnEntitlementActorType,
  AddOnEntitlementState,
  DeviceType,
  PaymentGatewayType,
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
import { pickBestDiscount } from '../../../common/utils/pending-discount.util';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { SystemEventsService, EVENT_TYPES } from '../../../common/services/system-events.service';
import { readJsonObject } from '../../../common/utils/read-json-object.util';
import { planNameMetadata, planNamesMetadata } from '../../../common/utils/plan-snapshot.util';
import { type AddOnRolloutFlags, readAddOnRolloutFlags } from '../../add-on-entitlements/add-on-rollout.config';
import { type AddOnQuote, readAddOnQuote } from '../../add-on-entitlements/domain/add-on-quote';
import { GIB_BYTES } from '../../add-on-entitlements/domain/cutover-baseline';
import {
  planResetEpoch,
  resetExpiryAt,
  ResetStrategy,
} from '../../add-on-entitlements/domain/reset-cycle-policy';
import { AddOnEntitlementService } from '../../add-on-entitlements/services/add-on-entitlement.service';
import {
  isBaselineExtendable,
  resolveConfiguredEntitlementBaseline,
  resolvePlanChangeLimitCarryInTransaction,
  resolveRecordedAddOnContribution,
} from '../../add-on-entitlements/services/configured-baseline.util';
import {
  bindResetEpochWindow,
  mintResetAnchorInTransaction,
  redateResetAddOnsInTransaction,
} from '../../add-on-entitlements/services/reset-epoch.util';
import {
  EffectiveProjectionService,
  type RecomputeProjectionResult,
} from '../../add-on-entitlements/services/effective-projection.service';
import { EntitlementCutoverService } from '../../add-on-entitlements/services/entitlement-cutover.service';
import { SubscriptionTermService } from '../../add-on-entitlements/services/subscription-term.service';
import { AddOnSwitchesService } from '../../add-on-entitlements/switches/add-on-switches.service';
import {
  carryTermLimitBonusesAcrossUpgradeInTransaction,
  readLiveTermLimitBonusesInTransaction,
} from '../../add-on-entitlements/services/term-limit-bonus.util';
import { carryImportDomainKeys } from '../../imports/utils/import-domain-snapshot.util';
import { displayPlanName } from '../../plans/utils/plan-deletion.util';
import { readTrialSettings } from '../../plans/utils/trial-settings.util';
import {
  patchSnapshotNumeric,
  resolveInheritedPlanLimitRefresh,
  type PlanInheritedLimitUpdate,
} from '../../subscriptions/services/plan-inherited-limits.util';
import {
  convertRenewalPricedBeforeUpgrade,
  describeRenewalPricedBeforeUpgrade,
  PAID_REMAINDER_CONVERSION_KEY,
  paidRemainderProvenance,
  readRenewalPricedBeforePlanChange,
  readRenewalPricedBeforeUpgrade,
  RENEWAL_PRICED_BEFORE_UPGRADE_KEY,
  renewalPricedBeforeUpgradeCode,
  renewalPricedBeforeUpgradeCompletionMetadata,
  renewalPricedBeforeUpgradeMessage,
  renewalPricedBeforeUpgradeMetadata,
  renewalPricedBeforeUpgradeProvenance,
  resolvePaidRemainderConversionInTransaction,
  type PaidRemainderConversion,
  type RenewalPricedBeforeUpgrade,
} from '../../subscriptions/services/paid-remainder-conversion.util';
import {
  consumePaidTrialClaim,
  countCommittedTrialClaimUnits,
} from '../../subscriptions/services/trial-claim-ledger.util';
import {
  describeLifetimeLineRefund,
  describeLifetimeRenewalNotApplied,
  describeLifetimeUpgradeNotApplied,
  findOpenEndedQueuedTerm,
  isLifetimeSubscription,
  LIFETIME_PAYMENT_WITHHELD_MESSAGE,
  LIFETIME_RENEWAL_CARD_KEY,
  LIFETIME_RENEWAL_NOT_APPLIED_CODE,
  LIFETIME_RENEWAL_NOT_APPLIED_KEY,
  LIFETIME_RENEWAL_NOT_APPLIED_MESSAGE,
  LIFETIME_UPGRADE_CARD_KEY,
  lifetimeRenewalNotAppliedProvenance,
  type LifetimeRenewalNotApplied,
  subscriptionIsLifetime,
} from '../utils/lifetime-renewal.util';
import { readProviderSubscriptionTerms } from '../utils/provider-subscription-terms.util';
import {
  AUTOPAY_AFTER_REFUND,
  CONVERSION_WITHHELD_AT_KEY,
  isTrialConversionSnapshot,
  isWithheldConversion,
  TRIAL_CONVERTED_BY_KEY,
  WITHHELD_FOR_LIFETIME_SUBSCRIPTION,
  WITHHELD_REASON_KEY,
  WITHHELD_REFUND_UI_PATH,
} from '../utils/trial-conversion.util';
import { autopayEndedByRefund, readProviderChargeMarker } from '../utils/refund-autopay.util';
import { writeTransactionGatewayData } from '../utils/transaction-gateway-data.util';
import {
  describeLatePlanMigrationRenewal,
  describeLatePlanMigrationRenewals,
  findLatePlanMigrationRenewal,
  LATE_PLAN_MIGRATION_RENEWAL_CODE,
  LATE_PLAN_MIGRATION_RENEWAL_MESSAGE,
  latePlanMigrationRenewalMetadata,
  type LatePlanMigrationRenewal,
  resolvePlanMigrationGuardCandidate,
  withPaidRenewalDuration,
} from './payment-renewal-plan-migration-guard.util';

/**
 * A renewal line still carrying add-on lines: sold under stage 5 («renewal
 * add-ons»), which was deleted with its code on 24.09.2026 and was never on by
 * default. Such a line is not fulfilled — renewing it would take the money for
 * its add-ons and deliver none of them, silently — so the payment stays paid
 * and unfulfilled, the webhook is marked FAILED with this bare code, and the
 * operator's alert fires: refund the add-ons' part (or the whole payment) by
 * hand. Such lines, if an install has any, are the unapplied rows of
 * `transaction_items` whose `add_on_lines` is a non-empty JSON array.
 */
const RENEWAL_ADDON_LINES_NOT_SUPPORTED = 'RENEWAL_ADDON_LINES_NOT_SUPPORTED';

/**
 * What an UPGRADE payment did: applied to its subscription, or — a trial's
 * conversion paid after another payment converted it — received and withheld
 * (see "A TRIAL CONVERTS ONCE"). `announce` is false when an earlier run
 * already withheld it, so the operator's notice goes out once per payment.
 */
type UpgradeOutcome =
  | {
      readonly kind: 'APPLIED';
      readonly subscription: Subscription;
      readonly syncJob: ProfileSyncJob;
      /** What was left of the old plan, added to the new term as days. */
      readonly paidRemainder: PaidRemainderConversion;
    }
  | {
      readonly kind: 'WITHHELD';
      readonly subscriptionId: string;
      readonly convertedByPaymentId: string;
      readonly announce: boolean;
    }
  | LifetimeWithheld;

/**
 * A renewal or an upgrade paid for a subscription that has no end date — or
 * whose paid periods end in a queued one without an end — withheld for refund
 * (`lifetime-renewal.util.ts`). `announce` is true for the run that wrote the
 * mark, which is the one that tells the operator.
 */
interface LifetimeWithheld {
  readonly kind: 'WITHHELD_LIFETIME';
  /** What was paid for, on which subscription, and why it was not applied. */
  readonly line: LifetimeRenewalNotApplied;
  readonly announce: boolean;
}

/** What a single renewal did: renewed the subscription, or was withheld because it has no end date. */
type RenewalOutcome =
  | {
      readonly kind: 'RENEWED';
      readonly subscription: Subscription;
      readonly syncJob: ProfileSyncJob;
      readonly latePlanMigrationRenewal: LatePlanMigrationRenewal | null;
      readonly renewalPricedBeforeUpgrade: RenewalPricedBeforeUpgrade | null;
    }
  | LifetimeWithheld;

/**
 * The payment that converted a trial, when a payment did: another UPGRADE on
 * the same subscription that was received and applied — COMPLETED, fulfilled,
 * and not itself withheld. `null` when the trial stopped being one without a
 * payment (a plan migration, an operator's edit), or when the only other
 * conversion was itself withheld and so converted nothing.
 */
async function findTrialConvertingPayment(
  client: Pick<Prisma.TransactionClient, 'transaction'>,
  input: { readonly subscriptionId: string; readonly transactionId: string },
): Promise<{ readonly paymentId: string } | null> {
  const upgrades = await client.transaction.findMany({
    where: {
      subscriptionId: input.subscriptionId,
      purchaseType: PurchaseType.UPGRADE,
      status: TransactionStatus.COMPLETED,
      fulfilledAt: { not: null },
      id: { not: input.transactionId },
    },
    select: { paymentId: true, gatewayData: true },
    orderBy: { fulfilledAt: 'asc' },
  });
  const converter = upgrades.find((upgrade) => !isWithheldConversion(upgrade.gatewayData));
  return converter === undefined ? null : { paymentId: converter.paymentId };
}

/** The durable term a fulfilled renewal appended. */
interface ScheduledRenewalTerm {
  readonly id: string;
}

@Injectable()
export class PaymentSubscriptionMutationService {
  private readonly logger = new Logger(PaymentSubscriptionMutationService.name);

  /** Brings a subscription into the term model: see {@link enterTermModelInTransaction}. */
  private readonly entitlementCutoverService: EntitlementCutoverService;

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly events: SystemEventsService,
    private readonly addOnEntitlementService: AddOnEntitlementService,
    private readonly effectiveProjectionService: EffectiveProjectionService,
    private readonly subscriptionTermService: SubscriptionTermService,
    private readonly trafficResetService: TrafficResetService,
    // `AddOnEntitlementsModule` exports it and `PaymentsModule` imports that
    // module, so Nest always injects the shared instance. `@Optional()` only
    // keeps the hand-built fulfilments of the unit specs compiling; the
    // fallback is the same stateless service over the same collaborators.
    @Optional() entitlementCutoverService?: EntitlementCutoverService,
    /** The stage switches; `@Optional()` only for the specs that build this by hand. */
    @Optional() private readonly addOnSwitches?: AddOnSwitchesService,
  ) {
    this.entitlementCutoverService =
      entitlementCutoverService ??
      new EntitlementCutoverService(prismaService, subscriptionTermService, effectiveProjectionService);
  }

  /**
   * THE ONE PLACE A PAYMENT BRINGS A SUBSCRIPTION INTO THE TERM MODEL: its
   * first term (generation 1, ACTIVE) and a SHADOW projection, minted from its
   * own columns by `EntitlementCutoverService.ensureTermInTransaction`, which
   * takes the row lock and is idempotent — a subscription that has a term
   * keeps it.
   *
   * GATED BY STAGE 1 («Новый учёт докупок») AND BY NOTHING ELSE. Only ENTERING
   * the model reads the flag; what a renewal, an upgrade or an add-on does once
   * a subscription is in it follows the term ROW, whatever the flags say now —
   * so turning stage 1 off stops new entrants and strands nobody.
   *
   * `flags` is REQUIRED: the one snapshot `applyCompletedTransaction` read
   * before any transaction opened (review R2b-07). Read here, inside the
   * caller's transaction, a cold settings cache needed a second pool connection
   * while this one was held, and a burst of payments could wait on each other
   * until the pool timed out; an operation that reads the switches twice can
   * also straddle a flip.
   *
   * Called at creation (NEW, ADDITIONAL, a paid trial) and lazily wherever a
   * payment needs the model: the add-on ledger, the renewal term, the upgrade
   * term. The background cutover brings in the rest.
   */
  private async enterTermModelInTransaction(
    tx: Prisma.TransactionClient,
    subscriptionId: string,
    flags: AddOnRolloutFlags,
  ): Promise<void> {
    if (!flags.entitlementShadow) return;
    await this.entitlementCutoverService.ensureTermInTransaction(tx, subscriptionId);
  }

  public async applyCompletedTransaction(
    transaction: Transaction,
  ): Promise<{ readonly syncJobs: readonly ProfileSyncJob[] }> {
    // ONE snapshot of the stage switches for the whole fulfilment, read here,
    // before any transaction opens, and handed down to every branch (review
    // R2b-07): see `enterTermModelInTransaction`.
    const flags = await readAddOnRolloutFlags(this.addOnSwitches);

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
      // An autopay charge the provider took after a refund ended its autopay
      // renews nothing: it would revive the subscription the refund took back.
      if (await autopayEndedByRefund(this.prismaService, transaction)) {
        return this.withholdAutopayCharge(transaction, items);
      }
      const combined = await this.applyCombinedRenewal(transaction, items, flags);
      // A multi-subscription renewal is a plan purchase — consume the
      // one-time "next purchase" discount once it completes.
      //
      // Every plan this renewal priced. A combined renewal has no single plan,
      // but each LINE was priced with its own — so a grant restricted to one of
      // them was applied and has to be settled. Passing `null` alone said
      // nothing applied, and the grant survived every combined renewal.
      //
      // Not when every line met a subscription with no end date: nothing was
      // bought, the money is to go back, and the discount with it.
      if (!combined.lifetimeOnly) {
        await this.consumePurchaseDiscount(
          transaction.userId,
          null,
          items,
          // Lines kept on their current plan — by a migration, or priced before
          // an upgrade — were still priced with the plan they paid for.
          [...combined.latePlanMigrationRenewals, ...combined.renewalsPricedBeforeUpgrade],
        );
      }
      return { syncJobs: combined.syncJobs };
    }

    // Add-on top-ups carry a marker in planSnapshot and have no plan/
    // duration — handle them before the plan-centric branches. Add-ons price
    // with purchaseDiscount = 0 (they never benefit from it), so they must
    // NOT consume the user's one-time purchase discount.
    if (isAddOnTransaction(transaction)) {
      const addOnResult = await this.applyAddOnTopUp(transaction, flags);
      return { syncJobs: [addOnResult.syncJob] };
    }

    const purchasedPlan = await this.getRequiredPlan(transaction);
    const selectedDurationDays = readSelectedDurationDays(transaction);

    let result: {
      readonly subscription: Subscription;
      readonly syncJob: ProfileSyncJob;
      /** Set by the RENEW path only; see {@link findLatePlanMigrationRenewal}. */
      readonly latePlanMigrationRenewal?: LatePlanMigrationRenewal | null;
      /** Set by the RENEW path only; see `readRenewalPricedBeforeUpgrade`. */
      readonly renewalPricedBeforeUpgrade?: RenewalPricedBeforeUpgrade | null;
      /** Set by the UPGRADE path only; see `paid-remainder-conversion.util.ts`. */
      readonly paidRemainder?: PaidRemainderConversion;
    };

    switch (transaction.purchaseType) {
      case PurchaseType.NEW:
      case PurchaseType.ADDITIONAL:
        result = await this.createSubscriptionFromPayment({
          transaction,
          purchasedPlan,
          selectedDurationDays,
          flags,
        });
        break;
      case PurchaseType.RENEW: {
        const renewed = await this.renewSubscriptionFromPayment({
          transaction,
          purchasedPlan,
          selectedDurationDays,
          flags,
        });
        if (renewed.kind === 'WITHHELD_LIFETIME') {
          // A subscription with no end date: settled and not applied, as a
          // trial's second conversion is. No «Платёж получен» for a sale, no
          // «Подписка продлена», and the one-time discount stays unspent: the
          // money is to go back. The operator's notice replaces all three.
          if (renewed.announce) {
            this.announceLifetimeWithheld({
              transaction,
              purchaseType: PurchaseType.RENEW,
              lines: [renewed.line],
              planName: displayPlanName(purchasedPlan),
              planType: purchasedPlan.type,
              durationDays: selectedDurationDays,
            });
          }
          return { syncJobs: [] };
        }
        result = renewed;
        break;
      }
      case PurchaseType.UPGRADE: {
        const upgraded = await this.upgradeSubscriptionFromPayment({
          transaction,
          purchasedPlan,
          selectedDurationDays,
          flags,
        });
        if (upgraded.kind === 'WITHHELD_LIFETIME') {
          // The same for an upgrade: it would have restarted the term at the
          // payment and given the subscription an end date.
          if (upgraded.announce) {
            this.announceLifetimeWithheld({
              transaction,
              purchaseType: PurchaseType.UPGRADE,
              lines: [upgraded.line],
              planName: displayPlanName(purchasedPlan),
              planType: purchasedPlan.type,
              durationDays: selectedDurationDays,
            });
          }
          return { syncJobs: [] };
        }
        if (upgraded.kind === 'WITHHELD') {
          // Settled and not applied: no «Платёж получен» for a sale, no
          // lifecycle card, and the one-time discount stays unspent. The
          // operator's notice replaces all three, once per payment.
          if (upgraded.announce) {
            this.announceWithheldConversion({
              transaction,
              purchasedPlan,
              selectedDurationDays,
              subscriptionId: upgraded.subscriptionId,
              convertedByPaymentId: upgraded.convertedByPaymentId,
            });
          }
          return { syncJobs: [] };
        }
        result = upgraded;
        break;
      }
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

    // ONE completion per payment, whichever way it went.
    //
    // The blocked case used to be a WARNING emitted in ADDITION to the INFO
    // below, so one payment produced two `payment.completed` events: two
    // «Платёж получен» cards, two runs of every automation rule and outbound
    // webhook bound to the type, and — with a receipt template active — two
    // receipt emails to the customer. The warning now IS the completion: the
    // same metadata, raised as WARNING with the note the operator has to act on.
    // A renewal a plan migration kept on the subscription's CURRENT plan
    // (decision 10) is announced by this same completion, raised as WARNING —
    // for the reason the blocked purchaser's is: a second event for the same
    // payment is a second card to reconcile against the first, and the type
    // already wears «Платёж получен, нужна проверка» when raised above INFO.
    // `planName` and the limits above stay the PAID plan's: they describe what
    // was bought; the note and the keys below say where the period went.
    // A renewal priced for the plan an upgrade left is told the same way: the
    // payment's plan above, and where its money went in the keys and the note.
    const latePlanMigrationRenewal = result.latePlanMigrationRenewal ?? null;
    const renewalPricedBeforeUpgrade = result.renewalPricedBeforeUpgrade ?? null;
    const completedMetadata = {
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
      ...(latePlanMigrationRenewal === null
        ? {}
        : latePlanMigrationRenewalMetadata(latePlanMigrationRenewal)),
      ...(renewalPricedBeforeUpgrade === null
        ? {}
        : renewalPricedBeforeUpgradeCompletionMetadata(renewalPricedBeforeUpgrade)),
    };
    const latePlanMigrationNote =
      latePlanMigrationRenewal !== null
        ? describeLatePlanMigrationRenewal(latePlanMigrationRenewal)
        : renewalPricedBeforeUpgrade !== null
          ? describeRenewalPricedBeforeUpgrade(renewalPricedBeforeUpgrade)
          : null;
    if (purchaserBlocked) {
      // In Russian, both of them: the operator reads the message in the event
      // feed and the note on the card («📝 Заметка»), and this one asks them
      // for a decision about money.
      //
      // Spelled out because this is the operator's decision, not ours: the
      // subscription exists and the VPN profile is disabled, so the customer
      // has paid for something they cannot use until unblocked.
      const blockedNote =
        'Счёт создан до блокировки, а оплачен после неё. Подписка записана, VPN-профиль ' +
        'отключён. Решите, нужен ли возврат средств.';
      this.events.warn(
        EVENT_TYPES.PAYMENT_COMPLETED,
        'PAYMENT',
        'Платёж получен от заблокированного пользователя',
        {
          ...completedMetadata,
          note: latePlanMigrationNote === null ? blockedNote : `${blockedNote} ${latePlanMigrationNote}`,
        },
      );
    } else if (latePlanMigrationNote !== null) {
      this.events.warn(
        EVENT_TYPES.PAYMENT_COMPLETED,
        'PAYMENT',
        latePlanMigrationRenewal !== null || renewalPricedBeforeUpgrade === null
          ? LATE_PLAN_MIGRATION_RENEWAL_MESSAGE
          : renewalPricedBeforeUpgradeMessage([renewalPricedBeforeUpgrade]),
        { ...completedMetadata, note: latePlanMigrationNote },
      );
    } else {
      this.events.info(
        EVENT_TYPES.PAYMENT_COMPLETED,
        'PAYMENT',
        `Payment completed: ${transaction.purchaseType}`,
        completedMetadata,
      );
    }

    // What happened TO THE SUBSCRIPTION, beside what happened to the money.
    //
    // «Платёж получен» describes the payment; these two describe the thing the
    // customer actually has, with its new expiry and its plan, and they are the
    // types an automation rule or an outbound webhook binds to when it cares
    // about the subscription rather than the till. An operator who finds two
    // cards per renewal too many unticks one of them in «Уведомления».
    //
    // Not for a renewal priced before a plan change that bought no day: it
    // renewed nothing, and the completion above asks for the refund.
    if (renewalPricedBeforeUpgrade?.conversion.days !== 0) {
      this.announceSubscriptionLifecycle(transaction.purchaseType, {
        subscription: result.subscription,
        paymentId: transaction.paymentId,
        // A renewal priced for the plan an upgrade left renewed the plan the
        // subscription is on, for the days its money bought there.
        planName:
          renewalPricedBeforeUpgrade === null
            ? displayPlanName(purchasedPlan)
            : (renewalPricedBeforeUpgrade.currentPlanName ?? renewalPricedBeforeUpgrade.currentPlanId),
        durationDays: renewalPricedBeforeUpgrade?.conversion.days ?? selectedDurationDays,
        paidRemainder: result.paidRemainder,
        renewalPricedBeforeUpgrade,
      });
    }

    // Consume the one-time "next purchase" discount (PURCHASE_DISCOUNT promo
    // reward) now that a plan purchase has completed. Without this it kept
    // applying to every future purchase. The permanent personalDiscount stays.
    await this.consumePurchaseDiscount(transaction.userId, purchasedPlan.id);

    return { syncJobs: [result.syncJob] };
  }

  /**
   * The plans a combined renewal actually priced.
   *
   * Read from each item's own subscription snapshot, because that is what
   * `priceRenewalItems` used when it built the amount.
   */
  private async resolveCombinedRenewalPlanIds(
    items: readonly { readonly subscriptionId: string | null }[],
    /**
     * Lines fulfilment kept on their subscription's current plan. Their
     * snapshot was deliberately NOT replaced with the paid plan, so it names
     * the plan a migration moved them to — which is not the plan the line was
     * priced with. The paid plan is what a normal renewal of the line leaves
     * in the snapshot, so it is what they contribute here. The same for a
     * line priced before an upgrade.
     */
    latePlanMigrationRenewals: ReadonlyArray<Pick<LatePlanMigrationRenewal, 'subscriptionId' | 'paidPlanId'>> = [],
  ): Promise<string[]> {
    const ids = items
      .map((item) => item.subscriptionId)
      .filter((value): value is string => typeof value === 'string' && value.length > 0);
    if (ids.length === 0) return [];
    const pricedPlanBySubscription = new Map(
      latePlanMigrationRenewals.map((renewal) => [renewal.subscriptionId, renewal.paidPlanId] as const),
    );
    const subscriptions = await this.prismaService.subscription.findMany({
      where: { id: { in: ids } },
      select: { id: true, planSnapshot: true },
    });
    const planIds = new Set<string>();
    for (const subscription of subscriptions) {
      const pricedPlanId = pricedPlanBySubscription.get(subscription.id);
      if (pricedPlanId !== undefined) {
        planIds.add(pricedPlanId);
        continue;
      }
      const snapshot = subscription.planSnapshot as Record<string, unknown> | null;
      const planId = typeof snapshot?.id === 'string' ? snapshot.id : null;
      if (planId !== null) planIds.add(planId);
    }
    return [...planIds];
  }

  /**
   * «⚠️ Платёж получен, но не применён» for a conversion that was withheld:
   * the money arrived, and the trial it was to convert had been converted by
   * another payment first, so nothing was applied.
   *
   * Its own type, `payment.withheld`, and never `payment.completed`: that one
   * is a receipt to the payer, a completed sale to automation rules and
   * outbound webhooks, and "Payment received" pushed to the payer's open
   * cabinet — all wrong for money that is to go back. `payment.withheld` is operator-only
   * (`OPERATOR_ONLY_EVENT_TYPES`): the audit log and the operator's card. It
   * is the only trace a default install gives them (payment webhook alerts are
   * off by default, and the notification is processed, not failed), so it
   * names both payments, the amount and the gateway, and says what to do and
   * where to record it. Raised after the commit that withheld the payment,
   * once: a replay finds the payment settled and never reaches here, a retry of
   * a run that rolled back never raised it.
   */
  private announceWithheldConversion(input: {
    readonly transaction: Transaction;
    readonly purchasedPlan: Plan;
    readonly selectedDurationDays: number | null;
    readonly subscriptionId: string;
    readonly convertedByPaymentId: string;
  }): void {
    const { transaction } = input;
    const charged = Number(transaction.amount.toString()) > 0;
    const note =
      `Пробную подписку уже перевёл на тариф платёж ${input.convertedByPaymentId}. ` +
      'Этот платёж не применён: подписка и её срок не изменились. ' +
      (charged
        ? `Верните деньги у платёжного провайдера (${transaction.gatewayType}), затем отметьте это в панели: ` +
          `${WITHHELD_REFUND_UI_PATH}.`
        : 'Денег по нему не списано — возвращать нечего.');
    this.events.warn(
      EVENT_TYPES.PAYMENT_WITHHELD,
      'PAYMENT',
      'Платёж получен, но не применён: пробная подписка уже переведена',
      {
        userId: transaction.userId,
        paymentId: transaction.paymentId,
        purchaseType: transaction.purchaseType,
        planName: input.purchasedPlan.name,
        planType: input.purchasedPlan.type,
        durationDays: input.selectedDurationDays ?? undefined,
        amount: transaction.amount.toString(),
        currency: transaction.currency,
        gatewayType: transaction.gatewayType,
        channel: transaction.channel,
        subscriptionId: input.subscriptionId,
        [TRIAL_CONVERTED_BY_KEY]: input.convertedByPaymentId,
        conversionWithheld: true,
        needsManualReview: charged,
        note,
      },
    );
  }

  /**
   * «⚠️ Платёж получен, но не применён» for a renewal or an upgrade paid for a
   * subscription that has no end date — or whose paid periods end in a queued
   * one without an end — and withheld for refund (`lifetime-renewal.util.ts`,
   * the owner's decision of 24.09.2026).
   *
   * The card, type and refund path of a trial's second conversion
   * ({@link announceWithheldConversion}): `payment.withheld`, operator-only,
   * never `payment.completed`, which is a receipt to the payer and a sale to
   * every rule and integration. Raised after the commit that withheld the
   * payment, by the run that wrote the mark, so once per payment. The note
   * names every subscription it was paid for, says nothing changed, and where
   * the refund is recorded.
   */
  private announceLifetimeWithheld(input: {
    readonly transaction: Transaction;
    readonly purchaseType: 'RENEW' | 'UPGRADE';
    /** What it paid for: one line for a single payment, each line of a combined renewal. */
    readonly lines: readonly LifetimeRenewalNotApplied[];
    readonly planName: string | undefined;
    readonly planType?: string;
    readonly durationDays: number | null;
  }): void {
    const { transaction } = input;
    const charged = Number(transaction.amount.toString()) > 0;
    const described = input.lines.map((line) =>
      input.purchaseType === PurchaseType.UPGRADE
        ? describeLifetimeUpgradeNotApplied(line)
        : describeLifetimeRenewalNotApplied(line),
    );
    const note = [
      ...described,
      charged
        ? `Верните деньги у платёжного провайдера (${transaction.gatewayType}), затем отметьте это в панели: ` +
          `${WITHHELD_REFUND_UI_PATH}.`
        : 'Денег по нему не списано — возвращать нечего.',
    ].join(' ');
    const subscriptionIds = [...new Set(input.lines.map((line) => line.subscriptionId))];
    this.logger.warn(
      `${WITHHELD_FOR_LIFETIME_SUBSCRIPTION} transaction=${transaction.id} payment=${transaction.paymentId} ` +
        `purchaseType=${input.purchaseType} subscriptions=${subscriptionIds.join(',')}: not applied — refund it`,
    );
    this.events.warn(EVENT_TYPES.PAYMENT_WITHHELD, 'PAYMENT', LIFETIME_PAYMENT_WITHHELD_MESSAGE, {
      userId: transaction.userId,
      paymentId: transaction.paymentId,
      purchaseType: input.purchaseType,
      ...(input.planName === undefined ? {} : { planName: input.planName }),
      ...(input.planType === undefined ? {} : { planType: input.planType }),
      durationDays: input.durationDays !== null && input.durationDays > 0 ? input.durationDays : undefined,
      amount: transaction.amount.toString(),
      currency: transaction.currency,
      gatewayType: transaction.gatewayType,
      channel: transaction.channel,
      ...(subscriptionIds.length === 1 ? { subscriptionId: subscriptionIds[0] } : { subscriptionIds }),
      conversionWithheld: true,
      [WITHHELD_REASON_KEY]: WITHHELD_FOR_LIFETIME_SUBSCRIPTION,
      // The card's ♾ line, for money that is to go back.
      ...(charged
        ? { [input.purchaseType === PurchaseType.UPGRADE ? LIFETIME_UPGRADE_CARD_KEY : LIFETIME_RENEWAL_CARD_KEY]: true }
        : {}),
      needsManualReview: charged,
      note,
    });
  }

  /**
   * Withholds a payment for refund because its subscription has no end date,
   * in the fulfilment's own transaction (`lifetime-renewal.util.ts`): settled
   * — COMPLETED, `fulfilledAt` — so the notification is processed rather than
   * retried, and marked (`CONVERSION_WITHHELD_AT_KEY`, with `withheldReason`)
   * so no post-payment hook pays out on it, a refund revokes nothing and the
   * lists show «Не применён» with «Отметить возврат». `provenance` is written
   * beside the mark. Returns whether this run wrote the mark: the one run that
   * tells the operator.
   */
  private async withholdForLifetimeSubscriptionInTransaction(
    tx: Prisma.TransactionClient,
    transactionId: string,
    provenance: Record<string, unknown> = {},
  ): Promise<boolean> {
    const held = await tx.transaction.findUnique({ where: { id: transactionId }, select: { gatewayData: true } });
    const first = !isWithheldConversion(held?.gatewayData);
    const withheldAt = new Date();
    if (first) {
      await writeTransactionGatewayData(tx, transactionId, {
        merge: {
          ...provenance,
          [CONVERSION_WITHHELD_AT_KEY]: withheldAt.toISOString(),
          [WITHHELD_REASON_KEY]: WITHHELD_FOR_LIFETIME_SUBSCRIPTION,
        },
      });
    }
    await tx.transaction.update({
      where: { id: transactionId },
      data: { fulfilledAt: withheldAt, status: TransactionStatus.COMPLETED },
    });
    return first;
  }

  /**
   * An autopay charge (2 and up) the provider took after a full refund ended
   * its autopay (`autopayEndedByRefund`): in the moment before the cancel
   * landed, or because the provider did not take the cancel. Applied as usual
   * it renewed the subscription the refund had taken back, and revived it.
   *
   * Withheld instead, as a trial's second conversion is: settled (COMPLETED,
   * `fulfilledAt`), applied to nothing — its lines claimed, so no later run
   * applies them — marked (`CONVERSION_WITHHELD_AT_KEY`, with
   * `withheldReason: AUTOPAY_AFTER_REFUND`) so no hook pays out on it, a
   * refund revokes nothing and the lists show «Не применён», and told to the
   * operator once, as `payment.withheld`, to refund it at the provider and
   * record that with «Отметить возврат». Once per payment: only the run that
   * writes the mark announces it.
   */
  private async withholdAutopayCharge(
    transaction: Transaction,
    items: readonly TransactionItem[],
  ): Promise<{ readonly syncJobs: readonly ProfileSyncJob[] }> {
    const announce = await this.prismaService.$transaction(async (tx) => {
      const held = await tx.transaction.findUnique({
        where: { id: transaction.id },
        select: { gatewayData: true },
      });
      const first = !isWithheldConversion(held?.gatewayData);
      const withheldAt = new Date();
      await tx.transactionItem.updateMany({
        where: { transactionId: transaction.id, appliedAt: null },
        data: { appliedAt: withheldAt },
      });
      if (first) {
        await writeTransactionGatewayData(tx, transaction.id, {
          merge: {
            [CONVERSION_WITHHELD_AT_KEY]: withheldAt.toISOString(),
            [WITHHELD_REASON_KEY]: AUTOPAY_AFTER_REFUND,
          },
        });
      }
      await tx.transaction.updateMany({
        where: { id: transaction.id, fulfilledAt: null },
        data: { fulfilledAt: withheldAt },
      });
      return first;
    });
    if (announce) {
      const marker = readProviderChargeMarker(transaction);
      const charged = Number(transaction.amount.toString()) > 0;
      this.logger.warn(
        `AUTOPAY_AFTER_REFUND transaction=${transaction.id} payment=${transaction.paymentId} ` +
          `providerSubscription=${marker?.providerSubscriptionId ?? '?'}: not applied — refund it`,
      );
      this.events.warn(
        EVENT_TYPES.PAYMENT_WITHHELD,
        'PAYMENT',
        'Платёж получен, но не применён: автосписание закончено возвратом',
        {
          userId: transaction.userId,
          paymentId: transaction.paymentId,
          purchaseType: transaction.purchaseType,
          amount: transaction.amount.toString(),
          currency: transaction.currency,
          gatewayType: transaction.gatewayType,
          subscriptionIds: [...new Set(items.map((item) => item.subscriptionId))],
          providerSubscriptionId: marker?.providerSubscriptionId ?? null,
          chargeNumber: marker?.chargeNumber ?? null,
          conversionWithheld: true,
          [WITHHELD_REASON_KEY]: AUTOPAY_AFTER_REFUND,
          needsManualReview: charged,
          note:
            `Провайдер (${transaction.gatewayType}) провёл списание по автоплатежу, который закончил возврат. ` +
            'Подписку оно не продлило. ' +
            (charged
              ? `Верните деньги у платёжного провайдера (${transaction.gatewayType}), затем отметьте это в панели: ` +
                `${WITHHELD_REFUND_UI_PATH}.`
              : 'Денег по нему не списано — возвращать нечего.'),
        },
      );
    }
    return { syncJobs: [] };
  }

  /**
   * «🔄 Подписка продлена» / «⬆️ Подписка улучшена» — what happened to the
   * subscription, as opposed to what happened to the money.
   *
   * Both types were registered, titled and tick-boxed and never raised. A NEW
   * purchase is deliberately not announced here: `subscription.created` is
   * raised by the provisioning step, once the panel profile exists, which is
   * the moment that subscription starts being real.
   *
   * Best-effort: the money is captured and the subscription is written. A card
   * that cannot be raised must not undo either.
   */
  private announceSubscriptionLifecycle(
    purchaseType: PurchaseType,
    input: {
      readonly subscription: Subscription;
      readonly paymentId: string;
      readonly planName: string;
      readonly durationDays: number | null;
      /**
       * An upgrade's conversion of what was left of the old plan. On the card
       * as «Остаток прежнего тарифа: +N дн.» when it added days, and in the
       * metadata — the audit row — whenever a paid chunk was weighed, with
       * what each source payment contributed.
       */
      readonly paidRemainder?: PaidRemainderConversion;
      /**
       * A renewal priced for the plan an upgrade left: on the card as what it
       * was priced for and the days it bought on the plan it renewed.
       */
      readonly renewalPricedBeforeUpgrade?: RenewalPricedBeforeUpgrade | null;
    },
  ): void {
    const type =
      purchaseType === PurchaseType.RENEW
        ? EVENT_TYPES.SUBSCRIPTION_RENEWED
        : purchaseType === PurchaseType.UPGRADE
          ? EVENT_TYPES.SUBSCRIPTION_UPGRADED
          : null;
    if (type === null) return;
    try {
      this.events.info(
        type,
        'SUBSCRIPTION',
        purchaseType === PurchaseType.RENEW ? 'Подписка продлена' : 'Подписка улучшена',
        {
          subscriptionId: input.subscription.id,
          userId: input.subscription.userId,
          planName: input.planName,
          status: input.subscription.status,
          paymentId: input.paymentId,
          ...(input.durationDays === null ? {} : { durationDays: input.durationDays }),
          ...(input.paidRemainder === undefined || input.paidRemainder.sources.length === 0
            ? {}
            : {
                paidRemainderDays: input.paidRemainder.days,
                paidRemainderSources: input.paidRemainder.sources.map((source) => ({ ...source })),
              }),
          ...(input.renewalPricedBeforeUpgrade === undefined || input.renewalPricedBeforeUpgrade === null
            ? {}
            : renewalPricedBeforeUpgradeMetadata(input.renewalPricedBeforeUpgrade)),
          ...(input.subscription.expiresAt === null
            ? {}
            : { expireAt: input.subscription.expiresAt.toISOString() }),
          ...(input.subscription.remnawaveId === null
            ? {}
            : { remnawaveId: input.subscription.remnawaveId }),
        },
      );
    } catch (error: unknown) {
      this.logger.warn(
        `Subscription lifecycle card was not raised for ${input.subscription.id}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Spends the one-time purchase discount now that a plan purchase completed.
   *
   * TWO PLACES hold one, and both have to be settled or the customer keeps it:
   *
   *  - `user.purchaseDiscount`, the original bare percentage. Donor imports and
   *    an older half of the system still write it, so it is still reset.
   *  - a `UserPendingDiscount` GRANT, which carries the restrictions the
   *    promocode attached — which plans it may be spent on, and until when.
   *    Only the grant the catalog actually quoted is marked spent: a customer
   *    holding a general 10% and a six-month-only 20% who buys one month must
   *    keep the 20%, because it was never applied.
   *
   * The choice is made by the SAME function the catalog priced with. Two
   * different rules would mean a price on screen that differs from the amount
   * charged — and here the difference would be permanent, because the wrong
   * grant would be burned.
   *
   * The PERSONAL discount is permanent and never touched here.
   */
  private async consumePurchaseDiscount(
    userId: string,
    planId: string | null,
    /**
     * Plans of every line of a COMBINED renewal. Each line was priced with its
     * own plan, so a grant restricted to one of them WAS applied — asking with
     * a single `null` plan said it was not, and the grant was never marked
     * spent. The customer could take the same one-time discount off every
     * combined renewal, indefinitely.
     */
    combinedItems: readonly { readonly subscriptionId: string | null }[] = [],
    /** See {@link resolveCombinedRenewalPlanIds}. */
    latePlanMigrationRenewals: ReadonlyArray<Pick<LatePlanMigrationRenewal, 'subscriptionId' | 'paidPlanId'>> = [],
  ): Promise<void> {
    // Best-effort: this runs AFTER the subscription has been committed. It must
    // never throw out of `applyCompletedTransaction`, otherwise the reconciler's
    // fulfilment claim would be released and the (already-provisioned) payment
    // re-provisioned on retry. A missed discount reset is harmless vs a double.
    try {
      const grants = await this.prismaService.userPendingDiscount.findMany({
        where: { userId, consumedAt: null },
        select: {
          id: true,
          percent: true,
          allowedPlanIds: true,
          expiresAt: true,
          consumedAt: true,
        },
      });
      // ── THE SAME INPUTS THE PRICE WAS BUILT FROM ──────────────────────
      //
      // `legacyPercent: 0` used to be passed here while both pricing paths
      // passed the real column. Same function, different inputs — which is the
      // same defect as two different functions, only harder to see. With a
      // legacy column larger than every grant, the customer was CHARGED at the
      // column and a grant that had never reduced anything was burned.
      const user = await this.prismaService.user.findUnique({
        where: { id: userId },
        select: { purchaseDiscount: true },
      });
      const now = new Date();
      // Resolved INSIDE the guard. Called as an argument it ran before the
      // try block, so a failure here could throw out of
      // `applyCompletedTransaction` — which releases the fulfilment claim and
      // re-provisions an already-provisioned payment on retry. A missed
      // discount settlement is harmless next to that.
      const candidatePlans =
        planId === null
          ? await this.resolveCombinedRenewalPlanIds(combinedItems, latePlanMigrationRenewals)
          : [planId];
      // A combined renewal prices each line separately, so the grant to settle
      // is the best one that applied to ANY of them.
      let chosen = pickBestDiscount({
        grants,
        planId: null,
        legacyPercent: user?.purchaseDiscount ?? 0,
        now,
      });
      for (const candidate of candidatePlans) {
        const forPlan = pickBestDiscount({
          grants,
          planId: candidate,
          legacyPercent: user?.purchaseDiscount ?? 0,
          now,
        });
        if (forPlan.percent > chosen.percent || (chosen.grantId === null && forPlan.grantId !== null)) {
          chosen = forPlan;
        }
      }
      if (chosen.grantId !== null) {
        await this.prismaService.userPendingDiscount.updateMany({
          where: { id: chosen.grantId, consumedAt: null },
          data: { consumedAt: new Date() },
        });
      }
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
    /**
     * The one snapshot `applyCompletedTransaction` read — for every line alike.
     * Read here, still before the transaction, only by a direct caller.
     */
    passedFlags?: AddOnRolloutFlags,
  ): Promise<{
    readonly syncJobs: readonly ProfileSyncJob[];
    /** Lines kept on their subscription's current plan; see the completion below. */
    readonly latePlanMigrationRenewals: readonly LatePlanMigrationRenewal[];
    /** Lines priced for the plan an upgrade left; see `readRenewalPricedBeforeUpgrade`. */
    readonly renewalsPricedBeforeUpgrade: readonly RenewalPricedBeforeUpgrade[];
    /** Every line this run claimed met a subscription with no end date: nothing was bought. */
    readonly lifetimeOnly: boolean;
  }> {
    const pending = items.filter((item) => item.appliedAt === null);
    if (pending.length === 0) {
      return { syncJobs: [], latePlanMigrationRenewals: [], renewalsPricedBeforeUpgrade: [], lifetimeOnly: false };
    }
    const flags = passedFlags ?? (await readAddOnRolloutFlags(this.addOnSwitches));

    const committed = await this.prismaService.$transaction(async (transactionClient) => {
      // Operator cards this fulfillment wants to raise, held until it COMMITS:
      // the lines a plan migration keeps on the current plan are announced
      // once, on the completion, and only for a commit. Declared INSIDE the
      // callback so a re-driven attempt starts from empty buffers and cannot
      // inherit the lines of an attempt that was rolled back. The same for the
      // lines priced for the plan an upgrade has since left.
      const latePlanMigrationRenewals: LatePlanMigrationRenewal[] = [];
      const renewalsPricedBeforeUpgrade: RenewalPricedBeforeUpgrade[] = [];
      // And for the lines that met a subscription with no end date, which
      // change nothing and are to be refunded.
      const lifetimeRenewals: LifetimeRenewalNotApplied[] = [];
      // What the operator's card calls this renewal. Collected from the plan
      // each line actually renewed on, not from the line's stored snapshot: an
      // autopay charge deliberately carries no snapshot so that it renews on
      // the plan as it is today, and a legacy draft has none either. Both fall
      // through to the live row, and both still have a name.
      const paidPlanNames: string[] = [];
      // One «Подписка продлена» per line, held for the commit like everything
      // else here: a combined payment renews several subscriptions at once and
      // each of them is its own lifecycle fact.
      const renewedLines: Array<{
        readonly subscription: Subscription;
        readonly planName: string;
        readonly durationDays: number | null;
        readonly renewalPricedBeforeUpgrade: RenewalPricedBeforeUpgrade | null;
      }> = [];
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
        return {
          jobs: [] as ProfileSyncJob[],
          latePlanMigrationRenewals,
          renewalsPricedBeforeUpgrade,
          lifetimeRenewals,
          withheld: null,
          paidPlanNames,
          renewedLines,
        };
      }
      const jobs: ProfileSyncJob[] = [];
      const now = new Date();
      for (const item of claimedItems) {
        // Add-on lines were sold with a renewal under stage 5, deleted with its
        // code: see RENEWAL_ADDON_LINES_NOT_SUPPORTED. Refused before anything is
        // written, so the whole fulfilment rolls back and every line of the
        // payment stays unapplied until an operator has dealt with it.
        if (carriesAddOnLines(item.addOnLines)) {
          this.logger.warn(
            `${RENEWAL_ADDON_LINES_NOT_SUPPORTED} transaction=${transaction.id} payment=${transaction.paymentId} ` +
              `item=${item.id} subscription=${item.subscriptionId}: the line carries add-ons sold with a renewal, ` +
              'which this version no longer delivers — refund their part by hand',
          );
          throw new ConflictException(RENEWAL_ADDON_LINES_NOT_SUPPORTED);
        }
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
        paidPlanNames.push(displayPlanName(plan));
        const currentSubscription = await this.lockRenewalSubscriptionInTransaction(
          transactionClient,
          item.subscriptionId,
        );
        assertRenewalFulfillmentPolicy(
          currentSubscription,
          readPersistedPlanAvailability(item.planSnapshot),
        );
        // A subscription with no end date is not renewed, and this line
        // changes nothing about it — the same rule, and for the same reasons,
        // as the single renewal (`renewSubscriptionFromPayment`), and the same
        // for one whose paid periods end in a queued period without an end.
        // The line stays claimed (`appliedAt` above), so no later run applies
        // it; its add-on lines, if any, are part of what is refunded. Every
        // line such: the payment is withheld, below.
        const openEndedTerm = isLifetimeSubscription(currentSubscription)
          ? null
          : await findOpenEndedQueuedTerm(transactionClient, currentSubscription);
        if (isLifetimeSubscription(currentSubscription) || openEndedTerm !== null) {
          if (transaction.gatewayType === PaymentGatewayType.PARTNER_BALANCE) {
            throw subscriptionIsLifetime();
          }
          lifetimeRenewals.push({
            subscriptionId: currentSubscription.id,
            paidPlanName: displayPlanName(plan),
            paidDays: item.durationDays,
            amount: item.amount.toString(),
            currency: item.currency,
            ...(openEndedTerm === null ? {} : { openEndedTerm }),
          });
          continue;
        }
        // Moved by a plan migration after the checkout priced it? Then
        // the line keeps its subscription on the plan it is on now: the term,
        // snapshot and limit decisions below all branch on this. Asked here,
        // under the row lock just taken — see `findLatePlanMigrationRenewal`.
        // `plan.id` is `item.planId`: the parsed snapshot is verified against
        // it and the live row is looked up by it.
        //
        // Priced for the plan an UPGRADE has since left? Then the line stays on
        // the plan the subscription is on, for the days its money buys there
        // (`readRenewalPricedBeforeUpgrade`), and the migration question does
        // not arise: the upgrade came after this payment's draft. Any other
        // move since the draft — «Назначить план», a bulk assignment — is asked
        // last, by plan identity, once the migration guard has said no.
        const planChange = await this.resolveRenewalPricedBeforePlanChangeInTransaction(
          transactionClient,
          {
            subscription: currentSubscription,
            paidPlan: plan,
            draftedAt: transaction.createdAt,
            amount: item.amount,
            currency: item.currency,
            paidDays: item.durationDays,
            gatewayData: transaction.gatewayData,
            paymentAmount: transaction.amount,
          },
          () =>
            findLatePlanMigrationRenewal(transactionClient, {
              subscription: currentSubscription,
              paidPlan: plan,
              transactionId: transaction.id,
            }),
        );
        const latePlanMigrationRenewal = planChange.latePlanMigrationRenewal;
        if (latePlanMigrationRenewal !== null) {
          latePlanMigrationRenewals.push(latePlanMigrationRenewal);
        }
        const pricedBeforeUpgrade = planChange.priced;
        if (pricedBeforeUpgrade !== null) {
          renewalsPricedBeforeUpgrade.push(pricedBeforeUpgrade.line);
        }
        const renewedDays = pricedBeforeUpgrade?.line.conversion.days ?? item.durationDays;

        // ── DECIDED BY THE TERM ROW ───────────────────────────────────────
        //
        // Appending the renewal's term follows the ROW: a subscription with an
        // ACTIVE term gets one whatever the flags say now, and one without
        // stays on the columns (`scheduleRenewalTermInTransaction`, which
        // first brings it into the model while stage 1 is on). Gated by the
        // flag instead, a rollback left the renewal on the columns while the
        // old term's base stayed in force for the next recompute.
        const correlationId = `payment:${transaction.paymentId}`;
        const term =
          pricedBeforeUpgrade === null
            ? await this.scheduleFulfilledRenewalTermInTransaction(transactionClient, {
                subscriptionId: currentSubscription.id,
                paidPlan: plan,
                durationDays: item.durationDays,
                latePlanMigrationRenewal,
                correlationId,
                flags,
              })
            : pricedBeforeUpgrade.currentPlan !== null && renewedDays > 0
              ? await this.scheduleRenewalTermInTransaction(transactionClient, {
                  subscriptionId: currentSubscription.id,
                  plan: pricedBeforeUpgrade.currentPlan,
                  durationDays: renewedDays,
                  correlationId,
                  flags,
                })
              : null;

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
        //
        // ── NONE OF IT FOR A LINE WHOSE SUBSCRIPTION A MIGRATION MOVED ──────
        //
        // Decision 10: that line buys its period on the plan the subscription
        // is on NOW. So the paid plan's snapshot, limits and squads are not
        // applied at all — `null` here — and the columns stay exactly as the
        // move left them. The snapshot below records only the paid duration,
        // where a normal renewal records it (`withPaidRenewalDuration`).
        // Everything else a renewal does is unchanged: status, expiry, the
        // sync job with its traffic reset, the `appliedAt` claim and the
        // payment's `fulfilledAt`.
        //
        // Nor for a line priced for the plan an upgrade left: the subscription
        // keeps the plan it paid the upgrade for, and its snapshot is not
        // touched at all — the upgrade's duration stays the one autopay renews.
        const inheritedLimitRefresh =
          latePlanMigrationRenewal !== null || pricedBeforeUpgrade !== null
            ? null
            : resolveInheritedPlanLimitRefresh({
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
          pricedBeforeUpgrade !== null
            ? undefined
            : inheritedLimitRefresh === null
              ? term === null
                ? withPaidRenewalDuration(lockedSubscription.planSnapshot, item.durationDays)
                : undefined
              : term === null
                ? buildItemPlanSnapshot({ item, plan, gatewayType: transaction.gatewayType })
                : patchSnapshotInheritedLimits(
                    lockedSubscription.planSnapshot,
                    inheritedLimitRefresh.snapshot,
                  );
        // A line priced before a plan change whose money buys no day on the
        // plan it is on (no price in its currency, or less than a day's worth)
        // renews NOTHING: its status and expiry stay exactly as they are. Set
        // ACTIVE anyway, it revived an expired subscription until now and
        // lifted a LIMITED one with no traffic reset. The operator is asked to
        // refund it (the completion's note and card line).
        const boughtNothing = pricedBeforeUpgrade !== null && renewedDays === 0;
        const renewedSubscription = await transactionClient.subscription.update({
          where: { id: currentSubscription.id },
          data: {
            ...(boughtNothing
              ? {}
              : { status: SubscriptionStatus.ACTIVE, expiresAt: calculateExpiry(renewalBase, renewedDays) }),
            ...(planSnapshotWrite === undefined
              ? {}
              : { planSnapshot: planSnapshotWrite as Prisma.InputJsonValue }),
            ...(inheritedLimitRefresh === null ? {} : inheritedLimitRefresh.columns),
          },
        });
        // «Подписка продлена» only for a line that renewed something.
        if (!boughtNothing) {
          renewedLines.push({
            subscription: renewedSubscription,
            planName:
              pricedBeforeUpgrade === null
                ? displayPlanName(plan)
                : (pricedBeforeUpgrade.line.currentPlanName ?? pricedBeforeUpgrade.line.currentPlanId),
            durationDays: renewedDays,
            renewalPricedBeforeUpgrade: pricedBeforeUpgrade?.line ?? null,
          });
        }
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
              // renewing the same three one by one. A line that bought no day
              // (priced before an upgrade, in a currency the plan has no price
              // in) starts no period.
              ...(renewedSubscription.remnawaveId === null || boughtNothing ? {} : { resetTraffic: true }),
            } as Prisma.InputJsonObject,
          },
        });
        await transactionClient.transactionItem.updateMany({
          where: { id: item.id, appliedAt: null },
          data: { appliedAt: now },
        });
        jobs.push(syncJob);
      }
      // What the lines priced before an upgrade bought instead, on the payment's
      // own row and in this transaction: the provenance a refund or an
      // operator's question reads.
      if (renewalsPricedBeforeUpgrade.length > 0) {
        await writeTransactionGatewayData(transactionClient, transaction.id, {
          merge: {
            [RENEWAL_PRICED_BEFORE_UPGRADE_KEY]: renewalPricedBeforeUpgradeProvenance(renewalsPricedBeforeUpgrade, now),
          },
        });
      }
      // And which lines met a subscription with no end date and were not
      // applied. When every line did, nothing was bought: the payment is
      // withheld for refund, as a single renewal of one is. When some lines
      // renewed, the payment stands and only the lifetime lines' part goes
      // back, which the completion below says.
      const lifetimeProvenance = {
        [LIFETIME_RENEWAL_NOT_APPLIED_KEY]: lifetimeRenewalNotAppliedProvenance(lifetimeRenewals, now),
      };
      let withheld: { readonly announce: boolean } | null = null;
      if (lifetimeRenewals.length === claimedItems.length) {
        withheld = {
          announce: await this.withholdForLifetimeSubscriptionInTransaction(
            transactionClient,
            transaction.id,
            lifetimeProvenance,
          ),
        };
      } else if (lifetimeRenewals.length > 0) {
        await writeTransactionGatewayData(transactionClient, transaction.id, { merge: lifetimeProvenance });
      }
      // Stamp the transaction-level idempotency flag atomically
      // applications so the webhook reconciler treats the combined renewal as
      // fulfilled (its per-item `appliedAt` still guards partial re-runs).
      await transactionClient.transaction.update({
        where: { id: transaction.id },
        data: { fulfilledAt: now },
      });
      return {
        jobs,
        latePlanMigrationRenewals,
        renewalsPricedBeforeUpgrade,
        lifetimeRenewals,
        withheld,
        paidPlanNames,
        renewedLines,
      };
    });

    const completedMetadata = {
      userId: transaction.userId,
      paymentId: transaction.paymentId,
      purchaseType: transaction.purchaseType,
      itemCount: pending.length,
      // WHICH PLAN WAS RENEWED. Without this the card for a combined renewal
      // said «Тип покупки: Продление» and «Позиций: 1» and nothing else — an
      // operator could not tell WHAT the customer had just renewed, which is
      // the first thing they are asked. The names come off the plans the
      // fulfilment above actually renewed on, so no extra read and no guess.
      ...planNameMetadata(committed.paidPlanNames),
      amount: transaction.amount.toString(),
      currency: transaction.currency,
      gatewayType: transaction.gatewayType,
    };
    const lifetime = committed.lifetimeRenewals;
    // Every line met a subscription with no end date: withheld, and told as
    // such — never as a completed sale, and nothing renewed to announce.
    if (committed.withheld !== null) {
      if (committed.withheld.announce) {
        this.announceLifetimeWithheld({
          transaction,
          purchaseType: PurchaseType.RENEW,
          lines: lifetime,
          planName: planNameMetadata(committed.paidPlanNames).planName,
          durationDays: null,
        });
      }
      return { syncJobs: [], latePlanMigrationRenewals: [], renewalsPricedBeforeUpgrade: [], lifetimeOnly: true };
    }
    if (
      committed.latePlanMigrationRenewals.length === 0 &&
      committed.renewalsPricedBeforeUpgrade.length === 0 &&
      lifetime.length === 0
    ) {
      this.events.info(
        EVENT_TYPES.PAYMENT_COMPLETED,
        'PAYMENT',
        `Payment completed: RENEW x${pending.length}`,
        completedMetadata,
      );
    } else if (committed.renewalsPricedBeforeUpgrade.length === 0 && lifetime.length === 0) {
      // ONE announcement for the payment, however many of its lines a plan
      // migration kept on their current plan: the completion itself, raised as
      // WARNING, exactly as the single renewal does. The list is metadata for
      // machines; the note names each subscription, because this card has no
      // subscription block of its own.
      this.events.warn(EVENT_TYPES.PAYMENT_COMPLETED, 'PAYMENT', LATE_PLAN_MIGRATION_RENEWAL_MESSAGE, {
        ...completedMetadata,
        code: LATE_PLAN_MIGRATION_RENEWAL_CODE,
        planMigrationRenewals: committed.latePlanMigrationRenewals.map((renewal) => ({ ...renewal })),
        note: describeLatePlanMigrationRenewals(committed.latePlanMigrationRenewals),
      });
    } else {
      // Lines priced for the plan an upgrade left are told the same way, on
      // the same one completion; a payment with both kinds names both. So are
      // the lines that met a subscription with no end date while others
      // renewed: the note names each one and asks for its part back.
      const migrated = committed.latePlanMigrationRenewals;
      const priced = committed.renewalsPricedBeforeUpgrade;
      this.events.warn(
        EVENT_TYPES.PAYMENT_COMPLETED,
        'PAYMENT',
        migrated.length > 0
          ? LATE_PLAN_MIGRATION_RENEWAL_MESSAGE
          : priced.length > 0
            ? renewalPricedBeforeUpgradeMessage(priced)
            : LIFETIME_RENEWAL_NOT_APPLIED_MESSAGE,
        {
          ...completedMetadata,
          code:
            migrated.length > 0
              ? LATE_PLAN_MIGRATION_RENEWAL_CODE
              : priced.length > 0
                ? renewalPricedBeforeUpgradeCode(priced)
                : LIFETIME_RENEWAL_NOT_APPLIED_CODE,
          ...(migrated.length > 0 ? { planMigrationRenewals: migrated.map((renewal) => ({ ...renewal })) } : {}),
          ...(priced.length > 0
            ? {
                renewalsPricedBeforeUpgrade: priced.map((line) => ({
                  subscriptionId: line.subscriptionId,
                  paidPlanId: line.paidPlanId,
                  currentPlanId: line.currentPlanId,
                  ...line.conversion,
                  ...(line.cause === 'PLAN_CHANGE' ? { cause: line.cause } : {}),
                })),
              }
            : {}),
          ...(lifetime.length > 0
            ? {
                lifetimeRenewalsNotApplied: lifetime.map((line) => ({ ...line })),
                [LIFETIME_RENEWAL_CARD_KEY]: true,
              }
            : {}),
          note: [
            ...(migrated.length > 0 ? [describeLatePlanMigrationRenewals(migrated)] : []),
            ...priced.map(describeRenewalPricedBeforeUpgrade),
            ...lifetime.map((line) => `${describeLifetimeRenewalNotApplied(line)} ${describeLifetimeLineRefund(line)}`),
          ].join(' '),
        },
      );
    }

    // What happened to each SUBSCRIPTION the payment renewed — one card per
    // line, after the commit, for the same reason everything else here waits:
    // a rolled-back attempt must announce nothing.
    for (const line of committed.renewedLines) {
      this.announceSubscriptionLifecycle(PurchaseType.RENEW, {
        subscription: line.subscription,
        paymentId: transaction.paymentId,
        planName: line.planName,
        durationDays: line.durationDays,
        renewalPricedBeforeUpgrade: line.renewalPricedBeforeUpgrade,
      });
    }

    return {
      syncJobs: committed.jobs,
      latePlanMigrationRenewals: committed.latePlanMigrationRenewals,
      renewalsPricedBeforeUpgrade: committed.renewalsPricedBeforeUpgrade,
      lifetimeOnly: false,
    };
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
    /**
     * The one snapshot of the stage switches `applyCompletedTransaction` read
     * before any transaction opened: the ledger's entry into the model and the
     * Remnawave zone come from it. What a «до сброса» add-on delivers does not:
     * that is the quote on the marker (`add-on-quote.ts`). Read here, still
     * before the transaction, only by a direct caller.
     */
    passedFlags?: AddOnRolloutFlags,
  ): Promise<{ readonly subscription: Subscription; readonly syncJob: ProfileSyncJob }> {
    const marker = readAddOnMarker(transaction);
    if (marker === null) {
      throw new NotFoundException('Add-on marker not found on transaction');
    }
    const flags = passedFlags ?? (await readAddOnRolloutFlags(this.addOnSwitches));

    // Set inside the transaction, acted on after it commits. A local flag
    // rather than a second return shape: this method's contract is read by the
    // whole capture path, and widening it to carry an outcome that has no
    // subscription-limit change would make every caller handle a case that
    // does not concern them.
    let resetTarget: { readonly subscriptionId: string; readonly addOnId: string } | null = null;
    // Also set inside, told after the commit: a reset-scoped add-on the
    // capture could not deliver as quoted (see `AddOnQuoteNote`).
    let quoteNote: AddOnQuoteNote | null = null;

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
      // When direct purchase (stage 2) is on and the target has an active
      // term, record the purchase as an immutable entitlement, recompute the
      // effective projection and mirror it into the limit columns, which the
      // ordinary profile sync pushes. Falls back to the legacy increment when
      // the entitlement cannot be fully materialized here.
      //
      // LIMITED as well as ACTIVE. The offer and the checkout both sell
      // to a LIMITED subscription — "out of traffic, buy +50 GB" is the
      // typical purchase — so refusing it here sent exactly that sale to the
      // PERMANENT legacy increment, with no entitlement row and no expiry.
      //
      // A marker drafted by the previous checkout carries no `lifetime` or
      // `sourceLineKey`; `withLedgerMarkerDefaults` gives it the v2 checkout's
      // own values (`UNTIL_SUBSCRIPTION_END`, the add-on id), so a draft in
      // flight across the deploy is ledgered too instead of becoming permanent.
      //
      // A «до сброса» QUOTE IS NEVER THE PERMANENT INCREMENT. It was sold
      // while stage 2 was on (nothing else can quote it), so it goes to the
      // ledger even when the switch went off before the money came in, and
      // when the ledger cannot deliver it the payment is recorded as not
      // applied and the operator is told — the legacy branch below raises a
      // column that nothing would ever take back.
      const ledgerMarker = withLedgerMarkerDefaults(marker);
      const resetQuoted = ledgerMarker.lifetime === AddOnLifetime.UNTIL_NEXT_RESET;
      const live =
        subscription.status === SubscriptionStatus.ACTIVE || subscription.status === SubscriptionStatus.LIMITED;
      if (live && (flags.directPurchase || resetQuoted)) {
        const ledgered = await this.applyAddOnViaLedger(tx, transaction, ledgerMarker, subscription, flags);
        if (ledgered !== null) {
          quoteNote = ledgered.quoteNote;
          return { subscription: ledgered.subscription, syncJob: ledgered.syncJob };
        }
      }
      if (resetQuoted) {
        quoteNote = { kind: 'NOT_APPLIED', reason: 'SUBSCRIPTION_NOT_ACTIVE' };
        return this.recordAddOnLedgerNoOp(tx, transaction, subscription, 'RESET_QUOTE_NOT_APPLIED');
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

    // `userId` is written at each emit call below, not here: pop-ups and
    // automations resolve the customer from it, and
    // `test/popup-capable-events.spec.ts` reads it at the call.
    const completedMetadata = {
      paymentId: transaction.paymentId,
      purchaseType: transaction.purchaseType,
      addOnType: marker.addOnType,
      addOnValue: marker.addOnValue,
      amount: transaction.amount.toString(),
      currency: transaction.currency,
      gatewayType: transaction.gatewayType,
      subscriptionId: result.subscription.id,
      // The plan the add-on was bought ONTO. An add-on is «+50 ГБ» to nobody
      // until the card says to what.
      ...planNamesMetadata([result.subscription.planSnapshot]),
    };
    // Captured by the same run that recorded it, after the commit: once per
    // payment, since a replay finds it fulfilled and never gets this far. ONE
    // `payment.completed` either way — INFO, or WARNING with the operator's
    // note when the quote could not be delivered as sold. Automations and
    // pop-ups match on the type and the customer, not on the severity, so
    // both fire them exactly once.
    const settledNote = quoteNote as AddOnQuoteNote | null;
    if (settledNote === null) {
      this.events.info(EVENT_TYPES.PAYMENT_COMPLETED, 'PAYMENT', 'Payment completed: ADD_ON', {
        userId: transaction.userId,
        ...completedMetadata,
      });
    } else {
      const card = describeAddOnQuoteNote(settledNote, {
        name: marker.name ?? marker.addOnId,
        gatewayType: transaction.gatewayType,
        charged: Number(transaction.amount.toString()) > 0,
      });
      this.logger.warn(
        `Add-on payment ${transaction.paymentId} for subscription ${result.subscription.id}: ${card.message} — ${card.note}`,
      );
      this.events.warn(EVENT_TYPES.PAYMENT_COMPLETED, 'PAYMENT', card.message, {
        userId: transaction.userId,
        ...completedMetadata,
        note: card.note,
        needsManualReview: card.needsManualReview,
      });
    }

    return result;
  }

  /**
   * Ledger fulfillment for a captured add-on. Returns `null` when a «до конца
   * подписки» entitlement cannot be fully materialized here (no active term,
   * no usable term window) so the caller falls back to the legacy increment.
   * A «до сброса» one is never handed back that way: it is delivered as quoted,
   * or with the subscription's end when no reset window can be bound, or
   * recorded as not applied — each with the `quoteNote` the caller turns into
   * the operator's card.
   */
  private async applyAddOnViaLedger(
    tx: Prisma.TransactionClient,
    transaction: Transaction,
    marker: AddOnMarker,
    unlockedSubscription: Subscription,
    /** The one snapshot of the switches this fulfilment read before its transaction. */
    flags: AddOnRolloutFlags,
  ): Promise<{
    readonly subscription: Subscription;
    readonly syncJob: ProfileSyncJob;
    readonly quoteNote: AddOnQuoteNote | null;
  } | null> {
    if (marker.lifetime === undefined || marker.sourceLineKey === undefined) return null;
    const resetQuoted = marker.lifetime === AddOnLifetime.UNTIL_NEXT_RESET;
    const notApplied = async (reason: AddOnNotAppliedReason, subscription: Subscription) => ({
      ...(await this.recordAddOnLedgerNoOp(tx, transaction, subscription, 'RESET_QUOTE_NOT_APPLIED')),
      quoteNote: { kind: 'NOT_APPLIED', reason } as const,
    });
    // An incoherent value cannot be turned into a ledger row at all — the
    // `BigInt(marker.addOnValue)` below throws a raw `RangeError` on a
    // fractional one and mints a NEGATIVE `totalValue` on a negative one, which
    // `addTrafficLimit`/`addDeviceLimit` then reject deep inside the projection
    // recompute. Falling back to the legacy path instead keeps the outcome to
    // ONE shape: the guard there records fulfillment and touches no column.
    if (!isCoherentAddOnValue(marker.addOnValue)) {
      return resetQuoted ? notApplied('INCOHERENT_VALUE', unlockedSubscription) : null;
    }

    // ── INTO THE MODEL, AND ONTO THE SUBSCRIPTION'S REAL END ───────────────
    //
    // A subscription the background cutover has not reached yet enters the
    // model here (stage 1), so the purchase is ledgered instead of becoming a
    // permanent increment. Then its tail term is ALIGNED with `expiresAt`:
    // bonus days, an operator's edit or a pull from Remnawave move the
    // expiry without the term, and an ACTIVE term whose `endsAt` had already
    // passed sent the purchase to the legacy increment below — permanently.
    // Both take the row lock, so everything read after this is current.
    await this.enterTermModelInTransaction(tx, unlockedSubscription.id, flags);
    await this.subscriptionTermService.alignTailToExpiryInTransaction(tx, unlockedSubscription.id, {
      correlationId: `payment:${transaction.paymentId}`,
    });
    const subscription =
      (await tx.subscription.findUnique({ where: { id: unlockedSubscription.id } })) ?? unlockedSubscription;

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
    if (term === null) return resetQuoted ? notApplied('NO_ACTIVE_TERM', subscription) : null;

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
    // A direct purchase activates IMMEDIATELY (`scheduledActivationAt` is the
    // transaction's creation instant and the ACTIVATE transition happens a few
    // lines below), so the answer here is the verdict, not a prediction about a
    // future term start. That is why this path keeps the recorded no-op —
    // fulfillment IS stamped, no ledger row is created, and the whole
    // transaction is the add-on, so the transaction row itself remains the
    // durable record a refund is made against.
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
      return { ...(await this.recordAddOnLedgerNoOp(tx, transaction, subscription)), quoteNote: null };
    }

    const now = new Date();
    let expiresAt: Date;
    let expiryEpochId: string | null = null;
    let quoteNote: AddOnQuoteNote | null = null;
    if (marker.lifetime === AddOnLifetime.UNTIL_SUBSCRIPTION_END) {
      if (term.endsAt === null || term.endsAt.getTime() <= now.getTime()) {
        return null; // no usable term window → fall back to legacy
      }
      expiresAt = term.endsAt;
    } else {
      // UNTIL_NEXT_RESET — traffic only (`withLedgerMarkerDefaults` sells a
      // device «до конца подписки», whatever its marker says).
      //
      // THE CAPTURE BINDS TO THE QUOTE (`add-on-quote.ts`), whatever the
      // switches, the zone or the term say now: the reset window the checkout
      // quoted is recorded as this term's epoch, and the entitlement ends when
      // the quote said — never after the subscription's end, which a later
      // shortening may have brought forward (P5). Only a draft made before
      // quotes were written has none; its window is computed now, as if stage
      // 4 were on — it was, when that draft was made.
      //
      // When no window can be bound at all (a rolling term without its anchor,
      // a zone the runtime does not know), it ends with the subscription and
      // the operator is told; with no end either, it is not applied — never the
      // permanent increment.
      const binding = await this.bindResetQuoteInTransaction(tx, {
        termId: term.id,
        strategy: term.trafficResetStrategy as ResetStrategy,
        anchorAt: term.resetAnchorAt,
        subscriptionEndsAt: subscription.expiresAt,
        quote: marker.quote,
        timeZone: flags.remnawaveTimeZone,
        now,
      });
      if (binding.kind === 'NOT_APPLIED') return notApplied(binding.reason, subscription);
      expiresAt = binding.expiresAt;
      expiryEpochId = binding.epochId;
      if (binding.epochId === null) quoteNote = { kind: 'BOUND_WITHOUT_RESET' };
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

    // Mirror the desired effective limits into the limit columns: they are what
    // the profile sync pushes to Remnawave.
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

    return { subscription: updatedSubscription, syncJob, quoteNote };
  }

  /**
   * Where a paid «до сброса» add-on ends — the quote's window and end, capped
   * by the subscription's end — or why it cannot be delivered at all.
   * See the note at its one call site in {@link applyAddOnViaLedger}.
   */
  private async bindResetQuoteInTransaction(
    tx: Prisma.TransactionClient,
    input: {
      readonly termId: string;
      readonly strategy: ResetStrategy;
      readonly anchorAt: Date | null;
      readonly subscriptionEndsAt: Date | null;
      readonly quote: AddOnQuote | undefined;
      readonly timeZone: string | undefined;
      readonly now: Date;
    },
  ): Promise<
    | { readonly kind: 'BOUND'; readonly expiresAt: Date; readonly epochId: string | null }
    | { readonly kind: 'NOT_APPLIED'; readonly reason: AddOnNotAppliedReason }
  > {
    let window: { readonly startsAt: Date; readonly plannedEndsAt: Date } | null = null;
    if (input.quote !== undefined && input.quote.resetAt !== null && input.quote.cycleStartsAt !== null) {
      window = { startsAt: input.quote.cycleStartsAt, plannedEndsAt: input.quote.resetAt };
    } else if (input.quote === undefined && input.anchorAt !== null) {
      try {
        const plan = planResetEpoch({
          strategy: input.strategy,
          capability: 'ENABLED',
          anchorAt: input.anchorAt,
          referenceAt: input.now,
          timeZone: input.timeZone,
        });
        window = plan === null ? null : { startsAt: plan.startsAt, plannedEndsAt: plan.plannedEndsAt };
      } catch {
        window = null; // an anchor or a zone the policy refuses: no window
      }
    }
    const epoch = window === null ? null : await bindResetEpochWindow(tx, { termId: input.termId, ...window });

    let end: Date | null = input.quote?.expiresAt ?? (epoch === null ? null : resetExpiryAt(epoch.plannedEndsAt));
    if (input.subscriptionEndsAt !== null && (end === null || input.subscriptionEndsAt.getTime() < end.getTime())) {
      end = input.subscriptionEndsAt;
    }
    if (end === null) return { kind: 'NOT_APPLIED', reason: 'NO_END' };
    // Paid after its own end — the notification came late — and an entitlement
    // born expired would only push a raised limit to Remnawave for the sweep to
    // take back minutes later.
    if (end.getTime() <= input.now.getTime()) return { kind: 'NOT_APPLIED', reason: 'ENDED_BEFORE_CAPTURE' };
    return { kind: 'BOUND', expiresAt: end, epochId: epoch === null ? null : epoch.id };
  }

  private async recordAddOnLedgerNoOp(
    tx: Prisma.TransactionClient,
    transaction: Transaction,
    subscription: Subscription,
    note: 'UNLIMITED_NOOP' | 'RESET_QUOTE_NOT_APPLIED' = 'UNLIMITED_NOOP',
  ): Promise<{ readonly subscription: Subscription; readonly syncJob: ProfileSyncJob }> {
    const syncJob = await tx.profileSyncJob.create({
      data: {
        subscriptionId: subscription.id,
        action: subscription.remnawaveId === null ? SyncAction.CREATE : SyncAction.UPDATE,
        status: SyncJobStatus.PENDING,
        payload: {
          source: 'ADDON_PURCHASE_LEDGER',
          paymentId: transaction.paymentId,
          note,
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
    /**
     * The one snapshot `applyCompletedTransaction` read before any transaction;
     * read here, still before this one, only by a direct caller.
     */
    readonly flags?: AddOnRolloutFlags;
  }): Promise<{ readonly subscription: Subscription; readonly syncJob: ProfileSyncJob }> {
    const flags = input.flags ?? (await readAddOnRolloutFlags(this.addOnSwitches));
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
      // Its first term, in this transaction, while stage 1 is on: the columns
      // are the plan's, so the baseline is MATCHED and the SHADOW projection
      // equals them, and an add-on bought a minute later is ledgered with an
      // end date rather than falling back to the permanent increment. A paid
      // trial is the same NEW purchase and gets one too.
      await this.enterTermModelInTransaction(transactionClient, createdSubscription.id, flags);
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
      // A provider subscription (Platega, RollyPay) this payment signed up for
      // renews the subscription it has just created, and is named in this very
      // write: nothing reads the row without it. The checkout guard refuses a
      // second autopay on the new subscription from the moment it exists, and
      // the sweep can check it from its next tick — where before the row waited
      // for the next look at the provider, up to a day, to be bound
      // (`ProviderSubscriptionService.resolveSubscriptionId`, still the fallback
      // for a row recorded after this). Only a row still unbound is touched.
      if (readProviderSubscriptionTerms(input.transaction.planSnapshot) !== null) {
        await transactionClient.providerSubscription.updateMany({
          where: { firstTransactionId: input.transaction.id, subscriptionId: null },
          data: { subscriptionId: createdSubscription.id },
        });
      }
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
        ...planNamesMetadata([result.subscription.planSnapshot]),
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
    /** See {@link createSubscriptionFromPayment}. */
    readonly flags?: AddOnRolloutFlags;
  }): Promise<RenewalOutcome> {
    if (input.transaction.subscriptionId === null) {
      throw new NotFoundException('Source subscription not found');
    }
    const flags = input.flags ?? (await readAddOnRolloutFlags(this.addOnSwitches));
    const result = await this.prismaService.$transaction(async (transactionClient): Promise<RenewalOutcome> => {
      const currentSubscription = await this.lockRenewalSubscriptionInTransaction(
        transactionClient,
        input.transaction.subscriptionId!,
      );
      assertRenewalFulfillmentPolicy(
        currentSubscription,
        readPersistedPlanAvailability(input.transaction.planSnapshot),
      );
      // ── A SUBSCRIPTION WITH NO END DATE IS NOT RENEWED ────────────────────
      //
      // The checkout refuses it (`SUBSCRIPTION_IS_LIFETIME`). A payment that
      // arrives anyway was drafted while the subscription still had a date,
      // and another payment took the date away before this one was paid — an
      // UPGRADE to a plan without an end. It changes NOTHING: no expiry (it
      // used to get one, counted from the payment), no status, plan, limits or
      // squads, no sync job, and in the term model no term appended or closed
      // and no add-on given an end. It is withheld for refund, as a trial's
      // second conversion is (`withholdForLifetimeSubscriptionInTransaction`):
      // settled, so the webhook does not retry it; no post-payment hook; «Не
      // применён» on «Платежи»; the operator told to return the money. The
      // same for a subscription whose paid periods end in a queued period
      // without an end (`findOpenEndedQueuedTerm`), which the renewal's term
      // could never follow. Asked under the row lock, first.
      const openEndedTerm = isLifetimeSubscription(currentSubscription)
        ? null
        : await findOpenEndedQueuedTerm(transactionClient, currentSubscription);
      if (isLifetimeSubscription(currentSubscription) || openEndedTerm !== null) {
        // No provider holds partner-balance money: refused instead, and that
        // path puts the balance back when fulfilment throws.
        if (input.transaction.gatewayType === PaymentGatewayType.PARTNER_BALANCE) {
          throw subscriptionIsLifetime();
        }
        const line: LifetimeRenewalNotApplied = {
          subscriptionId: currentSubscription.id,
          paidPlanName: displayPlanName(input.purchasedPlan),
          paidDays: input.selectedDurationDays,
          ...(openEndedTerm === null ? {} : { openEndedTerm }),
        };
        const announce = await this.withholdForLifetimeSubscriptionInTransaction(transactionClient, input.transaction.id, {
          [LIFETIME_RENEWAL_NOT_APPLIED_KEY]: lifetimeRenewalNotAppliedProvenance([line], new Date()),
        });
        return { kind: 'WITHHELD_LIFETIME', line, announce };
      }
      // ── PRICED FOR THE PLAN AN UPGRADE HAS SINCE LEFT ─────────────────────
      //
      // Drafted on the old plan, paid after the subscription was upgraded: as
      // it stood, fulfilment re-applied the old plan's snapshot, limits and
      // squads — the upgrade the customer paid for undone by a cheaper payment
      // — or, on a durable term, sold the dearer plan's days at the old price.
      // Now the subscription keeps the plan it is on, and the payment buys the
      // days its money buys there (`readRenewalPricedBeforeUpgrade`, the money
      // rule of `convertRenewalPricedBeforeUpgrade`), never the whole period.
      // Asked under the row lock, like the migration question below, which it
      // settles: the upgrade came after this payment's draft.
      //
      // ── MOVED BY A PLAN MIGRATION AFTER THE CHECKOUT PRICED IT ───────────
      //
      // A renewal checkout priced before a plan migration moved this
      // subscription — for the plan it left, or for that plan's replacement or
      // a plan chosen on it (decision 10). Asked here, under the row lock just
      // taken and before anything is written — see
      // `findLatePlanMigrationRenewal` for why it cannot be asked earlier, and
      // for the ten-minute window before the payment's creation it allows.
      // When it answers, the period is bought on the plan the subscription is
      // on NOW: the term below is that plan's, and neither the paid plan's
      // snapshot nor its limits or squads are applied. The completion event
      // tells the operator.
      //
      // ── MOVED BY ANYTHING ELSE SINCE THE DRAFT ───────────────────────────
      //
      // «Назначить план» and the bulk assignment leave `startedAt` alone and
      // record no migration, so neither question above sees them, and the
      // renewal put the plan it paid for back — the operator's assignment
      // undone by a payment drafted before it. Asked last, by plan identity
      // (`readRenewalPricedBeforePlanChange`), and answered with the upgrade's
      // money rule.
      const planChange = await this.resolveRenewalPricedBeforePlanChangeInTransaction(
        transactionClient,
        {
          subscription: currentSubscription,
          paidPlan: input.purchasedPlan,
          draftedAt: input.transaction.createdAt,
          amount: input.transaction.amount,
          currency: input.transaction.currency,
          paidDays: input.selectedDurationDays,
          gatewayData: input.transaction.gatewayData,
        },
        () =>
          findLatePlanMigrationRenewal(transactionClient, {
            subscription: currentSubscription,
            paidPlan: input.purchasedPlan,
            transactionId: input.transaction.id,
          }),
      );
      const pricedBeforeUpgrade = planChange.priced;
      const latePlanMigrationRenewal = planChange.latePlanMigrationRenewal;
      const renewedDays = pricedBeforeUpgrade?.line.conversion.days ?? input.selectedDurationDays;
      // ── DECIDED BY THE TERM ROW ─────────────────────────────────────────
      //
      // Appending the renewal's term follows the ROW — a subscription with an
      // ACTIVE term gets one whatever the flags say now, and one without stays
      // on the columns (`scheduleRenewalTermInTransaction`, which first brings
      // it into the model while stage 1 is on). Gated by the flag instead,
      // turning stage 1 off left a renewal on the columns while the old term's
      // base stayed in force for the next recompute.
      const correlationId = `payment:${input.transaction.paymentId}`;
      const term =
        pricedBeforeUpgrade === null
          ? await this.scheduleFulfilledRenewalTermInTransaction(transactionClient, {
              subscriptionId: currentSubscription.id,
              paidPlan: input.purchasedPlan,
              durationDays: input.selectedDurationDays,
              latePlanMigrationRenewal,
              correlationId,
              flags,
            })
          : pricedBeforeUpgrade.currentPlan !== null && renewedDays > 0
            ? await this.scheduleRenewalTermInTransaction(transactionClient, {
                subscriptionId: currentSubscription.id,
                plan: pricedBeforeUpgrade.currentPlan,
                durationDays: renewedDays,
                correlationId,
                flags,
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
      //
      // Skipped entirely — `null` — for a renewal a plan migration keeps on the
      // current plan, exactly as at the combined call site above: the columns
      // stay as the move left them, and the snapshot below records only the
      // paid duration, where a normal renewal records it
      // (`withPaidRenewalDuration`). Skipped too for a renewal priced before
      // an upgrade, whose snapshot is not touched at all: the upgrade's
      // duration stays the one autopay renews.
      const inheritedLimitRefresh =
        latePlanMigrationRenewal !== null || pricedBeforeUpgrade !== null
          ? null
          : resolveInheritedPlanLimitRefresh({
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
        pricedBeforeUpgrade !== null
          ? undefined
          : inheritedLimitRefresh === null
            ? term === null
              ? withPaidRenewalDuration(lockedSubscription.planSnapshot, input.selectedDurationDays)
              : undefined
            : term === null
              ? buildPlanSnapshot({
                  transaction: input.transaction,
                  purchasedPlan: input.purchasedPlan,
                  selectedDurationDays: input.selectedDurationDays,
                })
              : patchSnapshotInheritedLimits(
                  lockedSubscription.planSnapshot,
                  inheritedLimitRefresh.snapshot,
                );
      // A renewal priced before a plan change whose money buys no day on the
      // plan the subscription is on renews NOTHING: status and expiry stay as
      // they are. Set ACTIVE anyway, it revived an expired subscription until
      // now and lifted a LIMITED one with no traffic reset. The operator is
      // asked to refund it (the completion's note and card line).
      const boughtNothing = pricedBeforeUpgrade !== null && renewedDays === 0;
      const renewedSubscription = await transactionClient.subscription.update({
        where: { id: currentSubscription.id },
        data: {
          ...(boughtNothing
            ? {}
            : { status: SubscriptionStatus.ACTIVE, expiresAt: calculateExpiry(renewalBase, renewedDays) }),
          ...(planSnapshotWrite === undefined
            ? {}
            : { planSnapshot: planSnapshotWrite as Prisma.InputJsonValue }),
          ...(inheritedLimitRefresh === null ? {} : inheritedLimitRefresh.columns),
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
            // Nor for a renewal priced before a plan change that bought no day.
            ...(renewedSubscription.remnawaveId === null || boughtNothing ? {} : { resetTraffic: true }),
          },
        },
      });
      if (pricedBeforeUpgrade !== null) {
        await writeTransactionGatewayData(transactionClient, input.transaction.id, {
          merge: {
            [RENEWAL_PRICED_BEFORE_UPGRADE_KEY]: renewalPricedBeforeUpgradeProvenance([pricedBeforeUpgrade.line], now),
          },
        });
      }
      await transactionClient.transaction.update({
        where: { id: input.transaction.id },
        data: { fulfilledAt: now, status: TransactionStatus.COMPLETED },
      });
      return {
        kind: 'RENEWED',
        subscription: renewedSubscription,
        syncJob,
        latePlanMigrationRenewal,
        renewalPricedBeforeUpgrade: pricedBeforeUpgrade?.line ?? null,
      };
    });

    return result;
  }

  /**
   * Whether a renewal line was priced for a plan its subscription has LEFT
   * since the draft, and what its money buys on the plan it is on — asked in
   * the one order that keeps each rule's own answer. Under the subscription's
   * row lock, which the caller holds.
   *
   *  1. A paid UPGRADE since the draft (`readRenewalPricedBeforeUpgrade`, by
   *     `startedAt`): converted by money onto the current plan.
   *  2. A plan MIGRATION since the draft (`askMigration`, the caller's
   *     `findLatePlanMigrationRenewal`): owner's decision 10, the whole period
   *     on the current plan — answered as `latePlanMigrationRenewal`.
   *  3. ANY OTHER MOVE since the draft — «Назначить план», a bulk assignment
   *     (`readRenewalPricedBeforePlanChange`, by plan identity): converted
   *     like 1. Before it, such a renewal re-applied the plan it paid for and
   *     undid the operator's assignment.
   *
   * A renewal for the plan its subscription is on is none of them and costs no
   * query at all (`resolvePlanMigrationGuardCandidate`), which is nearly every
   * renewal. The current plan is read from its live row, as the migration guard
   * reads it; a plan deleted since has no prices left, and the payment then
   * buys no day and says so to the operator.
   */
  private async resolveRenewalPricedBeforePlanChangeInTransaction(
    tx: Prisma.TransactionClient,
    input: {
      readonly subscription: Subscription;
      readonly paidPlan: Plan;
      readonly draftedAt: Date;
      readonly amount: Prisma.Decimal;
      readonly currency: string;
      readonly paidDays: number;
      readonly gatewayData: Prisma.JsonValue | null;
      /** The whole payment's amount, for one line of a renewal of several subscriptions. */
      readonly paymentAmount?: Prisma.Decimal;
    },
    askMigration: () => Promise<LatePlanMigrationRenewal | null>,
  ): Promise<{
    readonly priced: { readonly line: RenewalPricedBeforeUpgrade; readonly currentPlan: Plan | null } | null;
    readonly latePlanMigrationRenewal: LatePlanMigrationRenewal | null;
  }> {
    const candidatePlanId = resolvePlanMigrationGuardCandidate(input.subscription.planSnapshot, input.paidPlan.id);
    if (candidatePlanId === null) return { priced: null, latePlanMigrationRenewal: null };
    const upgraded = readRenewalPricedBeforeUpgrade({
      subscription: input.subscription,
      paidPlanId: input.paidPlan.id,
      draftedAt: input.draftedAt,
    });
    if (upgraded !== null) {
      const currentPlan = await tx.plan.findUnique({ where: { id: upgraded.currentPlanId } });
      return {
        priced: await this.priceRenewalOnCurrentPlanInTransaction(tx, input, {
          currentPlanId: upgraded.currentPlanId,
          currentPlan,
          cause: 'UPGRADE',
        }),
        latePlanMigrationRenewal: null,
      };
    }
    const latePlanMigrationRenewal = await askMigration();
    if (latePlanMigrationRenewal !== null) return { priced: null, latePlanMigrationRenewal };
    const currentPlan = await tx.plan.findUnique({ where: { id: candidatePlanId } });
    const moved = readRenewalPricedBeforePlanChange({
      subscription: input.subscription,
      paidPlanId: input.paidPlan.id,
      currentPlan,
    });
    if (moved === null) return { priced: null, latePlanMigrationRenewal: null };
    return {
      priced: await this.priceRenewalOnCurrentPlanInTransaction(tx, input, {
        currentPlanId: moved.currentPlanId,
        currentPlan,
        cause: 'PLAN_CHANGE',
      }),
      latePlanMigrationRenewal: null,
    };
  }

  /** The line for {@link resolveRenewalPricedBeforePlanChangeInTransaction}: the money rule on the current plan. */
  private async priceRenewalOnCurrentPlanInTransaction(
    tx: Prisma.TransactionClient,
    input: {
      readonly subscription: Subscription;
      readonly paidPlan: Plan;
      readonly amount: Prisma.Decimal;
      readonly currency: string;
      readonly paidDays: number;
      readonly gatewayData: Prisma.JsonValue | null;
      readonly paymentAmount?: Prisma.Decimal;
    },
    current: {
      readonly currentPlanId: string;
      readonly currentPlan: Plan | null;
      readonly cause: 'UPGRADE' | 'PLAN_CHANGE';
    },
  ): Promise<{ readonly line: RenewalPricedBeforeUpgrade; readonly currentPlan: Plan | null }> {
    const { currentPlan } = current;
    const durations =
      currentPlan === null
        ? []
        : await tx.planDuration.findMany({
            where: { planId: currentPlan.id },
            select: { days: true, isActive: true, prices: { select: { currency: true, price: true } } },
          });
    const snapshotName = readJsonObject(input.subscription.planSnapshot)['name'];
    return {
      line: {
        subscriptionId: input.subscription.id,
        paidPlanId: input.paidPlan.id,
        paidPlanName: displayPlanName(input.paidPlan),
        currentPlanId: current.currentPlanId,
        currentPlanName:
          currentPlan !== null
            ? displayPlanName(currentPlan)
            : typeof snapshotName === 'string' && snapshotName.length > 0
              ? snapshotName
              : null,
        conversion: convertRenewalPricedBeforeUpgrade({
          amount: input.amount,
          currency: input.currency,
          paidDays: input.paidDays,
          currentPlanDurations: durations,
          gatewayData: input.gatewayData,
          ...(input.paymentAmount === undefined ? {} : { paymentAmount: input.paymentAmount }),
        }),
        ...(current.cause === 'PLAN_CHANGE' ? { cause: current.cause } : {}),
      },
      currentPlan,
    };
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
   * are never reused: each paid renewal owns its own term.
   */
  private async scheduleRenewalTermInTransaction(
    tx: Prisma.TransactionClient,
    input: {
      readonly subscriptionId: string;
      readonly plan: Plan;
      readonly durationDays: number;
      /** Written on the alignment's add-on events: the payment this renewal fulfils. */
      readonly correlationId?: string;
      /** The one snapshot `applyCompletedTransaction` read before any transaction. */
      readonly flags: AddOnRolloutFlags;
    },
  ): Promise<ScheduledRenewalTerm | null> {
    const parent = await tx.$queryRaw<Array<{ id: string; status: SubscriptionStatus }>>(Prisma.sql`
      SELECT "id", "status"::text AS "status"
      FROM "subscriptions"
      WHERE "id" = ${input.subscriptionId}
      FOR UPDATE
    `);
    if (parent.length !== 1 || parent[0]!.status === SubscriptionStatus.DELETED) {
      throw new ConflictException('Cannot append a renewal term to a missing or deleted subscription');
    }

    // A subscription the background cutover has not reached yet enters the
    // model here — only once a plan to mint the renewal's term from is in hand,
    // so a renewal that cannot mint one stays where it was.
    await this.enterTermModelInTransaction(tx, input.subscriptionId, input.flags);
    const activeTerm = await tx.subscriptionTerm.findFirst({
      where: { subscriptionId: input.subscriptionId, status: SubscriptionTermStatus.ACTIVE },
      orderBy: { generation: 'desc' },
      select: { id: true },
    });
    if (activeTerm === null) return null; // durable model not applicable (no cutover)

    // ── THE TAIL CATCHES UP BEFORE THE RENEWAL IS APPENDED ─────────────────
    //
    // Referral days, bulk «Продлить подписку», a webhook or a re-import move
    // `expiresAt` and leave the term to the hourly drift sweep. Appended as it
    // stood, the renewal's term began at the tail's OLD end while the renewal
    // extends `expiresAt` from the new one — and once a successor is queued,
    // alignment never touches the ACTIVE term under it again: its add-ons sold
    // "until the end" ended those days early for good, and the renewed plan's
    // limits began that much early. Aligned first, the tail ends where the
    // subscription does, its add-ons move with it, and the renewal follows.
    // All three renewals come through here: the single one, each line of a
    // combined one, and one a plan migration keeps on the current plan.
    await this.subscriptionTermService.alignTailToExpiryInTransaction(tx, input.subscriptionId, {
      correlationId: input.correlationId ?? `renewal:${input.subscriptionId}`,
    });
    const tail = await tx.subscriptionTerm.findFirst({
      where: {
        subscriptionId: input.subscriptionId,
        status: { in: [SubscriptionTermStatus.ACTIVE, SubscriptionTermStatus.SCHEDULED] },
      },
      orderBy: { generation: 'desc' },
      select: { id: true, status: true, generation: true, startsAt: true, endsAt: true },
    });
    if (tail === null) return null;

    // ── AN OPEN-ENDED TAIL IS NOT RENEWED AFTER ───────────────────────────
    //
    // A term that never ends (`endsAt = null`) is a lifetime subscription's,
    // and a lifetime subscription is not renewed: the checkout refuses it and
    // a payment that arrives anyway is withheld — both renewals stop before
    // they reach here (`renewSubscriptionFromPayment`, `applyCombinedRenewal`).
    // The alignment above closes an open tail on any subscription that has an
    // end date, save one case: the expiry moved to or before the start of a
    // queued open-ended term, which it leaves for a human
    // (`SCHEDULED_SUCCESSOR_BLOCKS`, an incident). The quote refuses that case
    // too, and both renewals withhold a payment for it before they get here
    // (`findOpenEndedQueuedTerm`). Closing the tail here, as a renewal once
    // did, ended a period bought without an end — and the add-ons riding on
    // it — on a payment for thirty days. So whatever still reaches it fails
    // closed: the payment stays paid and unfulfilled, the webhook is marked
    // FAILED with this code, and the operator's alert fires. The code is bare
    // because the webhook inbox keeps an error text only when it is one
    // (`normalizePaymentProviderError`).
    if (tail.endsAt === null) {
      this.logger.warn(
        `RENEWAL_AFTER_OPEN_ENDED_TERM subscription=${input.subscriptionId} term=${tail.id} ` +
          `status=${tail.status}: the chain ends in a term with no end, and a renewal does not close it`,
      );
      throw new ConflictException('RENEWAL_AFTER_OPEN_ENDED_TERM');
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
        name: displayPlanName(input.plan),
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
      // MONTH_ROLLING counts from the Remnawave profile's `createdAt` (P2).
      resetAnchorAt: await mintResetAnchorInTransaction(
        tx,
        input.subscriptionId,
        input.plan.trafficLimitStrategy,
        startsAt,
      ),
    });
    return { id: created.id };
  }

  /**
   * The durable term a FULFILLED renewal appends.
   *
   * Normally the paid plan's. For a renewal whose subscription a plan migration
   * moved after its checkout priced it (decision 10), it is the term a
   * renewal of the subscription's CURRENT plan appends: the same method, handed
   * that plan's row. Appending the paid plan's term instead would put the
   * subscription back on it the moment the term activates — the boundary sweep
   * writes a term's snapshot and squads onto the subscription — so the move
   * would be undone later rather than now.
   *
   * The current plan is read from its live row, as a single renewal reads the
   * plan it fulfils (`getRequiredPlan`) and as the move itself does. A
   * soft-deleted row still resolves — it is how a paid period is fulfilled on a
   * plan deleted after its invoice.
   *
   * FAIL CLOSED, in one case only: the current plan's row is gone AND the
   * subscription has a term chain to extend. There is no plan to mint the
   * term from, and extending expiry without one leaves the chain ending at
   * the OLD expiry — an ACTIVE term is only ended by its successor, so add-ons
   * bound "until subscription end" would lapse early and later add-on
   * purchases would fall back to the legacy increment. So nothing is written
   * and the payment stays paid-but-unfulfilled, where every other payment
   * that cannot be applied goes: the webhook is marked FAILED with this error,
   * the operator alert fires, and it can be replayed once the plan is
   * resolved. Without a term chain there is nothing to extend, and the
   * renewal proceeds on the column path.
   */
  private async scheduleFulfilledRenewalTermInTransaction(
    tx: Prisma.TransactionClient,
    input: {
      readonly subscriptionId: string;
      readonly paidPlan: Plan;
      readonly durationDays: number;
      readonly latePlanMigrationRenewal: LatePlanMigrationRenewal | null;
      /** See {@link scheduleRenewalTermInTransaction}. */
      readonly correlationId?: string;
      readonly flags: AddOnRolloutFlags;
    },
  ): Promise<ScheduledRenewalTerm | null> {
    if (input.latePlanMigrationRenewal === null) {
      return this.scheduleRenewalTermInTransaction(tx, {
        subscriptionId: input.subscriptionId,
        plan: input.paidPlan,
        durationDays: input.durationDays,
        correlationId: input.correlationId,
        flags: input.flags,
      });
    }
    const currentPlan = await tx.plan.findUnique({
      where: { id: input.latePlanMigrationRenewal.currentPlanId },
    });
    if (currentPlan !== null) {
      return this.scheduleRenewalTermInTransaction(tx, {
        subscriptionId: input.subscriptionId,
        plan: currentPlan,
        durationDays: input.durationDays,
        correlationId: input.correlationId,
        flags: input.flags,
      });
    }
    const activeTerm = await tx.subscriptionTerm.findFirst({
      where: { subscriptionId: input.subscriptionId, status: SubscriptionTermStatus.ACTIVE },
      select: { id: true },
    });
    if (activeTerm === null) {
      return null;
    }
    // The exception carries the bare code: the webhook inbox keeps an error
    // text only when it is a bounded code (`normalizePaymentProviderError`),
    // so a sentence would reach the operator's failed-webhook alert as a
    // plain «FAILED». The particulars go to the log.
    this.logger.warn(
      `LATE_RENEWAL_CURRENT_PLAN_NOT_FOUND subscription=${input.subscriptionId} ` +
        `paidPlan=${input.latePlanMigrationRenewal.paidPlanId} ` +
        `currentPlan=${input.latePlanMigrationRenewal.currentPlanId} ` +
        `run=${input.latePlanMigrationRenewal.planMigrationRunId}: moved by a plan migration after the ` +
        'checkout priced it, and the current plan has no row to append the renewal term from',
    );
    throw new ConflictException('LATE_RENEWAL_CURRENT_PLAN_NOT_FOUND');
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
   * outgoing ACTIVE term as part of the same claim. Its `endsAt` is the
   * upgrade's expiry as the caller computed it, the converted paid remainder of
   * the old plan already in it; nothing here adds it a second time.
   *
   * ── A QUEUED TERM IS CANCELED ────────────────────────────────────────────
   *
   * A queued SCHEDULED term was allocated inside the expiry window this upgrade
   * has just discarded, and it blocks the new term's activation outright
   * (`activateInTransaction` activates only the LOWEST scheduled generation).
   * It is CANCELED: its days are already converted into `endsAt`
   * (`paid-remainder-conversion.util.ts`).
   *
   * Add-ons bound to a queued term were sold only by stage 5 («renewal
   * add-ons»), deleted with its code on 24.09.2026 and never on by default. A
   * row it left behind stays PENDING on the cancelled term: it never counts,
   * and the entitlements inspector can reverse it.
   *
   * Returns `null` when the durable model does not apply (no ACTIVE term):
   * the caller stays on the column path. Decided by that ROW and never by a
   * rollout flag.
   */
  private async startUpgradeTermInTransaction(
    tx: Prisma.TransactionClient,
    input: {
      readonly subscriptionId: string;
      readonly plan: Plan;
      readonly durationDays: number;
      readonly startsAt: Date;
      readonly endsAt: Date | null;
    },
  ): Promise<{ readonly id: string; readonly resetAnchorAt: Date | null } | null> {
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
    if (activeTerm === null) return null; // not in the durable model: the column path

    await tx.subscriptionTerm.updateMany({
      where: { subscriptionId: input.subscriptionId, status: SubscriptionTermStatus.SCHEDULED },
      data: { status: SubscriptionTermStatus.CANCELED, endedAt: input.startsAt },
    });

    // MONTH_ROLLING counts from the Remnawave profile's `createdAt` (P2).
    const resetAnchorAt = await mintResetAnchorInTransaction(
      tx,
      input.subscriptionId,
      input.plan.trafficLimitStrategy,
      input.startsAt,
    );
    const created = await this.subscriptionTermService.createScheduledInTransaction(tx, {
      subscriptionId: input.subscriptionId,
      planId: input.plan.id,
      planSnapshot: {
        id: input.plan.id,
        name: displayPlanName(input.plan),
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
      resetAnchorAt,
    });
    await this.subscriptionTermService.activateInTransaction(tx, created.id, input.startsAt);
    return { id: created.id, resetAnchorAt };
  }

  /**
   * THE LIVE ADD-ONS ACROSS A PAID UPGRADE (owner, 24.09.2026): each keeps its
   * own end date, but never later than the subscription's new end — and is
   * re-bound to the new ACTIVE term, the one it now counts on.
   *
   *  - ACTIVE add-ons: clamped to `endsAt`, and moved onto the new term. One
   *    tied to a reset epoch stays on the term that epoch belongs to (the
   *    foreign key pairs them), and is only clamped — never to or before its
   *    own activation (`add_on_entitlements_boundary_check`).
   *  - EXPIRING add-ons are already past their end; nothing to keep.
   *
   * An add-on is never moved LATER: a clamp only ever shortens, and the new
   * term's longer window does not lengthen what was sold. Each change is a
   * version bump under a version guard (a transition that won the row is left
   * alone) and an `AddOnEntitlementEvent` carrying both terms and both dates.
   * No recompute here: neither a date nor a term binding is part of `desired`,
   * and the caller recomputes next.
   */
  private async carryLiveAddOnsAcrossUpgradeInTransaction(
    tx: Prisma.TransactionClient,
    input: {
      readonly subscriptionId: string;
      readonly termId: string;
      readonly endsAt: Date | null;
      readonly correlationId: string;
    },
  ): Promise<void> {
    const live = await tx.addOnEntitlement.findMany({
      where: { subscriptionId: input.subscriptionId, state: AddOnEntitlementState.ACTIVE },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        state: true,
        version: true,
        termId: true,
        expiresAt: true,
        expiryEpochId: true,
        scheduledActivationAt: true,
      },
    });
    for (const entitlement of live) {
      const rebind = entitlement.termId !== input.termId && entitlement.expiryEpochId === null;
      const clampTo =
        input.endsAt !== null &&
        (entitlement.expiresAt === null || entitlement.expiresAt.getTime() > input.endsAt.getTime()) &&
        input.endsAt.getTime() > entitlement.scheduledActivationAt.getTime()
          ? input.endsAt
          : null;
      if (!rebind && clampTo === null) continue;
      const expiresAt = clampTo ?? entitlement.expiresAt;
      const claimed = await tx.addOnEntitlement.updateMany({
        where: { id: entitlement.id, state: entitlement.state, version: entitlement.version },
        data: {
          ...(rebind ? { termId: input.termId } : {}),
          ...(clampTo === null ? {} : { expiresAt: clampTo }),
          version: { increment: 1 },
        },
      });
      if (claimed.count !== 1) continue;
      await tx.addOnEntitlementEvent.create({
        data: {
          entitlementId: entitlement.id,
          fromState: entitlement.state,
          toState: entitlement.state,
          reason: 'UPGRADE_KEPT_OWN_END',
          actorType: AddOnEntitlementActorType.SYSTEM,
          correlationId: input.correlationId,
          // The version the change produced: unique per add-on by construction.
          commandKey: `upgrade-carry:v${entitlement.version + 1}`,
          metadata: {
            previousTermId: entitlement.termId,
            termId: rebind ? input.termId : entitlement.termId,
            subscriptionEndsAt: input.endsAt?.toISOString() ?? null,
            previousExpiresAt: entitlement.expiresAt?.toISOString() ?? null,
            expiresAt: expiresAt?.toISOString() ?? null,
          },
        },
      });
    }
  }

  private async upgradeSubscriptionFromPayment(input: {
    readonly transaction: Transaction;
    readonly purchasedPlan: Plan;
    readonly selectedDurationDays: number;
    /** See {@link createSubscriptionFromPayment}. */
    readonly flags?: AddOnRolloutFlags;
  }): Promise<UpgradeOutcome> {
    if (input.transaction.subscriptionId === null) {
      throw new NotFoundException('Source subscription not found');
    }
    const flags = input.flags ?? (await readAddOnRolloutFlags(this.addOnSwitches));
    const convertsTrial = isTrialConversionSnapshot(input.transaction.planSnapshot);
    return this.prismaService.$transaction(async (transactionClient): Promise<UpgradeOutcome> => {
      // Every upgrade reads its subscription under the row lock. A conversion
      // of a trial: two conversions paid together otherwise both read it as a
      // trial, and the second restarts the term the first one paid for. And
      // every plan change: the paid remainder below is counted from this row's
      // expiry and its payments, and a renewal applied between that read and
      // the write would be counted against an expiry it had already moved. The
      // limit carry and the durable term further down lock the same row again
      // in this transaction, which PostgreSQL grants at once.
      const currentSubscription = await this.lockRenewalSubscriptionInTransaction(
        transactionClient,
        input.transaction.subscriptionId!,
      );
      // ── A TRIAL CONVERTS ONCE ──────────────────────────────────────────────
      //
      // This payment was drafted as the conversion of a trial, and another
      // PAYMENT has converted it since — two tabs, a card beside «для
      // автоматического списания», two sign-ups confirmed together. Applied as
      // an UPGRADE it would restart the term that payment bought (`expiresAt =
      // now + days` below): one term for two payments. Extending instead would
      // have to guess the plan when the two chose different ones, and would keep
      // a second provider subscription renewing it.
      //
      // So it is withheld: received, settled, not applied. The subscription is
      // not touched; the row is COMPLETED and fulfilled like any payment, so its
      // notification is processed, not failed, and nothing keeps it unsettled
      // — marked (`CONVERSION_WITHHELD_AT_KEY`) so no hook pays out on it, a
      // refund revokes nothing and the sweep stops the provider subscription it
      // signed up (`trialConversionOf`: LOST). The operator is told once, in
      // the event feed and the operator group, to refund it at the provider
      // (`announceWithheldConversion`). A partner-balance payment is refused
      // instead: no provider holds that money, and its path puts the balance
      // back when fulfilment throws.
      //
      // A trial that stopped being one WITHOUT a payment — a plan migration, an
      // operator's edit — is not this: nobody paid for its current term, and
      // the conversion is applied below as it always was.
      if (convertsTrial && !currentSubscription.isTrial) {
        const convertedBy = await findTrialConvertingPayment(transactionClient, {
          subscriptionId: currentSubscription.id,
          transactionId: input.transaction.id,
        });
        if (convertedBy !== null) {
          this.logger.warn(
            `TRIAL_ALREADY_CONVERTED transaction=${input.transaction.id} payment=${input.transaction.paymentId} ` +
              `subscription=${currentSubscription.id} convertedBy=${convertedBy.paymentId}: not applied — refund it`,
          );
          if (input.transaction.gatewayType === PaymentGatewayType.PARTNER_BALANCE) {
            throw new ConflictException('TRIAL_ALREADY_CONVERTED');
          }
          const held = await transactionClient.transaction.findUnique({
            where: { id: input.transaction.id },
            select: { gatewayData: true },
          });
          const announce = !isWithheldConversion(held?.gatewayData);
          const withheldAt = new Date();
          if (announce) {
            await writeTransactionGatewayData(transactionClient, input.transaction.id, {
              merge: {
                [CONVERSION_WITHHELD_AT_KEY]: withheldAt.toISOString(),
                [TRIAL_CONVERTED_BY_KEY]: convertedBy.paymentId,
              },
            });
          }
          await transactionClient.transaction.update({
            where: { id: input.transaction.id },
            data: { fulfilledAt: withheldAt, status: TransactionStatus.COMPLETED },
          });
          return {
            kind: 'WITHHELD',
            subscriptionId: currentSubscription.id,
            convertedByPaymentId: convertedBy.paymentId,
            announce,
          };
        }
      }
      // ── NOR IS A SUBSCRIPTION WITH NO END DATE UPGRADED ──────────────────
      //
      // The checkout refuses it (`SUBSCRIPTION_IS_LIFETIME`, the owner's
      // decision of 24.09.2026): an upgrade restarts the term at the payment,
      // which would put a subscription bought without an end on the new plan's
      // clock. A payment that arrives anyway — drafted while the subscription
      // had a date, then another payment took the date away — changes nothing
      // and is withheld for refund, as a renewal of one is. The same for one
      // whose paid periods end in a queued period without an end: the upgrade
      // would cancel that paid period. A trial is exempt: an upgrade is how a
      // trial is left, and its own rule is above.
      if (!currentSubscription.isTrial) {
        const openEndedTerm = isLifetimeSubscription(currentSubscription)
          ? null
          : await findOpenEndedQueuedTerm(transactionClient, currentSubscription);
        if (isLifetimeSubscription(currentSubscription) || openEndedTerm !== null) {
          if (input.transaction.gatewayType === PaymentGatewayType.PARTNER_BALANCE) {
            throw subscriptionIsLifetime('UPGRADE');
          }
          const announce = await this.withholdForLifetimeSubscriptionInTransaction(
            transactionClient,
            input.transaction.id,
          );
          return {
            kind: 'WITHHELD_LIFETIME',
            line: {
              subscriptionId: currentSubscription.id,
              paidPlanName: displayPlanName(input.purchasedPlan),
              paidDays: input.selectedDurationDays,
              ...(openEndedTerm === null ? {} : { openEndedTerm }),
            },
            announce,
          };
        }
      }
      const now = new Date();
      // ── WHAT WAS LEFT OF THE OLD PLAN, AS DAYS ON THE NEW ONE ─────────────
      //
      // The term restarts at the payment, and what the customer had paid for
      // beyond it used to be lost. It is converted instead — by money actually
      // paid, never by calendar days × list price, and never in the customer's
      // favour (`paid-remainder-conversion.util.ts` has the rule and why). The
      // quote shows the same function's estimate before the customer pays;
      // this is the number that counts, with this `now`, under the lock above.
      //
      // Added ONCE, here, to the one expiry everything below uses: the column,
      // and the durable term's `endsAt`. A term never adds it again.
      const paidRemainder = await resolvePaidRemainderConversionInTransaction(transactionClient, {
        now,
        subscription: currentSubscription,
        excludeTransactionId: input.transaction.id,
        planId: input.purchasedPlan.id,
        purchasedDurationDays: input.selectedDurationDays,
      });
      const expiresAt = calculateExpiry(
        now,
        // An unlimited term (-1) has no end to add days to; the conversion
        // already gives 0 there, and the -1 has to reach `calculateExpiry` as is.
        input.selectedDurationDays <= 0
          ? input.selectedDurationDays
          : input.selectedDurationDays + paidRemainder.days,
      );
      // A subscription the background cutover has not reached yet enters the
      // term model here, while stage 1 is on — minted from its columns as they
      // stand, before anything below changes them.
      await this.enterTermModelInTransaction(transactionClient, currentSubscription.id, flags);
      // …and its tail catches up with the expiry it has NOW, before the upgrade
      // writes the new one. An add-on sold "until the end of the subscription"
      // whose date bonus days left behind moves to that end first — and is then
      // clamped to the new end below, keeping its own date (owner, 24.09).
      // Aligning AFTER the new expiry instead would move every such add-on to
      // the new end: the plan-change rotation's rule, not a paid upgrade's.
      await this.subscriptionTermService.alignTailToExpiryInTransaction(transactionClient, currentSubscription.id, {
        correlationId: `payment:${input.transaction.paymentId}`,
      });
      // The free limit bonuses on the live terms, with their own ends — read
      // now, before the upgrade ends, cancels and re-bases those terms, and
      // carried onto the new ones below (`term-limit-bonus.ts`).
      const liveBonuses = await readLiveTermLimitBonusesInTransaction(transactionClient, currentSubscription.id);
      // ── WHAT SAT ABOVE THE OLD PLAN CARRIES — ON BOTH PATHS ──────────────
      //
      // Writing the new plan's raw values over the columns took back everything
      // the subscription held above its old plan: a paid add-on (the legacy
      // path records it nowhere else), an operator's raise, a bonus, a
      // grandfathered add-on folded into a term's base by the cutover — paid
      // for, then pushed off the panel by the upgrade. They carry instead, by
      // the rule renewal already uses (`resolvePlanChangeLimitCarry`), read
      // under the row lock from the OLD columns, the OLD snapshot and the
      // recorded add-on share.
      //
      // THE SNAPSHOT AND THE CARRIED COLUMNS ARE WRITTEN BEFORE ANY RECOMPUTE.
      // The recompute below decides what the subscription owns by comparing the
      // columns, less the recorded share, with the stored snapshot. Run first,
      // it compared the OLD columns with the OLD snapshot, read a raise or a
      // grandfathered add-on as an absolute operator value, and froze it: a 3 +
      // 2 legacy subscription upgraded to a 10-device plan stayed at 5, not 12.
      // Written first, `column − recorded` is the new plan plus what carried:
      // OVERRIDDEN by exactly that delta, or INHERITED so the new term's base
      // stands. Live entitlements are then summed on top ONCE — the carried
      // columns include their recorded share, which the recompute subtracts
      // again before it compares.
      const carry = await resolvePlanChangeLimitCarryInTransaction(
        transactionClient,
        currentSubscription.id,
        input.purchasedPlan,
      );
      let upgradedSubscription = await transactionClient.subscription.update({
        where: { id: currentSubscription.id },
        data: {
          status: SubscriptionStatus.ACTIVE,
          // Upgrading off a trial onto a regular plan clears the trial flag
          // (and the trial badge / "active trial" gating). Mirrors the NEW
          // path: the flag follows the purchased plan's availability.
          isTrial: input.purchasedPlan.availability === PlanAvailability.TRIAL,
          // The purchased plan's snapshot, and the row's import keys kept
          // (`carryImportDomainKeys`, R1-02): an imported customer's upgrade
          // used to drop `sourceSubscriptionId`, and the next import of the
          // same backup created a second subscription. Read under the row lock
          // this transaction took first.
          planSnapshot: carryImportDomainKeys(
            currentSubscription.planSnapshot,
            buildPlanSnapshot({
              transaction: input.transaction,
              purchasedPlan: input.purchasedPlan,
              selectedDurationDays: input.selectedDurationDays,
            }) as Prisma.InputJsonValue,
          ),
          trafficLimit: carry.columns.trafficLimit,
          deviceLimit: carry.columns.deviceLimit,
          internalSquads: input.purchasedPlan.internalSquads,
          externalSquad: input.purchasedPlan.externalSquad,
          startedAt: now,
          expiresAt,
        },
      });
      // ── THE TERM: DECIDED BY THE ROW, NEVER BY A FLAG ────────────────────
      //
      // With an ACTIVE term the baseline moves onto the purchased plan: the old
      // term ends, a term on the new plan starts now and ends at `expiresAt`,
      // the paid remainder already in it. Without that, any later recompute
      // took `old_base + active add-ons` and pushed it to the panel — the plan
      // change the customer paid for silently undone, and after a rollback of
      // stage 1 by the next add-on expiry. No ACTIVE term: the column path, and
      // the carried columns above are what the panel receives.
      const term = await this.startUpgradeTermInTransaction(transactionClient, {
        subscriptionId: currentSubscription.id,
        plan: input.purchasedPlan,
        durationDays: input.selectedDurationDays,
        startsAt: now,
        endsAt: expiresAt,
      });
      let projection: RecomputeProjectionResult | null = null;
      if (term !== null) {
        // The live add-ons keep their own end dates, clamped to the new end,
        // and count on the new term (owner, 24.09.2026).
        await this.carryLiveAddOnsAcrossUpgradeInTransaction(transactionClient, {
          subscriptionId: currentSubscription.id,
          termId: term.id,
          endsAt: expiresAt,
          correlationId: `payment:${input.transaction.paymentId}`,
        });
        // A plan that resets differently: the «до сброса» add-ons also end at
        // the first reset under ITS rule, never later than promised (P6) — in
        // the zone of the one switches snapshot this payment read.
        await redateResetAddOnsInTransaction(transactionClient, {
          subscriptionId: currentSubscription.id,
          strategy: input.purchasedPlan.trafficLimitStrategy,
          anchorAt: term.resetAnchorAt,
          timeZone: flags.remnawaveTimeZone,
          now,
          correlationId: `payment:${input.transaction.paymentId}`,
          reason: 'RESET_RULE_CHANGED',
        });
        // A free limit bonus follows the same rule: it keeps its own end, the
        // end of the period it was given in, clamped to the new end. Outside
        // the model an upgrade ends it, as it always has.
        await carryTermLimitBonusesAcrossUpgradeInTransaction(transactionClient, {
          subscriptionId: currentSubscription.id,
          bonuses: liveBonuses,
          endsAt: expiresAt,
          now,
        });
        // With a durable term the projection owns the effective limits, and the
        // columns mirror it — as every projection-aware writer leaves them.
        projection = await this.effectiveProjectionService.recomputeInTransaction(transactionClient, {
          subscriptionId: currentSubscription.id,
          mode: 'ACTIVE',
        });
        const mirrored = {
          trafficLimit:
            projection.desiredTrafficLimitBytes === null
              ? null
              : Number(projection.desiredTrafficLimitBytes / GIB_BYTES),
          deviceLimit: projection.desiredDeviceLimit === null ? 0 : projection.desiredDeviceLimit,
        };
        if (
          mirrored.trafficLimit !== upgradedSubscription.trafficLimit ||
          mirrored.deviceLimit !== upgradedSubscription.deviceLimit
        ) {
          upgradedSubscription = await transactionClient.subscription.update({
            where: { id: currentSubscription.id },
            data: mirrored,
          });
        }
      }
      const syncJob = await transactionClient.profileSyncJob.create({
        data: {
          subscriptionId: upgradedSubscription.id,
          action: upgradedSubscription.remnawaveId === null ? SyncAction.CREATE : SyncAction.UPDATE,
          status: SyncJobStatus.PENDING,
          // The revision it pushes, when a projection backs it: the record an
          // operator reads in the entitlements inspector.
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
      // Where the extra days came from, on the upgrade's own row and in this
      // same transaction: the days, and per source payment its overlap, value
      // and currency. Whenever a paid chunk was weighed, including one that
      // came to 0 — «checked, nothing» is not «never checked».
      if (paidRemainder.sources.length > 0) {
        await writeTransactionGatewayData(transactionClient, input.transaction.id, {
          merge: { [PAID_REMAINDER_CONVERSION_KEY]: paidRemainderProvenance(paidRemainder, now) },
        });
      }
      await transactionClient.transaction.update({
        where: { id: input.transaction.id },
        data: { fulfilledAt: now, status: TransactionStatus.COMPLETED },
      });
      return {
        kind: 'APPLIED',
        subscription: upgradedSubscription,
        syncJob,
        paidRemainder,
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
    // A plan deleted after the invoice was created is still fulfilled; it is
    // shown without the "(deleted …)" suffix a reuse of its name put on the row.
    name: displayPlanName(input.purchasedPlan),
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
    name: displayPlanName(input.plan),
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
  /** What the checkout quoted (`add-on-quote.ts`); absent on a draft made before quotes were written. */
  readonly quote?: AddOnQuote;
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
  const quote = readAddOnQuote(snapshot);
  return {
    addOnId,
    addOnType: addOnTypeRaw,
    addOnValue,
    targetSubscriptionId,
    name: typeof name === 'string' ? name : undefined,
    addOnRevision: typeof addOnRevision === 'number' ? addOnRevision : undefined,
    lifetime,
    sourceLineKey: typeof sourceLineKey === 'string' && sourceLineKey.length > 0 ? sourceLineKey : undefined,
    ...(quote === null ? {} : { quote }),
  };
}

/**
 * A marker as the ledger reads it: the v1 checkout wrote neither `lifetime`
 * nor `sourceLineKey`, and a draft it made can still be paid after the deploy.
 * The values the v2 checkout writes for the same purchase stand in for them —
 * `UNTIL_SUBSCRIPTION_END`, the add-on id as its one line key
 * (`AddOnPurchaseService.checkout`) — so that draft becomes an entitlement that
 * ends with the subscription, not a permanent increment. A marker that carries
 * its own values keeps them.
 *
 * Except one: devices always end with the subscription. A device marker that
 * says «до следующего сброса» — drafted before 25.09.2026, when the catalogue
 * still let an operator choose it — is fulfilled «до конца подписки», and
 * whatever reset window it quoted is dropped: a device slot taken away at the
 * next traffic reset is not what anyone should have sold.
 */
function withLedgerMarkerDefaults(marker: AddOnMarker): AddOnMarker {
  const lifetime =
    marker.addOnType === AddOnType.EXTRA_TRAFFIC
      ? (marker.lifetime ?? AddOnLifetime.UNTIL_SUBSCRIPTION_END)
      : AddOnLifetime.UNTIL_SUBSCRIPTION_END;
  const { quote, ...rest } = marker;
  return {
    ...rest,
    lifetime,
    sourceLineKey: marker.sourceLineKey ?? marker.addOnId,
    ...(quote !== undefined && quote.lifetime === lifetime ? { quote } : {}),
  };
}

/**
 * Why a paid reset-scoped add-on could not be delivered at all. It is never
 * turned into the permanent increment instead: the payment is recorded as
 * fulfilled, no limit moves, and the operator gets a card to refund it or
 * grant it by hand.
 */
type AddOnNotAppliedReason =
  | 'SUBSCRIPTION_NOT_ACTIVE'
  | 'NO_ACTIVE_TERM'
  | 'INCOHERENT_VALUE'
  | 'NO_END'
  | 'ENDED_BEFORE_CAPTURE';

/** Something about a reset-scoped add-on's capture the operator must hear about. */
type AddOnQuoteNote =
  | { readonly kind: 'NOT_APPLIED'; readonly reason: AddOnNotAppliedReason }
  /** Delivered, but with no reset window to end at: it ends with the subscription. */
  | { readonly kind: 'BOUND_WITHOUT_RESET' };

const ADD_ON_NOT_APPLIED_WHY: Readonly<Record<AddOnNotAppliedReason, string>> = {
  SUBSCRIPTION_NOT_ACTIVE: 'к моменту оплаты подписка уже не активна',
  NO_ACTIVE_TERM: 'у подписки нет действующего срока в учёте докупок',
  INCOHERENT_VALUE: 'у докупки в каталоге неверное значение',
  NO_END: 'у неё нет даты окончания: ни сброса трафика, ни конца подписки',
  ENDED_BEFORE_CAPTURE: 'оплата пришла уже после окончания её срока',
};

/** The card for a note, in the words the operator reads (`📝 Заметка`). */
function describeAddOnQuoteNote(
  note: AddOnQuoteNote,
  input: { readonly name: string; readonly gatewayType: string; readonly charged: boolean },
): { readonly message: string; readonly note: string; readonly needsManualReview: boolean } {
  if (note.kind === 'BOUND_WITHOUT_RESET') {
    return {
      message: 'Докупка применена без привязки к сбросу трафика',
      note:
        `Докупка «${input.name}» оплачена «до сброса трафика», но сброс её цикла определить не удалось ` +
        '(нет даты создания профиля в Remnawave или неверный «Часовой пояс Remnawave»). ' +
        'Она действует до конца подписки. Проверьте «Доп. услуги» → «Настройки».',
      needsManualReview: false,
    };
  }
  return {
    message: 'Докупка оплачена, но не применена',
    note:
      `Докупка «${input.name}» оплачена «до сброса трафика», но ${ADD_ON_NOT_APPLIED_WHY[note.reason]}. ` +
      'Лимиты подписки не менялись. ' +
      (input.charged
        ? `Верните деньги у платёжного провайдера (${input.gatewayType}) или выдайте докупку вручную.`
        : 'Денег по ней не списано — возвращать нечего.'),
    needsManualReview: input.charged,
  };
}

/**
 * Does this add-on marker carry a coherent number of units?
 *
 * WHOLE and POSITIVE, for both resources. `readAddOnMarker` only tests
 * `typeof addOnValue === 'number'`, so this is the check.
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

/**
 * Whether a renewal line still carries add-on lines (stage 5, deleted): any
 * value but `null` or an empty array. Anything else is money taken for add-ons
 * this version no longer delivers, so it is refused, not read.
 */
function carriesAddOnLines(raw: Prisma.JsonValue | null): boolean {
  return raw !== null && !(Array.isArray(raw) && raw.length === 0);
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
