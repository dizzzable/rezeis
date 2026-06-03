import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';

export const CORS_ALLOWED_METHODS = ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE'] as const;

export type CorsOriginConfig = false | string | string[];

interface ParseCorsOriginsOptions {
  readonly requireConfiguredOrigins?: boolean;
}

export function buildCorsOptions(origin: CorsOriginConfig): CorsOptions {
  if (origin === false) {
    return {
      origin: false,
      credentials: false,
      methods: [...CORS_ALLOWED_METHODS],
    };
  }

  const normalizedOrigin = Array.isArray(origin) ? [...origin] : origin;

  return {
    origin: normalizedOrigin,
    credentials: true,
    methods: [...CORS_ALLOWED_METHODS],
  };
}

export function parseCorsOrigins(
  value: string | undefined,
  options: ParseCorsOriginsOptions = {},
): CorsOriginConfig {
  const parsed = value
    ?.split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0)
    .map(normalizeCorsOrigin);

  if (parsed && parsed.length > 0) {
    const uniqueOrigins = [...new Set(parsed)];
    return uniqueOrigins.length === 1 ? uniqueOrigins[0]! : uniqueOrigins;
  }

  if (options.requireConfiguredOrigins === true) {
    throw new Error('ADMIN_CORS_ORIGINS must define at least one trusted admin origin when NODE_ENV=production');
  }

  return false;
}

function normalizeCorsOrigin(rawOrigin: string): string {
  if (rawOrigin === '*') {
    throw new Error('ADMIN_CORS_ORIGINS cannot include "*" when credentialed CORS is enabled');
  }

  let parsed: URL;
  try {
    parsed = new URL(rawOrigin);
  } catch {
    throw new Error('ADMIN_CORS_ORIGINS contains an invalid origin');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('ADMIN_CORS_ORIGINS origin must use http or https');
  }
  if (parsed.username || parsed.password) {
    throw new Error('ADMIN_CORS_ORIGINS origin must not include credentials');
  }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('ADMIN_CORS_ORIGINS origin must not include a path, query, or hash');
  }

  return parsed.origin;
}
