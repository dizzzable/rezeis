import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { describe, it } from 'node:test';

import { BadRequestException } from '@nestjs/common';
import { ForbiddenException } from '@nestjs/common';
import { PaymentGatewayType } from '@prisma/client';

import { PaymentWebhookNormalizerService } from '../src/modules/payments/services/payment-webhook-normalizer.service';

describe('PaymentWebhookNormalizerService', () => {
  const service = new PaymentWebhookNormalizerService();

  it('normalizes TELEGRAM_STARS webhooks with secret-token verification', () => {
    const rawBody = Buffer.from(
      JSON.stringify({
        update_id: 777,
        message: {
          successful_payment: {
            invoice_payload: 'payment-1',
          },
        },
      }),
      'utf8',
    );

    const result = service.normalizeWebhook({
      gatewayType: PaymentGatewayType.TELEGRAM_STARS,
      rawBody,
      headers: {
        'x-telegram-bot-api-secret-token': 'telegram-secret',
      },
      clientIp: null,
      gatewaySettings: { webhookSecret: 'telegram-secret' },
      verifySignature: true,
    });

    assert.equal(result.paymentId, 'payment-1');
    assert.equal(result.providerEventId, '777');
    assert.equal(result.eventStatus, 'SUCCESSFUL_PAYMENT');
  });

  it('normalizes YOOKASSA webhooks with trusted source IP verification', () => {
    const rawBody = Buffer.from(
      JSON.stringify({
        event: 'payment.succeeded',
        object: {
          id: 'yoo-provider-id',
          status: 'succeeded',
          metadata: {
            paymentId: 'local-payment-id',
          },
        },
      }),
      'utf8',
    );

    const result = service.normalizeWebhook({
      gatewayType: PaymentGatewayType.YOOKASSA,
      rawBody,
      headers: { 'x-forwarded-for': '185.71.76.1' },
      clientIp: '185.71.76.1',
      gatewaySettings: {},
      verifySignature: true,
    });

    assert.equal(result.paymentId, 'local-payment-id');
    assert.equal(result.providerEventId, 'yoo-provider-id');
    assert.equal(result.eventStatus, 'succeeded');
  });

  it('normalizes HELEKET webhooks with md5 signature verification', () => {
    const payload = {
      order_id: 'heleket-payment-id',
      status: 'paid',
    };
    const rawBody = Buffer.from(JSON.stringify(payload), 'utf8');
    const signature = createHash('md5')
      .update(`${rawBody.toString('base64')}heleket-secret`)
      .digest('hex');

    const result = service.normalizeWebhook({
      gatewayType: PaymentGatewayType.HELEKET,
      rawBody,
      headers: { sign: signature },
      clientIp: null,
      gatewaySettings: { apiKey: 'heleket-secret' },
      verifySignature: true,
    });

    assert.equal(result.paymentId, 'heleket-payment-id');
    assert.equal(result.providerEventId, 'heleket-payment-id');
    assert.equal(result.eventStatus, 'paid');
  });

  it('rejects a forged RIOPAY completed webhook without a valid X-Signature', () => {
    const rawBody = Buffer.from(
      JSON.stringify({
        id: 'riopay-provider-id',
        externalId: 'local-payment-id',
        status: 'COMPLETED',
      }),
      'utf8',
    );

    assert.throws(
      () =>
        service.normalizeWebhook({
          gatewayType: PaymentGatewayType.RIOPAY,
          rawBody,
          headers: { 'x-signature': 'forged' },
          clientIp: null,
          gatewaySettings: { apiToken: 'riopay-api-token' },
          verifySignature: true,
        }),
      ForbiddenException,
    );
  });

  it('normalizes PLATEGA webhooks with callback header verification', () => {
    const rawBody = Buffer.from(
      JSON.stringify({
        id: 'platega-event-id',
        payload: 'platega-payment-id',
        status: 'CONFIRMED',
      }),
      'utf8',
    );

    const result = service.normalizeWebhook({
      gatewayType: PaymentGatewayType.PLATEGA,
      rawBody,
      headers: {
        'x-merchantid': 'merchant-id',
        'x-secret': 'merchant-secret',
      },
      clientIp: null,
      gatewaySettings: { merchantId: 'merchant-id', secret: 'merchant-secret' },
      verifySignature: true,
    });

    assert.equal(result.paymentId, 'platega-payment-id');
    assert.equal(result.providerEventId, 'platega-event-id');
    assert.equal(result.eventStatus, 'CONFIRMED');
  });

  it('normalizes MULENPAY webhooks with api-key verification', () => {
    const rawBody = Buffer.from(
      JSON.stringify({
        uuid: 'mulenpay-payment-id',
        payment_status: 'paid',
      }),
      'utf8',
    );

    const result = service.normalizeWebhook({
      gatewayType: PaymentGatewayType.MULENPAY,
      rawBody,
      headers: { 'x-api-key': 'mulenpay-key' },
      clientIp: null,
      gatewaySettings: { apiKey: 'mulenpay-key' },
      verifySignature: true,
    });

    assert.equal(result.paymentId, 'mulenpay-payment-id');
    assert.equal(result.providerEventId, 'mulenpay-payment-id');
    assert.equal(result.eventStatus, 'paid');
  });

  it('normalizes CRYPTOMUS webhooks with md5 signature verification', () => {
    const payload = {
      uuid: 'cryptomus-event-id',
      order_id: 'cryptomus-payment-id',
      status: 'paid',
    };
    const rawBody = Buffer.from(JSON.stringify(payload), 'utf8');
    const signature = createHash('md5')
      .update(`${rawBody.toString('base64')}cryptomus-secret`)
      .digest('hex');

    const result = service.normalizeWebhook({
      gatewayType: PaymentGatewayType.CRYPTOMUS,
      rawBody,
      headers: { sign: signature },
      clientIp: null,
      gatewaySettings: { apiKey: 'cryptomus-secret' },
      verifySignature: true,
    });

    assert.equal(result.paymentId, 'cryptomus-payment-id');
    assert.equal(result.providerEventId, 'cryptomus-event-id');
    assert.equal(result.eventStatus, 'paid');
  });

  it('rejects invalid signatures', () => {
    const rawBody = Buffer.from(
      JSON.stringify({
        uuid: 'cryptomus-event-id',
        order_id: 'cryptomus-payment-id',
        status: 'paid',
      }),
      'utf8',
    );

    assert.throws(
      () =>
        service.normalizeWebhook({
          gatewayType: PaymentGatewayType.CRYPTOMUS,
          rawBody,
          headers: { sign: 'bad-signature' },
          clientIp: null,
          gatewaySettings: { apiKey: 'cryptomus-secret' },
          verifySignature: true,
        }),
      ForbiddenException,
    );
  });

  it('rejects malformed payloads before normalization', () => {
    assert.throws(
      () =>
        service.normalizeWebhook({
          gatewayType: PaymentGatewayType.PLATEGA,
          rawBody: Buffer.from('not-json', 'utf8'),
          headers: {
            'x-merchantid': 'merchant-id',
            'x-secret': 'merchant-secret',
          },
          clientIp: null,
          gatewaySettings: { merchantId: 'merchant-id', secret: 'merchant-secret' },
          verifySignature: true,
        }),
      BadRequestException,
    );
  });
});

describe('PaymentWebhookNormalizerService — CryptoPay', () => {
  const service = new PaymentWebhookNormalizerService();
  const apiToken = '12345:AAtoken';

  function signedBody(body: unknown): { rawBody: Buffer; signature: string } {
    const rawBody = Buffer.from(JSON.stringify(body), 'utf8');
    const secret = createHash('sha256').update(apiToken).digest();
    const signature = createHmac('sha256', secret).update(rawBody).digest('hex');
    return { rawBody, signature };
  }

  it('normalizes a verified invoice_paid webhook to a SUCCESS-mapping status', () => {
    const { rawBody, signature } = signedBody({
      update_id: 9001,
      update_type: 'invoice_paid',
      payload: {
        invoice_id: 555,
        status: 'paid',
        asset: 'USDT',
        amount: '12.5',
        payload: 'local-payment-cryptopay',
      },
    });

    const result = service.normalizeWebhook({
      gatewayType: PaymentGatewayType.CRYPTOPAY,
      rawBody,
      headers: { 'crypto-pay-api-signature': signature },
      clientIp: null,
      gatewaySettings: { apiToken },
      verifySignature: true,
    });

    assert.equal(result.paymentId, 'local-payment-cryptopay');
    assert.equal(result.providerEventId, '9001');
    assert.equal(result.eventStatus, 'paid');
  });

  it('falls back to invoice_id for the dedup key when update_id is absent', () => {
    const { rawBody, signature } = signedBody({
      update_type: 'invoice_paid',
      payload: { invoice_id: 777, status: 'active', payload: 'pid-2' },
    });

    const result = service.normalizeWebhook({
      gatewayType: PaymentGatewayType.CRYPTOPAY,
      rawBody,
      headers: { 'crypto-pay-api-signature': signature },
      clientIp: null,
      gatewaySettings: { apiToken },
      verifySignature: true,
    });

    assert.equal(result.paymentId, 'pid-2');
    assert.equal(result.providerEventId, '777');
    assert.equal(result.eventStatus, 'active');
  });

  it('rejects a CryptoPay webhook with a tampered signature', () => {
    const { rawBody } = signedBody({
      update_id: 1,
      payload: { invoice_id: 1, status: 'paid', payload: 'pid' },
    });

    assert.throws(
      () =>
        service.normalizeWebhook({
          gatewayType: PaymentGatewayType.CRYPTOPAY,
          rawBody,
          headers: { 'crypto-pay-api-signature': 'deadbeef' },
          clientIp: null,
          gatewaySettings: { apiToken },
          verifySignature: true,
        }),
      ForbiddenException,
    );
  });

  it('rejects a CryptoPay webhook with no signature header', () => {
    const { rawBody } = signedBody({
      update_id: 1,
      payload: { invoice_id: 1, status: 'paid', payload: 'pid' },
    });

    assert.throws(
      () =>
        service.normalizeWebhook({
          gatewayType: PaymentGatewayType.CRYPTOPAY,
          rawBody,
          headers: {},
          clientIp: null,
          gatewaySettings: { apiToken },
          verifySignature: true,
        }),
      ForbiddenException,
    );
  });
});
