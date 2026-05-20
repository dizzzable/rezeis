import { registerAs } from '@nestjs/config';

interface WebhookConfiguration {
  readonly enabled: boolean;
  readonly urls: readonly string[];
  readonly secretHeader: string | null;
}

/**
 * Webhook notification configuration. When enabled, rezeis-admin sends
 * signed HTTP POST notifications to the configured URL(s) on key events
 * (payment completed, subscription created, user registered, etc.).
 *
 * The secret header is used to sign the payload so receivers can verify
 * authenticity (HMAC-SHA256 of the JSON body).
 */
export const webhookConfig = registerAs(
  'webhook',
  (): WebhookConfiguration => {
    const enabled = process.env.WEBHOOK_ENABLED === 'true';
    const rawUrl = (process.env.WEBHOOK_URL ?? '').trim();
    const urls = rawUrl
      .split(',')
      .map((u) => u.trim())
      .filter((u) => u.startsWith('http://') || u.startsWith('https://'));
    const secretHeader = normalizeOptional(process.env.WEBHOOK_SECRET_HEADER);

    return { enabled, urls, secretHeader };
  },
);

function normalizeOptional(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
