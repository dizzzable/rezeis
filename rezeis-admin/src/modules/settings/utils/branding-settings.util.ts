/**
 * Reads and merges the `Settings.brandingSettings` JSON column into a typed
 * `BrandingSettingsInterface`, supplying safe defaults for any missing fields.
 *
 * The persisted JSON is always merged on top of `DEFAULT_BRANDING`, so the
 * caller can reason about a complete object regardless of how recently the
 * row was migrated.
 */

import {
  BG_EFFECTS,
  BgEffect,
  BrandingSettingsInterface,
  DEFAULT_BRANDING,
} from '../interfaces/branding-settings.interface';

/** Hex colour validation: 3, 4, 6 or 8 hex chars after a leading `#`. */
const HEX_PATTERN = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

export function readBrandingSettings(value: unknown): BrandingSettingsInterface {
  const record = readRecord(value);
  return {
    brandName: readString(record, 'brandName', DEFAULT_BRANDING.brandName),
    logoUrl: readNullableString(record, 'logoUrl'),
    primary: readHex(record, 'primary', DEFAULT_BRANDING.primary),
    primaryFg: readHex(record, 'primaryFg', DEFAULT_BRANDING.primaryFg),
    bgPrimary: readHex(record, 'bgPrimary', DEFAULT_BRANDING.bgPrimary),
    bgSecondary: readHex(record, 'bgSecondary', DEFAULT_BRANDING.bgSecondary),
    cardGradient: readString(record, 'cardGradient', DEFAULT_BRANDING.cardGradient),
    cardPattern: readNullableString(record, 'cardPattern'),
    bgEffect: readBgEffect(record, DEFAULT_BRANDING.bgEffect),
    borderRadius: readString(record, 'borderRadius', DEFAULT_BRANDING.borderRadius),
    fontFamily: readString(record, 'fontFamily', DEFAULT_BRANDING.fontFamily),
  };
}

/**
 * Merges a partial branding patch over the existing JSON value, returning a
 * shape suitable for storing in `Prisma.InputJsonValue`. Any field not present
 * on the patch is left untouched (existing value preserved).
 */
export function mergeBrandingSettings(input: {
  readonly existing: unknown;
  readonly patch: Partial<BrandingSettingsInterface>;
}): Record<string, unknown> {
  const current = readBrandingSettings(input.existing);
  const merged: Record<string, unknown> = { ...current };
  for (const key of Object.keys(input.patch) as Array<keyof BrandingSettingsInterface>) {
    const value = input.patch[key];
    if (value !== undefined) {
      merged[key] = value;
    }
  }
  return merged;
}

function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(
  record: Record<string, unknown>,
  key: string,
  fallback: string,
): string {
  const value = record[key];
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return fallback;
}

function readNullableString(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = record[key];
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return null;
}

function readHex(
  record: Record<string, unknown>,
  key: string,
  fallback: string,
): string {
  const value = record[key];
  if (typeof value === 'string' && HEX_PATTERN.test(value.trim())) {
    return value.trim();
  }
  return fallback;
}

function readBgEffect(
  record: Record<string, unknown>,
  fallback: BgEffect,
): BgEffect {
  const value = record['bgEffect'];
  if (typeof value === 'string') {
    const upper = value.toUpperCase() as BgEffect;
    if ((BG_EFFECTS as readonly string[]).includes(upper)) {
      return upper;
    }
  }
  return fallback;
}
