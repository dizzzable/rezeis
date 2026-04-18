import { registerAs } from '@nestjs/config';

interface DatabaseConfiguration {
  readonly url: string;
}

/**
 * Provides typed database configuration values.
 */
export const databaseConfig = registerAs(
  'database',
  (): DatabaseConfiguration => ({
    url: process.env.DATABASE_URL ?? '',
  }),
);
