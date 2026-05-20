import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
