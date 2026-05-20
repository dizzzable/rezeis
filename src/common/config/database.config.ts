import { registerAs } from '@nestjs/config';

interface DatabaseConfiguration {
  readonly host: string;
  readonly port: number;
  readonly name: string;
  readonly user: string;
  readonly password: string;
  readonly url: string;
  readonly poolSize: number;
  readonly maxOverflow: number;
  readonly poolTimeout: number;
  readonly poolRecycle: number;
}

/**
 * Provides typed database configuration values.
 * Builds DATABASE_URL from individual DATABASE_* variables.
 */
export const databaseConfig = registerAs(
  'database',
  (): DatabaseConfiguration => {
    const host = process.env.DATABASE_HOST ?? 'localhost';
    const port = Number.parseInt(process.env.DATABASE_PORT ?? '5432', 10);
    const name = process.env.DATABASE_NAME ?? 'rezeis';
    const user = process.env.DATABASE_USER ?? 'rezeis';
    const password = process.env.DATABASE_PASSWORD ?? '';
    const encodedPassword = encodeURIComponent(password);
    const url = `postgresql://${user}:${encodedPassword}@${host}:${port}/${name}`;

    return {
      host,
      port,
      name,
      user,
      password,
      url,
      poolSize: Number.parseInt(process.env.DATABASE_POOL_SIZE ?? '25', 10),
      maxOverflow: Number.parseInt(process.env.DATABASE_MAX_OVERFLOW ?? '25', 10),
      poolTimeout: Number.parseInt(process.env.DATABASE_POOL_TIMEOUT ?? '10', 10),
      poolRecycle: Number.parseInt(process.env.DATABASE_POOL_RECYCLE ?? '3600', 10),
    };
  },
);
