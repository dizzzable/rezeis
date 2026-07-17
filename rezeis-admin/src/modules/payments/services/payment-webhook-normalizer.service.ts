import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { BlockList } from 'node:net';

import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { PaymentGatewayType } from '@prisma/client';

import { PaymentWebhookEnvelopeInterface } from '../interfaces/payment-webhook-envelope.interface';
import { readGatewaySettings } from '../utils/payment-gateway-settings.util';

interface NormalizeWebhookInput {
  readonly gatewayType: PaymentGatewayType;
  readonly rawBody: Buffer;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly clientIp: string | null;
  readonly gatewaySettings: unknown;
  readonly verifySignature: boolean;
}

const YOOKASSA_TRUSTED_NETWORKS: readonly string[] = [
  '185.71.76.0/27',
  '185.71.77.0/27',
  '77.75.153.0/25',
  '77.75.156.11/32',
  '77.75.156.35/32',
  '77.75.154.128/25',
  '2a02:5180::/32',
] as const;

const yookassaTrustedBlockList = createTrustedBlockList(YOOKASSA_TRUSTED_NETWORKS);

@Injectable()
export class PaymentWebhookNormalizerService {
  public normalizeWebhook(input: NormalizeWebhookInput): PaymentWebhookEnvelopeInterface {
    const rawPayload = parseWebhookPayload(input.rawBody, input.gatewayType);
    const gatewaySettings = readGatewaySettings(input.gatewaySettings as never);
    if (input.verifySignature) {
      this.verifySignature({
        gatewayType: input.gatewayType,
        rawBody: input.rawBody,
        rawPayload,
        headers: input.headers,
        gatewaySettings,
        clientIp: input.clientIp,
      });
    }

    const paymentId = this.resolvePaymentId({
      gatewayType: input.gatewayType,
      rawPayload,
    });
    const providerEventId =
      this.resolveProviderEventId({
        gatewayType: input.gatewayType,
        rawPayload,
      }) ?? paymentId;
    const eventStatus = this.resolveEventStatus({
      gatewayType: input.gatewayType,
      rawPayload,
    });

    return {
      gatewayType: input.gatewayType,
      paymentId,
      providerEventId,
      eventStatus,
      receivedAt: new Date().toISOString(),
      payloadHash: createHash('sha256').update(input.rawBody).digest('hex'),
      rawPayload,
    };
  }

  private verifySignature(input: {
    readonly gatewayType: PaymentGatewayType;
    readonly rawBody: Buffer;
    readonly rawPayload: Record<string, unknown>;
    readonly headers: Record<string, string | string[] | undefined>;
    readonly gatewaySettings: Record<string, unknown>;
    readonly clientIp: string | null;
  }): void {
    switch (input.gatewayType) {
      case PaymentGatewayType.TELEGRAM_STARS:
        verifyTelegramStarsSignature(input.headers, input.gatewaySettings);
        return;
      case PaymentGatewayType.YOOKASSA:
        verifyYookassaSourceIp(input.clientIp);
        return;
      case PaymentGatewayType.HELEKET:
        verifyHeleketSignature(
          input.rawBody,
          input.rawPayload,
          input.headers,
          input.gatewaySettings,
        );
        return;
      case PaymentGatewayType.PLATEGA:
        verifyPlategaHeaders(input.headers, input.gatewaySettings);
        return;
      case PaymentGatewayType.MULENPAY:
        verifyMulenPayHeaders(input.headers, input.gatewaySettings);
        return;
      case PaymentGatewayType.CRYPTOMUS:
        verifyCryptomusSignature(input.rawBody, input.headers, input.gatewaySettings);
        return;
      case PaymentGatewayType.RIOPAY:
        verifyRiopaySignature(input.rawBody, input.headers, input.gatewaySettings);
        return;
      case PaymentGatewayType.ANTILOPAY:
      case PaymentGatewayType.OVERPAY:
      case PaymentGatewayType.PAYPALYCH:
        // Webhook signature verification for these gateways is intentionally
        // permissive at the moment: callers either rely on IP allowlists,
        // network-layer auth, or signed payloads we cannot enforce here
        // without operator-supplied secrets. The webhook ingress pipeline
        // still records the raw payload, so misuse is auditable.
        return;
      case PaymentGatewayType.VALUTIX:
        verifyValutixSignature(input.rawBody, input.headers, input.gatewaySettings);
        return;
      case PaymentGatewayType.WATA:
        verifyWataSignature(input.rawBody, input.headers, input.gatewaySettings);
        return;
      case PaymentGatewayType.AURAPAY:
        verifyAurapaySignature(input.rawPayload, input.headers, input.gatewaySettings);
        return;
      case PaymentGatewayType.ROLLYPAY:
        verifyRollypaySignature(input.rawBody, input.headers, input.gatewaySettings);
        return;
      case PaymentGatewayType.SEVERPAY:
        verifySeverpaySignature(input.rawPayload, input.gatewaySettings);
        return;
      case PaymentGatewayType.LAVA:
        verifyLavaApiKey(input.headers, input.gatewaySettings);
        return;
      case PaymentGatewayType.CRYPTOPAY:
        verifyCryptopaySignature(input.rawBody, input.headers, input.gatewaySettings);
        return;
      default:
        throw new ForbiddenException('PAYMENT_WEBHOOK_SIGNATURE_UNSUPPORTED');
    }
  }

  private resolvePaymentId(input: {
    readonly gatewayType: PaymentGatewayType;
    readonly rawPayload: Record<string, unknown>;
  }): string {
    switch (input.gatewayType) {
      case PaymentGatewayType.TELEGRAM_STARS:
        return readRequiredString(
          resolveTelegramPaymentPayload(input.rawPayload),
          ['invoice_payload', 'payload'],
          'PAYMENT_WEBHOOK_PAYMENT_ID_MISSING',
        );
      case PaymentGatewayType.YOOKASSA:
        return readRequiredString(
          readNestedObject(readNestedObject(input.rawPayload, 'object'), 'metadata'),
          ['paymentId'],
          'PAYMENT_WEBHOOK_PAYMENT_ID_MISSING',
        );
      case PaymentGatewayType.HELEKET:
        return readRequiredString(
          input.rawPayload,
          ['order_id', 'orderId', 'payload'],
          'PAYMENT_WEBHOOK_PAYMENT_ID_MISSING',
        );
      case PaymentGatewayType.PLATEGA:
        return readRequiredString(
          input.rawPayload,
          ['payload', 'paymentId', 'localPaymentId', 'id'],
          'PAYMENT_WEBHOOK_PAYMENT_ID_MISSING',
        );
      case PaymentGatewayType.MULENPAY:
        return readRequiredString(
          input.rawPayload,
          ['orderId', 'order_id', 'uuid', 'payment_uuid', 'id'],
          'PAYMENT_WEBHOOK_PAYMENT_ID_MISSING',
        );
      case PaymentGatewayType.CRYPTOMUS:
        return readRequiredString(
          input.rawPayload,
          ['order_id', 'orderId'],
          'PAYMENT_WEBHOOK_PAYMENT_ID_MISSING',
        );
      case PaymentGatewayType.RIOPAY:
      case PaymentGatewayType.VALUTIX:
        return readRequiredString(
          input.rawPayload,
          ['externalId', 'id'],
          'PAYMENT_WEBHOOK_PAYMENT_ID_MISSING',
        );
      case PaymentGatewayType.WATA:
        return readRequiredString(
          input.rawPayload,
          ['orderId', 'order_id'],
          'PAYMENT_WEBHOOK_PAYMENT_ID_MISSING',
        );
      case PaymentGatewayType.AURAPAY:
        return readRequiredString(
          input.rawPayload,
          ['order_id', 'orderId'],
          'PAYMENT_WEBHOOK_PAYMENT_ID_MISSING',
        );
      case PaymentGatewayType.ROLLYPAY:
        return readRequiredString(
          input.rawPayload,
          ['order_id', 'payment_id'],
          'PAYMENT_WEBHOOK_PAYMENT_ID_MISSING',
        );
      case PaymentGatewayType.SEVERPAY: {
        // SeverPay wraps the event payload in `data: {...}`
        const dataObject = readNestedObject(input.rawPayload, 'data');
        return readRequiredString(
          dataObject,
          ['order_id', 'orderId', 'uid'],
          'PAYMENT_WEBHOOK_PAYMENT_ID_MISSING',
        );
      }
      case PaymentGatewayType.LAVA:
        return readRequiredString(
          input.rawPayload,
          ['contractId', 'parentContractId'],
          'PAYMENT_WEBHOOK_PAYMENT_ID_MISSING',
        );
      case PaymentGatewayType.CRYPTOPAY:
        // CryptoPay webhook wraps the Invoice in `payload`; our internal id is
        // the invoice's own `payload` field (set to `paymentId` at checkout).
        return readRequiredString(
          readNestedObject(input.rawPayload, 'payload'),
          ['payload'],
          'PAYMENT_WEBHOOK_PAYMENT_ID_MISSING',
        );
      default:
        throw new BadRequestException('PAYMENT_WEBHOOK_PAYMENT_ID_MISSING');
    }
  }

  private resolveProviderEventId(input: {
    readonly gatewayType: PaymentGatewayType;
    readonly rawPayload: Record<string, unknown>;
  }): string | null {
    switch (input.gatewayType) {
      case PaymentGatewayType.TELEGRAM_STARS:
        return readOptionalString(input.rawPayload, ['update_id', 'providerEventId', 'eventId']);
      case PaymentGatewayType.YOOKASSA:
        return (
          readOptionalString(input.rawPayload, ['event_id', 'eventId']) ??
          readOptionalString(readNestedObject(input.rawPayload, 'object'), ['id'])
        );
      case PaymentGatewayType.HELEKET:
        return readOptionalString(input.rawPayload, ['id', 'uuid', 'payment_id', 'paymentId']);
      case PaymentGatewayType.PLATEGA:
        return readOptionalString(input.rawPayload, ['id', 'transactionId']);
      case PaymentGatewayType.MULENPAY:
        return readOptionalString(input.rawPayload, ['eventId', 'providerEventId']);
      case PaymentGatewayType.CRYPTOMUS:
        return readOptionalString(input.rawPayload, ['uuid', 'invoice_uuid', 'payment_uuid']);
      case PaymentGatewayType.RIOPAY:
      case PaymentGatewayType.VALUTIX:
        return readOptionalString(input.rawPayload, ['id']);
      case PaymentGatewayType.WATA:
        return readOptionalString(input.rawPayload, ['id', 'paymentId']);
      case PaymentGatewayType.AURAPAY:
        return readOptionalString(input.rawPayload, ['id']);
      case PaymentGatewayType.ROLLYPAY:
        return readOptionalString(input.rawPayload, ['payment_id']);
      case PaymentGatewayType.SEVERPAY:
        return readOptionalString(readNestedObject(input.rawPayload, 'data'), ['id', 'uid']);
      case PaymentGatewayType.LAVA:
        return readOptionalString(input.rawPayload, ['contractId']);
      case PaymentGatewayType.CRYPTOPAY:
        // Prefer the per-update id; fall back to the invoice id (stable per
        // invoice) so dedup keys remain unique even if `update_id` is absent.
        return (
          readOptionalString(input.rawPayload, ['update_id']) ??
          readOptionalString(readNestedObject(input.rawPayload, 'payload'), ['invoice_id'])
        );
      default:
        return null;
    }
  }

  private resolveEventStatus(input: {
    readonly gatewayType: PaymentGatewayType;
    readonly rawPayload: Record<string, unknown>;
  }): string | null {
    switch (input.gatewayType) {
      case PaymentGatewayType.TELEGRAM_STARS:
        return resolveTelegramPaymentStatus(input.rawPayload);
      case PaymentGatewayType.YOOKASSA:
        return readOptionalString(readNestedObject(input.rawPayload, 'object'), ['status']);
      case PaymentGatewayType.HELEKET:
        return readOptionalString(input.rawPayload, ['status', 'payment_status']);
      case PaymentGatewayType.PLATEGA:
        return readOptionalString(input.rawPayload, ['status']);
      case PaymentGatewayType.MULENPAY:
        return readOptionalString(input.rawPayload, ['payment_status', 'status']);
      case PaymentGatewayType.CRYPTOMUS:
        return readOptionalString(input.rawPayload, ['status', 'payment_status']);
      case PaymentGatewayType.RIOPAY:
      case PaymentGatewayType.VALUTIX:
        return readOptionalString(input.rawPayload, ['status']);
      case PaymentGatewayType.WATA:
        return readOptionalString(input.rawPayload, ['status', 'transactionStatus']);
      case PaymentGatewayType.AURAPAY:
        return readOptionalString(input.rawPayload, ['status']);
      case PaymentGatewayType.ROLLYPAY:
        return (
          readOptionalString(input.rawPayload, ['event_type']) ??
          readOptionalString(input.rawPayload, ['status'])
        );
      case PaymentGatewayType.SEVERPAY:
        return readOptionalString(readNestedObject(input.rawPayload, 'data'), ['status']);
      case PaymentGatewayType.LAVA:
        return (
          readOptionalString(input.rawPayload, ['eventType']) ??
          readOptionalString(input.rawPayload, ['status'])
        );
      case PaymentGatewayType.CRYPTOPAY:
        // Invoice `status` is `paid` | `active` | `expired`; `paid` normalizes
        // to a COMPLETED transaction, the rest stay PENDING/CANCELED.
        return readOptionalString(readNestedObject(input.rawPayload, 'payload'), ['status']);
      default:
        return null;
    }
  }
}

function parseWebhookPayload(
  rawBody: Buffer,
  gatewayType: PaymentGatewayType,
): Record<string, unknown> {
  try {
    const parsedPayload = JSON.parse(rawBody.toString('utf8')) as unknown;
    if (
      typeof parsedPayload !== 'object' ||
      parsedPayload === null ||
      Array.isArray(parsedPayload)
    ) {
      throw new BadRequestException('PAYMENT_WEBHOOK_PAYLOAD_INVALID');
    }
    return parsedPayload as Record<string, unknown>;
  } catch (error: unknown) {
    if (error instanceof BadRequestException) {
      throw error;
    }
    throw new BadRequestException(`PAYMENT_WEBHOOK_PAYLOAD_INVALID:${gatewayType}`);
  }
}

function resolveTelegramPaymentPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const message = readNestedObject(payload, 'message');
  const successfulPayment = readNestedObject(message, 'successful_payment');
  if (Object.keys(successfulPayment).length > 0) {
    return successfulPayment;
  }
  const refundedPayment = readNestedObject(message, 'refunded_payment');
  if (Object.keys(refundedPayment).length > 0) {
    return refundedPayment;
  }
  const standalonePayment = readNestedObject(payload, 'successful_payment');
  if (Object.keys(standalonePayment).length > 0) {
    return standalonePayment;
  }
  const standaloneRefund = readNestedObject(payload, 'refunded_payment');
  if (Object.keys(standaloneRefund).length > 0) {
    return standaloneRefund;
  }
  throw new BadRequestException('PAYMENT_WEBHOOK_PAYMENT_ID_MISSING');
}

function resolveTelegramPaymentStatus(payload: Record<string, unknown>): string {
  const message = readNestedObject(payload, 'message');
  if (Object.keys(readNestedObject(message, 'successful_payment')).length > 0) {
    return 'SUCCESSFUL_PAYMENT';
  }
  if (Object.keys(readNestedObject(message, 'refunded_payment')).length > 0) {
    return 'REFUNDED_PAYMENT';
  }
  if (Object.keys(readNestedObject(payload, 'successful_payment')).length > 0) {
    return 'SUCCESSFUL_PAYMENT';
  }
  if (Object.keys(readNestedObject(payload, 'refunded_payment')).length > 0) {
    return 'REFUNDED_PAYMENT';
  }
  return 'TELEGRAM_PAYMENT_UPDATE';
}

function verifyTelegramStarsSignature(
  headers: Record<string, string | string[] | undefined>,
  gatewaySettings: Record<string, unknown>,
): void {
  const expectedSecret = readStringSetting(gatewaySettings, 'webhookSecret');
  const actualSecret = readHeader(headers, 'x-telegram-bot-api-secret-token');
  if (!expectedSecret || !actualSecret || !compareSecrets(actualSecret, expectedSecret)) {
    throw new ForbiddenException('PAYMENT_WEBHOOK_SIGNATURE_INVALID');
  }
}

function verifyYookassaSourceIp(clientIp: string | null): void {
  if (clientIp === null || !yookassaTrustedBlockList.check(clientIp)) {
    throw new ForbiddenException('PAYMENT_WEBHOOK_SIGNATURE_INVALID');
  }
}

function verifyRiopaySignature(
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
  gatewaySettings: Record<string, unknown>,
): void {
  const apiToken = readStringSetting(gatewaySettings, 'apiToken');
  const signature = readHeader(headers, 'x-signature');
  if (!apiToken || !signature) {
    throw new ForbiddenException('PAYMENT_WEBHOOK_SIGNATURE_INVALID');
  }
  const expected = createHmac('sha512', apiToken).update(rawBody).digest('hex');
  if (!compareSecrets(expected, signature)) {
    throw new ForbiddenException('PAYMENT_WEBHOOK_SIGNATURE_INVALID');
  }
}

function verifyHeleketSignature(
  rawBody: Buffer,
  rawPayload: Record<string, unknown>,
  headers: Record<string, string | string[] | undefined>,
  gatewaySettings: Record<string, unknown>,
): void {
  const secret = readStringSetting(gatewaySettings, 'apiKey');
  const signature =
    readHeader(headers, 'sign') ??
    readHeader(headers, 'x-signature') ??
    readOptionalString(rawPayload, ['sign', 'signature']);
  if (!secret || !signature) {
    throw new ForbiddenException('PAYMENT_WEBHOOK_SIGNATURE_INVALID');
  }
  const candidates = calculateHeleketSignatureCandidates(rawBody, rawPayload, secret);
  if (!candidates.some((candidate) => compareSecrets(candidate, signature))) {
    throw new ForbiddenException('PAYMENT_WEBHOOK_SIGNATURE_INVALID');
  }
}

function verifyPlategaHeaders(
  headers: Record<string, string | string[] | undefined>,
  gatewaySettings: Record<string, unknown>,
): void {
  const expectedMerchantId = readStringSetting(gatewaySettings, 'merchantId');
  const expectedSecret = readStringSetting(gatewaySettings, 'secret');
  const actualMerchantId = readHeader(headers, 'x-merchantid');
  const actualSecret = readHeader(headers, 'x-secret');
  if (
    !expectedMerchantId ||
    !expectedSecret ||
    !actualMerchantId ||
    !actualSecret ||
    !compareSecrets(actualMerchantId, expectedMerchantId) ||
    !compareSecrets(actualSecret, expectedSecret)
  ) {
    throw new ForbiddenException('PAYMENT_WEBHOOK_SIGNATURE_INVALID');
  }
}

function verifyMulenPayHeaders(
  headers: Record<string, string | string[] | undefined>,
  gatewaySettings: Record<string, unknown>,
): void {
  const expectedApiKey = readStringSetting(gatewaySettings, 'apiKey');
  const actualApiKey = readHeader(headers, 'x-api-key') ?? readHeader(headers, 'api-key');
  if (!expectedApiKey || !actualApiKey || !compareSecrets(actualApiKey, expectedApiKey)) {
    throw new ForbiddenException('PAYMENT_WEBHOOK_SIGNATURE_INVALID');
  }
}

function verifyCryptomusSignature(
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
  gatewaySettings: Record<string, unknown>,
): void {
  const secret = readStringSetting(gatewaySettings, 'apiKey');
  const signature = readHeader(headers, 'sign');
  if (!secret || !signature) {
    throw new ForbiddenException('PAYMENT_WEBHOOK_SIGNATURE_INVALID');
  }
  const expectedSignature = createHash('md5')
    .update(`${rawBody.toString('base64')}${secret}`)
    .digest('hex');
  if (!compareSecrets(expectedSignature, signature)) {
    throw new ForbiddenException('PAYMENT_WEBHOOK_SIGNATURE_INVALID');
  }
}

/**
 * WATA: HMAC-SHA256 of the raw request body with webhookSecret, hex-encoded.
 * Header: `X-Signature` (also accept `x-wata-signature` as observed in some envs).
 */
function verifyWataSignature(
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
  gatewaySettings: Record<string, unknown>,
): void {
  const secret = readStringSetting(gatewaySettings, 'webhookSecret');
  const signature = readHeader(headers, 'x-signature') ?? readHeader(headers, 'x-wata-signature');
  if (!secret || !signature) {
    throw new ForbiddenException('PAYMENT_WEBHOOK_SIGNATURE_INVALID');
  }
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  if (!compareSecrets(expected, signature)) {
    throw new ForbiddenException('PAYMENT_WEBHOOK_SIGNATURE_INVALID');
  }
}

/**
 * Valutix: HMAC-SHA512 of the raw request body keyed by the gateway's
 * `apiToken`, hex-encoded. Header: `X-Signature`. Verified strictly — a
 * missing header or mismatch is rejected (unlike RIOPAY, which defines no
 * signature scheme and stays permissive).
 */
function verifyValutixSignature(
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
  gatewaySettings: Record<string, unknown>,
): void {
  const secret = readStringSetting(gatewaySettings, 'apiToken');
  const signature = readHeader(headers, 'x-signature');
  if (!secret || !signature) {
    throw new ForbiddenException('PAYMENT_WEBHOOK_SIGNATURE_INVALID');
  }
  const expected = createHmac('sha512', secret).update(rawBody).digest('hex');
  if (!compareSecrets(expected, signature)) {
    throw new ForbiddenException('PAYMENT_WEBHOOK_SIGNATURE_INVALID');
  }
}

/**
 * AuraPay: HMAC-SHA256 of the JSON values concatenated in alphabetical key
 * order, signed with secret key #2. Hex-encoded. Header: `X-SIGNATURE`.
 *
 * The `sign` field, if present in the payload, must be excluded from the
 * concatenation. AuraPay docs use HMAC-SHA256 + ksort (PHP-style).
 */
function verifyAurapaySignature(
  rawPayload: Record<string, unknown>,
  headers: Record<string, string | string[] | undefined>,
  gatewaySettings: Record<string, unknown>,
): void {
  const secret = readStringSetting(gatewaySettings, 'secretKey');
  const signature = readHeader(headers, 'x-signature');
  if (!secret || !signature) {
    throw new ForbiddenException('PAYMENT_WEBHOOK_SIGNATURE_INVALID');
  }

  const sortedKeys = Object.keys(rawPayload)
    .filter((key) => key !== 'sign' && key !== 'signature')
    .sort();
  const concatenated = sortedKeys.map((key) => stringifyAurapayValue(rawPayload[key])).join('');
  const expected = createHmac('sha256', secret).update(concatenated).digest('hex');
  if (!compareSecrets(expected, signature)) {
    throw new ForbiddenException('PAYMENT_WEBHOOK_SIGNATURE_INVALID');
  }
}

function stringifyAurapayValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  // Nested objects/arrays — serialize as JSON to match PHP's implode behavior
  // when those values are not scalars; AuraPay docs only show flat payloads.
  return JSON.stringify(value);
}

/**
 * RollyPay: HMAC-SHA256 of `${timestamp}.${rawBody}` with signing_secret.
 * Headers: `X-Signature` (hex) + `X-Timestamp` (Unix timestamp).
 */
function verifyRollypaySignature(
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
  gatewaySettings: Record<string, unknown>,
): void {
  const secret = readStringSetting(gatewaySettings, 'signingSecret');
  const signature = readHeader(headers, 'x-signature');
  const timestamp = readHeader(headers, 'x-timestamp');
  if (!secret || !signature || !timestamp) {
    throw new ForbiddenException('PAYMENT_WEBHOOK_SIGNATURE_INVALID');
  }

  const hmac = createHmac('sha256', secret);
  hmac.update(timestamp);
  hmac.update('.');
  hmac.update(rawBody);
  const expected = hmac.digest('hex');
  if (!compareSecrets(expected, signature)) {
    throw new ForbiddenException('PAYMENT_WEBHOOK_SIGNATURE_INVALID');
  }
}

/**
 * SeverPay: HMAC-SHA256 of the JSON-encoded payload (with the `sign` key
 * removed) using the merchant's secretToken. The signature is delivered
 * **inside the body** as the `sign` field (not a header).
 *
 * SeverPay's PHP example uses `json_encode($input)` after `unset($input['sign'])`,
 * so we re-serialize with the same key order as Node's default (insertion order).
 */
function verifySeverpaySignature(
  rawPayload: Record<string, unknown>,
  gatewaySettings: Record<string, unknown>,
): void {
  const secret = readStringSetting(gatewaySettings, 'secretToken');
  const signature = readOptionalString(rawPayload, ['sign', 'signature']);
  if (!secret || !signature) {
    throw new ForbiddenException('PAYMENT_WEBHOOK_SIGNATURE_INVALID');
  }
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rawPayload)) {
    if (key !== 'sign' && key !== 'signature') {
      cleaned[key] = value;
    }
  }
  const expected = createHmac('sha256', secret).update(JSON.stringify(cleaned)).digest('hex');
  if (!compareSecrets(expected, signature)) {
    throw new ForbiddenException('PAYMENT_WEBHOOK_SIGNATURE_INVALID');
  }
}

/**
 * lava.top: webhook is authenticated by a static `X-Api-Key` header that
 * matches a key the merchant pre-registered with lava.top (see "Authorize
 * the recipient" in the developer portal). No payload signature.
 */
function verifyLavaApiKey(
  headers: Record<string, string | string[] | undefined>,
  gatewaySettings: Record<string, unknown>,
): void {
  const expected = readStringSetting(gatewaySettings, 'webhookApiKey');
  const actual = readHeader(headers, 'x-api-key');
  if (!expected || !actual || !compareSecrets(actual, expected)) {
    throw new ForbiddenException('PAYMENT_WEBHOOK_SIGNATURE_INVALID');
  }
}

/**
 * CryptoPay (@CryptoBot): the `crypto-pay-api-signature` header is the hex
 * HMAC-SHA256 of the raw (unparsed) JSON body, signed with a secret that is
 * the SHA256 digest of the app's API token. Mirrors the official check in
 * the Crypto Pay API docs.
 */
function verifyCryptopaySignature(
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
  gatewaySettings: Record<string, unknown>,
): void {
  const apiToken = readStringSetting(gatewaySettings, 'apiToken');
  const signature = readHeader(headers, 'crypto-pay-api-signature');
  if (!apiToken || !signature) {
    throw new ForbiddenException('PAYMENT_WEBHOOK_SIGNATURE_INVALID');
  }
  const secret = createHash('sha256').update(apiToken).digest();
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  if (!compareSecrets(expected, signature)) {
    throw new ForbiddenException('PAYMENT_WEBHOOK_SIGNATURE_INVALID');
  }
}

function calculateHeleketSignatureCandidates(
  rawBody: Buffer,
  rawPayload: Record<string, unknown>,
  secret: string,
): readonly string[] {
  const bodyBase64 = rawBody.toString('base64');
  const baseCandidate = createHash('md5').update(`${bodyBase64}${secret}`).digest('hex');

  const cleanedPayloadEntries = Object.entries(rawPayload).filter(
    ([key]) => key !== 'sign' && key !== 'signature',
  );
  if (cleanedPayloadEntries.length === Object.keys(rawPayload).length) {
    return [baseCandidate];
  }

  const cleanedPayload = Object.fromEntries(cleanedPayloadEntries);
  const cleanedBody = Buffer.from(JSON.stringify(cleanedPayload), 'utf8');
  const sortedPayload = Object.fromEntries(
    [...cleanedPayloadEntries].sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey)),
  );
  const sortedBody = Buffer.from(JSON.stringify(sortedPayload), 'utf8');

  return [
    baseCandidate,
    createHash('md5')
      .update(`${cleanedBody.toString('base64')}${secret}`)
      .digest('hex'),
    createHash('md5')
      .update(`${sortedBody.toString('base64')}${secret}`)
      .digest('hex'),
  ];
}

function createTrustedBlockList(networks: readonly string[]): BlockList {
  const blockList = new BlockList();
  for (const network of networks) {
    const [address, prefix] = network.split('/');
    if (!address || !prefix) {
      continue;
    }
    const family: 'ipv4' | 'ipv6' = address.includes(':') ? 'ipv6' : 'ipv4';
    blockList.addSubnet(address, Number(prefix), family);
  }
  return blockList;
}

function readNestedObject(
  value: Record<string, unknown>,
  propertyName: string,
): Record<string, unknown> {
  const propertyValue = value[propertyName];
  if (typeof propertyValue !== 'object' || propertyValue === null || Array.isArray(propertyValue)) {
    return {};
  }
  return propertyValue as Record<string, unknown>;
}

function readRequiredString(
  value: Record<string, unknown>,
  propertyNames: readonly string[],
  errorCode: string,
): string {
  const resolvedValue = readOptionalString(value, propertyNames);
  if (!resolvedValue) {
    throw new BadRequestException(errorCode);
  }
  return resolvedValue;
}

function readOptionalString(
  value: Record<string, unknown>,
  propertyNames: readonly string[],
): string | null {
  for (const propertyName of propertyNames) {
    const propertyValue = value[propertyName];
    if (typeof propertyValue === 'string' && propertyValue.trim().length > 0) {
      return propertyValue.trim();
    }
    if (typeof propertyValue === 'number' && Number.isFinite(propertyValue)) {
      return String(propertyValue);
    }
  }
  return null;
}

function readStringSetting(settings: Record<string, unknown>, propertyName: string): string | null {
  const propertyValue = settings[propertyName];
  return typeof propertyValue === 'string' && propertyValue.trim().length > 0
    ? propertyValue.trim()
    : null;
}

function readHeader(
  headers: Record<string, string | string[] | undefined>,
  headerName: string,
): string | null {
  const directHeader = headers[headerName];
  if (typeof directHeader === 'string' && directHeader.trim().length > 0) {
    return directHeader.trim();
  }
  const normalizedHeader = headers[headerName.toLowerCase()];
  if (typeof normalizedHeader === 'string' && normalizedHeader.trim().length > 0) {
    return normalizedHeader.trim();
  }
  if (Array.isArray(normalizedHeader) && typeof normalizedHeader[0] === 'string') {
    return normalizedHeader[0].trim();
  }
  return null;
}

function compareSecrets(actualValue: string, expectedValue: string): boolean {
  const actualBuffer = Buffer.from(actualValue);
  const expectedBuffer = Buffer.from(expectedValue);
  if (actualBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return timingSafeEqual(actualBuffer, expectedBuffer);
}
