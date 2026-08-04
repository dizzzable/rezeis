import { HttpService } from '@nestjs/axios';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PaymentGatewayType, Prisma, Transaction, TransactionStatus } from '@prisma/client';
import { firstValueFrom } from 'rxjs';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import { RequestMetadataInterface } from '../../auth/interfaces/request-metadata.interface';
import { PaymentReconciliationService } from './payment-reconciliation.service';
import { readGatewaySettings } from '../utils/payment-gateway-settings.util';
import { redactPaymentDiagnosticMessage } from '../utils/payment-provider-error.util';
import {
  lockTransactionRefundLedger,
  readRefundLedger,
  readRefundedTotal,
} from '../utils/payment-refund-ledger.util';
import {
  readOptionalString,
  readRecord,
  requireSetting,
  requireYookassaSecretKey,
} from './payment-provider-execution.helpers';
import { PaymentWebhookPayloadRedactionService } from './payment-webhook-payload-redaction.service';

/** Whether a transaction can be refunded, and why not when it can't. */
export interface RefundEligibilityInterface {
  readonly refundable: boolean;
  /** Machine-readable blocker, `null` when refundable. */
  readonly reason: string | null;
  /** Amount still refundable, as a decimal string. */
  readonly refundableAmount: string;
  readonly currency: string;
  /** Already refunded through this panel, as a decimal string. */
  readonly refundedAmount: string;
}

export interface RefundResultInterface {
  readonly transactionId: string;
  /** Provider-side refund id. */
  readonly refundId: string;
  readonly amount: string;
  readonly currency: string;
  readonly providerStatus: string | null;
}

/**
 * Operator-initiated refunds.
 *
 * The panel is the ONLY way a refund starts — customers never self-serve one.
 * This service just calls the provider; it deliberately does not reverse any
 * side-effects itself. The provider answers with a `refund.succeeded` webhook,
 * and `PaymentReconciliationService` already owns the reversal (partner
 * accruals, referral qualification, tax income, ad conversion, subscription
 * revocation) with its own idempotency. Doing it in both places would double
 * the reversal, so the split is intentional.
 *
 * Only YooKassa is wired up: it is the one configured gateway with a documented
 * refund API in use here. Other gateways report `PAYMENT_REFUND_UNSUPPORTED_GATEWAY`
 * so the UI can explain instead of silently doing nothing.
 */
@Injectable()
export class PaymentRefundService {
  private readonly logger = new Logger(PaymentRefundService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly httpService: HttpService,
    private readonly redactionService: PaymentWebhookPayloadRedactionService,
    private readonly paymentReconciliationService: PaymentReconciliationService,
  ) {}

  /** Eligibility snapshot used to enable/disable the panel's refund control. */
  public async getEligibility(transactionId: string): Promise<RefundEligibilityInterface> {
    const transaction = await this.loadTransaction(transactionId);
    return this.evaluateEligibility(transaction);
  }

  /**
   * Issues a refund at the provider. `amount` omitted → full refund of what is
   * still refundable.
   */
  public async refundTransaction(input: {
    readonly transactionId: string;
    readonly amount?: string | null;
    readonly reason?: string | null;
    readonly currentAdmin: CurrentAdminInterface;
    readonly requestMetadata: RequestMetadataInterface;
  }): Promise<RefundResultInterface> {
    const transaction = await this.loadTransaction(input.transactionId);
    const eligibility = this.evaluateEligibility(transaction);
    if (!eligibility.refundable) {
      throw new BadRequestException(eligibility.reason ?? 'PAYMENT_REFUND_NOT_ALLOWED');
    }

    const refundableAmount = Number(eligibility.refundableAmount);
    const requestedAmount =
      typeof input.amount === 'string' && input.amount.trim().length > 0
        ? Number(input.amount.trim())
        : refundableAmount;
    if (!Number.isFinite(requestedAmount) || requestedAmount <= 0) {
      throw new BadRequestException('PAYMENT_REFUND_AMOUNT_INVALID');
    }
    // Guard against refunding more than was captured (the provider would reject
    // it too, but a clear 400 beats a raw provider error in the panel).
    if (requestedAmount > refundableAmount + 0.000001) {
      throw new BadRequestException('PAYMENT_REFUND_AMOUNT_EXCEEDS_BALANCE');
    }
    const amountValue = requestedAmount.toFixed(2);

    const gateway = await this.prismaService.paymentGateway.findUnique({
      where: { type: PaymentGatewayType.YOOKASSA },
    });
    // Check the flag too, not just the row's existence — the error code claims
    // "not active", so it should actually mean it.
    if (gateway === null || !gateway.isActive) {
      throw new BadRequestException('PAYMENT_GATEWAY_NOT_ACTIVE');
    }
    const settings = readGatewaySettings(gateway.settings);
    const shopId = requireSetting(settings, 'shopId');
    const apiKey = requireYookassaSecretKey(settings);

    // Idempotence-Key is derived from the transaction + amount, so an accidental
    // double-click (or a retry after a timeout) cannot refund twice: YooKassa
    // replays the original refund instead of creating a second one.
    const idempotenceKey = `refund:${transaction.id}:${amountValue}`;
    const response = await firstValueFrom(
      this.httpService.post(
        'https://api.yookassa.ru/v3/refunds',
        {
          payment_id: transaction.gatewayId,
          amount: { value: amountValue, currency: transaction.currency },
          ...(typeof input.reason === 'string' && input.reason.trim().length > 0
            ? { description: input.reason.trim().slice(0, 250) }
            : {}),
        },
        {
          auth: { username: shopId, password: apiKey },
          headers: { 'Idempotence-Key': idempotenceKey },
          validateStatus: () => true,
        },
      ),
    );
    if (response.status < 200 || response.status >= 300) {
      // Log the (redacted) provider answer before throwing: the admin-safe
      // exception filter rewrites any message carrying provider ids into a bare
      // "Internal server error", so without this line an operator hitting a
      // real cause — shop balance too low, refund window closed, method not
      // refundable — would see nothing here and nothing in the logs.
      this.logger.error(
        `YooKassa refund rejected for transaction ${transaction.id} (HTTP ${response.status}): ` +
          (redactPaymentDiagnosticMessage(JSON.stringify(response.data)) ?? 'no body'),
      );
      throw new ServiceUnavailableException('PAYMENT_REFUND_PROVIDER_REJECTED');
    }

    const data = readRecord(response.data);
    const refundId = readOptionalString(data, ['id']);
    if (refundId === null) {
      throw new ServiceUnavailableException('YooKassa refund: missing refund id');
    }
    const providerStatus = readOptionalString(data, ['status']);

    // A refund the provider accepted but has not settled (`pending`) must not
    // reduce the refundable balance: if it is later cancelled, the operator
    // would be locked out of re-issuing it with no way to correct the total.
    const countsTowardsBalance = providerStatus !== 'canceled' && providerStatus !== 'pending';

    // Record the request. The authoritative reversal still happens when the
    // `refund.succeeded` webhook lands; this stamp is what makes the panel show
    // "refund issued" immediately and what caps further refunds.
    //
    // Read-modify-write UNDER the row lock. Re-reading alone was not enough:
    // the webhook path writes the same two keys, so a refund landing between
    // this read and this write was simply overwritten — a real interleave (this
    // refund concurrent with the `refund.succeeded` webhook for a DIFFERENT
    // refund) dropped one of the two ledger entries. Reading inside the lock
    // also keeps the original reason the re-read exists: the provider call
    // above is a network round-trip and reconciliation can have written
    // `refundReversedAt`, the revoked-subscription audit and the manual-review
    // flag inside that window, which are the only breadcrumbs for undoing a
    // mistaken refund.
    //
    // The lock spans a read and a write and nothing else — the provider POST is
    // already done, and the full-refund reversal below runs after this
    // transaction has committed.
    const commit = await this.prismaService.$transaction(async (tx) => {
      const liveGatewayData =
        (await lockTransactionRefundLedger(tx, transaction.id)) ?? transaction.gatewayData;
      // Ledger keyed by the PROVIDER's refund id, not a running sum. A repeated
      // click sends the same Idempotence-Key, so YooKassa replays the ORIGINAL
      // refund rather than making a new one — adding the amount again would
      // invent a refund that never happened and lock out the remaining balance.
      // Recording each refund once makes the total derivable and self-correcting.
      //
      // The `refund.succeeded` webhook writes into this SAME ledger, so when it
      // lands before this call finishes, the refund we just issued is already
      // recorded and `isNewRefund` below is false. That is what stops the two
      // writers from counting one 500-of-1000 refund as 1000 and reversing a
      // subscription, commission and tax income that were never fully refunded.
      const ledger = readRefundLedger(liveGatewayData);
      const previousTotal = readRefundedTotal(liveGatewayData);
      const isNewRefund = countsTowardsBalance && !ledger.some((e) => e.refundId === refundId);
      if (isNewRefund) {
        ledger.push({ refundId, amount: amountValue, at: new Date().toISOString() });
      }
      // The total only ever grows. It is NOT derived from the ledger alone,
      // because refunds issued outside the panel (operator acting directly in the
      // provider's dashboard) reach us as webhooks that record the total without
      // a ledger entry — deriving purely from the ledger would forget them and
      // hand back balance that is already gone.
      const refundedTotal = Math.max(
        previousTotal + (isNewRefund ? requestedAmount : 0),
        ledger.reduce((sum, entry) => sum + Number(entry.amount), 0),
      );
      await tx.transaction.update({
        where: { id: transaction.id },
        data: {
          gatewayData: mergeRefundAudit(liveGatewayData, {
            refundRequestedAt: new Date().toISOString(),
            refundRequestedBy: input.currentAdmin.id,
            refundId,
            refundProviderStatus: providerStatus,
            refunds: ledger as unknown as Prisma.JsonValue,
            refundedAmountTotal: refundedTotal.toFixed(2),
            refundProviderResponse: this.redactionService.redact(data) as Prisma.JsonValue,
          }) as Prisma.InputJsonValue,
        },
      });
      return { refundedTotal };
    });

    await this.prismaService.adminAuditLog.create({
      data: {
        action: 'payments.transaction.refund',
        ipAddress: input.requestMetadata.remoteAddress,
        userAgent: input.requestMetadata.userAgent,
        metadata: {
          requestId: input.requestMetadata.requestId,
          transactionId: transaction.id,
          paymentId: transaction.paymentId,
          userId: transaction.userId,
          gatewayType: transaction.gatewayType,
          amount: amountValue,
          currency: transaction.currency,
          refundId,
          providerStatus,
          reason: input.reason ?? null,
          partial: requestedAmount < Number(transaction.amount.toString()) - 0.000001,
        },
        adminUser: { connect: { id: input.currentAdmin.id } },
      } as never,
    });

    this.logger.warn(
      `Refund issued by admin ${input.currentAdmin.id} for transaction ${transaction.id}: ` +
        `${amountValue} ${transaction.currency} (refundId=${refundId}, status=${providerStatus})`,
    );

    // Reverse the side-effects here rather than only on a `refund.succeeded`
    // webhook. Not every gateway sends one, and a refund the operator issues in
    // the provider's own dashboard never produces one at all — the partner kept
    // the commission, the income stayed declared to the tax service and the
    // advertising revenue stood forever. Only for a FULL refund: a partial one
    // must not wipe an all-or-nothing reversal, which is the same rule the
    // webhook path applies. Idempotent, so a webhook arriving afterwards is a
    // no-op, and best-effort, so the refund itself is never reported as failed
    // after the money has already gone back.
    //
    // Decided from the total computed UNDER the lock, but run outside it. The
    // fenced write means exactly one of the two writers can be the one whose
    // entry takes the cumulative total to the captured amount, so the reversal
    // still fires exactly once — while the partner debit, referral
    // un-qualification, МойНалог cancellation and Remnawave revoke job (seconds
    // of network work) stay out of the critical section.
    const paidAmount = Number(transaction.amount.toString());
    const fullyRefunded =
      countsTowardsBalance &&
      Number.isFinite(paidAmount) &&
      paidAmount > 0 &&
      commit.refundedTotal >= paidAmount - 0.000001;
    if (fullyRefunded) {
      try {
        const fresh = await this.prismaService.transaction.findUnique({
          where: { id: transaction.id },
        });
        if (fresh !== null) {
          await this.paymentReconciliationService.reverseFulfilledPayment(fresh, providerStatus);
        }
      } catch (error: unknown) {
        this.logger.error(
          `Refund reversal failed for transaction ${transaction.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    return {
      transactionId: transaction.id,
      refundId,
      amount: amountValue,
      currency: transaction.currency,
      providerStatus,
    };
  }

  private async loadTransaction(transactionId: string): Promise<Transaction> {
    const transaction = await this.prismaService.transaction.findUnique({
      where: { id: transactionId },
    });
    if (transaction === null) {
      throw new NotFoundException('Payment transaction not found');
    }
    return transaction;
  }

  private evaluateEligibility(transaction: Transaction): RefundEligibilityInterface {
    const paid = Number(transaction.amount.toString());
    // Single reader for the total, shared with the write path and with
    // reconciliation — two slightly different parsers here is how the panel and
    // the webhook start disagreeing about how much is left.
    const refundedAmount = readRefundedTotal(transaction.gatewayData);
    const remaining = Number.isFinite(paid) ? Math.max(0, paid - refundedAmount) : 0;
    const base = {
      refundableAmount: remaining.toFixed(2),
      currency: transaction.currency as string,
      refundedAmount: refundedAmount.toFixed(2),
    };

    if (transaction.gatewayType !== PaymentGatewayType.YOOKASSA) {
      return { ...base, refundable: false, reason: 'PAYMENT_REFUND_UNSUPPORTED_GATEWAY' };
    }
    if (transaction.status !== TransactionStatus.COMPLETED) {
      return { ...base, refundable: false, reason: 'PAYMENT_REFUND_NOT_COMPLETED' };
    }
    // Nothing was delivered yet → there is no captured payment to give back
    // through this path; the pending-expiry/cancel flow owns that case.
    if (transaction.fulfilledAt === null) {
      return { ...base, refundable: false, reason: 'PAYMENT_REFUND_NOT_FULFILLED' };
    }
    if (transaction.gatewayId === null || transaction.gatewayId.startsWith('__')) {
      return { ...base, refundable: false, reason: 'PAYMENT_REFUND_MISSING_PROVIDER_ID' };
    }
    if (remaining <= 0) {
      return { ...base, refundable: false, reason: 'PAYMENT_REFUND_ALREADY_REFUNDED' };
    }
    return { ...base, refundable: true, reason: null };
  }
}

/** Shallow-merges refund audit keys into `gatewayData` without dropping siblings. */
function mergeRefundAudit(
  current: Prisma.JsonValue | null,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const base =
    typeof current === 'object' && current !== null && !Array.isArray(current)
      ? (current as Record<string, unknown>)
      : {};
  return { ...base, ...patch };
}
