import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CryptoService } from '../src/modules/oauth/services/crypto.service';

/**
 * Regression: the old key derivation ran `Buffer.from(rawKey.padEnd(64,'0')
 * .slice(0,64), 'hex')`, which yields an empty/garbage buffer for any
 * realistic (non-hex) secret → `createCipheriv` threw `Invalid key length`
 * on the first OAuth secret save. The SHA-256 derivation must round-trip for
 * ANY secret string, and legacy hex-key ciphertext must still decrypt.
 */
function build(cryptKey: string): CryptoService {
  return new CryptoService({ cryptKey } as never);
}

describe('CryptoService (OAuth secret cipher)', () => {
  it('round-trips with a realistic non-hex passphrase (the crash case)', () => {
    const service = build('this-is-a-perfectly-normal-32char-secret!!');
    const secret = 'gho_S3cr3t-Client-Value/with+symbols=';
    const encrypted = service.encrypt(secret);
    assert.equal(service.decrypt(encrypted), secret);
    assert.equal(encrypted.split(':').length, 3);
  });

  it('round-trips with a short secret (padding path)', () => {
    const service = build('short');
    const secret = 'value';
    assert.equal(service.decrypt(service.encrypt(secret)), secret);
  });

  it('round-trips with a 64-char hex secret (legacy-shaped key)', () => {
    const service = build('a'.repeat(64));
    const secret = 'oauth-client-secret';
    assert.equal(service.decrypt(service.encrypt(secret)), secret);
  });

  it('produces a fresh IV per call (non-deterministic ciphertext)', () => {
    const service = build('some-master-crypt-key-value-1234567890');
    const a = service.encrypt('same');
    const b = service.encrypt('same');
    assert.notEqual(a, b);
    assert.equal(service.decrypt(a), 'same');
    assert.equal(service.decrypt(b), 'same');
  });

  it('throws on a malformed encrypted value', () => {
    const service = build('some-master-crypt-key-value-1234567890');
    assert.throws(() => service.decrypt('not-a-valid-format'));
  });
});
