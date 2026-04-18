import { registerAs } from '@nestjs/config';

interface RedisConfiguration {
  readonly url: string;
}

/**
 * Provides typed Redis configuration values.
 */
export const redisConfig = registerAs(
  'redis',
  (): RedisConfiguration => ({
    url: process.env.REDIS_URL ?? '',
  }),
);
