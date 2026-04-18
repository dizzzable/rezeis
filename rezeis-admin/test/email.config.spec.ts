import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { emailConfig } from '../src/common/config/email.config';

const originalEnvironment = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnvironment };
});

describe('emailConfig', () => {
  it('normalizes SMTP configuration values from process.env', () => {
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
});
