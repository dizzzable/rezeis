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
    });
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
    REZEIS_CRYPT_KEY: 'crypt-key',
  };
}
