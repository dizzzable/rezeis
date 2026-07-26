import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { authConfig } from '../src/common/config/auth.config';

describe('authConfig', () => {
  const originalEnvironment = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnvironment, ...createValidEnvironmentVariables() } as NodeJS.ProcessEnv;
  });

  afterEach(() => {
    process.env = { ...originalEnvironment } as NodeJS.ProcessEnv;
  });

  it('derives the JWT signing secret from REZEIS_CRYPT_KEY', () => {
    process.env.REZEIS_CRYPT_KEY = 'crypt-key-v2';

    assert.deepEqual(authConfig(), {
      jwtSecret: deriveJwtSecret('crypt-key-v2'),
      jwtExpiresIn: '24h',
      cryptKey: 'crypt-key-v2',
      internalSharedSecret: '',
      internalSignatureMode: 'log',
    });
  });

  // `log` by default and never `require`: reiwa has been signing all along while
  // this service never verified, so nobody knows yet whether every caller in a
  // given deployment carries the secret. Defaulting to strict would 401 the whole
  // customer cabinet on upgrade; defaulting to `off` would leave the second factor
  // switched off forever with nobody noticing.
  it('defaults the signature mode to log and reads the shared secret', () => {
    process.env.REZEIS_INTERNAL_SHARED_SECRET = '  shared-with-reiwa  ';
    assert.equal(authConfig().internalSharedSecret, 'shared-with-reiwa');
    assert.equal(authConfig().internalSignatureMode, 'log');
  });

  it('accepts only the three known modes', () => {
    process.env.REZEIS_INTERNAL_SIGNATURE_MODE = 'require';
    assert.equal(authConfig().internalSignatureMode, 'require');
    process.env.REZEIS_INTERNAL_SIGNATURE_MODE = 'OFF';
    assert.equal(authConfig().internalSignatureMode, 'off');
    // A typo must not silently disable verification.
    process.env.REZEIS_INTERNAL_SIGNATURE_MODE = 'strict';
    assert.equal(authConfig().internalSignatureMode, 'log');
  });
});

function deriveJwtSecret(cryptKey: string): string {
  return createHash('sha256')
    .update(`rezeis-admin:jwt:${cryptKey}`)
    .digest('hex');
}

function createValidEnvironmentVariables(): Record<string, string> {
  return {
    NODE_ENV: 'test',
    REZEIS_CRYPT_KEY: 'a-really-long-crypt-key-that-is-32plus-bytes!!',
  };
}
