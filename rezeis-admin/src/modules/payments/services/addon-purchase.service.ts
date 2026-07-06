import {
  BadRequestException,
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
  TransactionStatus,
} from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { PricingService } from '../../plans/services/pricing.service';
import { ProfileSyncQueueService } from '../../profile-sync/profile-sync-queue.service';
import { AccessModeGuard } from '../../settings/services/access-mode-guard.service';
import { SettingsService } from '../../settings/services/settings.service';
import { isGatewayConfigured } from '../utils/payment-gateway-settings.util';
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
    };

    const transaction = await this.prismaService.transaction.create({
      data: {
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
      },
    });

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
    const providerCheckout = await this.paymentProviderExecutionService.createCheckout({
      gateway,
      transaction,
      description: buildAddOnDescription(addOn.name),
      successUrl: input.successUrl ?? null,
      failUrl: input.failUrl ?? null,
    });

    const updatedTransaction = await this.prismaService.transaction.update({
      where: { id: transaction.id },
      data: {
        gatewayId: providerCheckout.gatewayId,
        gatewayData: providerCheckout.gatewayData as Prisma.InputJsonValue,
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
