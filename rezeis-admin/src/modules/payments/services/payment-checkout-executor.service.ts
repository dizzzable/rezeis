import { ConflictException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { PaymentGateway, Prisma, Transaction, TransactionStatus } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { ProfileSyncQueueService } from '../../profile-sync/profile-sync-queue.service';
import { EVENT_TYPES, SystemEventsService } from '../../../common/services/system-events.service';
import { InternalPaymentCheckoutInterface } from '../interfaces/internal-payment-checkout.interface';
import { claimForImmediateFulfillment, releaseFulfillmentClaim } from './payment-fulfillment-claim.util';
import { PaymentProviderExecutionService } from './payment-provider-execution.service';
import { PaymentReconciliationService } from './payment-reconciliation.service';
import { PaymentSubscriptionMutationService } from './payment-subscription-mutation.service';
import { SavedPaymentMethodService } from './saved-payment-method.service';

export interface ExecutePaymentCheckoutInput {
  readonly transaction: Transaction;
  readonly gateway: PaymentGateway;
  readonly description: string;
  readonly successUrl?: string;
  readonly failUrl?: string;
  readonly savedPaymentMethodId?: string;
  readonly savePaymentMethod?: boolean;
  readonly savePaymentMethodConsent?: boolean;
}

const PROVIDER_CREATION_CLAIM_PREFIX = '__CHECKOUT_PROVIDER_CREATE__:';

@Injectable()
export class PaymentCheckoutExecutorService {
  public constructor(
    private readonly prisma: PrismaService,
    private readonly provider: PaymentProviderExecutionService,
    private readonly mutation: PaymentSubscriptionMutationService,
    private readonly queue: ProfileSyncQueueService,
    private readonly savedMethods: SavedPaymentMethodService,
    private readonly reconciliation: PaymentReconciliationService,
    private readonly events: SystemEventsService,
  ) {}

  public async execute(input: ExecutePaymentCheckoutInput): Promise<InternalPaymentCheckoutInterface> {
    if (input.transaction.checkoutUrl !== null) return map(input.transaction, input.transaction.checkoutUrl, 'REDIRECT');
    if (input.transaction.status !== TransactionStatus.PENDING) return map(input.transaction, input.transaction.checkoutUrl, input.transaction.checkoutUrl === null ? 'NONE' : 'REDIRECT');
    if (input.transaction.amount.isZero()) return this.fulfill(input.transaction, false, 'NONE');
    const providerClaim = `${PROVIDER_CREATION_CLAIM_PREFIX}${input.transaction.paymentId}`;
    const create = async (savedMethod: { readonly id: string; readonly providerMethodId: string } | null) => {
      const claim = await this.prisma.transaction.updateMany({ where: { id: input.transaction.id, status: TransactionStatus.PENDING, gatewayId: null, checkoutUrl: null }, data: { gatewayId: providerClaim } });
      if (claim.count !== 1) throw unresolvedProviderCheckout();
      return this.provider.createCheckout({ gateway: input.gateway, transaction: input.transaction, description: input.description, successUrl: input.successUrl ?? null, failUrl: input.failUrl ?? null, paymentMethodId: savedMethod?.providerMethodId ?? null, savedPaymentMethodId: savedMethod?.id ?? null, savePaymentMethod: input.savePaymentMethod, savePaymentMethodConsent: input.savePaymentMethodConsent });
    };
    let updated: Transaction;
    let providerMode: string;
    let providerStatus: string;
    try {
      const checkout = input.savedPaymentMethodId
        ? await this.savedMethods.withActiveForCharge({ userId: input.transaction.userId, savedPaymentMethodId: input.savedPaymentMethodId, gatewayType: input.transaction.gatewayType }, create)
        : await create(null);
      updated = await this.prisma.transaction.update({ where: { id: input.transaction.id }, data: { gatewayId: checkout.gatewayId, gatewayData: checkout.gatewayData as Prisma.InputJsonValue, checkoutUrl: checkout.checkoutUrl } });
      providerMode = checkout.providerMode;
      providerStatus = String(checkout.providerStatus ?? '').toLowerCase();
    } catch (error: unknown) {
      const claimed = await this.prisma.transaction.findFirst({ where: { id: input.transaction.id, gatewayId: providerClaim }, select: { id: true } });
      if (claimed === null) throw error;
      const unresolvedAt = new Date().toISOString();
      await this.prisma.transaction.updateMany({ where: { id: input.transaction.id, gatewayId: providerClaim }, data: { gatewayData: { providerOutcome: 'UNKNOWN', providerCreateClaimedAt: unresolvedAt, providerRecovery: 'MANUAL_OR_WEBHOOK_ONLY', reason: 'PROVIDER_CREATE_UNAVAILABLE' } } }).catch(() => undefined);
      // YooKassa has no merchant-reference lookup in the current adapter. The
      // provider request itself is idempotent by paymentId, but retrying here
      // could still obscure an ambiguous response. Keep the durable claim,
      // surface it to operators, and rely only on webhook correlation/manual
      // review. Users can continue polling GET /api/internal/payments/:paymentId.
      this.events.warn(EVENT_TYPES.PAYMENT_FAILED, 'PAYMENT', 'Payment provider create outcome requires review', { paymentId: input.transaction.paymentId, gatewayType: input.transaction.gatewayType, providerOutcome: 'UNKNOWN', recovery: 'MANUAL_OR_WEBHOOK_ONLY' });
      throw error;
    }
    if (providerStatus === 'canceled' || providerStatus === 'cancelled') {
      const canceled = await this.prisma.transaction.update({ where: { id: updated.id }, data: { status: TransactionStatus.CANCELED } });
      return map(canceled, null, providerMode);
    }
    if (providerStatus === 'succeeded') return this.fulfill(updated, true, providerMode);
    return map(updated, updated.checkoutUrl, providerMode);
  }

  private async fulfill(transaction: Transaction, paid: boolean, providerMode: string): Promise<InternalPaymentCheckoutInterface> {
    const claimedAt = await claimForImmediateFulfillment(this.prisma, transaction.id);
    if (claimedAt === null) {
      const current = await this.prisma.transaction.findUnique({ where: { id: transaction.id } });
      if (current?.fulfilledAt !== null && current.subscriptionId !== null) return map(current, null, providerMode);
      throw new ConflictException('Checkout is already being fulfilled');
    }
    const completed = await this.prisma.transaction.findUniqueOrThrow({ where: { id: transaction.id } });
    let syncJobs;
    try { ({ syncJobs } = await this.mutation.applyCompletedTransaction(completed)); }
    catch (error: unknown) { await releaseFulfillmentClaim(this.prisma, transaction.id, claimedAt).catch(() => undefined); throw error; }
    for (const job of syncJobs) await this.queue.enqueue(job.id);
    const final = (await this.prisma.transaction.findUnique({ where: { id: transaction.id } })) ?? completed;
    if (paid) await this.reconciliation.runPostFulfillmentHooksBestEffort(final);
    return map(final, null, providerMode);
  }
}

export function isProviderCreationUnresolved(transaction: Transaction): boolean {
  return transaction.status === TransactionStatus.PENDING && transaction.amount.isPositive() && transaction.checkoutUrl === null;
}

export function unresolvedProviderCheckout(): ServiceUnavailableException {
  return new ServiceUnavailableException({ code: 'PROVIDER_CHECKOUT_CREATION_UNRESOLVED', message: 'Provider checkout creation is unresolved; awaiting reconciliation' });
}

function map(transaction: Transaction, checkoutUrl: string | null, providerMode: string): InternalPaymentCheckoutInterface {
  return { paymentId: transaction.paymentId, transactionStatus: transaction.status, gatewayType: transaction.gatewayType, purchaseType: transaction.purchaseType, amount: transaction.amount.toString(), currency: transaction.currency, checkoutUrl, providerMode, createdAt: transaction.createdAt.toISOString() };
}
