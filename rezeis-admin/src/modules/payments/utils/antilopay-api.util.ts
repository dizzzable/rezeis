import { createSign } from 'node:crypto';

import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

import { requireSetting } from '../services/payment-provider-execution.helpers';

/**
 * Antilopay's merchant API (lk.antilopay.com, documentation 1.51).
 *
 * Every request is a POST of a JSON body signed with the merchant's private key
 * (SHA256WithRSA over the EXACT bytes sent, base64) and carries the merchant's
 * secret id. The one signing routine lives here so that a payment's creation,
 * its status check and an autopay's cancel cannot drift apart.
 */
export const ANTILOPAY_API = 'https://lk.antilopay.com/api/v1';

/**
 * How long a status, check or cancel call waits for Antilopay. The default of
 * every outbound call is 45 s, and these calls are made one row at a time — by
 * the expiry sweep, by the sweeps of the subscriptions, inside the 30 s the
 * panel gives a customer's «Отключить автосписание» — so one slow answer was a
 * stalled sweep, or a request the panel had already cut off.
 */
export const ANTILOPAY_CALL_TIMEOUT_MS = 8_000;

/** The methods this panel calls, as the URL tail Antilopay documents. */
export type AntilopayMethod =
  | 'payment/create'
  | 'payment/check'
  | 'payment/recurrent/check'
  | 'payment/recurrent/cancel';

/**
 * Re-armors the stored signing key before OpenSSL sees it.
 *
 * The value arrives through the admin form as whatever the operator had on
 * the clipboard, and OpenSSL 3 is unforgiving about the difference. Measured
 * on Node 24 / OpenSSL 3.5.5, wrapping the setting directly in armor signs
 * correctly for raw base64, for 64-column-wrapped base64 and even with
 * embedded spaces — but a value carrying a **trailing newline**, or one that
 * is **already a complete PEM** with its own `-----BEGIN…` lines, throws
 * `ERR_OSSL_UNSUPPORTED`. Both are precisely what copying a key out of a
 * cabinet or a `.pem` file produces, and both were rethrown upstream as a
 * bare 503: the gateway went dark with no diagnostic naming the key.
 *
 * So the setting is reduced to its base64 body and re-wrapped at 64 columns.
 * The `RSA PRIVATE KEY` label is deliberately kept — Antilopay issues a
 * PKCS#8 key (its own Java, Go and C# samples read it with
 * `PKCS8EncodedKeySpec` / `ParsePKCS8PrivateKey` / `ImportPkcs8PrivateKey`),
 * and OpenSSL 3 signs that body under this label exactly as the provider's
 * own PHP and Node samples do. The armor was never the defect.
 */
export function toAntilopayPrivateKeyPem(privateKey: string): string {
  const base64Body = privateKey.replace(/-----(?:BEGIN|END)[^-]*-----/g, '').replace(/\s+/g, '');
  const wrappedBody = base64Body.match(/.{1,64}/g)?.join('\n') ?? '';
  return `-----BEGIN RSA PRIVATE KEY-----\n${wrappedBody}\n-----END RSA PRIVATE KEY-----\n`;
}

/** SHA256WithRSA of `bodyString`, base64: the value of `X-Apay-Sign`. */
export function signAntilopayBody(bodyString: string, privateKeyPem: string): string {
  const sign = createSign('RSA-SHA256');
  sign.update(bodyString);
  return sign.sign(privateKeyPem, 'base64');
}

/** The three headers every request carries. */
export function antilopayHeaders(secretId: string, signature: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-Apay-Secret-Id': secretId,
    'X-Apay-Sign': signature,
    'X-Apay-Sign-Version': '1',
  };
}

/** What Antilopay answered: its own `code` (0 is success) and the whole body. */
export interface AntilopayReply {
  readonly code: number;
  readonly data: Record<string, unknown>;
}

/** Antilopay answered, but not with a body that has a numeric `code`. */
export class AntilopayTransportError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'AntilopayTransportError';
  }
}

/**
 * Posts one signed request and returns Antilopay's own verdict.
 *
 * `project_identificator` is added here, first, so no caller can forget it.
 * A non-2xx HTTP status is NOT thrown on its own: Antilopay's documented
 * errors (8 «не найден», 28 «не активен») are JSON bodies with a `code`, and
 * whichever HTTP status carries them, the code is what the caller must read.
 * Only an answer without a numeric `code` (a gateway page, an empty body) is an
 * {@link AntilopayTransportError}; a connection failure or timeout rejects as
 * axios raised it.
 */
export async function postAntilopay(
  httpService: HttpService,
  settings: Record<string, unknown>,
  method: AntilopayMethod,
  payload: Record<string, unknown>,
  options: { readonly timeoutMs?: number } = {},
): Promise<AntilopayReply> {
  const projectIdentificator = requireSetting(settings, 'projectIdentificator');
  const secretId = requireSetting(settings, 'secretId');
  const privateKeyPem = toAntilopayPrivateKeyPem(requireSetting(settings, 'privateKey'));
  const bodyString = JSON.stringify({ project_identificator: projectIdentificator, ...payload });
  const response = await firstValueFrom(
    httpService.post(`${ANTILOPAY_API}/${method}`, bodyString, {
      headers: antilopayHeaders(secretId, signAntilopayBody(bodyString, privateKeyPem)),
      validateStatus: () => true,
      timeout: options.timeoutMs ?? ANTILOPAY_CALL_TIMEOUT_MS,
    }),
  );
  const data = response.data as unknown;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new AntilopayTransportError(`Antilopay ${method} answered HTTP ${response.status ?? '?'} without a JSON body`);
  }
  const record = data as Record<string, unknown>;
  const code = typeof record['code'] === 'number' ? record['code'] : Number.NaN;
  if (!Number.isFinite(code)) {
    throw new AntilopayTransportError(`Antilopay ${method} answered HTTP ${response.status ?? '?'} without a code`);
  }
  return { code, data: record };
}

/** A documented error code that is a fact about the payment, not a failure to ask. */
export const ANTILOPAY_NOT_FOUND = 8;
/** `payment/recurrent/cancel`: «Указанный рекуррентный платеж не активен». */
export const ANTILOPAY_RECURRENT_NOT_ACTIVE = 28;
/** `payment/create`: «Нет разрешения на создание рекуррентных платежей». */
export const ANTILOPAY_NO_RECURRENT_PERMISSION = 30;
/** `payment/create`: «Ошибки в данных для рекуррентного платежа». */
export const ANTILOPAY_BAD_RECURRENT_DATA = 29;

/**
 * A payment's `status` from `payment/check` (and from a callback), sorted by
 * what the panel does about it.
 *
 *  - `PAID`     SUCCESS: the money is in.
 *  - `OPEN`     PENDING: nobody has paid, and the invoice can still be paid.
 *  - `DEAD`     FAIL, CANCEL, EXPIRED: it will not be paid (a late payment on
 *               a row already cancelled is still revived by its callback).
 *  - `REVERSED` CHARGEBACK («через претензию в Банк-эмитент») and REVERSED
 *               («отменен Мерчантом в день оплаты»). Neither is ever sent as a
 *               callback — the documentation lists SUCCESS and FAIL only — so
 *               a status check is the only way the panel learns of them.
 *  - `UNKNOWN`  a word this build does not know: logged, never acted on.
 */
export type AntilopayPaymentVerdict = 'PAID' | 'OPEN' | 'DEAD' | 'REVERSED' | 'UNKNOWN';

export function classifyAntilopayPaymentStatus(status: string | null | undefined): AntilopayPaymentVerdict {
  switch (String(status ?? '').trim().toUpperCase()) {
    case 'SUCCESS':
      return 'PAID';
    case 'PENDING':
      return 'OPEN';
    case 'FAIL':
    case 'CANCEL':
    case 'EXPIRED':
      return 'DEAD';
    case 'CHARGEBACK':
    case 'REVERSED':
      return 'REVERSED';
    default:
      return 'UNKNOWN';
  }
}
