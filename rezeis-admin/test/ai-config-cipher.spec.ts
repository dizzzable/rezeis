import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  decryptApiKey,
  encryptApiKey,
  isEncryptedApiKey,
} from '../src/modules/ai-config/utils/ai-secret-cipher';

const CRYPT_KEY = 'unit-test-crypt-key-000000000000000000';

describe('ai-config secret cipher', () => {
  it('round-trips an API key through encrypt/decrypt', () => {
    const plaintext = 'sk-proj-abc123SECRETvalue';
    const enc = encryptApiKey(plaintext, CRYPT_KEY);
    assert.notEqual(enc, plaintext);
    assert.ok(isEncryptedApiKey(enc), 'encrypted payload should be recognised');
    assert.equal(decryptApiKey(enc, CRYPT_KEY), plaintext);
  });

  it('produces a fresh IV each time (ciphertext is non-deterministic)', () => {
    const a = encryptApiKey('same-key', CRYPT_KEY);
    const b = encryptApiKey('same-key', CRYPT_KEY);
    assert.notEqual(a, b);
    assert.equal(decryptApiKey(a, CRYPT_KEY), 'same-key');
    assert.equal(decryptApiKey(b, CRYPT_KEY), 'same-key');
  });

  it('fails to decrypt with the wrong key (GCM auth tag rejects)', () => {
    const enc = encryptApiKey('sk-secret', CRYPT_KEY);
    assert.throws(() => decryptApiKey(enc, 'a-different-crypt-key-1111111111111111'));
  });

  it('rejects a tampered ciphertext', () => {
    const enc = encryptApiKey('sk-secret', CRYPT_KEY);
    const [iv, ct, tag] = enc.split(':');
    const flipped = ct!.slice(0, -1) + (ct!.endsWith('0') ? '1' : '0');
    assert.throws(() => decryptApiKey(`${iv}:${flipped}:${tag}`, CRYPT_KEY));
  });

  it('does not classify legacy plaintext as encrypted', () => {
    assert.equal(isEncryptedApiKey('sk-plaintext-legacy-key'), false);
    assert.equal(isEncryptedApiKey(''), false);
    assert.equal(isEncryptedApiKey('a:b'), false);
  });

  it('throws on a malformed payload shape', () => {
    assert.throws(() => decryptApiKey('not-a-valid-payload', CRYPT_KEY));
  });
});
