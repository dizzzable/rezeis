import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { paymentsConfig } from '../src/common/config/payments.config';

describe('paymentsConfig', () => {
  const originalEnvironment = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnvironment };
  });

  it('uses payment configuration values from current process env variables', () => {
    process.env = {
      ...createValidEnvironmentVariables(),
      REZEIS_DOMAIN: '  https://admin.example.com/panel  ',
      BOT_TOKEN: '  telegram-bot-token-v2  ',
    } as NodeJS.ProcessEnv;

    assert.deepStrictEqual(paymentsConfig(), {
      domain: 'https://admin.example.com/panel',
      botToken: 'telegram-bot-token-v2',
    });
  });

  it('keeps omitted optional payment configuration values as null', () => {
    process.env = createValidEnvironmentVariables() as NodeJS.ProcessEnv;

    assert.deepStrictEqual(paymentsConfig(), {
      domain: null,
      botToken: null,
    });
  });
});

function createValidEnvironmentVariables(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
  };
}
