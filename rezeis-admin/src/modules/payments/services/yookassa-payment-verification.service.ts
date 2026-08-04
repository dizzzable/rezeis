import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { PaymentGatewayType, Prisma } from '@prisma/client';
import { firstValueFrom } from 'rxjs';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { readGatewaySettings } from '../utils/payment-gateway-settings.util';
import { redactPaymentDiagnosticMessage } from '../utils/payment-provider-error.util';
import {
  readOptionalString,
  readRecord,
  requireSetting,
  requireYookassaSecretKey,
} from './payment-provider-execution.helpers';

/**
 * What the provider said when asked whether a payment really is paid.
 *
 * Three outcomes, not two, because "the provider disagrees" and "we could not
 * ask" must never be handled the same way: the first is final and can only be
 * resolved by a human, the second is transient and resolves itself on a retry.
 * Collapsing them either strands real payments in the operator queue or turns a
 * five-second network blip into a permanent refusal.
 */
export type YookassaCompletionVerdict =
  /** The provider agrees the payment is captured. Safe to apply. */
  | { readonly outcome: 'CONFIRMED'; readonly providerStatus: string }
  /**
   * The provider actively disagrees, or the payment it returned is not the one
   * this transaction paid for. Final — asking again returns the same answer.
   */
  | {
      readonly outcome: 'CONTRADICTED';
      readonly providerStatus: string | null;
      readonly reason: string;
    }
  /** The question could not be answered right now. Retryable. */
  | { readonly outcome: 'UNAVAILABLE'; readonly reason: string };

/**
 * The second half of YooKassa's documented notification verification.
 *
 * YooKassa signs nothing. Its published source-IP list — enforced in
 * `payment-webhook-normalizer.service.ts` — is the whole of the FIRST half, and
 * it rests on Express's `trust proxy` boundary, which is set to `uniquelocal`.
 * The API container sits on a shared external Docker bridge with reiwa and
 * Remnawave and has its port exposed there, so any workload on that network can
 * reach the webhook route directly, bypassing the reverse proxy: its socket
 * address is private, so `X-Forwarded-For` is honoured, so it can name a
 * YooKassa source IP and be believed. A compromised third-party sidecar could
 * then post `payment.succeeded` for any transaction with no signature anywhere
 * in the path.
 *
 * The fix is NOT to read the client IP differently — switching to
 * `request.socket.remoteAddress` breaks every real delivery the moment a
 * legitimate proxy fronts the webhook. It is the step YooKassa documents and we
 * never implemented: re-fetch the payment from the API and let the provider
 * itself say whether it is paid. That is immune to IP renumbering and does not
 * depend on the trust-proxy boundary at all.
 *
 * Deliberately its own service rather than more code in
 * `PaymentReconciliationService`: this is one HTTP round-trip with one verdict,
 * and keeping it separate leaves the reconciler holding the policy (what to do
 * with each verdict) rather than the mechanism.
 */
@Injectable()
export class YookassaPaymentVerificationService {
  private readonly logger = new Logger(YookassaPaymentVerificationService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly httpService: HttpService,
  ) {}

  /**
   * Asks YooKassa whether the payment behind this transaction is captured.
   *
   * `paymentId` / `gatewayId` are OUR stored values and are what the answer is
   * bound against — see {@link isOurPayment}. Only the id we fetch comes from
   * the (untrusted) notification, which is harmless precisely because the
   * binding is re-checked on the provider's own copy afterwards.
   */
  public async verifyCompletion(input: {
    readonly transactionId: string;
    /** `Transaction.paymentId` — the id we wrote into the payment's metadata. */
    readonly paymentId: string;
    /** `Transaction.gatewayId` — YooKassa's own id, when checkout persisted it. */
    readonly gatewayId: string | null;
    readonly rawPayload: Prisma.JsonValue;
  }): Promise<YookassaCompletionVerdict> {
    // Fetch the id the notification names, falling back to the one checkout
    // stored. The notification's id is attacker-controlled on the forged path,
    // which would matter if the status alone decided the outcome — an attacker
    // could name their own real 1 ₽ payment and have us confirm it. It does not
    // matter here because nothing is accepted until the fetched object is bound
    // back to THIS transaction below. Preferring it over `gatewayId` is what
    // keeps the genuine backfill case working: when the process died between
    // YooKassa's 200 and our follow-up update, `gatewayId` is null or still
    // holds a `__…`/`claim:` provider-create placeholder, and the notification
    // is the only place the real id exists (see
    // `resolveYookassaGatewayIdBackfill`).
    const providerPaymentId =
      readOptionalString(readRecord(readRecord(input.rawPayload)['object']), ['id']) ??
      input.gatewayId;
    if (providerPaymentId === null) {
      return {
        outcome: 'CONTRADICTED',
        providerStatus: null,
        reason: 'PAYMENT_VERIFICATION_PAYMENT_ID_MISSING',
      };
    }

    let shopId: string;
    let apiKey: string;
    try {
      const gateway = await this.prismaService.paymentGateway.findUnique({
        where: { type: PaymentGatewayType.YOOKASSA },
        select: { settings: true },
      });
      if (gateway === null) {
        return { outcome: 'UNAVAILABLE', reason: 'PAYMENT_VERIFICATION_GATEWAY_UNAVAILABLE' };
      }
      const settings = readGatewaySettings(gateway.settings);
      shopId = requireSetting(settings, 'shopId');
      apiKey = requireYookassaSecretKey(settings);
    } catch (error: unknown) {
      // Missing credentials are OUR misconfiguration, never evidence about the
      // payment. Reported as unavailable so the row is retried and an operator
      // is alerted, rather than as a contradiction that would libel a genuine
      // payment as forged.
      this.logger.error(
        `YooKassa verification could not read gateway credentials for transaction ` +
          `${input.transactionId}: ${describeError(error)}`,
      );
      return { outcome: 'UNAVAILABLE', reason: 'PAYMENT_VERIFICATION_GATEWAY_UNAVAILABLE' };
    }

    let response: { readonly status: number; readonly data: unknown };
    try {
      response = await firstValueFrom(
        this.httpService.get(
          `https://api.yookassa.ru/v3/payments/${encodeURIComponent(providerPaymentId)}`,
          {
            auth: { username: shopId, password: apiKey },
            // Same as every other YooKassa call here: read the status ourselves
            // instead of letting axios throw, so a 404 can be told apart from a
            // 502 — one is proof, the other is noise.
            validateStatus: () => true,
          },
        ),
      );
    } catch (error: unknown) {
      this.logger.warn(
        `YooKassa verification request failed for transaction ${input.transactionId}: ` +
          `${describeError(error)}`,
      );
      return { outcome: 'UNAVAILABLE', reason: 'PAYMENT_VERIFICATION_PROVIDER_UNREACHABLE' };
    }

    if (response.status === 404) {
      // The shop's own API does not know this payment. A payment we created
      // cannot vanish, so this is the signature of a fabricated notification —
      // final, and worth a human.
      this.logger.error(
        `YooKassa verification: payment behind transaction ${input.transactionId} does not exist ` +
          `at the provider — refusing the completion`,
      );
      return {
        outcome: 'CONTRADICTED',
        providerStatus: null,
        reason: 'PAYMENT_VERIFICATION_PAYMENT_NOT_FOUND',
      };
    }
    if (response.status < 200 || response.status >= 300) {
      // 401/403/5xx say something about us or about YooKassa, nothing about the
      // payment. Log the (redacted) body: the admin-safe exception filter and
      // `normalizePaymentProviderError` both reduce the thrown message to a bare
      // code, so this line is the only place the real cause survives.
      this.logger.error(
        `YooKassa verification for transaction ${input.transactionId} returned HTTP ` +
          `${response.status}: ${redactPaymentDiagnosticMessage(JSON.stringify(response.data)) ?? 'no body'}`,
      );
      return { outcome: 'UNAVAILABLE', reason: 'PAYMENT_VERIFICATION_PROVIDER_HTTP_ERROR' };
    }

    const payment = readRecord(response.data);
    const providerStatus = readOptionalString(payment, ['status']);
    if (providerStatus === null) {
      return { outcome: 'UNAVAILABLE', reason: 'PAYMENT_VERIFICATION_PROVIDER_BODY_INVALID' };
    }

    if (!this.isOurPayment(payment, input)) {
      this.logger.error(
        `YooKassa verification: the payment named by the notification for transaction ` +
          `${input.transactionId} belongs to a different checkout — refusing the completion`,
      );
      return {
        outcome: 'CONTRADICTED',
        providerStatus,
        reason: 'PAYMENT_VERIFICATION_PAYMENT_NOT_OURS',
      };
    }

    // `succeeded` is YooKassa's terminal "captured" state — we always create
    // with `capture: true`, so there is no separate settle step to wait for and
    // no second status that means paid.
    if (providerStatus.toLowerCase() === 'succeeded') {
      return { outcome: 'CONFIRMED', providerStatus };
    }
    if (providerStatus.toLowerCase() === 'canceled') {
      return {
        outcome: 'CONTRADICTED',
        providerStatus,
        reason: 'PAYMENT_VERIFICATION_PROVIDER_CANCELED',
      };
    }
    // `pending` / `waiting_for_capture` are NOT contradictions: the payment may
    // still become `succeeded`, so the retry ladder is the right tool and
    // stamping the row for manual review would strand a live checkout. Anything
    // unrecognised lands here too — a status YooKassa added after this was
    // written is a change in their API, not evidence of forgery, and refusing to
    // fulfil while retrying is the safe reading of it either way.
    return { outcome: 'UNAVAILABLE', reason: 'PAYMENT_VERIFICATION_PROVIDER_STATUS_NOT_FINAL' };
  }

  /**
   * Is the payment the provider handed back the one THIS transaction paid for?
   *
   * This is the load-bearing half of the check. Without it the verification is
   * theatre: a forged notification can name any payment id, and an attacker who
   * has ever paid this shop one rouble owns a genuinely `succeeded` payment to
   * point us at.
   *
   * Two bindings, tried in order, because each covers the case the other cannot:
   *
   *  1. `metadata.paymentId`. Written by our own create call
   *     (`payment-provider-execution.service.ts`) and settable only by the
   *     merchant, never by the payer — so a match proves the provider's own
   *     record was created by us, for this transaction. This is the binding that
   *     works when `gatewayId` was never persisted, which is exactly the
   *     backfill case a forged notification would otherwise hide behind.
   *  2. `id` equals the `gatewayId` checkout stored. Covers a payment created
   *     before metadata was written. A provider-create placeholder can never
   *     equal a real YooKassa id, so a placeholder simply fails this comparison
   *     and falls back to (1) — no placeholder parsing needed here.
   */
  private isOurPayment(
    payment: Record<string, unknown>,
    input: { readonly paymentId: string; readonly gatewayId: string | null },
  ): boolean {
    const metadataPaymentId = readOptionalString(readRecord(payment['metadata']), [
      'paymentId',
      'payment_id',
    ]);
    if (metadataPaymentId !== null) {
      return metadataPaymentId === input.paymentId;
    }
    const providerPaymentId = readOptionalString(payment, ['id']);
    return (
      input.gatewayId !== null &&
      providerPaymentId !== null &&
      providerPaymentId === input.gatewayId
    );
  }
}

function describeError(error: unknown): string {
  return (
    redactPaymentDiagnosticMessage(error instanceof Error ? error.message : String(error)) ??
    'unknown error'
  );
}
