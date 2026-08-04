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
import { PaymentReconciliationService } from './payment-reconciliation.service';
import { releasePaidTrialClaim } from '../../subscriptions/services/trial-claim-ledger.util';

const PROVIDER_CREATION_CLAIM_PREFIX = '__CHECKOUT_PROVIDER_CREATE__:';

/**
 * A `gatewayId` that is a placeholder rather than a real provider handle.
 *
 * While one of these is set, a create request is in flight and may already have
 * charged an off-session card. Nothing may cancel such a row on a local
 * decision — the expiry sweep refuses them for the same reason.
 */
const PROVIDER_CREATION_CLAIM_PREFIXES = [
  PROVIDER_CREATION_CLAIM_PREFIX,
  '__RENEWAL_PROVIDER_CREATE__:',
  'claim:',
] as const;

export function isProviderCreationClaim(gatewayId: string): boolean {
  return PROVIDER_CREATION_CLAIM_PREFIXES.some((prefix) => gatewayId.startsWith(prefix));
}

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
    private readonly paymentReconciliationService: PaymentReconciliationService,
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

    const createdDraft = await this.paymentsTransactionsService.createCheckoutDraft({
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
      // Deliberately NO post-fulfilment hooks here: `amount <= 0` means no money
      // changed hands. Partner commission would be 0, МойНалог would register a
      // zero-rouble income, and — worst — `AdConversion.userId` is unique, so a
      // 0-value conversion would permanently consume this user's only conversion
      // slot and hide their later real purchase from the placement's revenue.
      return mapCheckoutResponse({
        transaction: finalTransaction,
        checkoutUrl: null,
        providerMode: 'NONE',
      });
    }

    const planSnapshot = readTransactionPlanSnapshot(transaction);
    const providerClaim = `${PROVIDER_CREATION_CLAIM_PREFIX}${transaction.paymentId}`;
    const providerCreationClaim = await this.prismaService.transaction.updateMany({
      where: {
        id: transaction.id,
        status: TransactionStatus.PENDING,
        gatewayId: null,
        checkoutUrl: null,
      },
      data: { gatewayId: providerClaim },
    });
    if (providerCreationClaim.count !== 1) {
      const current = await this.prismaService.transaction.findUnique({
        where: { id: transaction.id },
      });
      if (current !== null) {
        const checkoutUrl = readCheckoutUrl(current);
        if (checkoutUrl !== null) {
          return mapCheckoutResponse({
            transaction: current,
            checkoutUrl,
            providerMode: readProviderMode(current) ?? 'REDIRECT',
          });
        }
        if (
          current.status === TransactionStatus.COMPLETED ||
          (typeof current.gatewayId === 'string' &&
            current.gatewayId.length > 0 &&
            !current.gatewayId.startsWith(PROVIDER_CREATION_CLAIM_PREFIX))
        ) {
          return mapCheckoutResponse({
            transaction: current,
            checkoutUrl: null,
            providerMode: readProviderMode(current) ?? 'IMMEDIATE',
          });
        }
      }
      throw new ServiceUnavailableException({
        code: 'PROVIDER_CHECKOUT_CREATION_UNRESOLVED',
        message: 'Provider checkout creation is already claimed; awaiting reconciliation',
      });
    }

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
    let providerCheckout: Awaited<ReturnType<PaymentProviderExecutionService['createCheckout']>>;
    try {
      providerCheckout =
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
    } catch (error: unknown) {
      await this.failClaimedProviderCreation(transaction.id, providerClaim, error);
      throw error;
    }

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
      const canceledTransaction = await this.prismaService.$transaction(async (tx) => {
        const canceled = await tx.transaction.update({
          where: { id: transaction.id },
          data: {
            status: TransactionStatus.CANCELED,
            gatewayData: providerCheckout.gatewayData as Prisma.InputJsonValue,
          },
        });
        await releasePaidTrialClaim(tx, transaction.id, 'PROVIDER_TERMINAL_CANCELED');
        return canceled;
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
        // Off-session charge on a saved card: the money is captured here, so the
        // post-fulfilment hooks are owed here too. No `rawPayload` — the saved
        // method was already persisted above.
        await this.paymentReconciliationService.runPostFulfillmentHooksBestEffort(finalTransaction);
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

  /**
   * A checkout request can fail after the provider receives it. The local
   * draft is therefore terminal but still revivable by a late provider success;
   * its paid-trial reservation is released so that a provider error cannot
   * permanently exhaust the user's trial quota.
   */
  private async failClaimedProviderCreation(
    transactionId: string,
    providerClaim: string,
    error: unknown,
  ): Promise<void> {
    try {
      await this.prismaService.$transaction(async (tx) => {
        const failed = await tx.transaction.updateMany({
          where: {
            id: transactionId,
            status: TransactionStatus.PENDING,
            gatewayId: providerClaim,
          },
          data: {
            status: TransactionStatus.FAILED,
            gatewayId: null,
            gatewayData: {
              failureReason: normalizePaymentProviderError(error),
              providerCreateFailedAt: new Date().toISOString(),
            } as Prisma.InputJsonValue,
          },
        });
        if (failed.count === 1) {
          await releasePaidTrialClaim(tx, transactionId, 'PROVIDER_CHECKOUT_CREATION_FAILED');
        }
      });
    } catch {
      // Preserve the original provider error; reconciliation can still resolve
      // an ambiguous external outcome through the transaction payment id.
    }
  }

  /**
   * Abandons a pending checkout the buyer started and no longer wants.
   *
   * The escape hatch for the trial quota. A paid-trial draft holds a RESERVED
   * claim, and the quota counter treats RESERVED as spent, so an abandoned
   * attempt hides the trial plan from its own owner until the expiry sweep
   * catches up (up to 30 minutes). This lets the buyer — or an operator acting
   * for them — clear it at once instead of waiting or filing a ticket.
   *
   * Only PENDING rows of the calling user are touched, and the guard is in the
   * `updateMany` predicate, so a webhook that completes the payment between the
   * read and the write always wins. A late provider SUCCESS still fulfils:
   * reconciliation revives the transaction and `consumePaidTrialClaim` revives
   * the released claim with it, so cancelling here can never cost a buyer a
   * subscription they paid for.
   */
  public async abandonPendingCheckout(input: {
    readonly paymentId: string;
    readonly userId?: string;
    readonly telegramId?: string;
  }): Promise<{ readonly abandoned: boolean; readonly status: TransactionStatus }> {
    // Identity is REQUIRED here, unlike the read-only status sibling this was
    // modelled on. Treating "no identity supplied" as "skip the ownership
    // check" turns a cancel-any-payment-by-id primitive loose the moment a
    // caller forgets a parameter — and callers do: reiwa derives identity from
    // the session, which is empty for some session shapes.
    const ownerId = await this.resolveUserId(input);
    const transaction = await this.prismaService.transaction.findFirst({
      where: { paymentId: input.paymentId, userId: ownerId },
    });
    if (transaction === null) {
      // Deliberately indistinguishable from "no such payment": a caller must
      // not be able to probe for other users' payment ids.
      throw new NotFoundException('Payment transaction not found');
    }
    if (transaction.gatewayId !== null && isProviderCreationClaim(transaction.gatewayId)) {
      // A provider-create placeholder means a create request is in flight and
      // may already have charged an off-session card. The expiry sweep refuses
      // these for the same reason; cancelling one locally would hide a payment
      // that is still happening.
      throw new ConflictException({
        code: 'PAYMENT_PROVIDER_CREATE_IN_FLIGHT',
        message: 'A provider request is still in flight for this payment; retry shortly.',
      });
    }
    if (transaction.status !== TransactionStatus.PENDING) {
      // Already terminal — report the real state rather than pretending to act.
      return { abandoned: false, status: transaction.status };
    }
    if (transaction.gatewayId !== null) {
      // A real provider handle means an invoice exists and is still payable —
      // no gateway in this system exposes a cancel API, so we cannot kill it.
      // Freeing the quota while it lives would let one buyer stack N payable
      // trial invoices and pay them all: `consumePaidTrialClaim` revives a
      // RELEASED claim, so every one of them would fulfil.
      //
      // The buyer is not stuck: the draft stays PENDING, so quoting and the
      // catalog discount it (`findResumablePaidTrialClaim`) and they can finish
      // this very attempt. Abandoning is for the case before the gateway was
      // ever called — a closed page, a blocked redirect.
      throw new ConflictException({
        code: 'PAYMENT_ALREADY_AT_PROVIDER',
        message:
          'This checkout already exists at the payment provider; finish it or let it expire.',
      });
    }
    const outcome = await this.prismaService.$transaction(async (tx) => {
      const updated = await tx.transaction.updateMany({
        where: { id: transaction.id, status: TransactionStatus.PENDING },
        data: { status: TransactionStatus.CANCELED },
      });
      if (updated.count === 0) {
        // A webhook won the race and moved the row on. Report where it actually
        // landed: saying PENDING here would show a just-paid subscription as
        // still awaiting payment.
        const current = await tx.transaction.findUnique({
          where: { id: transaction.id },
          select: { status: true },
        });
        return { abandoned: false, status: current?.status ?? transaction.status };
      }
      await releasePaidTrialClaim(tx, transaction.id, 'ABANDONED_BY_USER');
      return { abandoned: true, status: TransactionStatus.CANCELED };
    });
    return outcome;
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
