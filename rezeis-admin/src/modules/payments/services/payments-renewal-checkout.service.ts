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
import { buildRenewalCheckoutFingerprint } from '../utils/checkout-fingerprint.util';
import { PaymentProviderExecutionService } from './payment-provider-execution.service';
import { PaymentSubscriptionMutationService } from './payment-subscription-mutation.service';

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
  /** Optional per-subscription selected renewal add-on ids (T-007). Honored
   *  only when the `renewalAddOns` rollout flag is on. */
  readonly addOns?: ReadonlyMap<string, readonly string[]>;
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
      plans: input.plans,
      addOns: input.addOns,
    });

    // ── Request-level idempotency (T-007) ─────────────────────────────────
    // The canonical fingerprint covers the full renewal composition (each
    // line's plan/duration/term), NOT the total amount. A keyed request that
    // matches an existing draft replays it; the same key with a different
    // composition is an IDEMPOTENCY_KEY_CONFLICT. Keyless (legacy) requests
    // keep the heuristic amount+subscription-set draft reuse below.
    const idempotencyKey =
      typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0
        ? input.idempotencyKey
        : null;
    const checkoutFingerprint = buildRenewalCheckoutFingerprint({
      contractVersion: input.contractVersion ?? 1,
      userId: priced.userId,
      gatewayType: input.gatewayType,
      channel,
      currency: priced.currency,
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
    if (idempotencyKey !== null) {
      const existing = await this.findByIdempotencyKey(priced.userId, idempotencyKey);
      if (existing !== null) {
        return this.replayOrConflict(existing, checkoutFingerprint);
      }
    }

    const draft =
      (await this.findExistingPendingDraft(priced, input.gatewayType, channel)) ??
      (await this.createCombinedDraft(
        priced,
        input.gatewayType,
        channel,
        idempotencyKey,
        checkoutFingerprint,
      ));
    // A concurrent keyed request won the unique race — replay its draft.
    if ('replay' in draft) {
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
    if (Number(transaction.amount) <= 0) {
      const completedTransaction = await this.prismaService.transaction.update({
        where: { id: transaction.id },
        data: { status: TransactionStatus.COMPLETED },
      });
      const { syncJobs } =
        await this.paymentSubscriptionMutationService.applyCompletedTransaction(completedTransaction);
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
    idempotencyKey: string | null,
    checkoutFingerprint: string,
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
              itemCount: priced.items.length,
              snapshotSource: 'RENEWAL_DRAFT',
            } as Prisma.InputJsonValue,
            deviceTypes: [],
            idempotencyKey,
            checkoutFingerprint: idempotencyKey !== null ? checkoutFingerprint : null,
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
          return { replay: this.replayOrConflict(existing, checkoutFingerprint) };
        }
      }
      throw error;
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
        gatewayData: true,
        createdAt: true,
        checkoutFingerprint: true,
      },
    });
  }

  /** Same composition → replay the existing draft; different → conflict. */
  private replayOrConflict(
    existing: ExistingRenewalDraft,
    checkoutFingerprint: string,
  ): InternalPaymentCheckoutInterface {
    if (existing.checkoutFingerprint !== checkoutFingerprint) {
      throw new ConflictException({
        code: 'IDEMPOTENCY_KEY_CONFLICT',
        message: 'Idempotency key was already used for a different renewal composition',
      });
    }
    const checkoutUrl = readCheckoutUrlFromData(existing.gatewayData);
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

interface ExistingRenewalDraft {
  readonly paymentId: string;
  readonly status: TransactionStatus;
  readonly gatewayType: PaymentGatewayType;
  readonly purchaseType: PurchaseType;
  readonly amount: Prisma.Decimal;
  readonly currency: Currency;
  readonly gatewayData: Prisma.JsonValue;
  readonly createdAt: Date;
  readonly checkoutFingerprint: string | null;
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
  const value = readGatewayRecord(transaction)['checkoutUrl'];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readProviderMode(transaction: Transaction): string | null {
  const value = readGatewayRecord(transaction)['providerMode'];
  return typeof value === 'string' && value.length > 0 ? value : null;
}
