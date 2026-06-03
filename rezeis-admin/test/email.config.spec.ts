import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { emailConfig } from '../src/common/config/email.config';

const originalEnvironment = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnvironment };
});

describe('emailConfig', () => {
  it('uses SMTP configuration values from EMAIL_* process env variables', () => {
    setValidBaseEnvironment();
    process.env.EMAIL_ENABLED = 'true';
    process.env.EMAIL_HOST = ' smtp.example.com ';
    process.env.EMAIL_PORT = '587';
    process.env.EMAIL_USERNAME = '   ';
    process.env.EMAIL_PASSWORD = ' smtp-password-v2 ';
    process.env.EMAIL_FROM_ADDRESS = 'no-reply@example.com';
    process.env.EMAIL_FROM_NAME = 'Rezeis Admin';
    process.env.EMAIL_USE_TLS = 'false';
    process.env.EMAIL_USE_SSL = 'true';

    const actualConfiguration = emailConfig();

    assert.deepStrictEqual(actualConfiguration, {
      enabled: true,
      host: 'smtp.example.com',
      port: 587,
      username: null,
      password: 'smtp-password-v2',
      fromAddress: 'no-reply@example.com',
      fromName: 'Rezeis Admin',
      useTls: false,
      useSsl: true,
    });
  });

  it('uses safe SMTP defaults when optional EMAIL_* variables are omitted', () => {
    setValidBaseEnvironment();

    assert.deepStrictEqual(emailConfig(), {
      enabled: false,
      host: null,
      port: 587,
      username: null,
      password: null,
      fromAddress: 'no-reply@rezeis.local',
      fromName: 'Rezeis',
      useTls: true,
      useSsl: false,
    });
  });
});

function setValidBaseEnvironment(): void {
  process.env.NODE_ENV = 'test';
}
