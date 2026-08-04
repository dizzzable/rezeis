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

  it('normalizes a YOOKASSA refund.succeeded to REFUNDED, keyed by the original payment id', () => {
    // The refund object carries `payment_id` (the original YooKassa payment id)
    // and its own `status: succeeded` — but no `metadata.paymentId`. The
    // normalizer must key by `payment_id` (matched via `gatewayId` downstream)
    // and surface REFUNDED so the reconciler reverses the payment's side-effects
    // instead of reading `succeeded` as a fresh completed payment.
    const rawBody = Buffer.from(
      JSON.stringify({
        type: 'notification',
        event: 'refund.succeeded',
        object: {
          id: 'yoo-refund-id',
          status: 'succeeded',
          payment_id: 'yoo-original-payment-id',
          amount: { value: '100.00', currency: 'RUB' },
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

    assert.equal(result.paymentId, 'yoo-original-payment-id');
    assert.equal(result.eventStatus, 'REFUNDED');
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

  function normalizeSigned(body: unknown) {
    const { rawBody, signature } = signedBody(body);
    return service.normalizeWebhook({
      gatewayType: PaymentGatewayType.CRYPTOPAY,
      rawBody,
      headers: { 'crypto-pay-api-signature': signature },
      clientIp: null,
      gatewaySettings: { apiToken },
      verifySignature: true,
    });
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
    // The invoice id, not the update id — see the collision test below.
    assert.equal(result.providerEventId, '555');
    assert.equal(result.eventStatus, 'paid');
  });

  it('keys the dedup id on invoice_id when update_id is absent', () => {
    const result = normalizeSigned({
      update_type: 'invoice_paid',
      payload: { invoice_id: 777, status: 'active', payload: 'pid-2' },
    });

    assert.equal(result.paymentId, 'pid-2');
    assert.equal(result.providerEventId, '777');
    assert.equal(result.eventStatus, 'active');
  });

  it('gives two invoices sharing one update_id distinct providerEventIds', () => {
    // Crypto Pay documents `update_id` as a "Non-unique update ID". Keying the
    // inbox on it meant a collision between two invoices landed on one dedup
    // row: the differing payload hash made the inbox overwrite that row in
    // place, re-pointing the already-queued job at the other invoice, so the
    // first invoice's `paid` event was destroyed before it was ever applied.
    const paidA = normalizeSigned({
      update_id: 4242,
      update_type: 'invoice_paid',
      payload: { invoice_id: 111, status: 'paid', payload: 'local-payment-a' },
    });
    const paidB = normalizeSigned({
      update_id: 4242,
      update_type: 'invoice_paid',
      payload: { invoice_id: 222, status: 'paid', payload: 'local-payment-b' },
    });

    assert.equal(paidA.providerEventId, '111');
    assert.equal(paidB.providerEventId, '222');
    assert.notEqual(paidA.providerEventId, paidB.providerEventId);
  });

  it('reuses one dedup key across an invoice active → paid transition, with distinct payload hashes', () => {
    // Same key by design. The inbox calls a collision a true duplicate only
    // when the payload hash matches too, so the `paid` body refreshes the row
    // and re-enqueues rather than being dropped. That is why the invoice id
    // alone suffices and `update_type` need not be folded into the key.
    const active = normalizeSigned({
      update_id: 1,
      update_type: 'invoice_paid',
      payload: { invoice_id: 333, status: 'active', payload: 'local-payment-c' },
    });
    const paid = normalizeSigned({
      update_id: 2,
      update_type: 'invoice_paid',
      payload: { invoice_id: 333, status: 'paid', payload: 'local-payment-c' },
    });

    assert.equal(active.providerEventId, '333');
    assert.equal(paid.providerEventId, '333');
    assert.notEqual(active.payloadHash, paid.payloadHash);
  });

  it('falls back to the local payment id when the invoice carries no invoice_id', () => {
    // A null from `resolveProviderEventId` is not a crash: `normalizeWebhook`
    // falls back to the already-resolved paymentId, which for CryptoPay is the
    // invoice's own `payload` — still one stable key per invoice.
    const result = normalizeSigned({
      update_id: 5,
      update_type: 'invoice_paid',
      payload: { status: 'paid', payload: 'local-payment-no-invoice-id' },
    });

    assert.equal(result.paymentId, 'local-payment-no-invoice-id');
    assert.equal(result.providerEventId, 'local-payment-no-invoice-id');
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
