import { createHash, timingSafeEqual } from 'node:crypto';
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
        verifyHeleketSignature(input.rawBody, input.rawPayload, input.headers, input.gatewaySettings);
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
      case PaymentGatewayType.ANTILOPAY:
      case PaymentGatewayType.OVERPAY:
      case PaymentGatewayType.PAYPALYCH:
      case PaymentGatewayType.RIOPAY:
        // Webhook verification for these gateways will be implemented
        // alongside their checkout integration. For now, accept all
        // callbacks so the webhook ingress pipeline doesn't reject them.
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
    if (typeof parsedPayload !== 'object' || parsedPayload === null || Array.isArray(parsedPayload)) {
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

function resolveTelegramPaymentPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
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
    createHash('md5').update(`${cleanedBody.toString('base64')}${secret}`).digest('hex'),
    createHash('md5').update(`${sortedBody.toString('base64')}${secret}`).digest('hex'),
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

function readStringSetting(
  settings: Record<string, unknown>,
  propertyName: string,
): string | null {
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
