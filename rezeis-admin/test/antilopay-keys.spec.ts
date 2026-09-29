import assert from 'node:assert/strict';
import { createPublicKey, createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';

import { BadRequestException } from '@nestjs/common';
import { PaymentGatewayType } from '@prisma/client';

import {
  signAntilopayBody,
  toAntilopayPrivateKeyPem,
} from '../src/modules/payments/utils/antilopay-api.util';
import {
  ANTILOPAY_KEY_REFUSAL_CODES,
  findAntilopayKeyProblem,
} from '../src/modules/payments/utils/antilopay-keys.util';
import { normalizeGatewaySettingsForStorage } from '../src/modules/payments/utils/payment-gateway-settings.util';

const PAIR_2048 = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const PAIR_1024 = generateKeyPairSync('rsa', {
  modulusLength: 1024,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const PAIR_PKCS1 = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
});

/** The base64 body of a PEM, which is what Antilopay's cabinet shows. */
const body = (pem: string): string => pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');

/** Every shape a private key arrives in from a cabinet, a `.pem` file or a chat. */
const PRIVATE_FORMS: ReadonlyArray<readonly [string, string]> = [
  ['PKCS#8 PEM with its trailing newline', PAIR_2048.privateKey],
  ['PKCS#8 PEM without it', PAIR_2048.privateKey.trimEnd()],
  ['bare base64 body', body(PAIR_2048.privateKey)],
  ['PEM with Windows line ends', PAIR_2048.privateKey.replace(/\n/g, '\r\n')],
  ['bare body with spaces for line breaks', PAIR_2048.privateKey.replace(/\n/g, ' ')],
  ['1024-bit key', PAIR_1024.privateKey],
  ['PKCS#1 PEM', PAIR_PKCS1.privateKey],
];

/** Every shape the public key arrives in (`createWebhookPublicKey`: PEM, or bare base64 DER). */
const PUBLIC_FORMS: ReadonlyArray<readonly [string, string]> = [
  ['SPKI PEM', PAIR_2048.publicKey],
  ['SPKI PEM without the trailing newline', PAIR_2048.publicKey.trimEnd()],
  ['bare base64 body of a 2048-bit key (starts with MIIB)', body(PAIR_2048.publicKey)],
  ['bare base64 body of a 1024-bit key (starts with MIGf)', body(PAIR_1024.publicKey)],
  ['bare base64 body with a trailing newline', `${body(PAIR_2048.publicKey)}\n`],
  ['PKCS#1 PEM', PAIR_PKCS1.publicKey],
];

describe('findAntilopayKeyProblem', () => {
  it('accepts a private key in every form a checkout signs with', () => {
    for (const [label, key] of PRIVATE_FORMS) {
      assert.equal(findAntilopayKeyProblem({ privateKey: key }), null, label);
      // The same key, used as a checkout uses it: "accepted" means "signs".
      assert.doesNotThrow(() => signAntilopayBody('{}', toAntilopayPrivateKeyPem(key)), label);
    }
  });

  it('accepts a public key in every form the callback check reads, whatever it starts with', () => {
    // The hint says «MF», and a 2048-bit key starts with «MIIB»: no prefix is a rule.
    assert.equal(body(PAIR_2048.publicKey).startsWith('MIIB'), true);
    assert.equal(body(PAIR_2048.publicKey).startsWith('MF'), false);
    for (const [label, key] of PUBLIC_FORMS) {
      assert.equal(findAntilopayKeyProblem({ publicKey: key }), null, label);
    }
  });

  it('takes a pair as it comes, and an absent or blank key as a draft, not a fault', () => {
    assert.equal(findAntilopayKeyProblem({ privateKey: PAIR_2048.privateKey, publicKey: PAIR_1024.publicKey }), null);
    assert.equal(findAntilopayKeyProblem({}), null);
    assert.equal(findAntilopayKeyProblem({ privateKey: '   ', publicKey: '' }), null);
    assert.equal(findAntilopayKeyProblem({ privateKey: undefined, publicKey: 42 }), null);
  });

  it('names a public key in the private field as a swap', () => {
    for (const [label, key] of PUBLIC_FORMS) {
      assert.equal(findAntilopayKeyProblem({ privateKey: key }), 'PRIVATE_KEY_IS_PUBLIC', label);
    }
  });

  it('names a private key in the public field as a swap, in every form it can be pasted in', () => {
    for (const [label, key] of PRIVATE_FORMS) {
      // `createPublicKey` alone would take the PEM ones and derive the public half.
      assert.equal(findAntilopayKeyProblem({ publicKey: key }), 'PUBLIC_KEY_IS_PRIVATE', label);
    }
  });

  it('reports the private field first when both are in each other\'s place', () => {
    assert.equal(
      findAntilopayKeyProblem({ privateKey: PAIR_2048.publicKey, publicKey: PAIR_2048.privateKey }),
      'PRIVATE_KEY_IS_PUBLIC',
    );
  });

  it('calls a key nobody can read unreadable, not swapped', () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['prose', 'вставьте ключ из личного кабинета'],
      ['a cut-off private key', body(PAIR_2048.privateKey).slice(0, 220)],
      ['the id of the project', 'PE8BED46C045139256'],
      ['a lone armor', '-----BEGIN PRIVATE KEY-----'],
    ];
    for (const [label, value] of cases) {
      assert.equal(findAntilopayKeyProblem({ privateKey: value }), 'PRIVATE_KEY_UNREADABLE', label);
    }
    const publicCases: ReadonlyArray<readonly [string, string]> = [
      ['prose', 'вставьте ключ из личного кабинета'],
      ['a cut-off public key', body(PAIR_2048.publicKey).slice(0, 120)],
      ['the id of the project', 'PE8BED46C045139256'],
      ['a lone armor', '-----BEGIN PUBLIC KEY-----'],
    ];
    for (const [label, value] of publicCases) {
      assert.equal(findAntilopayKeyProblem({ publicKey: value }), 'PUBLIC_KEY_UNREADABLE', label);
    }
  });

  it('keeps a key that signs verifiable: the public half of what was accepted verifies it', () => {
    const signature = signAntilopayBody('{"a":1}', toAntilopayPrivateKeyPem(body(PAIR_2048.privateKey)));
    const verifier = createVerify('RSA-SHA256');
    verifier.update('{"a":1}');
    assert.equal(verifier.verify(createPublicKey(PAIR_2048.publicKey), signature, 'base64'), true);
  });
});

describe('the Antilopay settings are refused for a key that is wrong, and say which', () => {
  const base = { projectIdentificator: 'project-1', secretId: 'secret-id-1' };

  function refusal(settings: Record<string, unknown>): unknown {
    try {
      normalizeGatewaySettingsForStorage(PaymentGatewayType.ANTILOPAY, settings);
    } catch (error) {
      assert.equal(error instanceof BadRequestException, true);
      return (error as BadRequestException).getResponse();
    }
    return null;
  }

  it('stores a good pair exactly as it was pasted', () => {
    const settings = { ...base, privateKey: body(PAIR_2048.privateKey), publicKey: body(PAIR_2048.publicKey) };
    assert.deepStrictEqual(normalizeGatewaySettingsForStorage(PaymentGatewayType.ANTILOPAY, settings), settings);
  });

  it('refuses a private key in the public field, with the code of that swap', () => {
    assert.deepStrictEqual(refusal({ ...base, privateKey: PAIR_2048.privateKey, publicKey: PAIR_2048.privateKey }), {
      code: 'ANTILOPAY_PUBLIC_KEY_IS_PRIVATE',
      message: 'ANTILOPAY_PUBLIC_KEY_IS_PRIVATE',
    });
  });

  it('refuses a public key in the private field, with the code of that swap', () => {
    assert.deepStrictEqual(refusal({ ...base, privateKey: PAIR_2048.publicKey, publicKey: PAIR_2048.publicKey }), {
      code: 'ANTILOPAY_PRIVATE_KEY_IS_PUBLIC',
      message: 'ANTILOPAY_PRIVATE_KEY_IS_PUBLIC',
    });
  });

  it('refuses a key that cannot be read, naming the field', () => {
    assert.deepStrictEqual(refusal({ ...base, privateKey: 'not-a-key' }), {
      code: 'ANTILOPAY_PRIVATE_KEY_UNREADABLE',
      message: 'ANTILOPAY_PRIVATE_KEY_UNREADABLE',
    });
    assert.deepStrictEqual(refusal({ ...base, privateKey: PAIR_2048.privateKey, publicKey: 'MFwwDQYJKoZI' }), {
      code: 'ANTILOPAY_PUBLIC_KEY_UNREADABLE',
      message: 'ANTILOPAY_PUBLIC_KEY_UNREADABLE',
    });
  });

  it('has one code per problem, and the settings page words all four', () => {
    assert.deepStrictEqual(Object.values(ANTILOPAY_KEY_REFUSAL_CODES).sort(), [
      'ANTILOPAY_PRIVATE_KEY_IS_PUBLIC',
      'ANTILOPAY_PRIVATE_KEY_UNREADABLE',
      'ANTILOPAY_PUBLIC_KEY_IS_PRIVATE',
      'ANTILOPAY_PUBLIC_KEY_UNREADABLE',
    ]);
  });

  it('leaves a draft without keys alone, and answers every other refusal as before', () => {
    assert.deepStrictEqual(normalizeGatewaySettingsForStorage(PaymentGatewayType.ANTILOPAY, base), base);
    for (const settings of [{ ...base, vat: 18 }, { ...base, unknownField: 'x' }]) {
      assert.equal((refusal(settings) as { message?: string }).message, 'PAYMENT_GATEWAY_SETTINGS_INVALID');
    }
  });

  it('checks the keys of Antilopay and of no other gateway', () => {
    assert.doesNotThrow(() =>
      normalizeGatewaySettingsForStorage(PaymentGatewayType.OVERPAY, {
        shopId: 'shop-1',
        secretKey: 'secret-1',
        publicKey: 'not-a-key-at-all',
      }),
    );
  });
});
