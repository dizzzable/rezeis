import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { PaymentGatewayType, Prisma, TariffConstructorModuleType, Transaction, TransactionStatus } from '@prisma/client';

import { PrismaService } from '../../common/prisma/prisma.service';
import { InternalPaymentCheckoutInterface } from '../payments/interfaces/internal-payment-checkout.interface';
import { isProviderCreationUnresolved, PaymentCheckoutExecutorService, unresolvedProviderCheckout } from '../payments/services/payment-checkout-executor.service';
import { fingerprint } from '../payments/utils/checkout-fingerprint.util';
import { isCurrencySupportedByGateway } from '../payments/utils/gateway-supported-currencies.util';
import { isGatewayConfigured } from '../payments/utils/payment-gateway-settings.util';
import { AccessModeGuard } from '../settings/services/access-mode-guard.service';
import { SettingsService } from '../settings/services/settings.service';
import { SubscriptionQuoteService } from '../subscriptions/services/subscription-quote.service';
import { CheckoutTariffConstructorDto } from './dto/tariff-constructor.dto';
import { TARIFF_CONSTRUCTOR_SNAPSHOT_SOURCE, TARIFF_CONSTRUCTOR_SNAPSHOT_VERSION, TariffConstructorSnapshot } from './tariff-constructor-snapshot';
import { TariffConstructorService } from './tariff-constructor.service';

@Injectable()
export class TariffConstructorCheckoutService {
  public constructor(private readonly prisma: PrismaService, private readonly catalog: TariffConstructorService, private readonly executor: PaymentCheckoutExecutorService, private readonly settings: SettingsService, private readonly access: AccessModeGuard, private readonly subscriptionQuote: SubscriptionQuoteService) {}

  public async checkout(input: CheckoutTariffConstructorDto): Promise<InternalPaymentCheckoutInterface> {
    const userId = await this.resolveUserId(input);
    const requestFingerprint = fingerprint({ kind: 'TARIFF_CONSTRUCTOR', userId, revisionId: input.revisionId, durationDays: input.durationDays, currency: input.currency, selections: normalizeSelections(input.selections), gatewayType: input.gatewayType, channel: input.channel, purchaseType: input.purchaseType, savedPaymentMethodId: input.savedPaymentMethodId ?? null });
    const existing = await this.findByKey(userId, input.idempotencyKey);
    if (existing !== null) return this.replayOrConflict(existing, requestFingerprint, input);

    const policy = await this.settings.getInternalPlatformPolicy();
    const rejection = this.access.evaluate({ gate: 'purchase.new', mode: policy.accessMode });
    if (rejection !== null) throw rejection.status === 503 ? new ServiceUnavailableException({ code: rejection.code, message: rejection.message }) : new ForbiddenException({ code: rejection.code, message: rejection.message });
    const capacity = await this.subscriptionQuote.getSubscriptionCapacity(userId);
    if (!capacity.capacityAvailable) throw new BadRequestException({ code: 'SUBSCRIPTION_LIMIT_REACHED', message: 'The user has reached the maximum number of active subscriptions.' });
    if (input.gatewayType !== PaymentGatewayType.YOOKASSA) throw new BadRequestException('TARIFF_CONSTRUCTOR_GATEWAY_UNSUPPORTED');

    const revision = await this.catalog.getEffectiveRevision();
    if (revision === null) throw new NotFoundException('TARIFF_CONSTRUCTOR_UNAVAILABLE');
    if (revision.id !== input.revisionId) throw new ConflictException('TARIFF_CONSTRUCTOR_REVISION_MISMATCH');
    const quote = await this.catalog.quote(input);
    if (quote.currency !== input.expectedCurrency || new Prisma.Decimal(quote.total).cmp(input.expectedAmount) !== 0) throw new ConflictException({ code: 'TARIFF_CONSTRUCTOR_QUOTE_MISMATCH', amount: quote.total, currency: quote.currency });
    const gateway = await this.prisma.paymentGateway.findUnique({ where: { type: input.gatewayType } });
    if (gateway === null) throw new BadRequestException('PAYMENT_GATEWAY_NOT_ACTIVE');
    if (!new Prisma.Decimal(quote.total).isZero()) {
      if (!gateway.isActive) throw new BadRequestException('PAYMENT_GATEWAY_NOT_ACTIVE');
      if (!isGatewayConfigured(gateway.type, gateway.settings)) throw new BadRequestException('PAYMENT_GATEWAY_NOT_CONFIGURED');
      if (!isCurrencySupportedByGateway(gateway.type, input.currency) || gateway.currency !== input.currency) throw new BadRequestException('PAYMENT_GATEWAY_CURRENCY_UNSUPPORTED');
    }
    const basePlan = await this.prisma.plan.findFirst({ where: { id: revision.basePlanId, isActive: true, isArchived: false } });
    if (basePlan === null) throw new BadRequestException('TARIFF_CONSTRUCTOR_BASE_PLAN_UNAVAILABLE');
    const selections = normalizeSelections(input.selections);
    const trafficLimit = selections.find((row) => row.type === TariffConstructorModuleType.TRAFFIC)?.value;
    const deviceLimit = selections.find((row) => row.type === TariffConstructorModuleType.DEVICES)?.value;
    if (trafficLimit === undefined || deviceLimit === undefined || trafficLimit < 1 || deviceLimit < 1) throw new BadRequestException('TARIFF_CONSTRUCTOR_LIMITS_UNSUPPORTED');
    const snapshot: TariffConstructorSnapshot = { snapshotSource: TARIFF_CONSTRUCTOR_SNAPSHOT_SOURCE, snapshotVersion: TARIFF_CONSTRUCTOR_SNAPSHOT_VERSION, revisionId: revision.id, revision: revision.version, selections, lines: quote.lines.map((line) => ({ kind: line.kind, module: line.module ?? null, value: line.value ?? null, steps: line.steps ?? null, perStepAmount: line.perStepAmount ?? null, amount: line.amount })), amount: quote.total, currency: quote.currency, basePlan: { id: basePlan.id, name: basePlan.name, description: basePlan.description, tag: basePlan.tag, type: basePlan.type, icon: basePlan.icon, trafficLimitStrategy: basePlan.trafficLimitStrategy, internalSquads: basePlan.internalSquads, externalSquad: basePlan.externalSquad }, trafficLimit, deviceLimit, durationDays: input.durationDays, channel: input.channel, gatewayType: input.gatewayType, purchaseType: input.purchaseType };
    let transaction: Transaction;
    try { transaction = await this.prisma.transaction.create({ data: { userId, status: TransactionStatus.PENDING, purchaseType: input.purchaseType, channel: input.channel, gatewayType: input.gatewayType, currency: quote.currency, amount: quote.total, planSnapshot: snapshot as unknown as Prisma.InputJsonValue, idempotencyKey: input.idempotencyKey, checkoutFingerprint: requestFingerprint } }); }
    catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const winner = await this.findByKey(userId, input.idempotencyKey);
        if (winner !== null) return this.replayOrConflict(winner, requestFingerprint, input);
      }
      throw error;
    }
    return this.executor.execute({ transaction, gateway, description: `Custom plan ${basePlan.name} ${input.durationDays}d`.slice(0, 128), successUrl: input.successUrl, failUrl: input.failUrl, savedPaymentMethodId: input.savedPaymentMethodId, savePaymentMethod: input.savePaymentMethod, savePaymentMethodConsent: input.savePaymentMethodConsent });
  }

  private async resolveUserId(input: { readonly userId?: string; readonly telegramId?: string }): Promise<string> {
    if (input.userId) { const user = await this.prisma.user.findUnique({ where: { id: input.userId }, select: { id: true } }); if (user !== null) return user.id; }
    if (input.telegramId) { const user = await this.prisma.user.findUnique({ where: { telegramId: BigInt(input.telegramId) }, select: { id: true } }); if (user !== null) return user.id; }
    throw new NotFoundException('User not found');
  }

  private findByKey(userId: string, idempotencyKey: string): Promise<Transaction | null> { return this.prisma.transaction.findFirst({ where: { userId, idempotencyKey } }); }
  private replayOrConflict(existing: Transaction, expectedFingerprint: string, input: CheckoutTariffConstructorDto): InternalPaymentCheckoutInterface {
    if (existing.checkoutFingerprint !== expectedFingerprint) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_CONFLICT', message: 'Idempotency key was already used for a different checkout' });
    if (existing.currency !== input.expectedCurrency || existing.amount.cmp(input.expectedAmount) !== 0) throw new ConflictException({ code: 'TARIFF_CONSTRUCTOR_QUOTE_MISMATCH', amount: existing.amount.toString(), currency: existing.currency });
    if (isProviderCreationUnresolved(existing)) throw unresolvedProviderCheckout();
    return { paymentId: existing.paymentId, transactionStatus: existing.status, gatewayType: existing.gatewayType, purchaseType: existing.purchaseType, amount: existing.amount.toString(), currency: existing.currency, checkoutUrl: existing.checkoutUrl, providerMode: existing.checkoutUrl === null ? 'NONE' : 'REDIRECT', createdAt: existing.createdAt.toISOString() };
  }
}

function normalizeSelections(input: readonly { readonly type: TariffConstructorModuleType; readonly value: number }[]): Array<{ readonly type: TariffConstructorModuleType; readonly value: number }> { return [...input].sort((left, right) => left.type.localeCompare(right.type)); }
