import {
  BadRequestException,
  ConflictException,
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
  SubscriptionStatus,
  SyncAction,
  SyncJobStatus,
  Transaction,
  TransactionStatus,
} from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { PROFILE_SYNC_MAX_ATTEMPTS } from '../../profile-sync/profile-sync.constants';
import { ProfileSyncQueueService } from '../../profile-sync/profile-sync-queue.service';
import { AccessModeGate, AccessModeGuard } from '../../settings/services/access-mode-guard.service';
import { SettingsService } from '../../settings/services/settings.service';
import { InternalPaymentCheckoutDto } from '../dto/internal-payment-checkout.dto';
import {
  InternalPaymentCheckoutInterface,
  InternalPaymentStatusInterface,
  SubscriptionProvisioningFailureCode,
  SubscriptionProvisioningStatus,
} from '../interfaces/internal-payment-checkout.interface';
import { isGatewayConfigured } from '../utils/payment-gateway-settings.util';
import { normalizePaymentProviderError } from '../utils/payment-provider-error.util';
import { PaymentProviderExecutionService } from './payment-provider-execution.service';
import { claimForImmediateFulfillment, releaseFulfillmentClaim } from './payment-fulfillment-claim.util';
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
      const claimedAt = await claimForImmediateFulfillment(this.prismaService, transaction.id);
      if (claimedAt === null) {
        const current = await this.prismaService.transaction.findUnique({ where: { id: transaction.id } });
        if (current?.status === TransactionStatus.COMPLETED && current.fulfilledAt !== null) {
          return mapCheckoutResponse({ transaction: current, checkoutUrl: null, providerMode: 'NONE' });
        }
        throw new ConflictException('Zero-value checkout is already being fulfilled');
      }
      const completedTransaction = await this.prismaService.transaction.findUniqueOrThrow({
        where: { id: transaction.id },
      });
      let syncJobs;
      try {
        ({ syncJobs } =
          await this.paymentSubscriptionMutationService.applyCompletedTransaction(
            completedTransaction,
          ));
      } catch (provisionError: unknown) {
        await releaseFulfillmentClaim(this.prismaService, transaction.id, claimedAt).catch(
          () => undefined,
        );
        throw provisionError;
      }
      // Enqueue after provision commit — never release the claim on queue errors
      // (profile-sync sweep recovers PENDING jobs; reopening would double-provision).
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
        savePaymentMethod: input.savePaymentMethod,
        savePaymentMethodConsent: input.savePaymentMethodConsent,
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
        checkoutUrl: providerCheckout.checkoutUrl,
      },
    });

    if (isProviderCanceled(providerCheckout.providerStatus)) {
      // Terminal cancel first so a later autopay-disable failure cannot leave
      // the row stuck PENDING.
      const canceledTransaction = await this.prismaService.transaction.update({
        where: { id: transaction.id },
        data: { status: TransactionStatus.CANCELED, gatewayData: providerCheckout.gatewayData as Prisma.InputJsonValue },
      });
      await disablePermissionRevokedAutopay(
        this.savedPaymentMethodService,
        transaction.userId,
        input.gatewayType,
        providerCheckout.gatewayData,
      ).catch(() => undefined);
      return mapCheckoutResponse({ transaction: canceledTransaction, checkoutUrl: null, providerMode: providerCheckout.providerMode });
    }

    // Off-session YooKassa may return status=succeeded in the create response.
    // Fulfill immediately (same claim pattern as zero-total checkout); webhook
    // remains the path for PENDING / redirect / 3DS.
    if (isProviderSucceeded(providerCheckout.providerStatus)) {
      const claimedAt = await claimForImmediateFulfillment(this.prismaService, transaction.id);
      if (claimedAt !== null) {
        const completedTransaction = await this.prismaService.transaction.findUniqueOrThrow({
          where: { id: transaction.id },
        });
        // Best-effort: never block entitlement on method-upsert failures
        // (matches reconciler persistSavedPaymentMethodBestEffort).
        await persistImmediateYookassaMethod(
          this.savedPaymentMethodService,
          transaction,
          providerCheckout,
        ).catch(() => undefined);
        let syncJobs;
        try {
          ({ syncJobs } =
            await this.paymentSubscriptionMutationService.applyCompletedTransaction(
              completedTransaction,
            ));
        } catch (provisionError: unknown) {
          await releaseFulfillmentClaim(this.prismaService, transaction.id, claimedAt).catch(
            () => undefined,
          );
          throw provisionError;
        }
        for (const syncJob of syncJobs) {
          await this.profileSyncQueueService.enqueue(syncJob.id);
        }
        const finalTransaction =
          (await this.prismaService.transaction.findUnique({ where: { id: transaction.id } })) ??
          completedTransaction;
        return mapCheckoutResponse({
          transaction: finalTransaction,
          checkoutUrl: null,
          providerMode: providerCheckout.providerMode,
        });
      }
      const current = await this.prismaService.transaction.findUnique({ where: { id: transaction.id } });
      if (current?.status === TransactionStatus.COMPLETED && current.fulfilledAt !== null) {
        return mapCheckoutResponse({ transaction: current, checkoutUrl: null, providerMode: providerCheckout.providerMode });
      }
    }

    if (providerCheckout.checkoutUrl !== null && typeof input.savedPaymentMethodId === 'string' && input.savedPaymentMethodId.length > 0) {
      this.savedPaymentMethodService.notifyAutopayConfirmationRequired({ userId: transaction.userId, paymentId: transaction.paymentId, checkoutUrl: providerCheckout.checkoutUrl });
    }

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
    const subscriptionProvisioning = await this.resolveSubscriptionProvisioning(transaction);
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
      subscriptionProvisioningStatus: subscriptionProvisioning.status,
      subscriptionProvisioningFailureCode: subscriptionProvisioning.failureCode,
      updatedAt: transaction.updatedAt.toISOString(),
    };
  }

  private async resolveSubscriptionProvisioning(
    transaction: Transaction,
  ): Promise<SubscriptionProvisioningResult> {
    if (!isSubscriptionProvisioningPayment(transaction)) {
      return NOT_APPLICABLE_PROVISIONING;
    }
    if (transaction.subscriptionId === null) {
      return {
        status: 'FULFILLING',
        failureCode: null,
      };
    }

    const subscription = await this.prismaService.subscription.findUnique({
      where: { id: transaction.subscriptionId },
      select: {
        status: true,
        remnawaveId: true,
        configUrl: true,
        syncJobs: {
          where: {
            action: SyncAction.CREATE,
            supersededAt: null,
          },
          select: {
            status: true,
            attempts: true,
            recoveryData: true,
          },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });

    return mapSubscriptionProvisioningStatus(subscription);
  }
}

interface SubscriptionProvisioningResult {
  readonly status: SubscriptionProvisioningStatus;
  readonly failureCode: SubscriptionProvisioningFailureCode | null;
}

interface SubscriptionProvisioningSnapshot {
  readonly status: SubscriptionStatus;
  readonly remnawaveId: string | null;
  readonly configUrl: string | null;
  readonly syncJobs: readonly {
    readonly status: SyncJobStatus;
    readonly attempts: number;
    readonly recoveryData: unknown;
  }[];
}

const NOT_APPLICABLE_PROVISIONING: SubscriptionProvisioningResult = {
  status: 'NOT_APPLICABLE',
  failureCode: null,
};

function isSubscriptionProvisioningPayment(transaction: Transaction): boolean {
  const snapshotSource = readOptionalString(readTransactionPlanSnapshot(transaction), [
    'snapshotSource',
  ]);
  return (
    transaction.status === TransactionStatus.COMPLETED &&
    snapshotSource !== 'ADDON_PURCHASE' &&
    (transaction.purchaseType === PurchaseType.NEW ||
      transaction.purchaseType === PurchaseType.ADDITIONAL ||
      transaction.purchaseType === PurchaseType.UPGRADE)
  );
}

function mapSubscriptionProvisioningStatus(
  subscription: SubscriptionProvisioningSnapshot | null,
): SubscriptionProvisioningResult {
  if (subscription === null) {
    return {
      status: 'PROFILE_PENDING',
      failureCode: null,
    };
  }

  if (
    subscription.status !== SubscriptionStatus.DELETED &&
    isPopulatedString(subscription.remnawaveId) &&
    isPopulatedString(subscription.configUrl)
  ) {
    return {
      status: 'READY',
      failureCode: null,
    };
  }

  const latestCreateJob = subscription.syncJobs[0];
  const recoveryClassification =
    latestCreateJob === undefined
      ? null
      : readOptionalString(readRecord(latestCreateJob.recoveryData), ['classification']);
  if (
    latestCreateJob?.status === SyncJobStatus.FAILED &&
    latestCreateJob.attempts >= PROFILE_SYNC_MAX_ATTEMPTS &&
    recoveryClassification === 'TERMINAL'
  ) {
    return {
      status: 'FAILED',
      failureCode: 'PROFILE_SYNC_FAILED',
    };
  }

  return {
    status: 'PROFILE_PENDING',
    failureCode: null,
  };
}

function isPopulatedString(value: string | null): value is string {
  return typeof value === 'string' && value.trim().length > 0;
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


async function disablePermissionRevokedAutopay(
  savedPaymentMethodService: SavedPaymentMethodService,
  userId: string,
  gatewayType: PaymentGatewayType,
  gatewayData: Record<string, unknown>,
): Promise<void> {
  const details = gatewayData['cancellation_details'];
  const reason = typeof details === 'object' && details !== null ? (details as Record<string, unknown>)['reason'] : null;
  const providerMethodId = gatewayData['paymentMethodId'];
  if (gatewayType === PaymentGatewayType.YOOKASSA && typeof reason === 'string' && reason.toLowerCase().includes('permission_revoked') && typeof providerMethodId === 'string') {
    await savedPaymentMethodService.disableAutopayForProviderMethod({ userId, gatewayType, providerMethodId, reason });
  }
}

async function persistImmediateYookassaMethod(
  savedPaymentMethodService: SavedPaymentMethodService,
  transaction: Transaction,
  providerCheckout: { readonly gatewayId: string | null; readonly yookassaPaymentPayload?: unknown },
): Promise<void> {
  if (transaction.gatewayType !== PaymentGatewayType.YOOKASSA || providerCheckout.yookassaPaymentPayload === undefined) return;
  await savedPaymentMethodService.upsertFromYookassaPayment({ userId: transaction.userId, transactionId: transaction.id, gatewayId: providerCheckout.gatewayId, rawPayload: providerCheckout.yookassaPaymentPayload });
}
function isProviderSucceeded(providerStatus: string | null | undefined): boolean {
  return String(providerStatus ?? '').trim().toLowerCase() === 'succeeded';
}

function isProviderCanceled(providerStatus: string | null | undefined): boolean {
  const status = String(providerStatus ?? '').trim().toLowerCase();
  return status === 'canceled' || status === 'cancelled';
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
