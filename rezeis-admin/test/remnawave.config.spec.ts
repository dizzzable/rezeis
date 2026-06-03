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
});

function createValidEnvironmentVariables(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
  };
}
