import { registerAs } from '@nestjs/config';

interface RedisConfiguration {
  readonly host: string;
  readonly port: number;
  readonly db: number;
  readonly password: string | null;
  readonly url: string;
}

/**
 * Provides typed Redis configuration values.
 */
export const redisConfig = registerAs(
  'redis',
  (): RedisConfiguration => {
    const host = process.env.REDIS_HOST ?? 'localhost';
    const port = Number.parseInt(process.env.REDIS_PORT ?? '6379', 10);
    const db = Number.parseInt(process.env.REDIS_NAME ?? '0', 10);
    const password = normalizeOptional(process.env.REDIS_PASSWORD);
    const auth = password ? `:${encodeURIComponent(password)}@` : '';
    const url = `redis://${auth}${host}:${port}/${db}`;

    return { host, port, db, password, url };
  },
);

function normalizeOptional(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
