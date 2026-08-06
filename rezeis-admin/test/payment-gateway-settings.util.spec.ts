import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BadRequestException } from '@nestjs/common';
import { PaymentGatewayType } from '@prisma/client';

import {
  encryptSettingValue,
  maskSecretValue,
} from '../src/modules/payments/utils/payment-gateway-secret-cipher';
import {
  encryptGatewaySettingsForStorage,
  isGatewayConfigured,
  maskGatewaySettings,
  normalizeGatewaySettingsForStorage,
  readGatewaySettings,
  resolveMaskedGatewaySettings,
} from '../src/modules/payments/utils/payment-gateway-settings.util';

// The cipher reads `process.env` at call time. Every spec in this file needs
// key material present, and the suite must not depend on the shell's env.
process.env.REZEIS_CRYPT_KEY ??= 'settings-util-spec-key-that-is-32plus!!';

describe('normalizeGatewaySettingsForStorage — Platega paymentMethod', () => {
  it('maps CARD to card acquiring (11), the value Platega documents', () => {
    const settings = normalizeGatewaySettingsForStorage(PaymentGatewayType.PLATEGA, {
      merchantId: 'merchant-1',
      secret: 'secret-1',
      paymentMethod: 'CARD',
    });

    assert.deepStrictEqual(settings, {
      merchantId: 'merchant-1',
      secret: 'secret-1',
      paymentMethod: 11,
    });
  });

  it('round-trips every documented enum value as a number and as a numeric string', () => {
    for (const paymentMethod of [2, 3, 11, 12, 13, 14]) {
      assert.equal(
        normalizeGatewaySettingsForStorage(PaymentGatewayType.PLATEGA, { paymentMethod }).paymentMethod,
        paymentMethod,
      );
      assert.equal(
        normalizeGatewaySettingsForStorage(PaymentGatewayType.PLATEGA, {
          paymentMethod: String(paymentMethod),
        }).paymentMethod,
        paymentMethod,
      );
    }
  });

  it('maps every human-readable alias to its documented enum value', () => {
    const expectedByAlias: Record<string, number> = {
      SBP: 2,
      SBPQR: 2,
      ERIP: 3,
      CARD: 11,
      INTERNATIONAL: 12,
      CRYPTO: 13,
      SBERPAY: 14,
    };

    for (const [alias, expected] of Object.entries(expectedByAlias)) {
      assert.equal(
        normalizeGatewaySettingsForStorage(PaymentGatewayType.PLATEGA, { paymentMethod: alias }).paymentMethod,
        expected,
      );
    }
  });

  it('rejects values outside the enum instead of falling back to СБП', () => {
    for (const paymentMethod of [1, '1', 0, 15, 2.5, 'card', 'CARDS', 'SBERBANK', true, null]) {
      assert.throws(
        () => normalizeGatewaySettingsForStorage(PaymentGatewayType.PLATEGA, { paymentMethod }),
        (error: unknown) => {
          assert.equal(error instanceof BadRequestException, true);
          assert.equal((error as BadRequestException).message, 'PAYMENT_GATEWAY_SETTINGS_INVALID');
          return true;
        },
        `expected ${JSON.stringify(paymentMethod)} to be rejected`,
      );
    }
  });

  it('leaves paymentMethod unset when the panel posts the field blank', () => {
    assert.deepStrictEqual(
      normalizeGatewaySettingsForStorage(PaymentGatewayType.PLATEGA, {
        merchantId: 'merchant-1',
        secret: 'secret-1',
        paymentMethod: '   ',
      }),
      { merchantId: 'merchant-1', secret: 'secret-1' },
    );
  });

  it('stores the provider-choice sentinel verbatim, so it survives the storage layer', () => {
    const normalized = normalizeGatewaySettingsForStorage(PaymentGatewayType.PLATEGA, {
      merchantId: 'merchant-1',
      secret: 'secret-1',
      paymentMethod: 'PROVIDER_CHOICE',
    });

    // A string, not a number: it cannot collide with a Platega method — now or
    // when Platega adds one — and it is what checkout matches on to pick
    // `POST /v2/transaction/process`.
    assert.deepStrictEqual(normalized, {
      merchantId: 'merchant-1',
      secret: 'secret-1',
      paymentMethod: 'PROVIDER_CHOICE',
    });

    // `paymentMethod` is deliberately not a secret key, so the sentinel is
    // never enveloped and never masked — panel → validate → encrypt → read
    // hands checkout back the same literal it was given.
    const stored = encryptGatewaySettingsForStorage(PaymentGatewayType.PLATEGA, normalized);
    assert.equal(stored.paymentMethod, 'PROVIDER_CHOICE');
    const readBack = readGatewaySettings(stored as never);
    assert.equal(readBack.paymentMethod, 'PROVIDER_CHOICE');
    assert.equal(
      maskGatewaySettings(PaymentGatewayType.PLATEGA, readBack).settings.paymentMethod,
      'PROVIDER_CHOICE',
    );
    // …and the write-without-read path leaves it alone too, so an operator who
    // only ever sees masks cannot lose the choice by saving the form.
    assert.equal(
      resolveMaskedGatewaySettings(PaymentGatewayType.PLATEGA, readBack, {
        merchantId: 'merchant-1',
        secret: 'secret-1',
        paymentMethod: 'PROVIDER_CHOICE',
      }).paymentMethod,
      'PROVIDER_CHOICE',
    );
  });

  it('keeps «provider choice» and «never chosen» as two different states on disk', () => {
    // The whole reason the sentinel exists. An absent key still means СБП (2)
    // at checkout for every gateway already live on it, so the two must not
    // collapse into one another in the persisted JSON.
    const chosen = normalizeGatewaySettingsForStorage(PaymentGatewayType.PLATEGA, {
      merchantId: 'merchant-1',
      secret: 'secret-1',
      paymentMethod: 'PROVIDER_CHOICE',
    });
    const neverChosen = normalizeGatewaySettingsForStorage(PaymentGatewayType.PLATEGA, {
      merchantId: 'merchant-1',
      secret: 'secret-1',
    });

    assert.equal('paymentMethod' in chosen, true);
    assert.equal('paymentMethod' in neverChosen, false);
  });

  it('rejects near-misses of the sentinel rather than reading them as a choice', () => {
    for (const paymentMethod of ['provider_choice', 'PROVIDER-CHOICE', 'PROVIDER', 'CHOICE']) {
      assert.throws(
        () =>
          normalizeGatewaySettingsForStorage(PaymentGatewayType.PLATEGA, {
            merchantId: 'merchant-1',
            secret: 'secret-1',
            paymentMethod,
          }),
        (error: unknown) => {
          assert.equal(error instanceof BadRequestException, true);
          return true;
        },
        `expected ${JSON.stringify(paymentMethod)} to be rejected`,
      );
    }
  });
});

describe('normalizeGatewaySettingsForStorage — RioPay/Valutix serviceId', () => {
  for (const gatewayType of [PaymentGatewayType.RIOPAY, PaymentGatewayType.VALUTIX]) {
    it(`stores ${gatewayType} serviceId as a number from both numeric forms`, () => {
      assert.deepStrictEqual(
        normalizeGatewaySettingsForStorage(gatewayType, { apiToken: 'token-1', serviceId: 42 }),
        { apiToken: 'token-1', serviceId: 42 },
      );
      assert.deepStrictEqual(
        normalizeGatewaySettingsForStorage(gatewayType, { apiToken: 'token-1', serviceId: '42' }),
        { apiToken: 'token-1', serviceId: 42 },
      );
    });

    it(`keeps ${gatewayType} settings valid when serviceId is not configured`, () => {
      assert.deepStrictEqual(normalizeGatewaySettingsForStorage(gatewayType, { apiToken: 'token-1' }), {
        apiToken: 'token-1',
      });
      assert.deepStrictEqual(
        normalizeGatewaySettingsForStorage(gatewayType, { apiToken: 'token-1', serviceId: '' }),
        { apiToken: 'token-1' },
      );
    });

    it(`rejects a ${gatewayType} serviceId that is not a positive integer`, () => {
      for (const serviceId of [0, -1, 1.5, '0', 'abc', '4 2', true]) {
        assert.throws(
          () => normalizeGatewaySettingsForStorage(gatewayType, { apiToken: 'token-1', serviceId }),
          (error: unknown) => {
            assert.equal(error instanceof BadRequestException, true);
            return true;
          },
          `expected ${JSON.stringify(serviceId)} to be rejected`,
        );
      }
    });
  }
});

describe('normalizeGatewaySettingsForStorage — Antilopay vat', () => {
  const antilopayCredentials = {
    projectIdentificator: 'project-1',
    secretId: 'secret-id-1',
    privateKey: 'MIIEow==',
    publicKey: 'MFwwDQ==',
  };

  it('stores the ОСНО rate as a number from both documented forms', () => {
    for (const vat of [10, 22]) {
      assert.deepStrictEqual(
        normalizeGatewaySettingsForStorage(PaymentGatewayType.ANTILOPAY, {
          ...antilopayCredentials,
          vat,
        }),
        { ...antilopayCredentials, vat },
      );
      assert.deepStrictEqual(
        normalizeGatewaySettingsForStorage(PaymentGatewayType.ANTILOPAY, {
          ...antilopayCredentials,
          vat: String(vat),
        }),
        { ...antilopayCredentials, vat },
      );
    }
  });

  it('leaves vat unset for a merchant on УСН/НПД', () => {
    assert.deepStrictEqual(
      normalizeGatewaySettingsForStorage(PaymentGatewayType.ANTILOPAY, antilopayCredentials),
      antilopayCredentials,
    );
    assert.deepStrictEqual(
      normalizeGatewaySettingsForStorage(PaymentGatewayType.ANTILOPAY, {
        ...antilopayCredentials,
        vat: '   ',
      }),
      antilopayCredentials,
    );
  });

  it('rejects a rate outside the documented enum at save time', () => {
    // Antilopay documents exactly 10 and 22 (p.14); anything else comes back
    // as error 17 on every checkout, so it must not reach storage.
    for (const vat of [0, 5, 18, 20, '18', '20', '10.0', 'НДС 22', true, null]) {
      assert.throws(
        () =>
          normalizeGatewaySettingsForStorage(PaymentGatewayType.ANTILOPAY, {
            ...antilopayCredentials,
            vat,
          }),
        (error: unknown) => {
          assert.equal(error instanceof BadRequestException, true);
          assert.equal((error as BadRequestException).message, 'PAYMENT_GATEWAY_SETTINGS_INVALID');
          return true;
        },
        `expected ${JSON.stringify(vat)} to be rejected`,
      );
    }
  });
});

describe('isGatewayConfigured — webhook verification credentials', () => {
  // Each of these gateways could previously be enabled on its checkout
  // credentials alone: the badge went green, checkouts succeeded, and every
  // callback was then rejected because the verifying credential was never
  // stored. The key named here is the one the webhook normalizer reads.
  const gatewaysRequiringAWebhookCredential = [
    {
      type: PaymentGatewayType.ANTILOPAY,
      checkoutCredentials: {
        projectIdentificator: 'project-1',
        secretId: 'secret-id-1',
        privateKey: 'MIIEow==',
      },
      webhookCredential: 'publicKey',
    },
    {
      type: PaymentGatewayType.OVERPAY,
      checkoutCredentials: { shopId: 'shop-1', secretKey: 'secret-1' },
      webhookCredential: 'publicKey',
    },
    {
      type: PaymentGatewayType.WATA,
      checkoutCredentials: { apiKey: 'wata-key' },
      webhookCredential: 'publicKey',
    },
    {
      type: PaymentGatewayType.AURAPAY,
      checkoutCredentials: { apiKey: 'aura-key', shopId: 'shop-1' },
      webhookCredential: 'secretKey',
    },
    {
      type: PaymentGatewayType.ROLLYPAY,
      checkoutCredentials: { apiKey: 'rolly-key' },
      webhookCredential: 'signingSecret',
    },
    {
      type: PaymentGatewayType.LAVA,
      checkoutCredentials: { apiKey: 'lava-key', offerId: 'offer-1' },
      webhookCredential: 'webhookApiKey',
    },
  ] as const;

  for (const gateway of gatewaysRequiringAWebhookCredential) {
    it(`reports ${gateway.type} unconfigured until ${gateway.webhookCredential} is stored`, () => {
      assert.equal(isGatewayConfigured(gateway.type, gateway.checkoutCredentials), false);
      assert.equal(
        isGatewayConfigured(gateway.type, {
          ...gateway.checkoutCredentials,
          [gateway.webhookCredential]: 'webhook-credential-1',
        }),
        true,
      );
    });

    it(`does not accept a blank ${gateway.type} ${gateway.webhookCredential}`, () => {
      for (const blankValue of ['', '   ', null, 0, true]) {
        assert.equal(
          isGatewayConfigured(gateway.type, {
            ...gateway.checkoutCredentials,
            [gateway.webhookCredential]: blankValue,
          }),
          false,
          `expected ${JSON.stringify(blankValue)} not to count as configured`,
        );
      }
    });

    it(`still requires the ${gateway.type} checkout credentials as well`, () => {
      assert.equal(
        isGatewayConfigured(gateway.type, {
          [gateway.webhookCredential]: 'webhook-credential-1',
        }),
        false,
      );
    });
  }

  it('does not invent a webhook credential for YooKassa, which signs nothing', () => {
    // YooKassa authenticates callbacks by source IP only — there is no shared
    // secret and no signature, so requiring one here would be fiction.
    assert.equal(
      isGatewayConfigured(PaymentGatewayType.YOOKASSA, { shopId: 'shop-1', apiKey: 'key-1' }),
      true,
    );
    assert.equal(
      isGatewayConfigured(PaymentGatewayType.YOOKASSA, { shopId: 'shop-1', secretKey: 'secret-1' }),
      true,
    );
  });
});

describe('encryptGatewaySettingsForStorage / readGatewaySettings — at-rest encryption', () => {
  it('encrypts only the secret-bearing fields and leaves configuration readable', () => {
    const stored = encryptGatewaySettingsForStorage(PaymentGatewayType.ANTILOPAY, {
      projectIdentificator: 'project-1',
      secretId: 'secret-id-1',
      privateKey: 'MIIEvQIBADANBgkqhkiG9w0',
      publicKey: 'MFwwDQYJKoZIhvcNAQEB',
      vat: 22,
    });

    // Credentials are unreadable in the column…
    assert.equal(String(stored.privateKey).startsWith('PGENC1:'), true);
    assert.equal(String(stored.secretId).startsWith('PGENC1:'), true);
    assert.equal(String(stored.privateKey).includes('MIIEvQIBADANBgkqhkiG9w0'), false);
    // …while the project id, the callback verification key and the VAT rate
    // stay browsable, because encrypting them buys nothing and a wrong VAT
    // rate is diagnosed by reading it.
    assert.equal(stored.projectIdentificator, 'project-1');
    assert.equal(stored.publicKey, 'MFwwDQYJKoZIhvcNAQEB');
    assert.equal(stored.vat, 22);

    assert.deepStrictEqual(readGatewaySettings(stored as never), {
      projectIdentificator: 'project-1',
      secretId: 'secret-id-1',
      privateKey: 'MIIEvQIBADANBgkqhkiG9w0',
      publicKey: 'MFwwDQYJKoZIhvcNAQEB',
      vat: 22,
    });
  });

  it('reads a legacy plaintext row unchanged', () => {
    // Rows written before at-rest encryption hold plaintext. Losing an
    // operator's stored credential on upgrade is not an acceptable outcome.
    const legacyRow = { shopId: 'shop-1', apiKey: 'legacy-plaintext-key', vatCode: '1' };

    assert.deepStrictEqual(readGatewaySettings(legacyRow as never), legacyRow);
    assert.equal(isGatewayConfigured(PaymentGatewayType.YOOKASSA, legacyRow as never), true);
  });

  it('reads a half-migrated row where only some fields are encrypted', () => {
    // The «Мой Налог» token rotation writes a single encrypted field into a row
    // that may still be plaintext elsewhere.
    const mixedRow = {
      shopId: 'shop-1',
      apiKey: 'still-plaintext',
      moyNalogRefreshToken: encryptSettingValue('rotated-token'),
    };

    assert.deepStrictEqual(readGatewaySettings(mixedRow as never), {
      shopId: 'shop-1',
      apiKey: 'still-plaintext',
      moyNalogRefreshToken: 'rotated-token',
    });
  });

  it('drops an unreadable field rather than surfacing ciphertext to a provider', () => {
    const previousKey = process.env.REZEIS_CRYPT_KEY;
    const previousDedicated = process.env.PAYMENT_GATEWAY_CRYPT_KEY;
    const row = {
      shopId: 'shop-1',
      apiKey: encryptSettingValue('key-written-under-the-old-crypt-key'),
    };
    try {
      process.env.REZEIS_CRYPT_KEY = 'an-entirely-different-key-32plus-bytes!!';
      delete process.env.PAYMENT_GATEWAY_CRYPT_KEY;

      // Ciphertext as an API key would fail auth at the provider mid-payment
      // while readiness still showed green. Dropping it flips readiness to
      // false, which the operator can actually see, and the row is untouched.
      assert.deepStrictEqual(readGatewaySettings(row as never), { shopId: 'shop-1' });
      assert.equal(isGatewayConfigured(PaymentGatewayType.YOOKASSA, row as never), false);
    } finally {
      process.env.REZEIS_CRYPT_KEY = previousKey;
      if (previousDedicated === undefined) {
        delete process.env.PAYMENT_GATEWAY_CRYPT_KEY;
      } else {
        process.env.PAYMENT_GATEWAY_CRYPT_KEY = previousDedicated;
      }
    }
  });

  it('keeps isGatewayConfigured working against an encrypted row', () => {
    const complete = encryptGatewaySettingsForStorage(PaymentGatewayType.WATA, {
      apiKey: 'wata-api-key',
      publicKey: 'MFwwDQYJKoZI',
    });
    const missingCredential = encryptGatewaySettingsForStorage(PaymentGatewayType.WATA, {
      publicKey: 'MFwwDQYJKoZI',
    });

    // Readiness runs on the decrypted values, so an envelope is never mistaken
    // for "some non-empty string is present".
    assert.equal(isGatewayConfigured(PaymentGatewayType.WATA, complete as never), true);
    assert.equal(isGatewayConfigured(PaymentGatewayType.WATA, missingCredential as never), false);
  });

  it('rejects a submitted value impersonating the storage envelope', () => {
    // Stored verbatim it could never be decrypted, so every later read would
    // drop the field and the operator's credential would vanish silently.
    assert.throws(
      () =>
        normalizeGatewaySettingsForStorage(PaymentGatewayType.YOOKASSA, {
          shopId: 'shop-1',
          apiKey: 'PGENC1:deadbeef:deadbeef:deadbeef',
        }),
      (error: unknown) =>
        error instanceof BadRequestException &&
        error.message === 'PAYMENT_GATEWAY_SETTINGS_INVALID',
    );
  });
});

describe('maskGatewaySettings / resolveMaskedGatewaySettings — the UI contract', () => {
  it('masks secrets and reports which keys are set', () => {
    const masked = maskGatewaySettings(PaymentGatewayType.YOOKASSA, {
      shopId: 'shop-1',
      apiKey: 'live_sk_9f3a72be41d0c8e5',
      vatCode: '1',
    });

    assert.deepStrictEqual(masked.settings, {
      shopId: 'shop-1',
      apiKey: '********c8e5',
      vatCode: '1',
    });
    // A key that is ABSENT means "not set"; present-and-masked means "set but
    // hidden". `secretKey` was never stored, so it does not appear at all.
    assert.deepStrictEqual(masked.maskedKeys, ['apiKey']);
    assert.equal('secretKey' in masked.settings, false);
  });

  it('preserves the stored secret when a masked form is submitted back', () => {
    const stored = { shopId: 'shop-1', apiKey: 'live_sk_9f3a72be41d0c8e5' };
    const submitted = {
      shopId: 'shop-1',
      // Exactly what the operator was shown — they never saw the real value.
      apiKey: maskSecretValue(stored.apiKey),
    };

    // Settings are REPLACED, not merged, so without this the save would store
    // `********c8e5` as the live API key and take the gateway down.
    assert.deepStrictEqual(
      resolveMaskedGatewaySettings(PaymentGatewayType.YOOKASSA, submitted, stored),
      stored,
    );
  });

  it('writes a genuinely new secret over the stored one', () => {
    assert.deepStrictEqual(
      resolveMaskedGatewaySettings(
        PaymentGatewayType.YOOKASSA,
        { shopId: 'shop-1', apiKey: 'rotated_sk_0000111122223333' },
        { shopId: 'shop-1', apiKey: 'live_sk_9f3a72be41d0c8e5' },
      ),
      { shopId: 'shop-1', apiKey: 'rotated_sk_0000111122223333' },
    );
  });

  it('keeps the stored secret even when the mask does not match its current tail', () => {
    // A stale form (rendered before someone else rotated the key) still echoes
    // a mask. Overwriting a live credential with `********` is the failure to
    // design against, so anything mask-shaped means "unchanged".
    assert.deepStrictEqual(
      resolveMaskedGatewaySettings(
        PaymentGatewayType.YOOKASSA,
        { apiKey: '********0000' },
        { apiKey: 'live_sk_9f3a72be41d0c8e5' },
      ),
      { apiKey: 'live_sk_9f3a72be41d0c8e5' },
    );
  });

  it('drops a masked value with nothing stored behind it', () => {
    // Storing the mask literally would make the gateway report itself ready
    // with `********` as its credential.
    assert.deepStrictEqual(
      resolveMaskedGatewaySettings(
        PaymentGatewayType.YOOKASSA,
        { shopId: 'shop-1', apiKey: '********' },
        { shopId: 'shop-1' },
      ),
      { shopId: 'shop-1' },
    );
  });

  it('leaves non-secret fields alone even when they look mask-shaped', () => {
    // Mask handling is scoped to secret-bearing keys, so a merchant id or a
    // VAT code is never second-guessed.
    assert.deepStrictEqual(
      resolveMaskedGatewaySettings(
        PaymentGatewayType.YOOKASSA,
        { shopId: '********', vatCode: '1' },
        { shopId: 'shop-1', vatCode: '1' },
      ),
      { shopId: '********', vatCode: '1' },
    );
  });
});
