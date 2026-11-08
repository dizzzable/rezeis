import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

import { readOptionalString, readRecord, requireSetting } from '../services/payment-provider-execution.helpers';
import { redactPaymentDiagnosticMessage } from './payment-provider-error.util';

/**
 * Platega's refunds (docs.platega.io, «Возвраты», read 08.11.2026):
 *
 *  - `GET /transaction/{id}/cancel-supported[?amount=]` — whether the payment
 *    can be refunded (the whole, or `amount` of it), whether in part at all,
 *    and the provider's fee for it. Moves no money. `supported: false` names
 *    why in `blockReason` (`INSUFFICIENT_FUNDS`: the merchant's USDT balance,
 *    which the refund is taken from, is short).
 *  - `POST /transaction/{id}/cancel` — the whole sum, no body (`amount` is a
 *    400 `AMOUNT_NOT_ALLOWED`). Its end comes as a `CHARGEBACKED` callback.
 *  - `POST /transaction/{id}/cancel-partial` — `{ amount }`, with a mandatory
 *    `Idempotency-Key` (≤128 characters): the same key and sum return the
 *    operation already made; the same key with another sum is a 409. Each
 *    operation ends with a `PARTIALLY_REFUNDED` callback, `refundStatus`
 *    Succeeded or Declined; the rest refunded in full turns the payment
 *    `CHARGEBACKED`.
 *
 * Both POSTs answer `accepted` (taken into work), `manualControlRequired`
 * (Platega reviews it by hand; the decision comes as a callback) and
 * `refundOperationId` — the `refundId` its callbacks carry. Asked again while
 * the refund runs, they answer `accepted: false` with the same operation id:
 * not an error and not a second refund.
 */

const PLATEGA_API = 'https://app.platega.io';
const REQUEST_TIMEOUT_MS = 20_000;

export interface PlategaRefundCheck {
  readonly supported: boolean;
  readonly partialSupported: boolean;
  /** Platega's fee for the refund, in the payment's currency, when it takes one. */
  readonly fee: { readonly amount: string; readonly currency: string } | null;
  readonly blockReason: string | null;
}

export interface PlategaRefundAnswer {
  /** A new operation, or (false) the one already running for this payment. */
  readonly accepted: boolean;
  readonly manualControlRequired: boolean;
  /** The `refundId` Platega's callbacks name this operation by. */
  readonly refundOperationId: string | null;
  readonly message: string | null;
}

/** Platega refused the request itself (a 4xx or 5xx). Its code, when it named one, and the status. */
export class PlategaRefundRefusedError extends Error {
  public constructor(
    public readonly httpStatus: number,
    public readonly providerCode: string | null,
    detail: string,
  ) {
    super(`Platega refund refused (HTTP ${httpStatus}${providerCode === null ? '' : `, ${providerCode}`}): ${detail}`);
  }
}

function plategaHeaders(settings: Record<string, unknown>): Record<string, string> {
  return { 'X-MerchantId': requireSetting(settings, 'merchantId'), 'X-Secret': requireSetting(settings, 'secret') };
}

function refusal(status: number, data: unknown): PlategaRefundRefusedError {
  const body = readRecord(data);
  const code = readOptionalString(body, ['code', 'errorCode', 'error', 'type']);
  const detail = redactPaymentDiagnosticMessage(JSON.stringify(data ?? null), 300) ?? 'no body';
  return new PlategaRefundRefusedError(status, code, detail);
}

function readBoolean(value: unknown): boolean {
  return value === true;
}

export async function checkPlategaRefund(
  http: HttpService,
  settings: Record<string, unknown>,
  providerPaymentId: string,
  amount: string | null = null,
): Promise<PlategaRefundCheck> {
  const response = await firstValueFrom(
    http.get(`${PLATEGA_API}/transaction/${encodeURIComponent(providerPaymentId)}/cancel-supported`, {
      headers: plategaHeaders(settings),
      ...(amount === null ? {} : { params: { amount } }),
      timeout: REQUEST_TIMEOUT_MS,
      validateStatus: () => true,
    }),
  );
  if (response.status < 200 || response.status >= 300) throw refusal(response.status, response.data);
  const data = readRecord(response.data);
  const feeAmount = data['penaltyNativeAmount'];
  const feeCurrency = readOptionalString(data, ['penaltyNativeCurrency']);
  return {
    supported: readBoolean(data['supported']),
    partialSupported: readBoolean(data['partialSupported']),
    fee:
      typeof feeAmount === 'number' && Number.isFinite(feeAmount) && feeAmount > 0
        ? { amount: feeAmount.toFixed(2), currency: feeCurrency ?? '' }
        : null,
    blockReason: readOptionalString(data, ['blockReason']),
  };
}

/** The whole payment (`amount` null) or part of it (`amount`, with its idempotency key). */
export async function requestPlategaRefund(
  http: HttpService,
  settings: Record<string, unknown>,
  providerPaymentId: string,
  input: { readonly amount: string | null; readonly idempotencyKey: string },
): Promise<PlategaRefundAnswer> {
  const id = encodeURIComponent(providerPaymentId);
  const response =
    input.amount === null
      ? await firstValueFrom(
          http.post<unknown>(`${PLATEGA_API}/transaction/${id}/cancel`, undefined, {
            headers: plategaHeaders(settings),
            timeout: REQUEST_TIMEOUT_MS,
            validateStatus: () => true,
          }),
        )
      : await firstValueFrom(
          http.post<unknown>(
            `${PLATEGA_API}/transaction/${id}/cancel-partial`,
            { amount: Number(input.amount) },
            {
              headers: { ...plategaHeaders(settings), 'Idempotency-Key': input.idempotencyKey.slice(0, 128) },
              timeout: REQUEST_TIMEOUT_MS,
              validateStatus: () => true,
            },
          ),
        );
  if (response.status < 200 || response.status >= 300) throw refusal(response.status, response.data);
  const data = readRecord(response.data);
  return {
    accepted: readBoolean(data['accepted']),
    manualControlRequired: readBoolean(data['manualControlRequired']),
    refundOperationId: readOptionalString(data, ['refundOperationId']),
    message: readOptionalString(data, ['message']),
  };
}
