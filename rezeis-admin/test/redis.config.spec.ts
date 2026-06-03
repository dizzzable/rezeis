import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { redisConfig } from '../src/common/config/redis.config';

describe('redisConfig', () => {
  const originalEnvironment = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnvironment };
  });

  it('builds the Redis URL from split REDIS_* configuration values', () => {
    process.env = {
      ...createValidEnvironmentVariables(),
      REDIS_HOST: 'cache.internal',
      REDIS_PORT: '6380',
      REDIS_NAME: '2',
      REDIS_PASSWORD: ' redis-password-v2 ',
    } as NodeJS.ProcessEnv;

    assert.deepStrictEqual(redisConfig(), {
      host: 'cache.internal',
      port: 6380,
      db: 2,
      password: 'redis-password-v2',
      url: 'redis://:redis-password-v2@cache.internal:6380/2',
    });
  });

  it('uses local Redis defaults when optional REDIS_* values are omitted', () => {
    process.env = createValidEnvironmentVariables() as NodeJS.ProcessEnv;

    assert.deepStrictEqual(redisConfig(), {
      host: 'localhost',
      port: 6379,
      db: 0,
      password: null,
      url: 'redis://localhost:6379/0',
    });
  });
});

function createValidEnvironmentVariables(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
  };
}
