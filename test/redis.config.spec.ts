import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { redisConfig } from '../src/common/config/redis.config';

describe('redisConfig', () => {
  const originalEnvironment = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnvironment };
  });

  it('uses the centrally validated Redis URL for BullMQ configuration', () => {
    process.env = {
      ...createValidEnvironmentVariables(),
      REDIS_URL: '  redis://localhost:6379/2  ',
    } as NodeJS.ProcessEnv;

    assert.deepStrictEqual(redisConfig(), {
      url: 'redis://localhost:6379/2',
    });
  });

  it('fails through sanitized environment validation when Redis URL is missing', () => {
    process.env = createValidEnvironmentVariables() as NodeJS.ProcessEnv;
    delete process.env.REDIS_URL;

    assert.throws((): void => {
      redisConfig();
    }, assertEnvironmentConfigurationError);
  });

  it('does not echo raw invalid Redis URL values in validation errors', () => {
    process.env = {
      ...createValidEnvironmentVariables(),
      REDIS_URL: 'postgres://redis-user:redis-secret@db.internal:5432/redis',
    } as NodeJS.ProcessEnv;

    assert.throws((): void => {
      redisConfig();
    }, (error: unknown): boolean => {
      assertEnvironmentConfigurationError(error);
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /redis-secret/);
      assert.doesNotMatch(error.message, /postgres:\/\//);
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
