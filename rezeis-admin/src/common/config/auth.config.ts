import { registerAs } from '@nestjs/config';
import type { StringValue } from 'ms';

interface AuthConfiguration {
  readonly jwtSecret: string;
  readonly jwtExpiresIn: StringValue;
  readonly internalApiKey: string;
}

/**
 * Provides typed authentication configuration values.
 */
export const authConfig = registerAs(
  'auth',
  (): AuthConfiguration => ({
    jwtSecret: process.env.REZEIS_ADMIN_JWT_SECRET ?? '',
    jwtExpiresIn: (process.env.REZEIS_ADMIN_JWT_EXPIRES_IN ?? '12h') as StringValue,
    internalApiKey: process.env.REZEIS_ADMIN_INTERNAL_API_KEY ?? '',
  }),
);
