import { registerAs } from '@nestjs/config';

interface EmailConfiguration {
  readonly enabled: boolean;
  readonly host: string | null;
  readonly port: number;
  readonly username: string | null;
  readonly password: string | null;
  readonly fromAddress: string;
  /**
   * `null` when the environment names no sender, and the brand is used — see
   * `EmailDeliveryService.resolveSmtpConfig`. There is no product name to fall
   * back to here: the one this used to carry was the panel's own.
   */
  readonly fromName: string | null;
  readonly useTls: boolean;
  readonly useSsl: boolean;
}

/**
 * Provides typed email/SMTP configuration values.
 */
export const emailConfig = registerAs(
  'email',
  (): EmailConfiguration => ({
    enabled: process.env.EMAIL_ENABLED === 'true',
    host: normalizeOptional(process.env.EMAIL_HOST),
    port: Number.parseInt(process.env.EMAIL_PORT ?? '587', 10),
    username: normalizeOptional(process.env.EMAIL_USERNAME),
    password: normalizeOptional(process.env.EMAIL_PASSWORD),
    fromAddress: process.env.EMAIL_FROM_ADDRESS ?? 'no-reply@rezeis.local',
    fromName: normalizeOptional(process.env.EMAIL_FROM_NAME),
    useTls: process.env.EMAIL_USE_TLS !== 'false',
    useSsl: process.env.EMAIL_USE_SSL === 'true',
  }),
);

function normalizeOptional(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
