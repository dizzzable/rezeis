import { registerAs } from '@nestjs/config';

import { normalizePanelBaseUrl } from './public-site-url.util';

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
    // An absolute base URL even when the operator wrote a bare host
    // (`docs/environment.md` allows `panel.example.com`): every provider
    // callback and return address is built on it.
    domain: normalizePanelBaseUrl(process.env.REZEIS_DOMAIN),
    botToken: normalizeOptional(process.env.BOT_TOKEN),
  }),
);
