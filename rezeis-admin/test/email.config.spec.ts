import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { emailConfig } from '../src/common/config/email.config';

const originalEnvironment = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnvironment };
});

describe('emailConfig', () => {
  it('uses validated SMTP configuration values from process.env', () => {
    setValidBaseEnvironment();
    process.env.REZEIS_ADMIN_SMTP_HOST = ' smtp.example.com ';
    process.env.REZEIS_ADMIN_SMTP_PORT = '587';
    process.env.REZEIS_ADMIN_SMTP_SECURE = ' false ';
    process.env.REZEIS_ADMIN_SMTP_USER = '   ';
    process.env.REZEIS_ADMIN_SMTP_PASSWORD = '   ';
    process.env.REZEIS_ADMIN_SMTP_FROM_ADDRESS = ' no-reply@example.com ';
    process.env.REZEIS_ADMIN_SMTP_FROM_NAME = ' Rezeis Admin ';
    process.env.REZEIS_ADMIN_SMTP_REPLY_TO = ' support@example.com ';
    process.env.REZEIS_ADMIN_SMTP_IDENTITY_DOMAIN = ' mail.example.com ';
    process.env.REZEIS_ADMIN_SMTP_TIMEOUT_MS = '15000';
    const actualConfiguration = emailConfig();
    assert.deepStrictEqual(actualConfiguration, {
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      user: null,
      password: null,
      fromAddress: 'no-reply@example.com',
      fromName: 'Rezeis Admin',
      replyTo: 'support@example.com',
      identityDomain: 'mail.example.com',
      timeoutMs: 15000,
    });
  });

  it('rejects unbounded SMTP timeout values before the mailer receives them', () => {
    setValidBaseEnvironment();
    process.env.REZEIS_ADMIN_SMTP_TIMEOUT_MS = '60001';

    assert.throws(
      (): void => {
        emailConfig();
      },
      (error: unknown): boolean => {
        assert.ok(error instanceof Error);
        assert.equal(error.name, 'EnvironmentConfigurationError');
        assert.match(error.message, /REZEIS_ADMIN_SMTP_TIMEOUT_MS/);
        assert.doesNotMatch(error.message, /60001/);
        assert.equal(error.stack, '');
        return true;
      },
    );
  });
});

function setValidBaseEnvironment(): void {
  process.env.NODE_ENV = 'test';
  process.env.PORT = '3000';
  process.env.DATABASE_URL = 'postgresql://rezeis:secret@localhost:5432/rezeis';
  process.env.REDIS_URL = 'redis://localhost:6379/0';
  process.env.REZEIS_ADMIN_CORS_ORIGIN = 'http://localhost:3000';
  process.env.REZEIS_ADMIN_JWT_SECRET = 'jwt-secret-v2';
  process.env.REZEIS_ADMIN_JWT_EXPIRES_IN = '12h';
  process.env.REZEIS_ADMIN_INTERNAL_API_KEY = 'internal-api-key-v2';
  process.env.REZEIS_ADMIN_SMTP_HOST = 'smtp.example.com';
  process.env.REZEIS_ADMIN_SMTP_PORT = '465';
  process.env.REZEIS_ADMIN_SMTP_SECURE = 'true';
  process.env.REZEIS_ADMIN_SMTP_USER = 'smtp-user';
  process.env.REZEIS_ADMIN_SMTP_PASSWORD = 'smtp-password-v2';
  process.env.REZEIS_ADMIN_SMTP_FROM_ADDRESS = 'no-reply@example.com';
  process.env.REZEIS_ADMIN_SMTP_FROM_NAME = 'Rezeis Admin';
  process.env.REZEIS_ADMIN_SMTP_REPLY_TO = 'support@example.com';
  process.env.REZEIS_ADMIN_SMTP_TIMEOUT_MS = '10000';
}
