import { HttpService } from '@nestjs/axios';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PaymentGatewayType, Prisma, Transaction, TransactionStatus } from '@prisma/client';
import { firstValueFrom } from 'rxjs';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { buildAdminAuditLogData } from '../../../common/utils/admin-audit-log.util';
import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import { RequestMetadataInterface } from '../../auth/interfaces/request-metadata.interface';
import { PaymentReconciliationService } from './payment-reconciliation.service';
import { readGatewaySettings } from '../utils/payment-gateway-settings.util';
import { redactPaymentDiagnosticMessage } from '../utils/payment-provider-error.util';
import {
  isRefundReversalClaimHeld,
  lockTransactionRefundLedger,
  readRefundLedger,
  readRefundedTotal,
} from '../utils/payment-refund-ledger.util';
import { writeTransactionGatewayData } from '../utils/transaction-gateway-data.util';
import {
  isWithheldConversion,
  MANUAL_REFUND_RECORDED_AT_KEY,
  MANUAL_REFUND_RECORDED_BY_KEY,
} from '../utils/trial-conversion.util';
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

/** What «Отметить возврат» did for a withheld payment. */
export interface WithheldRefundRecordResultInterface {
  readonly transactionId: string;
  /**
   * False when its refund had already been reversed — recorded by an operator
   * earlier, or reported by the provider — and nothing was done this time.
   */
  readonly recorded: boolean;
  /** When the reversal ran. */
  readonly refundedAt: string | null;
}

/**
 * How long one «Отметить возврат» holds a withheld payment before another may
 * run the reversal. The claim is what keeps two clicks, or two operators, from
 * running it twice; the reversal takes well under a second, and a claim older
 * than this belongs to a run that died, which a later click finishes.
 */
export const WITHHELD_REFUND_CLAIM_MS = 60_000;

function asGatewayRecord(gatewayData: unknown): Record<string, unknown> {
  return typeof gatewayData === 'object' && gatewayData !== null && !Array.isArray(gatewayData)
    ? (gatewayData as Record<string, unknown>)
    : {};
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
      // The ledger and the total are computed from the read above, under the
      // row lock; the write goes through the one writer anyway, so no path
      // writes `gatewayData` any other way (`writeTransactionGatewayData`).
      await writeTransactionGatewayData(tx, transaction.id, {
        merge: {
          refundRequestedAt: new Date().toISOString(),
          refundRequestedBy: input.currentAdmin.id,
          refundId,
          refundProviderStatus: providerStatus,
          refunds: ledger,
          refundedAmountTotal: refundedTotal.toFixed(2),
          refundProviderResponse: this.redactionService.redact(data) as Prisma.JsonValue,
        },
      });
      return { refundedTotal };
    });

    await this.prismaService.adminAuditLog.create({
      data: buildAdminAuditLogData({
        action: 'payments.transaction.refund',
        actorId: input.currentAdmin.id,
        requestMetadata: input.requestMetadata,
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
      }),
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
    // Decided from the total computed UNDER the lock, but run outside it, so
    // the partner debit, referral un-qualification, МойНалог cancellation and
    // Remnawave revoke job (seconds of network work) stay out of the critical
    // section. The fenced write alone did NOT make it run once: the webhook for
    // this very refund finds it ledgered already, reads the total as full too,
    // and reversed as well while this run was still going. The reversal takes
    // its own claim under the same lock, and that is what runs it once
    // (`reverseFulfilledPayment`).
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

  /**
   * «Отметить возврат»: the operator returned a withheld payment's money at the
   * provider, and says so here.
   *
   * A withheld payment is a trial's conversion that arrived after another
   * payment had converted the trial: received, applied to nothing, announced
   * to the operator as `payment.withheld` for a refund. A refund closes it by
   * itself only where the gateway reports one — YooKassa (and the panel's own
   * refund), Cryptomus and Heleket, WATA, Telegram Stars; Platega is known to
   * report only a chargeback, RollyPay only `payment.paid`, most others
   * nothing — so without this it stayed a received sale in every report.
   *
   * Runs the reversal a provider's refund notification runs
   * (`reverseFulfilledPayment`): the payment becomes CANCELED and stamped
   * `refundReversedAt`, and the operator is told (`payment.withheld_refunded`,
   * operator-only: no sale was ever announced for it). The subscription is
   * not touched — the payment never changed it, and the reversal skips a
   * withheld one (`CONVERSION_NOT_APPLIED`). Only a withheld payment: any other
   * is refused with `PAYMENT_NOT_WITHHELD`, because recording a refund without
   * the provider would revoke access and commission on a sale that stands.
   *
   * Idempotent. A payment already reversed — by an earlier click, or by the
   * provider's notification — answers `recorded: false` and changes nothing.
   * Two clicks at once are serialised on the row lock the refund writers share
   * (`lockTransactionRefundLedger`), and the first one's claim
   * (`manualRefundRecordedAt`) turns the second away for
   * {@link WITHHELD_REFUND_CLAIM_MS}; a claim older than that belongs to a run
   * that died before its reversal, and the next click finishes it. A click that
   * meets the reversal under way through another door — a provider's refund
   * notice — is turned away the same way. Whichever door comes second, the
   * reversal runs once (`reverseFulfilledPayment`).
   */
  public async recordWithheldRefund(input: {
    readonly transactionId: string;
    readonly currentAdmin: CurrentAdminInterface;
    readonly requestMetadata: RequestMetadataInterface;
  }): Promise<WithheldRefundRecordResultInterface> {
    const transaction = await this.loadTransaction(input.transactionId);
    if (!isWithheldConversion(transaction.gatewayData)) {
      throw new ConflictException('PAYMENT_NOT_WITHHELD');
    }

    const claim = await this.prismaService.$transaction(async (tx) => {
      const live = asGatewayRecord(await lockTransactionRefundLedger(tx, transaction.id));
      const reversedAt = live['refundReversedAt'];
      if (typeof reversedAt === 'string') {
        return { kind: 'ALREADY_REVERSED' as const, reversedAt };
      }
      const claimedAt = live[MANUAL_REFUND_RECORDED_AT_KEY];
      const claimedMs = typeof claimedAt === 'string' ? Date.parse(claimedAt) : Number.NaN;
      if (Number.isFinite(claimedMs) && Date.now() - claimedMs < WITHHELD_REFUND_CLAIM_MS) {
        return { kind: 'IN_PROGRESS' as const };
      }
      // The reversal is under way through another door — a provider's refund
      // notice, most likely. It ends the same way, so this click writes nothing.
      if (isRefundReversalClaimHeld(live)) {
        return { kind: 'IN_PROGRESS' as const };
      }
      await writeTransactionGatewayData(tx, transaction.id, {
        merge: {
          [MANUAL_REFUND_RECORDED_AT_KEY]: new Date().toISOString(),
          [MANUAL_REFUND_RECORDED_BY_KEY]: input.currentAdmin.id,
        },
      });
      return { kind: 'CLAIMED' as const };
    });
    if (claim.kind === 'ALREADY_REVERSED') {
      return { transactionId: transaction.id, recorded: false, refundedAt: claim.reversedAt };
    }
    if (claim.kind === 'IN_PROGRESS') {
      throw new ConflictException('PAYMENT_WITHHELD_REFUND_IN_PROGRESS');
    }

    // The operator's statement, attributed, before the reversal it sets off:
    // it is what they asserted, whatever becomes of the run.
    await this.prismaService.adminAuditLog.create({
      data: buildAdminAuditLogData({
        action: 'payments.transaction.withheld_refund_recorded',
        actorId: input.currentAdmin.id,
        requestMetadata: input.requestMetadata,
        metadata: {
          requestId: input.requestMetadata.requestId,
          transactionId: transaction.id,
          paymentId: transaction.paymentId,
          userId: transaction.userId,
          gatewayType: transaction.gatewayType,
          amount: transaction.amount.toString(),
          currency: transaction.currency,
        },
      }),
    });

    // Read after the claim: the reversal takes its `refundReversedAt` guard from
    // the row it is handed, and its own write merges in the statement.
    const fresh = await this.loadTransaction(transaction.id);
    await this.paymentReconciliationService.reverseFulfilledPayment(fresh, null, {
      // An operator's record is not a word from the provider: whatever the
      // provider said last stays on the row.
      recordProviderStatus: false,
    });
    this.logger.warn(
      `Refund of withheld payment ${transaction.id} recorded by admin ${input.currentAdmin.id}`,
    );

    const reversed = await this.loadTransaction(transaction.id);
    const refundedAt = asGatewayRecord(reversed.gatewayData)['refundReversedAt'];
    return {
      transactionId: transaction.id,
      recorded: true,
      refundedAt: typeof refundedAt === 'string' ? refundedAt : null,
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
