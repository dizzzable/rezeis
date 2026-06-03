import { registerAs } from '@nestjs/config';

import { parseCorsOrigins, type CorsOriginConfig } from '../http/cors-origin';
import { parseTrustedProxyMode, type TrustedProxyMode } from '../http/trusted-proxy';

interface AppConfiguration {
  readonly domain: string;
  readonly host: string;
  readonly port: number;
  readonly docsEnabled: boolean;
  readonly corsOrigins: CorsOriginConfig;
  readonly trustProxy: TrustedProxyMode;
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
    docsEnabled: parseBoolean(process.env.API_DOCS_ENABLED),
    corsOrigins: parseCorsOrigins(process.env.ADMIN_CORS_ORIGINS, {
      requireConfiguredOrigins: process.env.NODE_ENV === 'production',
    }),
    trustProxy: parseTrustedProxyMode(process.env.ADMIN_TRUST_PROXY),
    locales: (process.env.REZEIS_LOCALES ?? 'ru,en').split(',').map((l) => l.trim()),
    defaultLocale: process.env.REZEIS_DEFAULT_LOCALE ?? 'ru',
    cryptKey: process.env.REZEIS_CRYPT_KEY ?? '',
    serviceName: 'rezeis-admin',
  }),
);

function parseBoolean(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'true';
}
