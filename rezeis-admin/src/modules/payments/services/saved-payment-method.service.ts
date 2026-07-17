import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PaymentGatewayType, Prisma } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { EVENT_TYPES, SystemEventsService } from '../../../common/services/system-events.service';

const CHARGE_LOCK_TIMEOUT_MS = 30_000;

/**
 * Persists provider-saved payment instruments (YooKassa `payment_method`) and
 * exposes list/unbind for the user cabinet.
 *
 * Unbind is intentionally local: YooKassa has no merchant "detach card" API.
 * After unbind we stop using `providerMethodId` for off-session charges.
 */
@Injectable()
export class SavedPaymentMethodService {
  private readonly logger = new Logger(SavedPaymentMethodService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly systemEvents: SystemEventsService,
  ) {}

  public async listActiveForUser(userId: string) {
    const methods = await this.prismaService.savedPaymentMethod.findMany({
      where: { userId, isActive: true },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        gatewayType: true,
        providerMethodId: true,
        methodType: true,
        title: true,
        cardLast4: true,
        cardFirst6: true,
        cardExpiryMonth: true,
        cardExpiryYear: true,
        cardIssuerCountry: true,
        cardProduct: true,
        autopayEnabled: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return {
      methods: methods.map((method) => ({
        id: method.id,
        gatewayType: method.gatewayType,
        methodType: method.methodType,
        title: method.title ?? buildDisplayTitle(method),
        cardLast4: method.cardLast4,
        cardFirst6: method.cardFirst6,
        cardExpiryMonth: method.cardExpiryMonth,
        cardExpiryYear: method.cardExpiryYear,
        cardIssuerCountry: method.cardIssuerCountry,
        cardProduct: method.cardProduct,
        autopayEnabled: method.autopayEnabled,
        createdAt: method.createdAt.toISOString(),
        updatedAt: method.updatedAt.toISOString(),
      })),
      total: methods.length,
    };
  }

  /**
   * Soft-unbinds a saved method owned by the user. Idempotent when already inactive.
   */
  public async unbindForUser(
    userId: string,
    methodId: string,
  ): Promise<{ unbound: true; id: string }> {
    const { updated, changed } = await this.prismaService.$transaction(
      async (tx) => {
        await this.lockForChargeDecision(tx, methodId);
        const existing = await tx.savedPaymentMethod.findFirst({
          where: { id: methodId, userId },
        });
        if (existing === null) {
          throw new NotFoundException('Saved payment method not found');
        }
        if (!existing.isActive) {
          return { updated: existing, changed: false };
        }
        const updated = await tx.savedPaymentMethod.update({
          where: { id: existing.id },
          data: {
            isActive: false,
            unboundAt: new Date(),
          },
        });
        return { updated, changed: true };
      },
      { timeout: CHARGE_LOCK_TIMEOUT_MS },
    );

    if (!changed) {
      return { unbound: true, id: updated.id };
    }

    this.systemEvents.info(
      EVENT_TYPES.PAYMENT_METHOD_UNBOUND,
      'PAYMENT',
      `Способ оплаты отвязан пользователем: ${updated.methodType}`,
      {
        userId,
        savedPaymentMethodId: updated.id,
        gatewayType: updated.gatewayType,
        methodType: updated.methodType,
        cardLast4: updated.cardLast4,
        providerMethodId: updated.providerMethodId,
      },
    );

    return { unbound: true, id: updated.id };
  }

  /**
   * Enables/disables autopay for a bound method without unbinding it.
   * Card stays listed; resolveActiveForCharge rejects when disabled.
   */
  public async setAutopayEnabledForUser(
    userId: string,
    methodId: string,
    autopayEnabled: boolean,
  ): Promise<{ id: string; autopayEnabled: boolean }> {
    const { updated, changed } = await this.prismaService.$transaction(
      async (tx) => {
        await this.lockForChargeDecision(tx, methodId);
        const existing = await tx.savedPaymentMethod.findFirst({
          where: { id: methodId, userId, isActive: true },
        });
        if (existing === null) {
          throw new NotFoundException('Saved payment method not found');
        }
        if (existing.autopayEnabled === autopayEnabled) {
          return { updated: existing, changed: false };
        }
        const updated = await tx.savedPaymentMethod.update({
          where: { id: existing.id },
          data: { autopayEnabled },
          select: {
            id: true,
            autopayEnabled: true,
            gatewayType: true,
            methodType: true,
            cardLast4: true,
            providerMethodId: true,
          },
        });
        return { updated, changed: true };
      },
      { timeout: CHARGE_LOCK_TIMEOUT_MS },
    );

    if (!changed) {
      return { id: updated.id, autopayEnabled: updated.autopayEnabled };
    }

    this.systemEvents.info(
      EVENT_TYPES.PAYMENT_METHOD_AUTOPAY_UPDATED,
      'PAYMENT',
      autopayEnabled
        ? `Автосписание включено: ${updated.methodType}`
        : `Автосписание отключено: ${updated.methodType}`,
      {
        userId,
        savedPaymentMethodId: updated.id,
        autopayEnabled: updated.autopayEnabled,
        gatewayType: updated.gatewayType,
        methodType: updated.methodType,
        cardLast4: updated.cardLast4,
        providerMethodId: updated.providerMethodId,
      },
    );

    return { id: updated.id, autopayEnabled: updated.autopayEnabled };
  }

  /**
   * Picks the newest chargeable saved method for autopay (active + autopay on).
   * Prefer YOOKASSA — currently the only off-session charge path.
   */
  public async findPreferredForCharge(userId: string): Promise<{
    readonly id: string;
    readonly gatewayType: PaymentGatewayType;
    readonly providerMethodId: string;
  } | null> {
    const method = await this.prismaService.savedPaymentMethod.findFirst({
      where: {
        userId,
        isActive: true,
        autopayEnabled: true,
        gatewayType: PaymentGatewayType.YOOKASSA,
        providerMethodId: { not: '' },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        gatewayType: true,
        providerMethodId: true,
      },
    });
    if (method === null) {
      return null;
    }
    const providerMethodId = method.providerMethodId.trim();
    if (providerMethodId.length === 0 || providerMethodId.startsWith('demo_pm_')) {
      return null;
    }
    return {
      id: method.id,
      gatewayType: method.gatewayType,
      providerMethodId,
    };
  }

  /**
   * Resolves a user-owned active saved method for off-session charge.
   * Returns the local id + provider payment_method.id used by YooKassa.
   */
  public async resolveActiveForCharge(input: {
    readonly userId: string;
    readonly savedPaymentMethodId: string;
    readonly gatewayType: PaymentGatewayType;
  }): Promise<{ readonly id: string; readonly providerMethodId: string }> {
    return this.withActiveForCharge(input, async (method) => method);
  }

  /**
   * Serializes provider submission with disable/unbind on the saved-method row.
   * The callback must cover only the provider submission, not later fulfillment.
   */
  public async withActiveForCharge<T>(
    input: {
      readonly userId: string;
      readonly savedPaymentMethodId: string;
      readonly gatewayType: PaymentGatewayType;
    },
    submit: (method: { readonly id: string; readonly providerMethodId: string }) => Promise<T>,
  ): Promise<T> {
    return this.prismaService.$transaction(
      async (tx) => {
        await this.lockForChargeDecision(tx, input.savedPaymentMethodId);
        const method = await tx.savedPaymentMethod.findFirst({
          where: {
            id: input.savedPaymentMethodId,
            userId: input.userId,
            isActive: true,
          },
          select: {
            id: true,
            gatewayType: true,
            providerMethodId: true,
            autopayEnabled: true,
          },
        });
        const resolved = this.assertChargeableMethod(method, input.gatewayType);
        return submit(resolved);
      },
      { timeout: CHARGE_LOCK_TIMEOUT_MS },
    );
  }

  private assertChargeableMethod(
    method: {
      readonly id: string;
      readonly gatewayType: PaymentGatewayType;
      readonly providerMethodId: string;
      readonly autopayEnabled: boolean;
    } | null,
    gatewayType: PaymentGatewayType,
  ): { readonly id: string; readonly providerMethodId: string } {
    if (method === null) {
      throw new BadRequestException({
        code: 'SAVED_PAYMENT_METHOD_NOT_FOUND',
        message: 'Saved payment method not found or inactive',
      });
    }
    if (!method.autopayEnabled) {
      throw new BadRequestException({
        code: 'SAVED_PAYMENT_METHOD_AUTOPAY_DISABLED',
        message: 'Autopay is disabled for this payment method',
      });
    }
    if (method.gatewayType !== gatewayType) {
      throw new BadRequestException({
        code: 'SAVED_PAYMENT_METHOD_GATEWAY_MISMATCH',
        message: 'Saved payment method does not match the selected gateway',
      });
    }
    if (
      typeof method.providerMethodId !== 'string' ||
      method.providerMethodId.trim().length === 0
    ) {
      throw new BadRequestException({
        code: 'SAVED_PAYMENT_METHOD_INVALID',
        message: 'Saved payment method has no provider instrument id',
      });
    }
    return {
      id: method.id,
      providerMethodId: method.providerMethodId.trim(),
    };
  }

  private async lockForChargeDecision(
    tx: Prisma.TransactionClient,
    methodId: string,
  ): Promise<void> {
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "saved_payment_methods" WHERE "id" = ${methodId} FOR UPDATE`,
    );
  }

  /**
   * Upserts a YooKassa (or compatible) saved payment_method from a successful payment.
   * Safe to call on every COMPLETED reconciliation — unique on (gateway, providerMethodId).
   */
  public async upsertFromYookassaPayment(input: {
    readonly userId: string;
    readonly transactionId: string;
    readonly gatewayId: string | null;
    readonly rawPayload: unknown;
  }): Promise<void> {
    const paymentObject = extractYookassaPaymentObject(input.rawPayload);
    if (paymentObject === null) {
      return;
    }

    const paymentMethod = asRecord(paymentObject.payment_method);
    if (paymentMethod === null) {
      return;
    }

    // Only store methods the provider marked as reusable for autopayments.
    if (paymentMethod.saved !== true) {
      return;
    }

    const providerMethodId = readString(paymentMethod.id);
    if (providerMethodId === null) {
      return;
    }

    const methodType = readString(paymentMethod.type) ?? 'unknown';
    const card = asRecord(paymentMethod.card);
    const cardLast4 = readString(card?.last4);
    const cardFirst6 = readString(card?.first6);
    const cardExpiryMonth = readString(card?.expiry_month);
    const cardExpiryYear = readString(card?.expiry_year);
    const cardIssuerCountry = readString(card?.issuer_country);
    const cardProduct =
      readString(asRecord(card?.card_product)?.name) ?? readString(card?.card_type);
    const title =
      readString(paymentMethod.title) ??
      buildDisplayTitle({
        methodType,
        cardLast4,
        cardProduct,
      });

    const rawSnapshot = {
      id: providerMethodId,
      type: methodType,
      saved: true,
      title,
      card: card
        ? {
            first6: cardFirst6,
            last4: cardLast4,
            expiry_month: cardExpiryMonth,
            expiry_year: cardExpiryYear,
            issuer_country: cardIssuerCountry,
            card_product: cardProduct,
          }
        : null,
    } as Prisma.InputJsonValue;

    try {
      const existing = await this.prismaService.savedPaymentMethod.findUnique({
        where: {
          gatewayType_providerMethodId: {
            gatewayType: PaymentGatewayType.YOOKASSA,
            providerMethodId,
          },
        },
      });

      if (existing !== null) {
        // Re-bind if the user previously unbound the same provider method, or refresh metadata.
        await this.prismaService.savedPaymentMethod.update({
          where: { id: existing.id },
          data: {
            userId: input.userId,
            methodType,
            title,
            cardLast4,
            cardFirst6,
            cardExpiryMonth,
            cardExpiryYear,
            cardIssuerCountry,
            cardProduct,
            isActive: true,
            unboundAt: null,
            sourceTransactionId: existing.sourceTransactionId ?? input.transactionId,
            sourceGatewayId: existing.sourceGatewayId ?? input.gatewayId,
            rawSnapshot,
          },
        });
        return;
      }

      await this.prismaService.savedPaymentMethod.create({
        data: {
          userId: input.userId,
          gatewayType: PaymentGatewayType.YOOKASSA,
          providerMethodId,
          methodType,
          title,
          cardLast4,
          cardFirst6,
          cardExpiryMonth,
          cardExpiryYear,
          cardIssuerCountry,
          cardProduct,
          isActive: true,
          sourceTransactionId: input.transactionId,
          sourceGatewayId: input.gatewayId,
          rawSnapshot,
        },
      });

      this.systemEvents.info(
        EVENT_TYPES.PAYMENT_METHOD_SAVED,
        'PAYMENT',
        `Сохранён способ оплаты: ${methodType}`,
        {
          userId: input.userId,
          gatewayType: PaymentGatewayType.YOOKASSA,
          methodType,
          cardLast4,
          transactionId: input.transactionId,
          providerMethodId,
        },
      );
    } catch (error: unknown) {
      // Unique race: another webhook worker inserted the same method.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        this.logger.debug(
          `Saved payment method race for ${providerMethodId}; treating as upserted`,
        );
        return;
      }
      this.logger.error(
        `Failed to persist saved payment method for user ${input.userId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

function extractYookassaPaymentObject(rawPayload: unknown): Record<string, unknown> | null {
  const root = asRecord(rawPayload);
  if (root === null) {
    return null;
  }
  // Webhook shape: { event, object: { id, payment_method, ... } }
  const object = asRecord(root.object);
  if (object !== null && (object.payment_method !== undefined || object.id !== undefined)) {
    return object;
  }
  // Some paths may store the payment object itself.
  if (root.payment_method !== undefined) {
    return root;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function readString(value: unknown): string | null {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function buildDisplayTitle(input: {
  readonly methodType: string;
  readonly cardLast4?: string | null;
  readonly cardProduct?: string | null;
}): string {
  if (input.cardLast4) {
    const product = input.cardProduct ? `${input.cardProduct} ` : '';
    return `${product}•••• ${input.cardLast4}`.trim();
  }
  switch (input.methodType) {
    case 'bank_card':
      return 'Банковская карта';
    case 'yoo_money':
      return 'ЮMoney';
    case 'sberbank':
      return 'SberPay';
    case 'tinkoff_bank':
      return 'T-Pay';
    case 'sbp':
      return 'СБП';
    default:
      return input.methodType;
  }
}
