import { registerAs } from '@nestjs/config';

import { DEFAULT_SMTP_PORT, DEFAULT_SMTP_TIMEOUT_MS } from './email.constants';

interface EmailConfiguration {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly user: string | null;
  readonly password: string | null;
  readonly fromAddress: string;
  readonly fromName: string;
  readonly replyTo: string | null;
  readonly identityDomain: string | null;
  readonly timeoutMs: number;
}

function readOptionalString(value: string | undefined): string | null {
  const normalizedValue = value?.trim() ?? '';
  return normalizedValue === '' ? null : normalizedValue;
}

function readRequiredString(value: string | undefined): string {
  return value?.trim() ?? '';
}

/**
 * Provides typed SMTP email configuration values.
 */
export const emailConfig = registerAs(
  'email',
  (): EmailConfiguration => ({
    host: readRequiredString(process.env.REZEIS_ADMIN_SMTP_HOST),
    port: Number.parseInt(process.env.REZEIS_ADMIN_SMTP_PORT ?? String(DEFAULT_SMTP_PORT), 10),
    secure: readRequiredString(process.env.REZEIS_ADMIN_SMTP_SECURE) === 'true',
    user: readOptionalString(process.env.REZEIS_ADMIN_SMTP_USER),
    password: readOptionalString(process.env.REZEIS_ADMIN_SMTP_PASSWORD),
    fromAddress: readRequiredString(process.env.REZEIS_ADMIN_SMTP_FROM_ADDRESS),
    fromName: readRequiredString(process.env.REZEIS_ADMIN_SMTP_FROM_NAME),
    replyTo: readOptionalString(process.env.REZEIS_ADMIN_SMTP_REPLY_TO),
    identityDomain: readOptionalString(process.env.REZEIS_ADMIN_SMTP_IDENTITY_DOMAIN),
    timeoutMs: Number.parseInt(
      process.env.REZEIS_ADMIN_SMTP_TIMEOUT_MS ?? String(DEFAULT_SMTP_TIMEOUT_MS),
      10,
    ),
  }),
);
