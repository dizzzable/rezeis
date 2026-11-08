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
import { importedPaymentSource, PaymentReconciliationService } from './payment-reconciliation.service';
import { readGatewaySettings } from '../utils/payment-gateway-settings.util';
import { redactPaymentDiagnosticMessage } from '../utils/payment-provider-error.util';
import {
  isRefundReversalClaimHeld,
  lockTransactionRefundLedger,
  readRefundLedger,
  readRefundedTotal,
  REFUND_CANCEL_PURCHASE_PENDING_KEY,
} from '../utils/payment-refund-ledger.util';
import { writeTransactionGatewayData } from '../utils/transaction-gateway-data.util';
import {
  checkPlategaRefund,
  type PlategaRefundAnswer,
  type PlategaRefundCheck,
  requestPlategaRefund,
} from '../utils/platega-refund.util';
import { readProviderSubscriptionTerms } from '../utils/provider-subscription-terms.util';
import { refundEndsAutopay } from '../utils/refund-autopay.util';
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
  /** Whether part of the sum can be refunded: Platega says per payment; ЮKassa always can. */
  readonly partialSupported?: boolean;
  /** The provider's fee for refunding the whole, in the payment's currency (Platega); null when none. */
  readonly providerFee?: { readonly amount: string; readonly currency: string } | null;
}

export interface RefundResultInterface {
  readonly transactionId: string;
  /** Provider-side refund id. */
  readonly refundId: string;
  readonly amount: string;
  readonly currency: string;
  readonly providerStatus: string | null;
  /** Platega took the refund for its own review: the money moves when it decides. */
  readonly manualControlRequired?: boolean;
  /** What the payment bought was undone with this refund (always for a full one that counts). */
  readonly purchaseCanceled?: boolean;
  /** «Отменить покупку» waits for the provider to confirm this refund. */
  readonly purchaseCancelPending?: boolean;
}

/** The gateways the panel refunds itself, through the provider's API («Вернуть»). */
const PANEL_REFUNDED_GATEWAYS: ReadonlySet<PaymentGatewayType> = new Set([
  PaymentGatewayType.YOOKASSA,
  PaymentGatewayType.PLATEGA,
]);

/** `refundProviderStatus` of a Platega refund taken into work. */
export const PLATEGA_REFUND_ACCEPTED = 'ACCEPTED';
/** …taken for Platega's own review: the money moves when it decides. */
export const PLATEGA_REFUND_MANUAL_CONTROL = 'MANUAL_CONTROL';
/** …asked for again while the same refund still runs there. */
export const PLATEGA_REFUND_ALREADY_RUNNING = 'ALREADY_RUNNING';

/** What a provider said to a refund the panel asked for. */
interface IssuedRefund {
  readonly refundId: string;
  readonly providerStatus: string | null;
  /** Counts against what is left to refund now; else it waits for the provider. */
  readonly countsTowardsBalance: boolean;
  readonly manualControlRequired: boolean;
  readonly providerResponse: Record<string, unknown>;
}

/** The panel's code for Platega's `blockReason`: a short balance gets its own words. */
function plategaBlockedReason(blockReason: string | null): string {
  return blockReason === 'INSUFFICIENT_FUNDS'
    ? 'PAYMENT_REFUND_PROVIDER_INSUFFICIENT_FUNDS'
    : 'PAYMENT_REFUND_PROVIDER_BLOCKED';
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What «Отметить возврат» did — for a withheld payment, or for any other made at its provider. */
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

/** What «Отметить возврат» did for any payment; the same answer. */
export type ProviderRefundRecordResultInterface = WithheldRefundRecordResultInterface;

/**
 * How long one «Отметить возврат» holds a payment before another may run the
 * reversal. The claim is what keeps two clicks, or two operators, from
 * running it twice; the reversal takes well under a second, and a claim older
 * than this belongs to a run that died, which a later click finishes.
 */
export const WITHHELD_REFUND_CLAIM_MS = 60_000;

/**
 * Why a refund made at the provider cannot be recorded for this payment
 * («Отметить возврат» on any payment), or null when it can. The panel refunds
 * ЮKassa itself, with «Вернуть»; a partner-balance payment has no provider to
 * refund it at; a payment imported from another bot was settled there; and
 * only a payment that went through and was delivered has anything to undo.
 * A withheld payment is decided by its own rule, not this one.
 */
export function providerRefundRecordRefusal(
  transaction: Pick<Transaction, 'gatewayType' | 'status' | 'fulfilledAt' | 'amount' | 'planSnapshot'>,
): string | null {
  if (transaction.gatewayType === PaymentGatewayType.YOOKASSA) return 'PAYMENT_REFUND_RECORD_USE_REFUND';
  if (transaction.gatewayType === PaymentGatewayType.PARTNER_BALANCE) return 'PAYMENT_REFUND_RECORD_NO_PROVIDER';
  if (importedPaymentSource(transaction) !== null) return 'PAYMENT_REFUND_RECORD_IMPORTED';
  if (transaction.status !== TransactionStatus.COMPLETED) return 'PAYMENT_REFUND_NOT_COMPLETED';
  if (transaction.fulfilledAt === null) return 'PAYMENT_REFUND_NOT_FULFILLED';
  const amount = Number(transaction.amount.toString());
  if (!Number.isFinite(amount) || amount <= 0) return 'PAYMENT_REFUND_RECORD_NOTHING_PAID';
  return null;
}

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
 * ЮKassa and Platega are wired up (`PANEL_REFUNDED_GATEWAYS`; Platega since
 * 08.11.2026, the owner's request). Other gateways report
 * `PAYMENT_REFUND_UNSUPPORTED_GATEWAY` so the UI can explain instead of
 * silently doing nothing; their refunds are made at the provider and recorded
 * with «Отметить возврат».
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

  /**
   * Eligibility snapshot used to enable/disable the panel's refund control.
   * For Platega it asks Platega too (`cancel-supported`): whether the balance
   * covers the refund, whether part of it can go back, and its fee.
   */
  public async getEligibility(transactionId: string): Promise<RefundEligibilityInterface> {
    const transaction = await this.loadTransaction(transactionId);
    const eligibility = this.evaluateEligibility(transaction);
    if (!eligibility.refundable || transaction.gatewayType !== PaymentGatewayType.PLATEGA) {
      return { ...eligibility, ...(eligibility.refundable ? { partialSupported: true, providerFee: null } : {}) };
    }
    const settings = await this.readPlategaSettings();
    let check: PlategaRefundCheck;
    try {
      check = await checkPlategaRefund(this.httpService, settings, transaction.gatewayId as string);
    } catch (error: unknown) {
      this.logger.warn(`Platega refund check for transaction ${transaction.id} failed: ${errorText(error)}`);
      return { ...eligibility, refundable: false, reason: 'PAYMENT_REFUND_PROVIDER_UNAVAILABLE' };
    }
    if (!check.supported) {
      return { ...eligibility, refundable: false, reason: plategaBlockedReason(check.blockReason) };
    }
    return { ...eligibility, partialSupported: check.partialSupported, providerFee: check.fee };
  }

  /**
   * Issues a refund at the provider. `amount` omitted → full refund of what is
   * still refundable.
   *
   * `cancelPurchase` — «Отменить покупку» beside a PARTIAL sum: the operator's
   * call per refund (the owner, 08.11.2026). What the payment bought is then
   * undone as a full refund undoes it (`cancelPurchaseForPartialRefund`) while
   * the money side stays partial. A full refund always undoes the purchase.
   */
  public async refundTransaction(input: {
    readonly transactionId: string;
    readonly amount?: string | null;
    readonly reason?: string | null;
    readonly cancelPurchase?: boolean | null;
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

    const issued =
      transaction.gatewayType === PaymentGatewayType.PLATEGA
        ? await this.issuePlategaRefund(transaction, requestedAmount, amountValue)
        : await this.issueYookassaRefund(transaction, amountValue, input.reason ?? null);

    const commit = await this.recordIssuedRefund(transaction, {
      refundId: issued.refundId,
      amountValue,
      requestedAmount,
      providerStatus: issued.providerStatus,
      countsTowardsBalance: issued.countsTowardsBalance,
      providerResponse: issued.providerResponse,
      currentAdmin: input.currentAdmin,
    });

    const paidAmount = Number(transaction.amount.toString());
    const partial = requestedAmount < paidAmount - 0.000001;
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
          refundId: issued.refundId,
          providerStatus: issued.providerStatus,
          reason: input.reason ?? null,
          partial,
          ...(partial ? { cancelPurchase: input.cancelPurchase === true } : {}),
          ...(issued.manualControlRequired ? { manualControlRequired: true } : {}),
        },
      }),
    });

    this.logger.warn(
      `Refund issued by admin ${input.currentAdmin.id} for transaction ${transaction.id}: ` +
        `${amountValue} ${transaction.currency} (refundId=${issued.refundId}, status=${issued.providerStatus})`,
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
    const fullyRefunded =
      issued.countsTowardsBalance &&
      Number.isFinite(paidAmount) &&
      paidAmount > 0 &&
      commit.refundedTotal >= paidAmount - 0.000001;
    let purchaseCanceled = false;
    if (fullyRefunded) {
      try {
        const fresh = await this.prismaService.transaction.findUnique({
          where: { id: transaction.id },
        });
        if (fresh !== null) {
          // The provider's cancel of the autopay comes after this answer, and
          // the card with it (`deferAutopay`): the operator is not kept waiting
          // on Platega or RollyPay past the request's 30 s.
          await this.paymentReconciliationService.reverseFulfilledPayment(fresh, issued.providerStatus, {
            deferAutopay: true,
          });
          purchaseCanceled = true;
        }
      } catch (error: unknown) {
        this.logger.error(`Refund reversal failed for transaction ${transaction.id}: ${errorText(error)}`);
      }
    }
    // Every refund ends the autopay (`refundEndsAutopay`); a full one did in the
    // reversal above. A partial one ends it here rather than waiting for the
    // provider's notice of it, whose card then reports the cancel. Only once the
    // refund counts: one the provider holds as pending is not money back yet —
    // save one Platega took into work, which is the operator's word to stop.
    // The provider is asked after this answer, as for a full one.
    const accepted = issued.countsTowardsBalance || issued.manualControlRequired;
    if (!fullyRefunded && accepted && refundEndsAutopay({ full: false })) {
      await this.paymentReconciliationService.endAutopayAfterResponse(transaction);
    }
    // What the payment bought, undone with the money and never before it. Part
    // of the sum with «Отменить покупку»: now, when the refund counts; when it
    // does not yet (ЮKassa's `pending`, Platega's own review), the wish is kept
    // on the payment and the provider's confirmation of this refund carries it
    // out (`PaymentReconciliationService.handleRefundReversal`). The whole sum
    // needs no wish: its confirmation runs the full reversal, which undoes the
    // purchase — and a whole refund Platega declines sends no callback at all,
    // so undoing it before the money moved could never be told.
    let purchaseCancelPending = false;
    if (partial && input.cancelPurchase === true) {
      if (issued.countsTowardsBalance) {
        try {
          const canceled = await this.paymentReconciliationService.cancelPurchaseForPartialRefund(transaction);
          purchaseCanceled = canceled.canceled;
        } catch (error: unknown) {
          this.logger.error(`Cancelling the purchase of refunded transaction ${transaction.id} failed: ${errorText(error)}`);
        }
      } else if (accepted || issued.providerStatus === 'pending') {
        await writeTransactionGatewayData(this.prismaService, transaction.id, {
          merge: { [REFUND_CANCEL_PURCHASE_PENDING_KEY]: issued.refundId },
        });
        purchaseCancelPending = true;
      }
    }

    return {
      transactionId: transaction.id,
      refundId: issued.refundId,
      amount: amountValue,
      currency: transaction.currency,
      providerStatus: issued.providerStatus,
      ...(issued.manualControlRequired ? { manualControlRequired: true } : {}),
      purchaseCanceled,
      ...(purchaseCancelPending ? { purchaseCancelPending: true } : {}),
    };
  }

  /** ЮKassa's refund: `POST /v3/refunds`, settled in the answer or pending. */
  private async issueYookassaRefund(
    transaction: Transaction,
    amountValue: string,
    reason: string | null,
  ): Promise<IssuedRefund> {
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
          ...(typeof reason === 'string' && reason.trim().length > 0
            ? { description: reason.trim().slice(0, 250) }
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
    return {
      refundId,
      providerStatus,
      // A refund the provider accepted but has not settled (`pending`) must not
      // reduce the refundable balance: if it is later cancelled, the operator
      // would be locked out of re-issuing it with no way to correct the total.
      countsTowardsBalance: providerStatus !== 'canceled' && providerStatus !== 'pending',
      manualControlRequired: false,
      providerResponse: data,
    };
  }

  /**
   * Platega's refund (`platega-refund.util.ts`). Asked first whether it can be
   * done — the merchant's balance, part of the sum at all — then the whole sum
   * goes back through `cancel` and part of it through `cancel-partial`.
   *
   * Platega answers that it took the refund into work; its end comes as a
   * callback (`CHARGEBACKED`, `PARTIALLY_REFUNDED` with `refundStatus`). Taken
   * into work, it counts at once, as ЮKassa's settled refund does: Platega
   * checked the balance a moment ago, and a decline is the exception its
   * callback corrects (`PaymentReconciliationService`). One Platega reviews by
   * hand (`manualControlRequired`) does not count until it decides.
   *
   * The idempotency key names the payment, what was refunded before and this
   * sum: a second click on the same refund is the same operation, and a second
   * refund of the same sum after the first is a new one.
   */
  private async issuePlategaRefund(
    transaction: Transaction,
    requestedAmount: number,
    amountValue: string,
  ): Promise<IssuedRefund> {
    const settings = await this.readPlategaSettings();
    const providerPaymentId = transaction.gatewayId as string;
    const previouslyRefunded = readRefundedTotal(transaction.gatewayData);
    const paidAmount = Number(transaction.amount.toString());
    const whole = previouslyRefunded <= 0.000001 && requestedAmount >= paidAmount - 0.000001;

    let check: PlategaRefundCheck;
    try {
      check = await checkPlategaRefund(this.httpService, settings, providerPaymentId, whole ? null : amountValue);
    } catch (error: unknown) {
      this.logger.error(`Platega refund check for transaction ${transaction.id} failed: ${errorText(error)}`);
      throw new ServiceUnavailableException('PAYMENT_REFUND_PROVIDER_UNAVAILABLE');
    }
    if (!check.supported) {
      throw new BadRequestException(plategaBlockedReason(check.blockReason));
    }
    if (!whole && !check.partialSupported) {
      throw new BadRequestException('PAYMENT_REFUND_PARTIAL_UNSUPPORTED');
    }

    let answer: PlategaRefundAnswer;
    try {
      answer = await requestPlategaRefund(this.httpService, settings, providerPaymentId, {
        amount: whole ? null : amountValue,
        idempotencyKey: `refund-${transaction.id}-${previouslyRefunded.toFixed(2)}-${amountValue}`,
      });
    } catch (error: unknown) {
      this.logger.error(`Platega refund rejected for transaction ${transaction.id}: ${errorText(error)}`);
      throw new ServiceUnavailableException('PAYMENT_REFUND_PROVIDER_REJECTED');
    }
    if (answer.refundOperationId === null) {
      // Nothing to key the ledger on, and nothing a callback could be matched
      // to: the operator is told the refund was not confirmed.
      this.logger.error(
        `Platega refund for transaction ${transaction.id} answered without an operation id ` +
          `(accepted=${answer.accepted}, message=${redactPaymentDiagnosticMessage(answer.message ?? '', 200) ?? ''})`,
      );
      throw new ServiceUnavailableException('PAYMENT_REFUND_PROVIDER_REJECTED');
    }
    const providerStatus = answer.manualControlRequired
      ? PLATEGA_REFUND_MANUAL_CONTROL
      : answer.accepted
        ? PLATEGA_REFUND_ACCEPTED
        : PLATEGA_REFUND_ALREADY_RUNNING;
    return {
      refundId: answer.refundOperationId,
      providerStatus,
      countsTowardsBalance: !answer.manualControlRequired,
      manualControlRequired: answer.manualControlRequired,
      providerResponse: { ...answer, transactionId: providerPaymentId },
    };
  }

  /**
   * Records an issued refund on the payment. Read-modify-write UNDER the row
   * lock: re-reading alone was not enough, because the webhook path writes the
   * same keys, so a refund landing between the read and this write was simply
   * overwritten — a real interleave (this refund concurrent with the provider's
   * notice of a DIFFERENT refund) dropped one of the two ledger entries.
   * Reading inside the lock also keeps what the provider call's round-trip may
   * have let reconciliation write meanwhile: `refundReversedAt`, the
   * revoked-subscription audit and the manual-review flag, which are the only
   * breadcrumbs for undoing a mistaken refund.
   *
   * The lock spans a read and a write and nothing else — the provider POST is
   * already done, and the full-refund reversal runs after this transaction has
   * committed.
   */
  private async recordIssuedRefund(
    transaction: Transaction,
    input: {
      readonly refundId: string;
      readonly amountValue: string;
      readonly requestedAmount: number;
      readonly providerStatus: string | null;
      readonly countsTowardsBalance: boolean;
      readonly providerResponse: Record<string, unknown>;
      readonly currentAdmin: CurrentAdminInterface;
    },
  ): Promise<{ readonly refundedTotal: number }> {
    return this.prismaService.$transaction(async (tx) => {
      const liveGatewayData =
        (await lockTransactionRefundLedger(tx, transaction.id)) ?? transaction.gatewayData;
      // Ledger keyed by the PROVIDER's refund id, not a running sum. A repeated
      // click replays the ORIGINAL refund at the provider rather than making a
      // new one — adding the amount again would invent a refund that never
      // happened and lock out the remaining balance. Recording each refund once
      // makes the total derivable and self-correcting.
      //
      // The provider's notice writes into this SAME ledger, so when it lands
      // before this call finishes, the refund we just issued is already
      // recorded and `isNewRefund` below is false. That is what stops the two
      // writers from counting one 500-of-1000 refund as 1000 and reversing a
      // subscription, commission and tax income that were never fully refunded.
      const ledger = readRefundLedger(liveGatewayData);
      const previousTotal = readRefundedTotal(liveGatewayData);
      const isNewRefund = input.countsTowardsBalance && !ledger.some((e) => e.refundId === input.refundId);
      if (isNewRefund) {
        ledger.push({ refundId: input.refundId, amount: input.amountValue, at: new Date().toISOString() });
      }
      // The total only ever grows. It is NOT derived from the ledger alone,
      // because refunds issued outside the panel (operator acting directly in the
      // provider's dashboard) reach us as webhooks that record the total without
      // a ledger entry — deriving purely from the ledger would forget them and
      // hand back balance that is already gone.
      const refundedTotal = Math.max(
        previousTotal + (isNewRefund ? input.requestedAmount : 0),
        ledger.reduce((sum, entry) => sum + Number(entry.amount), 0),
      );
      await writeTransactionGatewayData(tx, transaction.id, {
        merge: {
          refundRequestedAt: new Date().toISOString(),
          refundRequestedBy: input.currentAdmin.id,
          refundId: input.refundId,
          refundProviderStatus: input.providerStatus,
          refunds: ledger,
          refundedAmountTotal: refundedTotal.toFixed(2),
          refundProviderResponse: this.redactionService.redact(input.providerResponse) as Prisma.JsonValue,
        },
      });
      return { refundedTotal };
    });
  }

  /** The Platega gateway's settings: a refund needs only its keys, not the gateway switched on. */
  private async readPlategaSettings(): Promise<Record<string, unknown>> {
    const gateway = await this.prismaService.paymentGateway.findUnique({
      where: { type: PaymentGatewayType.PLATEGA },
    });
    if (gateway === null) {
      throw new BadRequestException('PAYMENT_GATEWAY_NOT_ACTIVE');
    }
    return readGatewaySettings(gateway.settings);
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
    return this.recordRefundMadeAtProvider(input, { onlyWithheld: true });
  }

  /**
   * «Отметить возврат» on ANY payment: the operator returned its money at the
   * provider — in Platega's or RollyPay's own dashboard, or by hand for any
   * gateway — and says so here. Those refunds never reach the panel (Platega
   * reports only a chargeback, RollyPay only `payment.paid`), so the autopay
   * went on and the commission and the cashback stayed.
   *
   * A WHOLE refund, with exactly what a provider's own refund notice does to
   * the payment, because it runs the same reversal
   * (`PaymentReconciliationService.reverseFulfilledPayment`): the payment
   * becomes CANCELED, the partner's commission, the referral reward and the
   * cashback are taken back, analytics stops counting it, a NEW purchase's
   * subscription is revoked, a renewal gives back the days it bought (a plan
   * change is left for the operator, as the notice leaves it), the autopay ends
   * (`refundEndsAutopay`), and the operator's card «↩️ Платёж возвращён» says
   * with its «📝 Заметка» what became of the autopay. Nothing is sent to the
   * provider, and the answer does not wait for one: the provider cancels and
   * the card come after it (`deferAutopay`).
   *
   * No «Мой налог» receipt is cancelled, because there is none: the panel
   * files them for ЮKassa payments only, this door refuses a ЮKassa payment
   * that was not withheld, and a withheld one was never filed. The reversal's
   * cancellation job stops at such a payment (`MoyNalogProcessor`).
   *
   * Only for a payment the panel does not refund itself and that has something
   * to undo ({@link providerRefundRecordRefusal}); refused with 409 otherwise.
   *
   * A withheld payment takes the branch {@link recordWithheldRefund} takes —
   * one door behind both routes, so the operator never meets a dead end, and a
   * withheld payment's record stays what it was: its own audit action, its own
   * refusals, `payment.withheld_refunded`, and no subscription or saved card
   * touched.
   */
  public async recordProviderRefund(input: {
    readonly transactionId: string;
    readonly currentAdmin: CurrentAdminInterface;
    readonly requestMetadata: RequestMetadataInterface;
  }): Promise<ProviderRefundRecordResultInterface> {
    return this.recordRefundMadeAtProvider(input, { onlyWithheld: false });
  }

  /**
   * «Отметить возврат», both doors: see {@link recordWithheldRefund} and
   * {@link recordProviderRefund}. The branch is whether the payment is
   * withheld; `onlyWithheld` is the withheld door refusing every other one.
   */
  private async recordRefundMadeAtProvider(
    input: {
      readonly transactionId: string;
      readonly currentAdmin: CurrentAdminInterface;
      readonly requestMetadata: RequestMetadataInterface;
    },
    door: { readonly onlyWithheld: boolean },
  ): Promise<WithheldRefundRecordResultInterface> {
    const transaction = await this.loadTransaction(input.transactionId);
    const withheld = isWithheldConversion(transaction.gatewayData);
    if (!withheld) {
      if (door.onlyWithheld) {
        throw new ConflictException('PAYMENT_NOT_WITHHELD');
      }
      // A payment reversed already answers «recorded before» below, whatever
      // its status says now: its reversal made it CANCELED.
      if (typeof asGatewayRecord(transaction.gatewayData)['refundReversedAt'] !== 'string') {
        const refusal = providerRefundRecordRefusal(transaction);
        if (refusal !== null) throw new ConflictException(refusal);
      }
    }
    const inProgress = withheld ? 'PAYMENT_WITHHELD_REFUND_IN_PROGRESS' : 'PAYMENT_REFUND_RECORD_IN_PROGRESS';

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
      throw new ConflictException(inProgress);
    }

    // The operator's statement, attributed, before the reversal it sets off:
    // it is what they asserted, whatever becomes of the run. Its own action
    // for any other payment, so «Лента операционной активности» on the
    // dashboard says which it was.
    await this.prismaService.adminAuditLog.create({
      data: buildAdminAuditLogData({
        action: withheld
          ? 'payments.transaction.withheld_refund_recorded'
          : 'payments.transaction.provider_refund_recorded',
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
          ...(withheld ? {} : { purchaseType: transaction.purchaseType }),
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
      // Nor does the answer wait on the provider: the autopay is cancelled
      // after it, and the card comes then.
      deferAutopay: true,
    });
    this.logger.warn(
      withheld
        ? `Refund of withheld payment ${transaction.id} recorded by admin ${input.currentAdmin.id}`
        : `Refund made at the provider for payment ${transaction.id} recorded by admin ${input.currentAdmin.id}`,
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

    if (!PANEL_REFUNDED_GATEWAYS.has(transaction.gatewayType)) {
      return { ...base, refundable: false, reason: 'PAYMENT_REFUND_UNSUPPORTED_GATEWAY' };
    }
    // A Platega sign-up's checkout carries the SUBSCRIPTION's id, not a
    // payment's, and the panel's row of each later charge carries none:
    // Platega refunds payments by their id, so an autopay's money is refunded
    // in Platega's own dashboard and recorded here with «Отметить возврат».
    if (
      transaction.gatewayType === PaymentGatewayType.PLATEGA &&
      (readProviderSubscriptionTerms(transaction.planSnapshot) !== null ||
        asGatewayRecord(transaction.planSnapshot)['snapshotSource'] === 'PROVIDER_SUBSCRIPTION_CHARGE')
    ) {
      return { ...base, refundable: false, reason: 'PAYMENT_REFUND_SUBSCRIPTION_CHECKOUT' };
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
