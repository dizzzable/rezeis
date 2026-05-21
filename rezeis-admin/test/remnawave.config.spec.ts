import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { remnawaveConfig } from '../src/common/config/remnawave.config';

describe('remnawaveConfig', () => {
  const originalEnvironment = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnvironment };
  });

  it('uses centrally validated Remnawave configuration values', () => {
    process.env = {
      ...createValidEnvironmentVariables(),
      REMNAWAVE_HOST: '  remnawave.internal  ',
      REMNAWAVE_PORT: '3001',
      REMNAWAVE_TOKEN: '  remnawave-runtime-token-v2  ',
      REMNAWAVE_WEBHOOK_SECRET: '  remnawave-webhook-runtime-v2  ',
      REMNAWAVE_CADDY_TOKEN: '  remnawave-caddy-runtime-v2  ',
      REMNAWAVE_COOKIE: '  remnawave-cookie-runtime-v2  ',
    } as NodeJS.ProcessEnv;

    assert.deepStrictEqual(remnawaveConfig(), {
      host: 'remnawave.internal',
      port: 3001,
      token: 'remnawave-runtime-token-v2',
      webhookSecret: 'remnawave-webhook-runtime-v2',
      caddyToken: 'remnawave-caddy-runtime-v2',
      cookie: 'remnawave-cookie-runtime-v2',
    });
  });

  it('keeps omitted optional Remnawave configuration values as null', () => {
    process.env = createValidEnvironmentVariables() as NodeJS.ProcessEnv;

    assert.deepStrictEqual(remnawaveConfig(), {
      host: null,
      port: null,
      token: null,
      webhookSecret: null,
      caddyToken: null,
      cookie: null,
    });
  });

  it('fails through sanitized environment validation for partial Remnawave connection config', () => {
    process.env = {
      ...createValidEnvironmentVariables(),
      REMNAWAVE_HOST: 'remnawave.internal',
      REMNAWAVE_TOKEN: 'remnawave-runtime-token-v2',
    } as NodeJS.ProcessEnv;

    assert.throws((): void => {
      remnawaveConfig();
    }, assertEnvironmentConfigurationError);
  });

  it('does not echo raw invalid Remnawave secret values in validation errors', () => {
    process.env = {
      ...createValidEnvironmentVariables(),
      REMNAWAVE_HOST: 'remnawave.internal',
      REMNAWAVE_PORT: '3001',
      REMNAWAVE_TOKEN: 'remnawave-token\u0000secret-fragment',
      REMNAWAVE_WEBHOOK_SECRET: 'replace-me',
    } as NodeJS.ProcessEnv;

    assert.throws((): void => {
      remnawaveConfig();
    }, (error: unknown): boolean => {
      assertEnvironmentConfigurationError(error);
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /secret-fragment/);
      assert.doesNotMatch(error.message, /replace-me/);
      assert.doesNotMatch(JSON.stringify(error), /secret-fragment/);
      assert.doesNotMatch(JSON.stringify(error), /replace-me/);
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
