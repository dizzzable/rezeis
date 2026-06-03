import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  PaymentGatewayType,
  Prisma,
  PurchaseChannel,
  PurchaseType,
  Transaction,
} from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { InternalPaymentCheckoutDto } from '../dto/internal-payment-checkout.dto';
import {
  InternalPaymentCheckoutInterface,
  InternalPaymentStatusInterface,
} from '../interfaces/internal-payment-checkout.interface';
import { isGatewayConfigured } from '../utils/payment-gateway-settings.util';
import { normalizePaymentProviderError } from '../utils/payment-provider-error.util';
import { PaymentProviderExecutionService } from './payment-provider-execution.service';
import { PaymentsTransactionsService } from './payments-transactions.service';

@Injectable()
export class PaymentsCheckoutService {
  public constructor(
    private readonly prismaService: PrismaService,
    private readonly paymentsTransactionsService: PaymentsTransactionsService,
    private readonly paymentProviderExecutionService: PaymentProviderExecutionService,
  ) {}

  /**
   * Resolves the canonical `reiwa_id` from either `userId` (reiwa_id) or
   * `telegramId`. Mirrors the subscription-quote resolver so the
   * checkout path accepts the same identity inputs.
   */
  private async resolveUserId(input: {
    readonly userId?: string;
    readonly telegramId?: string;
  }): Promise<string> {
    if (typeof input.userId === 'string' && input.userId.length > 0) {
      return input.userId;
    }
    if (typeof input.telegramId === 'string' && input.telegramId.length > 0) {
      const user = await this.prismaService.user.findUnique({
        where: { telegramId: BigInt(input.telegramId) },
        select: { id: true },
      });
      if (user === null) {
        throw new NotFoundException('User not found');
      }
      return user.id;
    }
    throw new BadRequestException('A userId or telegramId is required');
  }

  public async checkout(input: InternalPaymentCheckoutDto): Promise<InternalPaymentCheckoutInterface> {
    const userId = await this.resolveUserId(input);
    const gateway = await this.prismaService.paymentGateway.findUnique({
      where: { type: input.gatewayType },
    });
    if (gateway === null || !gateway.isActive) {
      throw new BadRequestException('PAYMENT_GATEWAY_NOT_ACTIVE');
    }
    if (!isGatewayConfigured(gateway.type, gateway.settings)) {
      throw new BadRequestException('PAYMENT_GATEWAY_NOT_CONFIGURED');
    }
    const channel = input.channel ?? PurchaseChannel.WEB;
    if (gateway.type === PaymentGatewayType.TELEGRAM_STARS && channel === PurchaseChannel.WEB) {
      throw new BadRequestException('PAYMENT_GATEWAY_CHANNEL_UNSUPPORTED');
    }

    const createdDraft = await this.paymentsTransactionsService.createDraft({
      userId,
      purchaseType: input.purchaseType,
      planId: input.planId,
      durationDays: input.durationDays,
      gatewayType: input.gatewayType,
      sourceSubscriptionId: input.subscriptionId,
      channel,
      deviceType: input.deviceType,
    });
    const transaction = await this.prismaService.transaction.findUnique({
      where: { paymentId: createdDraft.paymentId },
    });
    if (transaction === null) {
      throw new NotFoundException('Payment transaction not found');
    }

    const existingCheckoutUrl = readCheckoutUrl(transaction);
    if (existingCheckoutUrl !== null) {
      return mapCheckoutResponse({
        transaction,
        checkoutUrl: existingCheckoutUrl,
        providerMode: readProviderMode(transaction) ?? 'REDIRECT',
      });
    }

    const planSnapshot = readTransactionPlanSnapshot(transaction);
    const providerCheckout = await this.paymentProviderExecutionService.createCheckout({
      gateway,
      transaction,
      description: buildCheckoutDescription({
        purchaseType: input.purchaseType,
        planSnapshot,
      }),
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

  public async getPaymentStatus(input: {
    readonly paymentId: string;
    readonly userId?: string;
    readonly telegramId?: string;
  }): Promise<InternalPaymentStatusInterface> {
    const transaction = await this.prismaService.transaction.findUnique({
      where: { paymentId: input.paymentId },
    });
    if (transaction === null) {
      throw new NotFoundException('Payment transaction not found');
    }
    // Ownership check: resolve the caller's reiwa_id from either input
    // and verify it owns the transaction. When neither identifier is
    // supplied we skip the check (internal/admin reads).
    if (input.userId !== undefined || input.telegramId !== undefined) {
      const ownerId = await this.resolveUserId(input);
      if (transaction.userId !== ownerId) {
        throw new NotFoundException('Payment transaction not found');
      }
    }
    const gatewayData = readGatewayData(transaction);
    const rawFailureReason =
      readOptionalString(gatewayData, ['failureReason']) ??
      readOptionalString(gatewayData, ['lastError']) ??
      null;
    const failureReason = rawFailureReason === null
      ? null
      : normalizePaymentProviderError(rawFailureReason);
    return {
      paymentId: transaction.paymentId,
      status: transaction.status,
      gatewayType: transaction.gatewayType,
      purchaseType: transaction.purchaseType,
      amount: transaction.amount.toString(),
      currency: transaction.currency,
      checkoutUrl: readOptionalString(gatewayData, ['checkoutUrl']),
      failureReason,
      subscriptionId: transaction.subscriptionId,
      updatedAt: transaction.updatedAt.toISOString(),
    };
  }
}

function buildCheckoutDescription(input: {
  readonly purchaseType: PurchaseType;
  readonly planSnapshot: Record<string, unknown>;
}): string {
  const planName = readOptionalString(input.planSnapshot, ['name']) ?? 'Plan';
  const selectedDurationDays = readOptionalString(input.planSnapshot, ['selectedDurationDays']);
  const durationLabel =
    selectedDurationDays === null
      ? ''
      : selectedDurationDays === '-1'
        ? ' unlimited'
        : ` ${selectedDurationDays}d`;
  return `${input.purchaseType} ${planName}${durationLabel}`.trim();
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

function readGatewayData(transaction: Transaction): Record<string, unknown> {
  return readRecord(transaction.gatewayData);
}

function readTransactionPlanSnapshot(transaction: Transaction): Record<string, unknown> {
  return readRecord(transaction.planSnapshot);
}

function readCheckoutUrl(transaction: Transaction): string | null {
  return readOptionalString(readGatewayData(transaction), ['checkoutUrl']);
}

function readProviderMode(transaction: Transaction): string | null {
  return readOptionalString(readGatewayData(transaction), ['providerMode']);
}

function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readOptionalString(
  value: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return String(candidate);
    }
  }
  return null;
}
