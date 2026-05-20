import { registerAs } from '@nestjs/config';

interface AppConfiguration {
  readonly domain: string;
  readonly host: string;
  readonly port: number;
  readonly locales: readonly string[];
  readonly defaultLocale: string;
  readonly cryptKey: string;
  readonly serviceName: string;
}

/**
 * Provides typed application configuration values.
 */
export const appConfig = registerAs(
  'app',
  (): AppConfiguration => ({
    domain: process.env.REZEIS_DOMAIN ?? 'localhost',
    host: process.env.REZEIS_HOST ?? '0.0.0.0',
    port: Number.parseInt(process.env.REZEIS_PORT ?? '8000', 10),
    locales: (process.env.REZEIS_LOCALES ?? 'ru,en').split(',').map((l) => l.trim()),
    defaultLocale: process.env.REZEIS_DEFAULT_LOCALE ?? 'ru',
    cryptKey: process.env.REZEIS_CRYPT_KEY ?? '',
    serviceName: 'rezeis-admin',
  }),
);
