export const EXPRESS_TRUST_PROXY_SETTING = 'trust proxy';

export type TrustedProxyMode = 'disabled' | 'loopback' | 'linklocal' | 'uniquelocal';

export function buildTrustedProxyValue(mode: TrustedProxyMode | undefined = 'disabled'): false | TrustedProxyMode {
  if (mode === 'loopback' || mode === 'linklocal' || mode === 'uniquelocal') return mode;
  return false;
}

export function parseTrustedProxyMode(value: string | undefined): TrustedProxyMode {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'loopback' || normalized === 'linklocal' || normalized === 'uniquelocal') {
    return normalized;
  }
  return 'disabled';
}
