import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
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
import { ProfileSyncQueueService } from '../../profile-sync/profile-sync-queue.service';
import { AccessModeGate, AccessModeGuard } from '../../settings/services/access-mode-guard.service';
import { SettingsService } from '../../settings/services/settings.service';
import { InternalPaymentCheckoutDto } from '../dto/internal-payment-checkout.dto';
import {
  InternalPaymentCheckoutInterface,
  InternalPaymentStatusInterface,
} from '../interfaces/internal-payment-checkout.interface';
import { isGatewayConfigured } from '../utils/payment-gateway-settings.util';
import { normalizePaymentProviderError } from '../utils/payment-provider-error.util';
import { PaymentProviderExecutionService } from './payment-provider-execution.service';
import { PaymentSubscriptionMutationService } from './payment-subscription-mutation.service';
import { PaymentsTransactionsService } from './payments-transactions.service';
import { SavedPaymentMethodService } from './saved-payment-method.service';

@Injectable()
export class PaymentsCheckoutService {
  public constructor(
    private readonly prismaService: PrismaService,
    private readonly paymentsTransactionsService: PaymentsTransactionsService,
    private readonly paymentProviderExecutionService: PaymentProviderExecutionService,
    private readonly paymentSubscriptionMutationService: PaymentSubscriptionMutationService,
    private readonly profileSyncQueueService: ProfileSyncQueueService,
    private readonly settingsService: SettingsService,
    private readonly accessModeGuard: AccessModeGuard,
    private readonly savedPaymentMethodService: SavedPaymentMethodService,
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

  public async checkout(
    input: InternalPaymentCheckoutDto,
  ): Promise<InternalPaymentCheckoutInterface> {
    // Two-layer enforcement (Property 2): the reiwa edge runs the same
    // gate, but a direct internal API call would otherwise bypass the
    // platform access mode. Renewal is intentionally NOT gated here —
    // it flows through `PaymentsRenewalCheckoutService` and uses the
    // `purchase.renewal` gate (open under PURCHASE_BLOCKED).
    const policy = await this.settingsService.getInternalPlatformPolicy();
    const gate = mapPurchaseTypeToAccessGate(input.purchaseType);
    const rejection = this.accessModeGuard.evaluate({
      gate,
      mode: policy.accessMode,
    });
    if (rejection !== null) {
      throw rejection.status === 503
        ? new ServiceUnavailableException({ code: rejection.code, message: rejection.message })
        : new ForbiddenException({ code: rejection.code, message: rejection.message });
    }

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

    // Zero-total checkout (e.g. a 100% discount / fully-covered price): there
    // is no real payment to create, and a provider would reject a 0 amount.
    // Complete the transaction and provision the subscription directly,
    // mirroring the free-add-on path — the user gets their subscription
    // without a payment step instead of a "payment failed" error.
    if (Number(transaction.amount) <= 0) {
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
      const finalTransaction =
        (await this.prismaService.transaction.findUnique({ where: { id: transaction.id } })) ??
        completedTransaction;
      return mapCheckoutResponse({
        transaction: finalTransaction,
        checkoutUrl: null,
        providerMode: 'NONE',
      });
    }

    const planSnapshot = readTransactionPlanSnapshot(transaction);
    const createProviderCheckout = async (
      chargedMethod: { readonly id: string; readonly providerMethodId: string } | null,
    ) =>
      this.paymentProviderExecutionService.createCheckout({
        gateway,
        transaction,
        description: buildCheckoutDescription({
          purchaseType: input.purchaseType,
          planSnapshot,
        }),
        successUrl: input.successUrl ?? null,
        failUrl: input.failUrl ?? null,
        paymentMethodId: chargedMethod?.providerMethodId ?? null,
        savedPaymentMethodId: chargedMethod?.id ?? null,
      });
    const providerCheckout =
      typeof input.savedPaymentMethodId === 'string' && input.savedPaymentMethodId.length > 0
        ? await this.savedPaymentMethodService.withActiveForCharge(
            {
              userId,
              savedPaymentMethodId: input.savedPaymentMethodId,
              gatewayType: input.gatewayType,
            },
            createProviderCheckout,
          )
        : await createProviderCheckout(null);

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
    const failureReason =
      rawFailureReason === null ? null : normalizePaymentProviderError(rawFailureReason);
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
/**
 * Maps a {@link PurchaseType} onto the matching {@link AccessModeGate}.
 * RENEW lives in `PaymentsRenewalCheckoutService` and gates separately;
 * if it ever reaches `checkout()` (legacy callers) we treat it as a
 * renewal so PURCHASE_BLOCKED keeps allowing it.
 */
function mapPurchaseTypeToAccessGate(purchaseType: PurchaseType): AccessModeGate {
  switch (purchaseType) {
    case PurchaseType.UPGRADE:
      return 'purchase.upgrade';
    case PurchaseType.RENEW:
      return 'purchase.renewal';
    case PurchaseType.NEW:
    case PurchaseType.ADDITIONAL:
    default:
      return 'purchase.new';
  }
}
