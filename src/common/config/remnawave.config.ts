import { registerAs } from '@nestjs/config';

interface RemnawaveConfiguration {
  readonly host: string | null;
  readonly port: number | null;
  readonly token: string | null;
  readonly webhookSecret: string | null;
  readonly caddyToken: string | null;
  readonly cookie: string | null;
}

export const remnawaveConfig = registerAs(
  'remnawave',
  (): RemnawaveConfiguration => ({
    host: normalizeOptional(process.env.REMNAWAVE_HOST),
    port: normalizeOptionalNumber(process.env.REMNAWAVE_PORT),
    token: normalizeOptional(process.env.REMNAWAVE_TOKEN),
    webhookSecret: normalizeOptional(process.env.REMNAWAVE_WEBHOOK_SECRET),
    caddyToken: normalizeOptional(process.env.REMNAWAVE_CADDY_TOKEN),
    cookie: normalizeOptional(process.env.REMNAWAVE_COOKIE),
  }),
);

function normalizeOptional(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeOptionalNumber(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}
