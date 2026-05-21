import { registerAs } from '@nestjs/config';

interface PaymentsConfiguration {
  readonly domain: string | null;
  readonly botToken: string | null;
}

function normalizeOptional(value: string | undefined): string | null {
  const v = value?.trim() ?? '';
  return v === '' ? null : v;
}

export const paymentsConfig = registerAs(
  'payments',
  (): PaymentsConfiguration => ({
    domain: normalizeOptional(process.env.REZEIS_DOMAIN),
    botToken: normalizeOptional(process.env.BOT_TOKEN),
  }),
);
