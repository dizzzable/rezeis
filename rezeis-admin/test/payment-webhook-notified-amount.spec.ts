import 'reflect-metadata';

import assert from 'node:assert/strict';
import { createHash, createHmac, createSign, generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';

import { PaymentGatewayType, Prisma } from '@prisma/client';

import {
  PaymentWebhookNormalizerService,
  paypalychExpectedSignature,
} from '../src/modules/payments/services/payment-webhook-normalizer.service';

/**
 * The envelope now carries the sum the provider says was paid, so the
 * reconciler can compare it against what we booked.
 *
 * Worth stating plainly at the top of the file that tests it, because a test
 * suite is where a check gets over-trusted: this is defence-in-depth, NOT an
 * anti-forgery control. A forger controls every field in the body and would
 * echo the correct amount back. What it catches is an AUTHENTIC notification
 * that disagrees with our record — a provider-side pricing or currency bug, a
 * partial capture, a misconfigured merchant account.
 *
 * That is why coverage travels with the value. The amount is only meaningful
 * evidence where the gateway's signature actually binds it, and three classes
 * exist: signed (12 gateways), static-header auth only (4), and no signature at
 * all (YooKassa, source-IP). Each class is exercised below.
 *
 * Every test drives `normalizeWebhook` end to end with a genuinely-signed body,
 * so it fails if the transport, the signature, the container traversal or the
 * money extraction regress — following `paypalych-webhook.spec.ts`.
 */

const service = new PaymentWebhookNormalizerService();

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const SPKI_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();

function json(fields: Record<string, unknown>): Buffer {
  return Buffer.from(JSON.stringify(fields), 'utf8');
}

function rsaSign(rawBody: Buffer): string {
  return createSign('SHA256').update(rawBody).sign(privateKey, 'base64');
}

// ── Cryptomus / Heleket: md5(base64(json without sign) + apiKey), in the body ──

const CRYPTOMUS_KEY = 'cryptomus-api-key';

function cryptomusBody(fields: Record<string, unknown>): Buffer {
  const escaped = JSON.stringify(fields).replace(/\//g, '\\/');
  const sign = createHash('md5')
    .update(`${Buffer.from(escaped, 'utf8').toString('base64')}${CRYPTOMUS_KEY}`)
    .digest('hex');
  return json({ ...fields, sign });
}

function normalizeCryptomus(fields: Record<string, unknown>) {
  return service.normalizeWebhook({
    gatewayType: PaymentGatewayType.CRYPTOMUS,
    rawBody: cryptomusBody(fields),
    headers: {},
    clientIp: null,
    gatewaySettings: { apiKey: CRYPTOMUS_KEY },
    verifySignature: true,
  });
}

// ── Antilopay / Overpay: SHA256withRSA over the raw body ──────────────────────

function normalizeAntilopay(fields: Record<string, unknown>) {
  const rawBody = json(fields);
  return service.normalizeWebhook({
    gatewayType: PaymentGatewayType.ANTILOPAY,
    rawBody,
    headers: { 'x-apay-callback': rsaSign(rawBody) },
    clientIp: null,
    gatewaySettings: { publicKey: SPKI_PEM },
    verifySignature: true,
  });
}

function normalizeOverpay(fields: Record<string, unknown>) {
  const rawBody = json(fields);
  return service.normalizeWebhook({
    gatewayType: PaymentGatewayType.OVERPAY,
    rawBody,
    headers: { 'content-signature': rsaSign(rawBody) },
    clientIp: null,
    gatewaySettings: { publicKey: SPKI_PEM },
    verifySignature: true,
  });
}

// ── Gateways with no payload signature at all ────────────────────────────────

function normalizePlatega(fields: Record<string, unknown>) {
  return service.normalizeWebhook({
    gatewayType: PaymentGatewayType.PLATEGA,
    rawBody: json(fields),
    headers: { 'x-merchantid': 'merchant-1', 'x-secret': 'platega-secret' },
    clientIp: null,
    gatewaySettings: { merchantId: 'merchant-1', secret: 'platega-secret' },
    verifySignature: true,
  });
}

/** YooKassa authenticates by source IP only — this is a documented address. */
function normalizeYookassa(fields: Record<string, unknown>) {
  return service.normalizeWebhook({
    gatewayType: PaymentGatewayType.YOOKASSA,
    rawBody: json(fields),
    headers: {},
    clientIp: '185.71.76.1',
    gatewaySettings: {},
    verifySignature: true,
  });
}

function normalizeTelegramStars(fields: Record<string, unknown>) {
  return service.normalizeWebhook({
    gatewayType: PaymentGatewayType.TELEGRAM_STARS,
    rawBody: json(fields),
    headers: { 'x-telegram-bot-api-secret-token': 'stars-secret' },
    clientIp: null,
    gatewaySettings: { webhookSecret: 'stars-secret' },
    verifySignature: true,
  });
}

// ── Remaining signed gateways used below ─────────────────────────────────────

function normalizePally(fields: { OutSum: string; InvId: string; CurrencyIn?: string }) {
  const form = new URLSearchParams({
    ...fields,
    Status: 'SUCCESS',
    SignatureValue: paypalychExpectedSignature(fields.OutSum, fields.InvId, 'pally-token'),
  });
  return service.normalizeWebhook({
    gatewayType: PaymentGatewayType.PAYPALYCH,
    rawBody: Buffer.from(form.toString(), 'utf8'),
    headers: {},
    clientIp: null,
    gatewaySettings: { apiKey: 'pally-token', shopId: 'shop-1' },
    verifySignature: true,
  });
}

function normalizeCryptopay(fields: Record<string, unknown>) {
  const rawBody = json(fields);
  const secret = createHash('sha256').update('cryptopay-token').digest();
  return service.normalizeWebhook({
    gatewayType: PaymentGatewayType.CRYPTOPAY,
    rawBody,
    headers: {
      'crypto-pay-api-signature': createHmac('sha256', secret).update(rawBody).digest('hex'),
    },
    clientIp: null,
    gatewaySettings: { apiToken: 'cryptopay-token' },
    verifySignature: true,
  });
}

function normalizeRiopay(fields: Record<string, unknown>) {
  const rawBody = json(fields);
  return service.normalizeWebhook({
    gatewayType: PaymentGatewayType.RIOPAY,
    rawBody,
    headers: { 'x-signature': createHmac('sha512', 'riopay-token').update(rawBody).digest('hex') },
    clientIp: null,
    gatewaySettings: { apiToken: 'riopay-token' },
    verifySignature: true,
  });
}

describe('Notified amount — the three signature-coverage classes', () => {
  it('marks a Cryptomus amount as signature-covered, because the digest binds the whole body', () => {
    const envelope = normalizeCryptomus({
      uuid: 'inv-1',
      order_id: 'payment-1',
      status: 'paid',
      amount: '10.00',
      payment_amount: '10.00',
      currency: 'USDT',
    });

    assert.ok(envelope.notifiedAmount?.value.equals(new Prisma.Decimal('10.00')));
    assert.equal(envelope.notifiedAmount?.signatureCovered, true);
    assert.equal(envelope.notifiedCurrency?.value, 'USDT');
    assert.equal(envelope.notifiedCurrency?.signatureCovered, true);
  });

  it('reports what ARRIVED, not what was invoiced, when Cryptomus says they differ', () => {
    // The underpayment shape: `amount` is what we asked for, `payment_amount`
    // is what the buyer actually sent. Reading `amount` here would report the
    // invoice back to us and hide every short payment.
    const envelope = normalizeCryptomus({
      uuid: 'inv-2',
      order_id: 'payment-2',
      status: 'wrong_amount',
      amount: '12.34',
      payment_amount: '6.40',
      currency: 'USDT',
    });

    assert.ok(envelope.notifiedAmount?.value.equals(new Prisma.Decimal('6.40')));
  });

  it('marks a Platega amount as NOT signature-covered — static headers bind nothing', () => {
    // `X-MerchantId` + `X-Secret` prove the sender knows a secret and say
    // nothing about the body, so this amount could have been rewritten in
    // flight without invalidating anything.
    const envelope = normalizePlatega({
      id: 'platega-event-1',
      payload: 'payment-3',
      status: 'CONFIRMED',
      amount: '499.00',
      currency: 'RUB',
    });

    assert.ok(envelope.notifiedAmount?.value.equals(new Prisma.Decimal('499.00')));
    assert.equal(envelope.notifiedAmount?.signatureCovered, false);
    assert.equal(envelope.notifiedCurrency?.signatureCovered, false);
  });

  it('marks a YooKassa amount as NOT signature-covered — there is no signature at all', () => {
    // YooKassa is authenticated by source IP only. The amount is still worth
    // surfacing as evidence; it is simply not evidence about the merchant.
    const envelope = normalizeYookassa({
      event: 'payment.succeeded',
      object: {
        id: 'yoo-1',
        status: 'succeeded',
        amount: { value: '100.00', currency: 'RUB' },
        metadata: { paymentId: 'payment-4' },
      },
    });

    assert.ok(envelope.notifiedAmount?.value.equals(new Prisma.Decimal('100.00')));
    assert.equal(envelope.notifiedAmount?.signatureCovered, false);
    assert.equal(envelope.notifiedCurrency?.value, 'RUB');
    assert.equal(envelope.notifiedCurrency?.signatureCovered, false);
  });
});

describe('Antilopay — original_amount, not amount', () => {
  it('reads original_amount, the sum charged, and never amount, which is net of fee', () => {
    // «Сумма платежа, указанная при создании». `amount` is what Antilopay
    // settles after commission — reading it would make every honest payment
    // look short by the fee and hold entitlement back on all of them.
    const envelope = normalizeAntilopay({
      order_id: 'payment-5',
      payment_id: 'apay-5',
      status: 'SUCCESS',
      original_amount: '1000.00',
      amount: '965.00',
      fee: '35.00',
      currency: 'rub',
    });

    assert.ok(envelope.notifiedAmount?.value.equals(new Prisma.Decimal('1000.00')));
    assert.equal(envelope.notifiedAmount?.value.equals(new Prisma.Decimal('965.00')), false);
    assert.equal(envelope.notifiedAmount?.signatureCovered, true);
  });

  it('reports no amount at all rather than falling back to the net figure', () => {
    // A gap is recoverable; a confidently wrong number is not. Falling back to
    // `amount` would silently report the post-commission sum as the sum paid.
    const envelope = normalizeAntilopay({
      order_id: 'payment-6',
      status: 'SUCCESS',
      amount: '965.00',
      fee: '35.00',
    });

    assert.equal(envelope.notifiedAmount, undefined);
  });

  it('upper-cases a currency the provider spells in lower case', () => {
    // Antilopay and MulenPay are invoiced in `rub` and echo that spelling back;
    // our `Currency` enum is upper-case, so a raw comparison would flag a
    // mismatch on a perfectly correct notification.
    const envelope = normalizeAntilopay({
      order_id: 'payment-7',
      status: 'SUCCESS',
      original_amount: '500.00',
      currency: 'rub',
    });

    assert.equal(envelope.notifiedCurrency?.value, 'RUB');
  });
});

describe('Pally — a signed amount beside an unsigned currency', () => {
  it('marks the amount covered and the currency NOT covered, because the md5 names only two fields', () => {
    // `md5(OutSum + ":" + InvId + ":" + apiToken)` binds the sum and the
    // invoice id. `CurrencyIn` travels in the same form body with nothing
    // authenticating it. One per-envelope boolean would drag the currency up to
    // "trusted" and let a genuinely-signed 100.00 RUB be read as 100.00 USD.
    const envelope = normalizePally({
      OutSum: '100.00',
      InvId: 'payment-8',
      CurrencyIn: 'RUB',
    });

    assert.ok(envelope.notifiedAmount?.value.equals(new Prisma.Decimal('100.00')));
    assert.equal(envelope.notifiedAmount?.signatureCovered, true);
    assert.equal(envelope.notifiedCurrency?.value, 'RUB');
    assert.equal(envelope.notifiedCurrency?.signatureCovered, false);
  });
});

describe('Notifications that carry no amount', () => {
  it('leaves both fields undefined rather than inventing a zero', () => {
    // A Telegram Stars update with no `total_amount`. Zero would read as "the
    // buyer paid nothing" and alert on a payment that is perfectly fine.
    const envelope = normalizeTelegramStars({
      update_id: 777,
      message: { successful_payment: { invoice_payload: 'payment-9' } },
    });

    assert.equal(envelope.paymentId, 'payment-9');
    assert.equal(envelope.notifiedAmount, undefined);
    assert.equal(envelope.notifiedCurrency, undefined);
  });

  it('still surfaces a Telegram total_amount when the update carries one, uncovered', () => {
    // Stars are their own smallest unit and our invoice posts them unscaled, so
    // `total_amount` maps 1:1 with the booked amount — but the bot secret is a
    // static header, so it is uncovered like the rest of that class.
    const envelope = normalizeTelegramStars({
      update_id: 778,
      message: {
        successful_payment: {
          invoice_payload: 'payment-10',
          currency: 'XTR',
          total_amount: 250,
        },
      },
    });

    assert.ok(envelope.notifiedAmount?.value.equals(new Prisma.Decimal('250')));
    assert.equal(envelope.notifiedAmount?.signatureCovered, false);
    assert.equal(envelope.notifiedCurrency?.value, 'XTR');
  });

  it('drops an unparsable amount instead of emitting a NaN that mismatches everything', () => {
    const envelope = normalizeRiopay({
      externalId: 'payment-11',
      id: 'rio-11',
      status: 'COMPLETED',
      amount: 'not-a-number',
    });

    assert.equal(envelope.notifiedAmount, undefined);
  });
});

describe('Units and precision', () => {
  it('descales Overpay minor units so the amount is comparable to the booked sum', () => {
    // Our checkout posts `Math.round(amount * 100)` and Overpay echoes the same
    // scale back. Left raw, every Overpay payment would read as a 100x
    // mismatch.
    const envelope = normalizeOverpay({
      transaction: {
        tracking_id: 'payment-12',
        status: 'successful',
        amount: 100000,
        currency: 'RUB',
      },
    });

    assert.ok(envelope.notifiedAmount?.value.equals(new Prisma.Decimal('1000.00')));
    assert.equal(envelope.notifiedCurrency?.value, 'RUB');
  });

  it('reads the amount and its currency from the same Overpay container', () => {
    // The checkout-token notification puts both under `order` rather than
    // `transaction`. Taking the sum from one container and the ticker from
    // another would produce a pair that looks comparable and is not.
    const envelope = normalizeOverpay({
      status: 'successful',
      order: { tracking_id: 'payment-13', amount: 250050, currency: 'RUB' },
    });

    assert.ok(envelope.notifiedAmount?.value.equals(new Prisma.Decimal('2500.50')));
    assert.equal(envelope.notifiedCurrency?.value, 'RUB');
  });

  it('keeps exact decimal arithmetic that a float would lose', () => {
    // `Transaction.amount` is Decimal(20, 8) and the comparison downstream is
    // an equality check. Routing a crypto sum through a JS number is precisely
    // where the digits go: `0.1 + 0.2 !== 0.3` as a float.
    const envelope = normalizeCryptopay({
      update_id: 9001,
      update_type: 'invoice_paid',
      payload: { invoice_id: 555, status: 'paid', asset: 'USDT', amount: '0.1', payload: 'payment-14' },
    });

    assert.equal(0.1 + 0.2 === 0.3, false);
    assert.ok(envelope.notifiedAmount?.value.plus('0.2').equals(new Prisma.Decimal('0.3')));
    assert.equal(envelope.notifiedCurrency?.value, 'USDT');
  });
});
