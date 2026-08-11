import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decryptOlcrtcSecret,
  encryptOlcrtcSecret,
} from '../src/modules/olcrtc/utils/olcrtc-secret-cipher';

test('olcrtc secret cipher round-trips secrets', () => {
  const encrypted = encryptOlcrtcSecret('secret-value', 'crypt-key');

  assert.notEqual(encrypted, 'secret-value');
  assert.equal(decryptOlcrtcSecret(encrypted, 'crypt-key'), 'secret-value');
});

test('olcrtc secret cipher rejects wrong crypt key', () => {
  const encrypted = encryptOlcrtcSecret('secret-value', 'crypt-key');

  assert.throws(() => decryptOlcrtcSecret(encrypted, 'other-key'));
});

test('olcrtc secret cipher rejects malformed payloads', () => {
  assert.throws(() => decryptOlcrtcSecret('not-a-valid-payload', 'crypt-key'));
});
