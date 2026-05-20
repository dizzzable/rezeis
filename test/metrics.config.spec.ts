import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { metricsConfig } from '../src/common/config/metrics.config';

describe('metricsConfig', () => {
  it('uses validated metrics access defaults from the central environment schema', () => {
    const previousEnvironment = process.env;
    process.env = {
      ...previousEnvironment,
      ...createValidEnvironmentVariables(),
    } as NodeJS.ProcessEnv;

    try {
      assert.deepEqual(metricsConfig(), {
        accessMode: 'open',
        basicAuthUsername: undefined,
        basicAuthPassword: undefined,
      });
    } finally {
      process.env = previousEnvironment;
    }
  });

  it('uses validated normalized basic auth credentials without changing the config shape', () => {
    const previousEnvironment = process.env;
    process.env = {
      ...previousEnvironment,
      ...createValidEnvironmentVariables(),
      REZEIS_ADMIN_METRICS_ACCESS_MODE: 'basic',
      REZEIS_ADMIN_METRICS_BASIC_USER: '  prometheus  ',
      REZEIS_ADMIN_METRICS_BASIC_PASSWORD: '  metrics-password-v2  ',
    } as NodeJS.ProcessEnv;

    try {
      assert.deepEqual(metricsConfig(), {
        accessMode: 'basic',
        basicAuthUsername: 'prometheus',
        basicAuthPassword: 'metrics-password-v2',
      });
    } finally {
      process.env = previousEnvironment;
    }
  });

  it('rejects invalid metrics credentials through sanitized environment validation', () => {
    const previousEnvironment = process.env;
    process.env = {
      ...previousEnvironment,
      ...createValidEnvironmentVariables(),
      REZEIS_ADMIN_METRICS_ACCESS_MODE: 'basic',
      REZEIS_ADMIN_METRICS_BASIC_USER: 'prometheus:ops',
      REZEIS_ADMIN_METRICS_BASIC_PASSWORD: 'change_me',
    } as NodeJS.ProcessEnv;

    try {
      assert.throws(
        (): void => {
          metricsConfig();
        },
        (error: unknown): boolean => {
          assert.ok(error instanceof Error);
          assert.equal(error.name, 'EnvironmentConfigurationError');
          assert.equal(error.stack, '');
          assert.match(error.message, /REZEIS_ADMIN_METRICS_BASIC_USER/);
          assert.match(error.message, /REZEIS_ADMIN_METRICS_BASIC_PASSWORD/);
          assert.doesNotMatch(error.message, /prometheus:ops/);
          assert.doesNotMatch(error.message, /change_me/);
          assert.doesNotMatch(error.message, /ZodError/);
          return true;
        },
      );
    } finally {
      process.env = previousEnvironment;
    }
  });
});

function createValidEnvironmentVariables(): Record<string, string> {
  return {
    NODE_ENV: 'test',
    PORT: '3000',
    DATABASE_URL: 'postgresql://rezeis:secret@localhost:5432/rezeis',
    REDIS_URL: 'redis://localhost:6379/0',
    REZEIS_ADMIN_CORS_ORIGIN: 'http://localhost:3000',
    REZEIS_ADMIN_JWT_SECRET: 'jwt-secret-v2',
    REZEIS_ADMIN_JWT_EXPIRES_IN: '12h',
    REZEIS_ADMIN_INTERNAL_API_KEY: 'internal-api-key-v2',
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
