export const EXPRESS_TRUST_PROXY_SETTING = 'trust proxy';

export type TrustedProxyMode = 'disabled' | 'loopback' | 'linklocal' | 'uniquelocal';

export function buildTrustedProxyValue(
  mode: TrustedProxyMode | undefined = 'uniquelocal',
): false | TrustedProxyMode {
  if (mode === 'loopback' || mode === 'linklocal' || mode === 'uniquelocal') return mode;
  return false;
}

export function parseTrustedProxyMode(value: string | undefined): TrustedProxyMode {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === 'loopback' ||
    normalized === 'linklocal' ||
    normalized === 'uniquelocal' ||
    normalized === 'disabled'
  ) {
    return normalized;
  }
  // Default `uniquelocal` (see ADMIN_TRUST_PROXY in env.schema.ts): the panel
  // almost always runs behind a local reverse proxy, so trust private +
  // loopback hops to resolve the real client IP. Explicitly set `disabled`
  // when the app is directly internet-facing.
  return 'uniquelocal';
}
