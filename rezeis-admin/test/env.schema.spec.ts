import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { validateEnvironment } from '../src/common/config/env.schema';

describe('validateEnvironment', () => {
  it('parses the SMTP delivery variables into the expected runtime shapes', () => {
    const actualEnvironment = validateEnvironment(createValidEnvironmentVariables());
    assert.equal(actualEnvironment.REZEIS_ADMIN_SMTP_HOST, 'smtp.example.com');
    assert.equal(actualEnvironment.REZEIS_ADMIN_SMTP_PORT, 465);
    assert.equal(actualEnvironment.REZEIS_ADMIN_SMTP_SECURE, true);
    assert.equal(actualEnvironment.REZEIS_ADMIN_SMTP_REPLY_TO, 'support@example.com');
    assert.equal(actualEnvironment.REZEIS_ADMIN_SMTP_TIMEOUT_MS, 10000);
  });

  it('treats whitespace-only optional SMTP values as omitted', () => {
    const actualEnvironment = validateEnvironment({
      ...createValidEnvironmentVariables(),
      REZEIS_ADMIN_SMTP_USER: '   ',
      REZEIS_ADMIN_SMTP_PASSWORD: '   ',
      REZEIS_ADMIN_SMTP_REPLY_TO: '   ',
      REZEIS_ADMIN_SMTP_IDENTITY_DOMAIN: '   ',
    });
    assert.equal(actualEnvironment.REZEIS_ADMIN_SMTP_USER, undefined);
    assert.equal(actualEnvironment.REZEIS_ADMIN_SMTP_PASSWORD, undefined);
    assert.equal(actualEnvironment.REZEIS_ADMIN_SMTP_REPLY_TO, undefined);
    assert.equal(actualEnvironment.REZEIS_ADMIN_SMTP_IDENTITY_DOMAIN, undefined);
  });

  it('rejects an invalid SMTP sender address', () => {
    assert.throws(
      (): void => {
        validateEnvironment({
          ...createValidEnvironmentVariables(),
          REZEIS_ADMIN_SMTP_FROM_ADDRESS: 'not-an-email',
        });
      },
      {
        name: 'ZodError',
      },
    );
  });

  it('rejects partial SMTP authentication configuration', () => {
    assert.throws(
      (): void => {
        validateEnvironment({
          ...createValidEnvironmentVariables(),
          REZEIS_ADMIN_SMTP_PASSWORD: '',
        });
      },
      {
        name: 'ZodError',
      },
    );
  });

  it('rejects an unsafe SMTP identity domain', () => {
    assert.throws(
      (): void => {
        validateEnvironment({
          ...createValidEnvironmentVariables(),
          REZEIS_ADMIN_SMTP_IDENTITY_DOMAIN: 'bad domain\r\n',
        });
      },
      {
        name: 'ZodError',
      },
    );
  });

  it('accepts a valid SMTP identity domain', () => {
    const actualEnvironment = validateEnvironment({
      ...createValidEnvironmentVariables(),
      REZEIS_ADMIN_SMTP_IDENTITY_DOMAIN: 'mail.example.com',
    });
    assert.equal(actualEnvironment.REZEIS_ADMIN_SMTP_IDENTITY_DOMAIN, 'mail.example.com');
  });

  it('rejects SMTP sender names with control characters', () => {
    assert.throws(
      (): void => {
        validateEnvironment({
          ...createValidEnvironmentVariables(),
          REZEIS_ADMIN_SMTP_FROM_NAME: 'Rezeis\r\nAdmin',
        });
      },
      {
        name: 'ZodError',
      },
    );
  });
});

function createValidEnvironmentVariables(): Record<string, unknown> {
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
