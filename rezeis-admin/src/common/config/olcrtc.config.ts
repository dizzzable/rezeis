import { registerAs } from '@nestjs/config';

interface OlcrtcConfiguration {
  readonly enabled: boolean;
  readonly subscriptionName: string;
  readonly defaultRefreshSeconds: number;
}

export const olcrtcConfig = registerAs(
  'olcrtc',
  (): OlcrtcConfiguration => ({
    enabled: parseBoolean(process.env.OLCRTC_ENABLED),
    subscriptionName: process.env.OLCRTC_SUBSCRIPTION_NAME?.trim() || 'Restricted connection',
    defaultRefreshSeconds: Number.parseInt(process.env.OLCRTC_DEFAULT_REFRESH_SECONDS ?? '3600', 10),
  }),
);

function parseBoolean(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
}
