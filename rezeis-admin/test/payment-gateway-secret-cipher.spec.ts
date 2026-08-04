import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PaymentGatewayType } from '@prisma/client';

import {
  GATEWAY_SECRET_SETTING_KEYS,
  decryptSettingValue,
  encryptSettingValue,
  isEncryptedSettingValue,
  isMaskOf,
  isSecretSettingKey,
  looksLikeMask,
  maskSecretValue,
} from '../src/modules/payments/utils/payment-gateway-secret-cipher';

const MASTER_KEY = 'master-crypt-key-that-is-32plus-bytes-long!!';
const DEDICATED_KEY = 'dedicated-payment-key-that-is-32plus-bytes!!';

/**
 * Runs `body` with an exact crypt-key environment and restores whatever the
 * process had afterwards. The cipher reads `process.env` at call time (matching
 * `ai-config.service.ts`), so key rotation and the no-key case are only
 * reachable by swapping the variables around the call.
 */
function withCryptKeys(
  keys: { readonly master?: string; readonly dedicated?: string },
  body: () => void,
): void {
  const previousMaster = process.env.REZEIS_CRYPT_KEY;
  const previousDedicated = process.env.PAYMENT_GATEWAY_CRYPT_KEY;
  try {
    if (keys.master === undefined) {
      delete process.env.REZEIS_CRYPT_KEY;
    } else {
      process.env.REZEIS_CRYPT_KEY = keys.master;
    }
    if (keys.dedicated === undefined) {
      delete process.env.PAYMENT_GATEWAY_CRYPT_KEY;
    } else {
      process.env.PAYMENT_GATEWAY_CRYPT_KEY = keys.dedicated;
    }
    body();
  } finally {
    if (previousMaster === undefined) {
      delete process.env.REZEIS_CRYPT_KEY;
    } else {
      process.env.REZEIS_CRYPT_KEY = previousMaster;
    }
    if (previousDedicated === undefined) {
      delete process.env.PAYMENT_GATEWAY_CRYPT_KEY;
    } else {
      process.env.PAYMENT_GATEWAY_CRYPT_KEY = previousDedicated;
    }
  }
}

describe('payment gateway secret cipher', () => {
  it('round-trips a secret through encrypt and decrypt', () => {
    withCryptKeys({ master: MASTER_KEY }, () => {
      const secret = 'live_sk_9f3a72be41d0c8e5';
      const envelope = encryptSettingValue(secret);

      assert.equal(isEncryptedSettingValue(envelope), true);
      // The ciphertext must not contain the plaintext anywhere — that is the
      // whole point of encrypting the column.
      assert.equal(envelope.includes(secret), false);
      assert.equal(decryptSettingValue(envelope), secret);
    });
  });

  it('produces a different envelope each time the same secret is encrypted', () => {
    withCryptKeys({ master: MASTER_KEY }, () => {
      const first = encryptSettingValue('same-secret-value');
      const second = encryptSettingValue('same-secret-value');

      // A fresh random IV per write. Without it, two gateways sharing a
      // credential would be visibly identical in the database.
      assert.notEqual(first, second);
      assert.equal(decryptSettingValue(first), 'same-secret-value');
      assert.equal(decryptSettingValue(second), 'same-secret-value');
    });
  });

  it('refuses to encrypt rather than store plaintext when no crypt key is set', () => {
    withCryptKeys({}, () => {
      // Deriving a key from the empty string would produce ciphertext anyone
      // can open while every downstream check reports the value as encrypted.
      // Failing loudly is the only outcome an operator can notice.
      assert.throws(() => encryptSettingValue('some-secret'), /PAYMENT_GATEWAY_CRYPT_KEY/);
    });
  });

  it('still decrypts master-key rows after a dedicated payment key is added', () => {
    let envelope = '';
    withCryptKeys({ master: MASTER_KEY }, () => {
      envelope = encryptSettingValue('rotating-secret');
    });

    withCryptKeys({ master: MASTER_KEY, dedicated: DEDICATED_KEY }, () => {
      // Adding PAYMENT_GATEWAY_CRYPT_KEY to a live panel must not orphan the
      // rows already written under REZEIS_CRYPT_KEY — both keys are tried.
      assert.equal(decryptSettingValue(envelope), 'rotating-secret');
      // New writes use the dedicated key, and the master alone can no longer
      // open them, which is what makes the separate rotation meaningful.
      const rewritten = encryptSettingValue('rotating-secret');
      withCryptKeys({ master: MASTER_KEY }, () => {
        assert.equal(decryptSettingValue(rewritten), null);
      });
    });
  });

  it('returns null instead of ciphertext when no configured key opens the envelope', () => {
    let envelope = '';
    withCryptKeys({ master: MASTER_KEY }, () => {
      envelope = encryptSettingValue('unreadable-secret');
    });

    withCryptKeys({ master: 'a-completely-different-key-32plus-bytes!!' }, () => {
      // Handing a provider the ciphertext as its API key would fail auth on a
      // live payment while readiness still reported the gateway as ready.
      assert.equal(decryptSettingValue(envelope), null);
    });
  });

  it('rejects a malformed envelope without throwing', () => {
    withCryptKeys({ master: MASTER_KEY }, () => {
      assert.equal(decryptSettingValue('PGENC1:not-an-envelope'), null);
      assert.equal(decryptSettingValue('PGENC1:aabb:ccdd:eeff'), null);
    });
  });

  it('masks a long secret as eight asterisks plus its real last four characters', () => {
    // Last-4 is what lets an operator confirm WHICH key is installed against
    // the provider dashboard without being able to reconstruct it.
    assert.equal(maskSecretValue('live_sk_9f3a72be41d0c8e5'), '********c8e5');
    assert.equal(maskSecretValue('12345678'), '********5678');
  });

  it('masks a short secret without revealing any suffix', () => {
    // Showing the last 4 of a 6-character value hands over most of it.
    assert.equal(maskSecretValue('short'), '********');
    assert.equal(maskSecretValue('1234567'), '********');
    // Fixed width regardless of length, so the mask never leaks how long the
    // real credential is.
    assert.equal(maskSecretValue('a'.repeat(200)), '********aaaa');
  });

  it('recognises the exact mask of a stored value and anything mask-shaped', () => {
    assert.equal(isMaskOf('********c8e5', 'live_sk_9f3a72be41d0c8e5'), true);
    assert.equal(isMaskOf('********0000', 'live_sk_9f3a72be41d0c8e5'), false);
    // Deliberately permissive: mistaking a mask for a real credential replaces
    // a live key with `********` and stops payments, so anything carrying the
    // mask body is treated as "unchanged".
    assert.equal(looksLikeMask('********'), true);
    assert.equal(looksLikeMask('********c8e5'), true);
    assert.equal(looksLikeMask('live_sk_9f3a72be41d0c8e5'), false);
  });

  it('classifies credentials as secret and configuration as readable', () => {
    // The explicit policy: what a leak would actually cost is what decides,
    // not whether the field name sounds sensitive.
    const secret: ReadonlyArray<readonly [PaymentGatewayType, string]> = [
      [PaymentGatewayType.YOOKASSA, 'apiKey'],
      [PaymentGatewayType.YOOKASSA, 'secretKey'],
      [PaymentGatewayType.YOOKASSA, 'moyNalogPassword'],
      [PaymentGatewayType.YOOKASSA, 'moyNalogRefreshToken'],
      // Proxy URLs routinely embed `user:pass@host`.
      [PaymentGatewayType.YOOKASSA, 'moyNalogProxy'],
      [PaymentGatewayType.TELEGRAM_STARS, 'providerToken'],
      [PaymentGatewayType.TELEGRAM_STARS, 'webhookSecret'],
      [PaymentGatewayType.PLATEGA, 'secret'],
      [PaymentGatewayType.ANTILOPAY, 'privateKey'],
      // Travels in the `X-Apay-Secret-Id` auth header beside the signature.
      [PaymentGatewayType.ANTILOPAY, 'secretId'],
      [PaymentGatewayType.WATA, 'apiKey'],
      [PaymentGatewayType.WATA, 'webhookSecret'],
      [PaymentGatewayType.LAVA, 'webhookApiKey'],
      [PaymentGatewayType.ROLLYPAY, 'signingSecret'],
      [PaymentGatewayType.SEVERPAY, 'secretToken'],
      [PaymentGatewayType.RIOPAY, 'apiToken'],
    ];
    for (const [gatewayType, key] of secret) {
      assert.equal(isSecretSettingKey(gatewayType, key), true, `${gatewayType}.${key} must be secret`);
    }

    const readable: ReadonlyArray<readonly [PaymentGatewayType, string]> = [
      // Merchant-facing identifiers, printed on invoices and in the provider's
      // own dashboard — encrypting them hides nothing.
      [PaymentGatewayType.YOOKASSA, 'shopId'],
      [PaymentGatewayType.HELEKET, 'merchantId'],
      [PaymentGatewayType.PLATEGA, 'merchantId'],
      [PaymentGatewayType.ANTILOPAY, 'projectIdentificator'],
      [PaymentGatewayType.SEVERPAY, 'mid'],
      [PaymentGatewayType.LAVA, 'offerId'],
      // Public keys verify the provider's callback signature; Wata publishes
      // its own at `GET /api/h2h/public-key`.
      [PaymentGatewayType.WATA, 'publicKey'],
      [PaymentGatewayType.ANTILOPAY, 'publicKey'],
      [PaymentGatewayType.OVERPAY, 'publicKey'],
      // Behaviour switches and fiscal codes — reading them back is how a wrong
      // Platega method or a missing Antilopay VAT rate gets diagnosed.
      [PaymentGatewayType.PLATEGA, 'paymentMethod'],
      [PaymentGatewayType.RIOPAY, 'serviceId'],
      [PaymentGatewayType.VALUTIX, 'serviceId'],
      [PaymentGatewayType.ANTILOPAY, 'vat'],
      [PaymentGatewayType.YOOKASSA, 'vatCode'],
      [PaymentGatewayType.CRYPTOPAY, 'isTestnet'],
      // Taxpayer number printed on every receipt; device handle authenticates
      // nothing on its own.
      [PaymentGatewayType.YOOKASSA, 'moyNalogInn'],
      [PaymentGatewayType.YOOKASSA, 'moyNalogDeviceId'],
    ];
    for (const [gatewayType, key] of readable) {
      assert.equal(
        isSecretSettingKey(gatewayType, key),
        false,
        `${gatewayType}.${key} must stay readable`,
      );
    }
  });

  it('covers every gateway type so a new provider cannot default to unprotected', () => {
    for (const gatewayType of Object.values(PaymentGatewayType)) {
      assert.equal(
        Array.isArray(GATEWAY_SECRET_SETTING_KEYS[gatewayType]),
        true,
        `${gatewayType} is missing from the secret-field catalog`,
      );
    }
    // The internal wallet method never calls an external provider.
    assert.deepStrictEqual(GATEWAY_SECRET_SETTING_KEYS[PaymentGatewayType.PARTNER_BALANCE], []);
  });
});
