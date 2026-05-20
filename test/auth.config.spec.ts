import assert from 'node:assert/strict';
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

  it('uses validated authentication configuration values from process.env', () => {
    process.env.REZEIS_ADMIN_JWT_SECRET = '  jwt-secret-v2  ';
    process.env.REZEIS_ADMIN_JWT_EXPIRES_IN = '24h';
    process.env.REZEIS_ADMIN_INTERNAL_API_KEY = '  internal-api-key-v2  ';

    assert.deepEqual(authConfig(), {
      jwtSecret: 'jwt-secret-v2',
      jwtExpiresIn: '24h',
      internalApiKey: 'internal-api-key-v2',
    });
  });

  it('rejects placeholder auth secrets through the centralized sanitized environment validator', () => {
    process.env.REZEIS_ADMIN_JWT_SECRET = 'change_me';
    process.env.REZEIS_ADMIN_INTERNAL_API_KEY = 'internal-api-key-v2';

    assert.throws(
      (): void => {
        authConfig();
      },
      (error: unknown): boolean => {
        assert.ok(error instanceof Error);
        assert.equal(error.name, 'EnvironmentConfigurationError');
        assert.match(error.message, /REZEIS_ADMIN_JWT_SECRET/);
        assert.match(error.message, /must not use a placeholder value/);
        assert.doesNotMatch(error.message, /change_me/i);
        assert.doesNotMatch(JSON.stringify(error), /change_me/i);
        assert.equal(error.stack, '');
        return true;
      },
    );
  });
});

function createValidEnvironmentVariables(): Record<string, string> {
  return {
    NODE_ENV: 'test',
    PORT: '3000',
    DATABASE_URL: 'postgresql://rezeis:secret@localhost:5432/rezeis',
    REDIS_URL: 'redis://localhost:6379/0',
    REZEIS_ADMIN_CORS_ORIGIN: 'http://localhost:3000',
    REZEIS_ADMIN_JWT_SECRET: 'jwt-secret',
    REZEIS_ADMIN_JWT_EXPIRES_IN: '12h',
    REZEIS_ADMIN_INTERNAL_API_KEY: 'internal-api-key',
    REZEIS_ADMIN_SMTP_HOST: 'smtp.example.com',
    REZEIS_ADMIN_SMTP_PORT: '465',
    REZEIS_ADMIN_SMTP_SECURE: 'true',
    REZEIS_ADMIN_SMTP_USER: 'smtp-user',
    REZEIS_ADMIN_SMTP_PASSWORD: 'smtp-password-v2',
    REZEIS_ADMIN_SMTP_FROM_ADDRESS: 'no-reply@example.com',
    REZEIS_ADMIN_SMTP_FROM_NAME: 'Rezeis Admin',
    REZEIS_ADMIN_SMTP_REPLY_TO: 'support@example.com',
    REZEIS_ADMIN_SMTP_TIMEOUT_MS: '10000',
  };
}
