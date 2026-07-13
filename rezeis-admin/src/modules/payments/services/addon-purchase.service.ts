import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  AddOnType,
  Currency,
  PaymentGatewayType,
  Prisma,
  PurchaseChannel,
  PurchaseType,
  SubscriptionStatus,
  Transaction,
  TransactionStatus,
} from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { PricingService } from '../../plans/services/pricing.service';
import { ProfileSyncQueueService } from '../../profile-sync/profile-sync-queue.service';
import { AccessModeGuard } from '../../settings/services/access-mode-guard.service';
import { SettingsService } from '../../settings/services/settings.service';
import { isGatewayConfigured } from '../utils/payment-gateway-settings.util';
import { buildAddOnCheckoutFingerprint } from '../utils/checkout-fingerprint.util';
import {
  InternalPaymentCheckoutInterface,
} from '../interfaces/internal-payment-checkout.interface';
import { PaymentProviderExecutionService } from './payment-provider-execution.service';
import { PaymentSubscriptionMutationService } from './payment-subscription-mutation.service';

export interface AddOnCheckoutInput {
  readonly userId?: string;
  readonly telegramId?: string;
  readonly addOnId: string;
  readonly subscriptionId: string;
  readonly gatewayType: PaymentGatewayType;
  readonly channel?: PurchaseChannel;
  readonly successUrl?: string | null;
  readonly failUrl?: string | null;
  readonly contractVersion?: number;
  readonly idempotencyKey?: string;
  readonly expectedAddOnRevision?: number;
}

/**
 * AddOnPurchaseService
 * ────────────────────
 * Sells "extra traffic (GB)" / "extra devices" top-ups for an EXISTING
 * subscription. The flow mirrors the plan checkout but prices off the
 * `AddOnPrice` table (per gateway currency, no plan/duration), and tags
 * the resulting `Transaction` as `ADDITIONAL` with an add-on marker in
 * `planSnapshot` so the fulfillment layer
 * (`PaymentSubscriptionMutationService`) raises the target
 * subscription's limit + enqueues a Remnawave sync instead of creating a
 * fresh subscription.
 *
 * `Transaction.subscriptionId` is left `null` at draft time (the target id
 * lives in `planSnapshot`); the fulfillment step stamps both it and
 * `transaction.fulfilledAt` atomically. The reconciliation guard fulfils only
 * when `fulfilledAt === null`, giving us idempotency against webhook retries.
 */
@Injectable()
export class AddOnPurchaseService {
  public constructor(
    private readonly prismaService: PrismaService,
    private readonly pricingService: PricingService,
    private readonly paymentProviderExecutionService: PaymentProviderExecutionService,
    private readonly paymentSubscriptionMutationService: PaymentSubscriptionMutationService,
    private readonly profileSyncQueueService: ProfileSyncQueueService,
    private readonly settingsService: SettingsService,
    private readonly accessModeGuard: AccessModeGuard,
  ) {}

  public async checkout(input: AddOnCheckoutInput): Promise<InternalPaymentCheckoutInterface> {
    // Two-layer enforcement (Property 2): add-on purchases are gated
    // exactly like NEW/UPGRADE — closed under PURCHASE_BLOCKED and
    // RESTRICTED.
    const policy = await this.settingsService.getInternalPlatformPolicy();
    const rejection = this.accessModeGuard.evaluate({
      gate: 'purchase.addon',
      mode: policy.accessMode,
    });
    if (rejection !== null) {
      throw rejection.status === 503
        ? new ServiceUnavailableException({ code: rejection.code, message: rejection.message })
        : new ForbiddenException({ code: rejection.code, message: rejection.message });
    }

    const channel = input.channel ?? PurchaseChannel.WEB;

    // Resolve the canonical user from either the reiwa_id (web / web-first
    // users) or the Telegram id (Telegram-only flows).
    let userId: string;
    if (typeof input.userId === 'string' && input.userId.length > 0) {
      userId = input.userId;
    } else if (typeof input.telegramId === 'string' && input.telegramId.length > 0) {
      // Guard BigInt() against a non-numeric telegramId (would throw a raw 500).
      if (!/^\d+$/.test(input.telegramId)) {
        throw new NotFoundException('User not found');
      }
      const user = await this.prismaService.user.findFirst({
        where: { telegramId: BigInt(input.telegramId) },
        select: { id: true },
      });
      if (user === null) {
        throw new NotFoundException('User not found');
      }
      userId = user.id;
    } else {
      throw new NotFoundException('A userId or telegramId is required');
    }

    // ── Gateway validation ────────────────────────────────────────────────
    const gateway = await this.prismaService.paymentGateway.findUnique({
      where: { type: input.gatewayType },
    });
    if (gateway === null || !gateway.isActive) {
      throw new BadRequestException('PAYMENT_GATEWAY_NOT_ACTIVE');
    }
    if (!isGatewayConfigured(gateway.type, gateway.settings)) {
      throw new BadRequestException('PAYMENT_GATEWAY_NOT_CONFIGURED');
    }
    if (gateway.type === PaymentGatewayType.TELEGRAM_STARS && channel === PurchaseChannel.WEB) {
      throw new BadRequestException('PAYMENT_GATEWAY_CHANNEL_UNSUPPORTED');
    }

    // ── Subscription validation ───────────────────────────────────────────
    const subscription = await this.prismaService.subscription.findUnique({
      where: { id: input.subscriptionId },
      select: {
        id: true,
        userId: true,
        status: true,
        trafficLimit: true,
        planSnapshot: true,
      },
    });
    if (subscription === null || subscription.userId !== userId) {
      throw new NotFoundException('Subscription not found');
    }
    if (
      subscription.status !== SubscriptionStatus.ACTIVE &&
      subscription.status !== SubscriptionStatus.LIMITED
    ) {
      throw new BadRequestException('Add-ons require an active subscription');
    }

    // ── Add-on validation ─────────────────────────────────────────────────
    const addOn = await this.prismaService.addOn.findUnique({
      where: { id: input.addOnId },
      include: { prices: true },
    });
    if (addOn === null || !addOn.isActive) {
      throw new NotFoundException('Add-on not found');
    }
    const subscriptionPlanId = readPlanId(subscription.planSnapshot);
    if (
      addOn.applicablePlanIds.length > 0 &&
      (subscriptionPlanId === null || !addOn.applicablePlanIds.includes(subscriptionPlanId))
    ) {
      throw new BadRequestException('Add-on is not available for this subscription plan');
    }
    if (addOn.type === AddOnType.EXTRA_TRAFFIC && subscription.trafficLimit === null) {
      throw new BadRequestException(
        'Subscription has unlimited traffic — extra traffic cannot be applied',
      );
    }

    // ── Pricing (per gateway currency) ────────────────────────────────────
    const currency = gateway.currency;
    const priceRow = addOn.prices.find((p) => p.currency === currency);
    if (priceRow === undefined) {
      throw new BadRequestException('Add-on has no price for the selected payment method');
    }
    // Add-ons are sold at face value — no plan discounts apply. We still
    // run the amount through the pricing service to honour per-currency
    // rounding / minimum rules.
    const snapshot = this.pricingService.buildSnapshot({
      amount: priceRow.price.toString(),
      currency: currency as Currency,
      purchaseDiscount: 0,
      personalDiscount: 0,
    });

    // ── Optimistic catalog-revision guard ────────────────────────────────
    // If the client pinned the revision it saw, reject a stale composition
    // rather than silently selling the repriced/changed add-on.
    if (input.expectedAddOnRevision !== undefined && input.expectedAddOnRevision !== addOn.revision) {
      throw new ConflictException({
        code: 'ADDON_REVISION_CONFLICT',
        message: 'Add-on changed since it was shown; refresh and try again',
      });
    }

    // ── Request-level idempotency ────────────────────────────────────────
    // A logical checkout attempt is identified by its canonical composition.
    // Same key + same composition → return the existing draft; same key +
    // different composition → IDEMPOTENCY_KEY_CONFLICT. Keyless (legacy)
    // requests skip this and always create a fresh draft.
    const checkoutFingerprint = buildAddOnCheckoutFingerprint({
      contractVersion: input.contractVersion ?? 1,
      userId,
      subscriptionId: subscription.id,
      termId: null,
      addOnId: addOn.id,
      addOnRevision: addOn.revision,
      type: addOn.type,
      value: addOn.value,
      lifetime: addOn.lifetime,
      gatewayType: gateway.type,
      channel,
      currency,
      amount: snapshot.price,
    });
    const idempotencyKey =
      typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0
        ? input.idempotencyKey
        : null;
    if (idempotencyKey !== null) {
      const existing = await this.findByIdempotencyKey(userId, idempotencyKey);
      if (existing !== null) {
        return this.replayOrConflict(existing, checkoutFingerprint);
      }
    }

    // ── Draft transaction ─────────────────────────────────────────────────
    const planSnapshot: Record<string, unknown> = {
      snapshotSource: 'ADDON_PURCHASE',
      addOnId: addOn.id,
      addOnType: addOn.type,
      addOnValue: addOn.value,
      name: addOn.name,
      targetSubscriptionId: subscription.id,
      purchaseType: PurchaseType.ADDITIONAL,
      gatewayType: gateway.type,
      amount: snapshot.price,
      currency,
      // ── v2 entitlement-ledger marker (additive) ─────────────────────────
      // Consumed by the flag-gated ledger fulfillment (T-005c). The legacy
      // marker parser ignores these fields, so this is safe on the old path.
      contractVersion: input.contractVersion ?? 1,
      addOnRevision: addOn.revision,
      lifetime: addOn.lifetime,
      // One add-on line per transaction → a stable per-line dedup key backing
      // the unique (sourceTransactionId, sourceLineKey) entitlement constraint.
      sourceLineKey: addOn.id,
    };

    const transaction = await this.createDraftTransaction(
      {
        userId,
        // Left null so the reconciliation guard runs fulfillment; the
        // target subscription id lives in planSnapshot and is stamped
        // onto the transaction at fulfillment time.
        subscriptionId: null,
        status: TransactionStatus.PENDING,
        purchaseType: PurchaseType.ADDITIONAL,
        channel,
        gatewayType: gateway.type,
        currency,
        amount: snapshot.price,
        planSnapshot: planSnapshot as Prisma.InputJsonValue,
        deviceTypes: [],
        idempotencyKey,
        checkoutFingerprint: idempotencyKey !== null ? checkoutFingerprint : null,
      },
      userId,
      idempotencyKey,
      checkoutFingerprint,
    );
    // A concurrent request with the same key won the race — replay its draft.
    if ('replay' in transaction) {
      return transaction.replay;
    }

    // ── Free add-on (zero amount): apply immediately, skip the provider ───
    // A 0-price add-on (e.g. an operator-granted extra) has no real payment.
    // Mark the draft COMPLETED and run the standard add-on fulfillment so the
    // subscription limit is raised right away, then return a completed result
    // with no checkout URL.
    if (Number(snapshot.price) <= 0) {
      const completedTransaction = await this.prismaService.transaction.update({
        where: { id: transaction.id },
        data: { status: TransactionStatus.COMPLETED },
      });
      const { syncJobs } =
        await this.paymentSubscriptionMutationService.applyCompletedTransaction(
          completedTransaction,
        );
      for (const syncJob of syncJobs) {
        await this.profileSyncQueueService.enqueue(syncJob.id);
      }
      const finalTransaction = await this.prismaService.transaction.findUnique({
        where: { id: transaction.id },
      });
      const tx = finalTransaction ?? completedTransaction;
      return {
        paymentId: tx.paymentId,
        transactionStatus: tx.status,
        gatewayType: tx.gatewayType,
        purchaseType: tx.purchaseType,
        amount: tx.amount.toString(),
        currency: tx.currency,
        checkoutUrl: null,
        providerMode: 'NONE',
        createdAt: tx.createdAt.toISOString(),
      };
    }

    // ── Provider checkout ─────────────────────────────────────────────────
    // The draft's `paymentId` is already the stable merchant reference (passed
    // to every adapter as order_id / tracking_id / metadata / Idempotence-Key),
    // so the provider call is idempotent and a late webhook can always find
    // this draft. If the provider create fails non-deterministically (timeout /
    // 5xx / network — surfaced as ServiceUnavailableException by the execution
    // layer) we CANNOT know whether the provider created the payment: stamp the
    // draft as `PROVIDER_OUTCOME_UNKNOWN` (kept, not deleted) so a keyed retry
    // replays the same draft (no second checkout) and the webhook reconciler /
    // recovery sweeper resolve the money. Deterministic config errors
    // (BadRequest) mean the draft is unusable and propagate unchanged.
    let providerCheckout;
    try {
      providerCheckout = await this.paymentProviderExecutionService.createCheckout({
        gateway,
        transaction,
        description: buildAddOnDescription(addOn.name),
        successUrl: input.successUrl ?? null,
        failUrl: input.failUrl ?? null,
      });
    } catch (error: unknown) {
      if (error instanceof ServiceUnavailableException) {
        await this.prismaService.transaction
          .update({
            where: { id: transaction.id },
            data: {
              gatewayData: {
                providerOutcome: 'UNKNOWN',
                reason: 'PROVIDER_CREATE_UNAVAILABLE',
              } as Prisma.InputJsonValue,
            },
          })
          .catch(() => undefined);
        throw new ServiceUnavailableException({
          code: 'PROVIDER_OUTCOME_UNKNOWN',
          message: 'Payment provider outcome is unknown; awaiting reconciliation',
        });
      }
      throw error;
    }

    const updatedTransaction = await this.prismaService.transaction.update({
      where: { id: transaction.id },
      data: {
        gatewayId: providerCheckout.gatewayId,
        gatewayData: providerCheckout.gatewayData as Prisma.InputJsonValue,
        // Persist the payment link so an idempotent replay returns the same
        // checkout instead of creating a second invoice.
        checkoutUrl: providerCheckout.checkoutUrl,
      },
    });

    return {
      paymentId: updatedTransaction.paymentId,
      transactionStatus: updatedTransaction.status,
      gatewayType: updatedTransaction.gatewayType,
      purchaseType: updatedTransaction.purchaseType,
      amount: updatedTransaction.amount.toString(),
      currency: updatedTransaction.currency,
      checkoutUrl: providerCheckout.checkoutUrl,
      providerMode: providerCheckout.providerMode,
      createdAt: updatedTransaction.createdAt.toISOString(),
    };
  }

  /**
   * Create the draft, tolerating a concurrent duplicate under the same
   * idempotency key: on the unique-index race we replay the winner's draft
   * instead of surfacing a raw DB error.
   */
  private async createDraftTransaction(
    data: Prisma.TransactionUncheckedCreateInput,
    userId: string,
    idempotencyKey: string | null,
    checkoutFingerprint: string,
  ): Promise<Transaction | { readonly replay: InternalPaymentCheckoutInterface }> {
    try {
      return await this.prismaService.transaction.create({ data });
    } catch (error: unknown) {
      if (
        idempotencyKey !== null &&
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const existing = await this.findByIdempotencyKey(userId, idempotencyKey);
        if (existing !== null) {
          return { replay: this.replayOrConflict(existing, checkoutFingerprint) };
        }
      }
      throw error;
    }
  }

  private findByIdempotencyKey(
    userId: string,
    idempotencyKey: string,
  ): Promise<ExistingDraft | null> {
    return this.prismaService.transaction.findFirst({
      where: { userId, idempotencyKey },
      select: {
        paymentId: true,
        status: true,
        gatewayType: true,
        purchaseType: true,
        amount: true,
        currency: true,
        checkoutUrl: true,
        createdAt: true,
        checkoutFingerprint: true,
      },
    });
  }

  /** Same composition → replay the existing draft; different → conflict. */
  private replayOrConflict(
    existing: ExistingDraft,
    checkoutFingerprint: string,
  ): InternalPaymentCheckoutInterface {
    if (existing.checkoutFingerprint !== checkoutFingerprint) {
      throw new ConflictException({
        code: 'IDEMPOTENCY_KEY_CONFLICT',
        message: 'Idempotency key was already used for a different checkout',
      });
    }
    return {
      paymentId: existing.paymentId,
      transactionStatus: existing.status,
      gatewayType: existing.gatewayType,
      purchaseType: existing.purchaseType,
      amount: existing.amount.toString(),
      currency: existing.currency,
      checkoutUrl: existing.checkoutUrl,
      providerMode: existing.checkoutUrl !== null ? 'REDIRECT' : 'NONE',
      createdAt: existing.createdAt.toISOString(),
    };
  }
}

interface ExistingDraft {
  readonly paymentId: string;
  readonly status: TransactionStatus;
  readonly gatewayType: PaymentGatewayType;
  readonly purchaseType: PurchaseType;
  readonly amount: Prisma.Decimal;
  readonly currency: Currency;
  readonly checkoutUrl: string | null;
  readonly createdAt: Date;
  readonly checkoutFingerprint: string | null;
}

function buildAddOnDescription(name: string): string {
  return `Add-on: ${name}`.slice(0, 128);
}

function readPlanId(planSnapshot: unknown): string | null {
  if (typeof planSnapshot !== 'object' || planSnapshot === null || Array.isArray(planSnapshot)) {
    return null;
  }
  const id = (planSnapshot as Record<string, unknown>)['id'];
  return typeof id === 'string' && id.length > 0 ? id : null;
}
