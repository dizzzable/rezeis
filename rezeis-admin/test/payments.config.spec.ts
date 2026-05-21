import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { paymentsConfig } from '../src/common/config/payments.config';

describe('paymentsConfig', () => {
  const originalEnvironment = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnvironment };
  });

  it('uses centrally validated payment configuration values', () => {
    process.env = {
      ...createValidEnvironmentVariables(),
      REZEIS_ADMIN_PUBLIC_BASE_URL: '  https://admin.example.com/panel  ',
      RUID_PUBLIC_WEB_URL: '  https://app.example.com/user  ',
      BOT_TOKEN: '  telegram-bot-token-v2  ',
    } as NodeJS.ProcessEnv;

    assert.deepStrictEqual(paymentsConfig(), {
      adminPublicBaseUrl: 'https://admin.example.com/panel',
      ruidPublicWebUrl: 'https://app.example.com/user',
      botToken: 'telegram-bot-token-v2',
    });
  });

  it('keeps omitted optional payment configuration values as null', () => {
    process.env = createValidEnvironmentVariables() as NodeJS.ProcessEnv;

    assert.deepStrictEqual(paymentsConfig(), {
      adminPublicBaseUrl: null,
      ruidPublicWebUrl: null,
      botToken: null,
    });
  });

  it('rejects unsafe public payment URLs through sanitized environment validation', () => {
    process.env = {
      ...createValidEnvironmentVariables(),
      REZEIS_ADMIN_PUBLIC_BASE_URL: 'ftp://admin.example.com/secret-path?token=admin-secret-fragment',
      RUID_PUBLIC_WEB_URL: 'https://user:secret-password@app.example.com/#payment-secret-fragment',
    } as NodeJS.ProcessEnv;

    assert.throws((): void => {
      paymentsConfig();
    }, (error: unknown): boolean => {
      assertEnvironmentConfigurationError(error);
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /admin-secret-fragment/);
      assert.doesNotMatch(error.message, /secret-password/);
      assert.doesNotMatch(error.message, /payment-secret-fragment/);
      assert.doesNotMatch(JSON.stringify(error), /admin-secret-fragment/);
      assert.doesNotMatch(JSON.stringify(error), /secret-password/);
      assert.doesNotMatch(JSON.stringify(error), /payment-secret-fragment/);
      return true;
    });
  });

  it('rejects unsafe bot tokens through sanitized environment validation', () => {
    process.env = {
      ...createValidEnvironmentVariables(),
      BOT_TOKEN: 'bot-token\u0000secret-fragment',
    } as NodeJS.ProcessEnv;

    assert.throws((): void => {
      paymentsConfig();
    }, (error: unknown): boolean => {
      assertEnvironmentConfigurationError(error);
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /secret-fragment/);
      assert.doesNotMatch(JSON.stringify(error), /secret-fragment/);
      return true;
    });
  });
});

function createValidEnvironmentVariables(): NodeJS.ProcessEnv {
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
    REZEIS_ADMIN_SMTP_PASSWORD: 'smtp-password',
    REZEIS_ADMIN_SMTP_FROM_ADDRESS: 'no-reply@example.com',
    REZEIS_ADMIN_SMTP_FROM_NAME: 'Rezeis Admin',
    REZEIS_ADMIN_SMTP_REPLY_TO: 'support@example.com',
    REZEIS_ADMIN_SMTP_TIMEOUT_MS: '10000',
  };
}

function assertEnvironmentConfigurationError(error: unknown): boolean {
  assert.ok(error instanceof Error);
  assert.equal(error.name, 'EnvironmentConfigurationError');
  assert.match(error.message, /Environment configuration validation failed/);
  assert.equal(error.stack, '');
  return true;
}
