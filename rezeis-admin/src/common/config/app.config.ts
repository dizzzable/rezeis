import { registerAs } from '@nestjs/config';

interface AppConfiguration {
  readonly corsOrigin: string;
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly port: number;
  readonly serviceName: string;
}

/**
 * Provides typed application configuration values.
 */
export const appConfig = registerAs(
  'app',
  (): AppConfiguration => ({
    corsOrigin: process.env.REZEIS_ADMIN_CORS_ORIGIN ?? 'http://localhost:3000',
    nodeEnv: (process.env.NODE_ENV as AppConfiguration['nodeEnv'] | undefined) ?? 'development',
    port: Number.parseInt(process.env.PORT ?? '3000', 10),
    serviceName: 'rezeis-admin',
  }),
);
