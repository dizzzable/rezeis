import 'reflect-metadata';

import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';
import { PaymentGatewayType } from '@prisma/client';

import { PaymentWebhookNormalizerService } from '../src/modules/payments/services/payment-webhook-normalizer.service';

/**
 * Antilopay signs the **raw body** with SHA256withRSA, base64, and delivers it
 * in `X-Apay-Callback`. The merchant verifies with Antilopay's public key.
 *
 * The bug this pins is not the algorithm — that was right — but the key format.
 * Verification accepted bare base64 DER only, while the Node.js sample in
 * Antilopay's own documentation presents the key as PEM. An operator who
 * followed the documentation pasted PEM and every single callback answered 403:
 * money taken, the transaction left PENDING, then cancelled by the expiry
 * sweep. Nothing about that failure points at the key encoding.
 *
 * Wata's PKCS1 PEM is covered here too, because Antilopay, Overpay and Wata now
 * share one key-loading helper and Wata is the one that publishes PKCS1.
 */

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

const SPKI_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const SPKI_DER_BASE64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

const service = new PaymentWebhookNormalizerService();

function body(fields: Record<string, unknown>): Buffer {
  return Buffer.from(JSON.stringify(fields), 'utf8');
}

function sign(rawBody: Buffer, algorithm = 'SHA256'): string {
  return createSign(algorithm).update(rawBody).sign(privateKey, 'base64');
}

function normalizeAntilopay(rawBody: Buffer, settingsPublicKey: string, signature: string) {
  return service.normalizeWebhook({
    gatewayType: PaymentGatewayType.ANTILOPAY,
    rawBody,
    headers: { 'x-apay-callback': signature },
    clientIp: null,
    gatewaySettings: { publicKey: settingsPublicKey },
    verifySignature: true,
  });
}

describe('Antilopay webhook signature — public key formats', () => {
  it('verifies a callback with a PEM public key, the form the docs show', () => {
    // The regression: this is what an operator following the documentation
    // pastes, and it used to fail every time.
    const rawBody = body({ order_id: 'payment-1', payment_id: 'apay-1', status: 'SUCCESS' });
    const envelope = normalizeAntilopay(rawBody, SPKI_PEM, sign(rawBody));
    assert.equal(envelope.paymentId, 'payment-1');
    assert.equal(envelope.eventStatus, 'SUCCESS');
  });

  it('verifies a callback with a bare base64 DER public key', () => {
    // The form that already worked — it must keep working, so an operator who
    // configured the gateway before the fix is not broken by it.
    const rawBody = body({ order_id: 'payment-2', status: 'SUCCESS' });
    assert.equal(normalizeAntilopay(rawBody, SPKI_DER_BASE64, sign(rawBody)).paymentId, 'payment-2');
  });

  it('tolerates a trailing newline on a PEM key', () => {
    // Copying a key out of a doc page or a file brings the newline along.
    const rawBody = body({ order_id: 'payment-3', status: 'SUCCESS' });
    assert.equal(
      normalizeAntilopay(rawBody, `${SPKI_PEM}\n`, sign(rawBody)).paymentId,
      'payment-3',
    );
  });

  it('tolerates surrounding whitespace on a base64 DER key', () => {
    const rawBody = body({ order_id: 'payment-4', status: 'SUCCESS' });
    assert.equal(
      normalizeAntilopay(rawBody, `  ${SPKI_DER_BASE64}\n`, sign(rawBody)).paymentId,
      'payment-4',
    );
  });

  it('reports FAIL rather than swallowing it', () => {
    const rawBody = body({ order_id: 'payment-5', status: 'FAIL' });
    assert.equal(normalizeAntilopay(rawBody, SPKI_PEM, sign(rawBody)).eventStatus, 'FAIL');
  });
});

describe('Antilopay webhook signature — rejection', () => {
  it('rejects a signature made with a different key', () => {
    const rawBody = body({ order_id: 'payment-6', status: 'SUCCESS' });
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const forged = createSign('SHA256').update(rawBody).sign(other.privateKey, 'base64');
    assert.throws(
      () => normalizeAntilopay(rawBody, SPKI_PEM, forged),
      /PAYMENT_WEBHOOK_SIGNATURE_INVALID/,
    );
  });

  it('rejects a body edited after signing', () => {
    // The signature covers the raw body, so raising the amount invalidates it.
    const honest = body({ order_id: 'payment-7', status: 'SUCCESS', amount: '10.00' });
    const tampered = body({ order_id: 'payment-7', status: 'SUCCESS', amount: '1000.00' });
    assert.throws(
      () => normalizeAntilopay(tampered, SPKI_PEM, sign(honest)),
      /PAYMENT_WEBHOOK_SIGNATURE_INVALID/,
    );
  });

  it('rejects a callback with no signature header at all', () => {
    const rawBody = body({ order_id: 'payment-8', status: 'SUCCESS' });
    assert.throws(
      () =>
        service.normalizeWebhook({
          gatewayType: PaymentGatewayType.ANTILOPAY,
          rawBody,
          headers: {},
          clientIp: null,
          gatewaySettings: { publicKey: SPKI_PEM },
          verifySignature: true,
        }),
      /PAYMENT_WEBHOOK_SIGNATURE_INVALID/,
    );
  });

  it('rejects when the configured public key is unparsable', () => {
    // A mangled key must fail closed, not throw something the ingress does not
    // recognize as a signature failure.
    const rawBody = body({ order_id: 'payment-9', status: 'SUCCESS' });
    assert.throws(
      () => normalizeAntilopay(rawBody, 'not-a-key', sign(rawBody)),
      /PAYMENT_WEBHOOK_SIGNATURE_INVALID/,
    );
  });
});

describe('Wata webhook signature — shared key loader', () => {
  it('still verifies a PKCS1 PEM key, the form Wata publishes', () => {
    // Antilopay, Overpay and Wata share one key loader now; Wata is the only
    // one that serves PKCS1 ("BEGIN RSA PUBLIC KEY"), so it is the case that
    // would break unnoticed if the helper ever dropped the PEM branch.
    const rawBody = body({ orderId: 'payment-10', transactionStatus: 'Paid' });
    const envelope = service.normalizeWebhook({
      gatewayType: PaymentGatewayType.WATA,
      rawBody,
      headers: { 'x-signature': sign(rawBody, 'SHA512') },
      clientIp: null,
      gatewaySettings: {
        publicKey: publicKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
      },
      verifySignature: true,
    });
    assert.equal(envelope.paymentId, 'payment-10');
  });
});
