import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  PaymentGatewayType,
  Prisma,
  PurchaseChannel,
  PurchaseType,
  Transaction,
  TransactionStatus,
} from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { AccessModeGuard } from '../../settings/services/access-mode-guard.service';
import { SettingsService } from '../../settings/services/settings.service';
import { SubscriptionRenewalService } from '../../subscriptions/services/subscription-renewal.service';
import { PricedRenewalInterface } from '../../subscriptions/interfaces/subscription-renewal.interface';
import { InternalPaymentCheckoutInterface } from '../interfaces/internal-payment-checkout.interface';
import { isGatewayConfigured } from '../utils/payment-gateway-settings.util';
import { PaymentProviderExecutionService } from './payment-provider-execution.service';

export interface RenewalCheckoutInput {
  readonly userId?: string;
  readonly telegramId?: string;
  readonly subscriptionIds: readonly string[];
  readonly gatewayType: PaymentGatewayType;
  readonly channel?: PurchaseChannel;
  readonly successUrl?: string | null;
  readonly failUrl?: string | null;
  /** Optional per-subscription chosen renewal duration (days). */
  readonly durations?: ReadonlyMap<string, number>;
}

/**
 * Creates a single combined provider checkout that renews several
 * subscriptions at once. Each renewal becomes a {@link Prisma.TransactionItem}
 * line on one PENDING Transaction whose `amount` is the summed total; the
 * existing reconciliation + fulfillment pipeline then renews every item
 * atomically once the provider confirms payment.
 */
@Injectable()
export class PaymentsRenewalCheckoutService {
  public constructor(
    private readonly prismaService: PrismaService,
    private readonly subscriptionRenewalService: SubscriptionRenewalService,
    private readonly paymentProviderExecutionService: PaymentProviderExecutionService,
    private readonly settingsService: SettingsService,
    private readonly accessModeGuard: AccessModeGuard,
  ) {}

  public async renewalCheckout(
    input: RenewalCheckoutInput,
  ): Promise<InternalPaymentCheckoutInterface> {
    // Two-layer enforcement (Property 2). Renewal stays open under
    // PURCHASE_BLOCKED so paying customers don't lose VPN; only
    // RESTRICTED freezes it (handled by the guard).
    const policy = await this.settingsService.getInternalPlatformPolicy();
    const rejection = this.accessModeGuard.evaluate({
      gate: 'purchase.renewal',
      mode: policy.accessMode,
    });
    if (rejection !== null) {
      throw rejection.status === 503
        ? new ServiceUnavailableException({ code: rejection.code, message: rejection.message })
        : new ForbiddenException({ code: rejection.code, message: rejection.message });
    }

    const channel = input.channel ?? PurchaseChannel.WEB;

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

    const priced = await this.subscriptionRenewalService.priceRenewalItems({
      identity: { userId: input.userId, telegramId: input.telegramId },
      subscriptionIds: input.subscriptionIds,
      gatewayType: input.gatewayType,
      channel,
      durations: input.durations,
    });

    const transaction =
      (await this.findExistingPendingDraft(priced, input.gatewayType, channel)) ??
      (await this.createCombinedDraft(priced, input.gatewayType, channel));

    // Reuse an already-created provider checkout (idempotent re-tap).
    const existingCheckoutUrl = readCheckoutUrl(transaction);
    if (existingCheckoutUrl !== null) {
      return mapCheckoutResponse({
        transaction,
        checkoutUrl: existingCheckoutUrl,
        providerMode: readProviderMode(transaction) ?? 'REDIRECT',
      });
    }

    const providerCheckout = await this.paymentProviderExecutionService.createCheckout({
      gateway,
      transaction,
      description: `RENEW x${priced.items.length}`,
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

    return mapCheckoutResponse({
      transaction: updatedTransaction,
      checkoutUrl: providerCheckout.checkoutUrl,
      providerMode: providerCheckout.providerMode,
    });
  }

  /**
   * Persists the combined transaction + its line items in one DB
   * transaction. `subscriptionId` is intentionally left `null` (the
   * presence of items marks this as a combined renewal for fulfillment).
   */
  private async createCombinedDraft(
    priced: PricedRenewalInterface,
    gatewayType: PaymentGatewayType,
    channel: PurchaseChannel,
  ): Promise<Transaction> {
    return this.prismaService.$transaction(async (tx) => {
      const created = await tx.transaction.create({
        data: {
          userId: priced.userId,
          subscriptionId: null,
          status: TransactionStatus.PENDING,
          purchaseType: PurchaseType.RENEW,
          channel,
          gatewayType,
          currency: priced.currency,
          amount: new Prisma.Decimal(priced.total),
          planSnapshot: {
            combinedRenewal: true,
            itemCount: priced.items.length,
            snapshotSource: 'RENEWAL_DRAFT',
          } as Prisma.InputJsonValue,
          deviceTypes: [],
        },
      });
      await tx.transactionItem.createMany({
        data: priced.items.map((item) => ({
          transactionId: created.id,
          subscriptionId: item.subscriptionId,
          planId: item.planId,
          planSnapshot: item.planSnapshot as Prisma.InputJsonValue,
          durationDays: item.durationDays,
          amount: new Prisma.Decimal(item.amount),
          currency: item.currency,
          discountPercent: item.discountPercent,
        })),
      });
      return created;
    });
  }

  /**
   * Finds a reusable PENDING combined draft for the same user, gateway,
   * channel, currency, total and exact subscription set — so a double-tap
   * doesn't mint a second provider checkout.
   */
  private async findExistingPendingDraft(
    priced: PricedRenewalInterface,
    gatewayType: PaymentGatewayType,
    channel: PurchaseChannel,
  ): Promise<Transaction | null> {
    const wanted = new Set(priced.items.map((item) => item.subscriptionId));
    const candidates = await this.prismaService.transaction.findMany({
      where: {
        userId: priced.userId,
        status: TransactionStatus.PENDING,
        purchaseType: PurchaseType.RENEW,
        gatewayType,
        channel,
        currency: priced.currency,
        amount: new Prisma.Decimal(priced.total),
        subscriptionId: null,
      },
      include: { items: { select: { subscriptionId: true } } },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });
    for (const candidate of candidates) {
      if (candidate.items.length !== wanted.size) {
        continue;
      }
      if (candidate.items.every((item) => wanted.has(item.subscriptionId))) {
        const { items: _items, ...transaction } = candidate;
        return transaction as Transaction;
      }
    }
    return null;
  }
}

function mapCheckoutResponse(input: {
  readonly transaction: Transaction;
  readonly checkoutUrl: string | null;
  readonly providerMode: string;
}): InternalPaymentCheckoutInterface {
  return {
    paymentId: input.transaction.paymentId,
    transactionStatus: input.transaction.status,
    gatewayType: input.transaction.gatewayType,
    purchaseType: input.transaction.purchaseType,
    amount: input.transaction.amount.toString(),
    currency: input.transaction.currency,
    checkoutUrl: input.checkoutUrl,
    providerMode: input.providerMode,
    createdAt: input.transaction.createdAt.toISOString(),
  };
}

function readGatewayRecord(transaction: Transaction): Record<string, unknown> {
  const value = transaction.gatewayData;
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readCheckoutUrl(transaction: Transaction): string | null {
  const value = readGatewayRecord(transaction)['checkoutUrl'];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readProviderMode(transaction: Transaction): string | null {
  const value = readGatewayRecord(transaction)['providerMode'];
  return typeof value === 'string' && value.length > 0 ? value : null;
}
