import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  Currency,
  PaymentGatewayType,
  Prisma,
  PurchaseChannel,
  PurchaseType,
  Transaction,
  TransactionStatus,
} from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { ProfileSyncQueueService } from '../../profile-sync/profile-sync-queue.service';
import { AccessModeGuard } from '../../settings/services/access-mode-guard.service';
import { SettingsService } from '../../settings/services/settings.service';
import { SubscriptionRenewalService } from '../../subscriptions/services/subscription-renewal.service';
import { PricedRenewalInterface } from '../../subscriptions/interfaces/subscription-renewal.interface';
import { InternalPaymentCheckoutInterface } from '../interfaces/internal-payment-checkout.interface';
import { isGatewayConfigured } from '../utils/payment-gateway-settings.util';
import { buildRenewalCheckoutFingerprint, fingerprint } from '../utils/checkout-fingerprint.util';
import { PaymentProviderExecutionService } from './payment-provider-execution.service';
import { claimForImmediateFulfillment, releaseFulfillmentClaim } from './payment-fulfillment-claim.util';
import { PaymentSubscriptionMutationService } from './payment-subscription-mutation.service';
import { SavedPaymentMethodService } from './saved-payment-method.service';

const PROVIDER_CREATION_CLAIM_PREFIX = '__RENEWAL_PROVIDER_CREATE__:';

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
  /** Optional per-subscription chosen plan id (for plan-less subscriptions). */
  readonly plans?: ReadonlyMap<string, string>;
  /** Optional client idempotency key for request-level dedup (T-007). */
  readonly idempotencyKey?: string;
  /** Contract version the client composed against (defaults to 1). */
  readonly contractVersion?: number;
  /** Quote confirmed by the client on the review screen. Both fields must be
   * present together; legacy internal callers may omit both. */
  readonly expectedAmount?: string;
  readonly expectedCurrency?: Currency;
  /** Optional per-subscription selected renewal add-on ids (T-007). Honored
   *  only when the `renewalAddOns` rollout flag is on. */
  readonly addOns?: ReadonlyMap<string, readonly string[]>;
  /** Local SavedPaymentMethod.id for off-session YooKassa charge. */
  readonly savedPaymentMethodId?: string;
  /** Per-request YooKassa bind-card intent (interactive only). */
  readonly savePaymentMethod?: boolean;
  /** Explicit consent to save method for autopay. */
  readonly savePaymentMethodConsent?: boolean;
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
    private readonly paymentSubscriptionMutationService: PaymentSubscriptionMutationService,
    private readonly profileSyncQueueService: ProfileSyncQueueService,
    private readonly settingsService: SettingsService,
    private readonly accessModeGuard: AccessModeGuard,
    private readonly savedPaymentMethodService: SavedPaymentMethodService,
  ) {}

  public async renewalCheckout(
    input: RenewalCheckoutInput,
  ): Promise<InternalPaymentCheckoutInterface> {
    const channel = input.channel ?? PurchaseChannel.WEB;

    const idempotencyKey =
      typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0
        ? input.idempotencyKey
        : null;
    const resolvedUserId =
      idempotencyKey !== null ? await resolveRenewalUserId(this.prismaService, input) : null;
    const requestFingerprint =
      idempotencyKey !== null && resolvedUserId !== null
        ? buildRenewalRequestFingerprint({ input, userId: resolvedUserId, channel })
        : null;

    if (idempotencyKey !== null && resolvedUserId !== null && requestFingerprint !== null) {
      const existing = await this.findByIdempotencyKey(resolvedUserId, idempotencyKey);
      if (existing !== null) {
        const persistedRequestFingerprint = readRenewalRequestFingerprint(existing.planSnapshot);
        if (
          persistedRequestFingerprint === null ||
          persistedRequestFingerprint !== requestFingerprint
        ) {
          throw new ConflictException({
            code: 'IDEMPOTENCY_KEY_CONFLICT',
            message: 'Idempotency key was already used for a different renewal request',
          });
        }
        const replay = this.replayOrConflict(existing, {
          checkoutFingerprint: existing.checkoutFingerprint,
          requestFingerprint,
        });
        this.assertExpectedQuote(input, replay.amount, replay.currency);
        if (replay.transactionStatus === TransactionStatus.PENDING && replay.checkoutUrl === null) {
          throw new ServiceUnavailableException({
            code: 'PROVIDER_CHECKOUT_CREATION_UNRESOLVED',
            message: 'Provider checkout creation is unresolved; awaiting reconciliation',
          });
        }
        return replay;
      }
    }

    // Persisted keyed replay is intentionally independent of mutable runtime
    // policy. A new checkout still passes the purchase gate before any gateway,
    // pricing, draft, or provider side effect.
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
      plans: input.plans,
      addOns: input.addOns,
    });

    // ── Request-level idempotency (T-007) ─────────────────────────────────
    // The canonical fingerprint covers the full renewal composition (each
    // line's plan/duration/term), NOT the total amount. A keyed request that
    // matches an existing draft replays it; the same key with a different
    // composition is an IDEMPOTENCY_KEY_CONFLICT. Keyless (legacy) requests
    // keep the heuristic amount+subscription-set draft reuse below.
    // Request-level key is resolved before pricing so a persisted keyed draft
    // can replay without consulting mutable catalog/gateway state.
    const checkoutFingerprint = buildRenewalCheckoutFingerprint({
      contractVersion: input.contractVersion ?? 1,
      userId: priced.userId,
      gatewayType: input.gatewayType,
      channel,
      currency: priced.currency,
      savedPaymentMethodId: input.savedPaymentMethodId ?? null,
      lines: priced.items.map((item) => ({
        subscriptionId: item.subscriptionId,
        planId: item.planId,
        durationDays: item.durationDays,
        termId: null,
        addOns: (item.addOnLines ?? []).map((addOn) => ({
          addOnId: addOn.addOnId,
          addOnRevision: addOn.catalogRevision,
          type: addOn.type,
          value: addOn.value,
          lifetime: addOn.lifetime,
          activation: addOn.activation,
        })),
      })),
    });
    const existing =
      idempotencyKey !== null
        ? await this.findByIdempotencyKey(priced.userId, idempotencyKey)
        : null;
    if (existing !== null) {
      const replay = this.replayOrConflict(existing, {
        checkoutFingerprint,
        requestFingerprint,
      });
      this.assertExpectedQuote(input, replay.amount, replay.currency);
      if (replay.transactionStatus === TransactionStatus.PENDING && replay.checkoutUrl === null) {
        throw new ServiceUnavailableException({
          code: 'PROVIDER_CHECKOUT_CREATION_UNRESOLVED',
          message: 'Provider checkout creation is unresolved; awaiting reconciliation',
        });
      }
      return replay;
    }

    this.assertExpectedQuote(input, priced.total, priced.currency);

    const draft =
      (await this.findExistingPendingDraft(
        priced,
        input.gatewayType,
        channel,
        checkoutFingerprint,
      )) ??
      (await this.createCombinedDraft(
        priced,
        input.gatewayType,
        channel,
        idempotencyKey,
        checkoutFingerprint,
        requestFingerprint,
      ));
    // A concurrent keyed request won the unique race — replay its draft.
    if ('replay' in draft) {
      this.assertExpectedQuote(input, draft.replay.amount, draft.replay.currency);
      if (
        draft.replay.transactionStatus === TransactionStatus.PENDING &&
        draft.replay.checkoutUrl === null
      ) {
        throw new ServiceUnavailableException({
          code: 'PROVIDER_CHECKOUT_CREATION_UNRESOLVED',
          message: 'Provider checkout creation is unresolved; awaiting reconciliation',
        });
      }
      return draft.replay;
    }
    const transaction = draft;

    // Reuse an already-created provider checkout (idempotent re-tap).
    const existingCheckoutUrl = readCheckoutUrl(transaction);
    if (existingCheckoutUrl !== null) {
      return mapCheckoutResponse({
        transaction,
        checkoutUrl: existingCheckoutUrl,
        providerMode: readProviderMode(transaction) ?? 'REDIRECT',
      });
    }

    // Zero-total renewal (e.g. a 100% discount fully covers the renewal):
    // there is no real payment to create and a provider would reject a 0
    // amount. Complete the combined-renewal draft and fulfill every item
    // directly, mirroring the zero-total path in PaymentsCheckoutService —
    // the user's subscriptions are renewed instead of a "payment failed".
    // Paid money (amount > 0) never fulfills here — only after webhook SUCCESS.
    if (Number(transaction.amount) <= 0) {
      const claimedAt = await claimForImmediateFulfillment(this.prismaService, transaction.id);
      if (claimedAt === null) {
        const current = await this.prismaService.transaction.findUnique({ where: { id: transaction.id } });
        if (current?.status === TransactionStatus.COMPLETED && current.fulfilledAt !== null) {
          return mapCheckoutResponse({ transaction: current, checkoutUrl: null, providerMode: 'NONE' });
        }
        throw new ConflictException('Zero-value renewal checkout is already being fulfilled');
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

    const providerClaim = `${PROVIDER_CREATION_CLAIM_PREFIX}${transaction.paymentId}`;
    const claim = await this.prismaService.transaction.updateMany({
      where: {
        id: transaction.id,
        status: TransactionStatus.PENDING,
        gatewayId: null,
        checkoutUrl: null,
      },
      data: { gatewayId: providerClaim },
    });
    if (claim.count !== 1) {
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
        // Off-session drafts can settle without checkoutUrl; replay once gatewayId is real.
        if (
          typeof current.gatewayId === 'string' &&
          current.gatewayId.length > 0 &&
          !current.gatewayId.startsWith(PROVIDER_CREATION_CLAIM_PREFIX)
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

    let providerCheckout: Awaited<
      ReturnType<PaymentProviderExecutionService['createCheckout']>
    >;
    let providerSubmissionStarted = false;
    try {
      const createProviderCheckout = async (
        chargedMethod: { readonly id: string; readonly providerMethodId: string } | null,
      ) => {
        providerSubmissionStarted = true;
        return this.paymentProviderExecutionService.createCheckout({
          gateway,
          transaction,
          description: `RENEW x${priced.items.length}`,
          successUrl: input.successUrl ?? null,
          failUrl: input.failUrl ?? null,
          paymentMethodId: chargedMethod?.providerMethodId ?? null,
          savedPaymentMethodId: chargedMethod?.id ?? null,
          savePaymentMethod: input.savePaymentMethod,
          savePaymentMethodConsent: input.savePaymentMethodConsent,
        });
      };
      providerCheckout =
        typeof input.savedPaymentMethodId === 'string' && input.savedPaymentMethodId.length > 0
          ? await this.savedPaymentMethodService.withActiveForCharge(
              {
                userId: transaction.userId,
                savedPaymentMethodId: input.savedPaymentMethodId,
                gatewayType: input.gatewayType,
              },
              createProviderCheckout,
            )
          : await createProviderCheckout(null);
      if (
        providerCheckout === null ||
        typeof providerCheckout !== 'object' ||
        typeof providerCheckout.gatewayId !== 'string' ||
        providerCheckout.gatewayId.length === 0 ||
        // Off-session charges may complete without a hosted checkout URL.
        (typeof providerCheckout.checkoutUrl === 'string'
          ? providerCheckout.checkoutUrl.length === 0 &&
            providerCheckout.providerMode === 'REDIRECT'
          : providerCheckout.providerMode === 'REDIRECT')
      ) {
        throw new ServiceUnavailableException({
          code: 'PROVIDER_CHECKOUT_RESULT_INVALID',
          message: 'Payment provider returned an incomplete checkout result',
        });
      }
    } catch (error: unknown) {
      // Failures before provider submission are authoritative and can release
      // the attempt. Once submission starts, a timeout or malformed response
      // is ambiguous: the provider may have charged successfully. Preserve the
      // payment-id-bound claim so the same cycle cannot create attempt a2.
      if (!providerSubmissionStarted) {
        await this.failClaimedProviderCreation(transaction.id, providerClaim);
      }
      throw error;
    }

    // Persist provider ids. If YooKassa already returned succeeded (off-session
    // capture), fulfill immediately so autopay does not wait on webhook lag.
    // Webhook path remains the source of truth for PENDING / redirect / 3DS.
    const updatedTransaction = await this.prismaService.transaction.update({
      where: { id: transaction.id },
      data: {
        gatewayId: providerCheckout.gatewayId,
        gatewayData: providerCheckout.gatewayData as Prisma.InputJsonValue,
        checkoutUrl: providerCheckout.checkoutUrl,
      },
    });

    if (isProviderCanceled(providerCheckout.providerStatus)) {
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

    if (isProviderSucceeded(providerCheckout.providerStatus)) {
      const claimedAt = await claimForImmediateFulfillment(this.prismaService, transaction.id);
      if (claimedAt !== null) {
        const completedTransaction = await this.prismaService.transaction.findUniqueOrThrow({
          where: { id: transaction.id },
        });
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
          // Mirror reconciler: release only this claim so a webhook/retry can
          // re-provision instead of leaving paid-but-undelivered. Fenced so a
          // delayed former claimant cannot erase a newer lease.
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

  /**
   * Releases a provider-create claim only when checkout fails before the
   * external submission begins. Ambiguous external outcomes remain PENDING
   * for reconciliation against the original payment id.
   */
  private async failClaimedProviderCreation(
    transactionId: string,
    providerClaim: string,
  ): Promise<void> {
    try {
      await this.prismaService.transaction.updateMany({
        where: {
          id: transactionId,
          status: TransactionStatus.PENDING,
          gatewayId: providerClaim,
        },
        data: {
          status: TransactionStatus.FAILED,
          gatewayId: null,
        },
      });
    } catch {
      // best-effort; original provider error is rethrown by caller
    }
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
    idempotencyKey: string | null,
    checkoutFingerprint: string,
    requestFingerprint: string | null,
  ): Promise<Transaction | { readonly replay: InternalPaymentCheckoutInterface }> {
    try {
      return await this.prismaService.$transaction(async (tx) => {
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
              snapshotVersion: 1,
              itemCount: priced.items.length,
              snapshotSource: 'RENEWAL_DRAFT',
              ...(requestFingerprint === null
                ? {}
                : { renewalRequestFingerprint: requestFingerprint }),
            } as Prisma.InputJsonValue,
            deviceTypes: [],
            idempotencyKey,
            checkoutFingerprint,
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
            addOnLines:
              (item.addOnLines ?? []).length > 0
                ? (item.addOnLines as unknown as Prisma.InputJsonValue)
                : Prisma.JsonNull,
          })),
        });
        return created;
      });
    } catch (error: unknown) {
      // A concurrent keyed request created the draft first — replay the winner.
      if (
        idempotencyKey !== null &&
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const existing = await this.findByIdempotencyKey(priced.userId, idempotencyKey);
        if (existing !== null) {
          return {
            replay: this.replayOrConflict(existing, {
              checkoutFingerprint,
              requestFingerprint,
            }),
          };
        }
      }
      throw error;
    }
  }

  private assertExpectedQuote(
    input: RenewalCheckoutInput,
    actualAmount: string,
    actualCurrency: Currency,
  ): void {
    if (input.expectedAmount === undefined && input.expectedCurrency === undefined) {
      return;
    }
    let amountMatches = false;
    try {
      amountMatches =
        input.expectedAmount !== undefined &&
        new Prisma.Decimal(input.expectedAmount).equals(new Prisma.Decimal(actualAmount));
    } catch {
      amountMatches = false;
    }
    if (!amountMatches || input.expectedCurrency !== actualCurrency) {
      throw new ConflictException({
        code: 'QUOTE_CHANGED',
        message: 'Renewal quote changed; refresh the review before paying',
        currentAmount: actualAmount,
        currentCurrency: actualCurrency,
      });
    }
  }

  private findByIdempotencyKey(
    userId: string,
    idempotencyKey: string,
  ): Promise<ExistingRenewalDraft | null> {
    return this.prismaService.transaction.findFirst({
      where: { userId, idempotencyKey },
      select: {
        paymentId: true,
        status: true,
        gatewayType: true,
        purchaseType: true,
        amount: true,
        currency: true,
        planSnapshot: true,
        gatewayData: true,
        checkoutUrl: true,
        createdAt: true,
        checkoutFingerprint: true,
      },
    });
  }

  /** Same composition → replay the existing draft; different → conflict. */
  private replayOrConflict(
    existing: ExistingRenewalDraft,
    input: {
      readonly checkoutFingerprint: string | null;
      readonly requestFingerprint: string | null;
    },
  ): InternalPaymentCheckoutInterface {
    const persistedRequestFingerprint = readRenewalRequestFingerprint(existing.planSnapshot);
    const requestMatches =
      input.requestFingerprint !== null && persistedRequestFingerprint === input.requestFingerprint;
    const checkoutMatches =
      input.checkoutFingerprint !== null &&
      existing.checkoutFingerprint === input.checkoutFingerprint;
    if (!requestMatches && !checkoutMatches) {
      throw new ConflictException({
        code: 'IDEMPOTENCY_KEY_CONFLICT',
        message: 'Idempotency key was already used for a different renewal composition',
      });
    }
    const checkoutUrl = existing.checkoutUrl ?? readCheckoutUrlFromData(existing.gatewayData);
    return {
      paymentId: existing.paymentId,
      transactionStatus: existing.status,
      gatewayType: existing.gatewayType,
      purchaseType: existing.purchaseType,
      amount: existing.amount.toString(),
      currency: existing.currency,
      checkoutUrl,
      providerMode: checkoutUrl !== null ? 'REDIRECT' : 'NONE',
      createdAt: existing.createdAt.toISOString(),
    };
  }

  /**
   * Finds a reusable PENDING combined draft for the same full persisted
   * checkout composition. Amount + subscription set remain cheap candidate
   * filters, but the canonical fingerprint is the authoritative match.
   */
  private async findExistingPendingDraft(
    priced: PricedRenewalInterface,
    gatewayType: PaymentGatewayType,
    channel: PurchaseChannel,
    checkoutFingerprint: string,
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
      if (candidate.checkoutFingerprint !== checkoutFingerprint) {
        continue;
      }
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

interface ExistingRenewalDraft {
  readonly paymentId: string;
  readonly status: TransactionStatus;
  readonly gatewayType: PaymentGatewayType;
  readonly purchaseType: PurchaseType;
  readonly amount: Prisma.Decimal;
  readonly currency: Currency;
  readonly planSnapshot: Prisma.JsonValue;
  readonly gatewayData: Prisma.JsonValue;
  readonly checkoutUrl: string | null;
  readonly createdAt: Date;
  readonly checkoutFingerprint: string | null;
}

function buildRenewalRequestFingerprint(input: {
  readonly input: RenewalCheckoutInput;
  readonly userId: string;
  readonly channel: PurchaseChannel;
}): string {
  return fingerprint({
    kind: 'RENEWAL_REQUEST',
    contractVersion: input.input.contractVersion ?? 1,
    userId: input.userId,
    gatewayType: input.input.gatewayType,
    channel: input.channel,
    savedPaymentMethodId: input.input.savedPaymentMethodId ?? null,
    subscriptionIds: [...new Set(input.input.subscriptionIds)].sort(),
    durations: [...(input.input.durations?.entries() ?? [])]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([subscriptionId, days]) => ({ subscriptionId, days })),
    plans: [...(input.input.plans?.entries() ?? [])]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([subscriptionId, planId]) => ({ subscriptionId, planId })),
    addOns: [...(input.input.addOns?.entries() ?? [])]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([subscriptionId, addOnIds]) => ({ subscriptionId, addOnIds: [...addOnIds].sort() })),
  });
}

function readRenewalRequestFingerprint(snapshot: Prisma.JsonValue): string | null {
  if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) return null;
  const value = (snapshot as Record<string, unknown>)['renewalRequestFingerprint'];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readCheckoutUrlFromData(gatewayData: Prisma.JsonValue): string | null {
  const record =
    typeof gatewayData === 'object' && gatewayData !== null && !Array.isArray(gatewayData)
      ? (gatewayData as Record<string, unknown>)
      : {};
  const value = record['checkoutUrl'];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readGatewayRecord(transaction: Transaction): Record<string, unknown> {
  const value = transaction.gatewayData;
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readCheckoutUrl(transaction: Transaction): string | null {
  if (typeof transaction.checkoutUrl === 'string' && transaction.checkoutUrl.length > 0) {
    return transaction.checkoutUrl;
  }
  const value = readGatewayRecord(transaction)['checkoutUrl'];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readProviderMode(transaction: Transaction): string | null {
  const value = readGatewayRecord(transaction)['providerMode'];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

async function resolveRenewalUserId(
  prisma: PrismaService,
  input: RenewalCheckoutInput,
): Promise<string> {
  const suppliedUserId =
    typeof input.userId === 'string' && input.userId.length > 0 ? input.userId : null;
  if (typeof input.telegramId === 'string' && input.telegramId.length > 0) {
    const user = await prisma.user.findUnique({
      where: { telegramId: BigInt(input.telegramId) },
      select: { id: true },
    });
    if (user !== null && (suppliedUserId === null || user.id === suppliedUserId)) return user.id;
    if (suppliedUserId !== null) {
      throw new BadRequestException('userId and telegramId refer to different users');
    }
    if (user !== null) return user.id;
  }
  if (suppliedUserId !== null) return suppliedUserId;
  throw new BadRequestException('A userId or telegramId is required');
}
