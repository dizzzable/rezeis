import 'reflect-metadata';

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { PaymentGatewayType } from '@prisma/client';

import {
  PaymentWebhookNormalizerService,
  paypalychExpectedSignature,
} from '../src/modules/payments/services/payment-webhook-normalizer.service';

/**
 * Pally (sold as PayPalych / Pal24 — one service) posts its notification as
 * `application/x-www-form-urlencoded`, and signs it as
 *   `SignatureValue = strtoupper(md5(OutSum + ":" + InvId + ":" + apiToken))`
 * carried in the body.
 *
 * Every one of those facts was wrong in our code: the body was parsed as JSON
 * and threw before verification even ran, and verification looked for an
 * HMAC-SHA256 in an `x-signature` header. No Pally payment could complete.
 *
 * These tests drive the real service end to end, so they fail if the transport,
 * the signature, the id or the status resolution regress.
 */

const TOKEN = 'pally-api-token';

function form(fields: Record<string, string>): Buffer {
  return Buffer.from(new URLSearchParams(fields).toString(), 'utf8');
}

function signedBody(fields: { OutSum: string; InvId: string; Status: string }): Buffer {
  return form({
    ...fields,
    CurrencyIn: 'RUB',
    SignatureValue: paypalychExpectedSignature(fields.OutSum, fields.InvId, TOKEN),
  });
}

const service = new PaymentWebhookNormalizerService();

function normalize(rawBody: Buffer) {
  return service.normalizeWebhook({
    gatewayType: PaymentGatewayType.PAYPALYCH,
    rawBody,
    headers: {},
    clientIp: null,
    gatewaySettings: { apiKey: TOKEN, shopId: 'shop-1' },
    verifySignature: true,
  });
}

describe('Pally webhook', () => {
  it('accepts a genuine form-encoded notification', () => {
    const envelope = normalize(
      signedBody({ OutSum: '100.00', InvId: 'payment-1', Status: 'SUCCESS' }),
    );
    assert.equal(envelope.paymentId, 'payment-1');
    assert.equal(envelope.eventStatus, 'SUCCESS');
  });

  it('accepts a lower-case signature', () => {
    // The docs specify upper case, but comparing case-sensitively would reject
    // a technically-correct digest for no reason.
    const body = form({
      OutSum: '100.00',
      InvId: 'payment-2',
      Status: 'SUCCESS',
      SignatureValue: paypalychExpectedSignature('100.00', 'payment-2', TOKEN).toLowerCase(),
    });
    assert.equal(normalize(body).paymentId, 'payment-2');
  });

  it('rejects a signature made with a different token', () => {
    const body = form({
      OutSum: '100.00',
      InvId: 'payment-3',
      Status: 'SUCCESS',
      SignatureValue: createHash('md5')
        .update(`100.00:payment-3:other-token`)
        .digest('hex')
        .toUpperCase(),
    });
    assert.throws(() => normalize(body), /PAYMENT_WEBHOOK_SIGNATURE_INVALID/);
  });

  it('rejects a tampered amount', () => {
    // The signature covers OutSum, so raising the paid amount invalidates it.
    const honest = paypalychExpectedSignature('10.00', 'payment-4', TOKEN);
    const body = form({
      OutSum: '1000.00',
      InvId: 'payment-4',
      Status: 'SUCCESS',
      SignatureValue: honest,
    });
    assert.throws(() => normalize(body), /PAYMENT_WEBHOOK_SIGNATURE_INVALID/);
  });

  it('rejects a notification with no signature at all', () => {
    const body = form({ OutSum: '10.00', InvId: 'payment-5', Status: 'SUCCESS' });
    assert.throws(() => normalize(body), /PAYMENT_WEBHOOK_SIGNATURE_INVALID/);
  });

  it('surfaces the underpaid / overpaid statuses rather than losing them', () => {
    // Both mean money arrived — just not the exact amount. They must reach the
    // status mapper instead of being swallowed as a parse failure.
    for (const status of ['UNDERPAID', 'OVERPAID', 'FAIL']) {
      const envelope = normalize(
        signedBody({ OutSum: '99.00', InvId: `payment-${status}`, Status: status }),
      );
      assert.equal(envelope.eventStatus, status);
    }
  });

  it('rejects an empty body instead of treating it as an empty object', () => {
    assert.throws(() => normalize(Buffer.from('', 'utf8')), /PAYMENT_WEBHOOK_PAYLOAD_INVALID/);
  });
});
