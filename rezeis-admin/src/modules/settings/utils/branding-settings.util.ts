/**
 * Reads and merges the `Settings.brandingSettings` JSON column into a typed
 * `BrandingSettingsInterface`, supplying safe defaults for any missing fields.
 *
 * The persisted JSON is always merged on top of `DEFAULT_BRANDING`, so the
 * caller can reason about a complete object regardless of how recently the
 * row was migrated.
 */

import {
  AppBackgroundKind,
  APP_BACKGROUND_KINDS,
  AppBackgroundSettings,
  AppBackgroundTexture,
  APP_BACKGROUND_TEXTURES,
  AppBackgroundTextureSettings,
  BG_EFFECTS,
  BgEffect,
  BrandingSettingsInterface,
  CARD_EFFECTS,
  CARD_LOGO_PRESETS,
  CardEffect,
  CardEffectSlot,
  CardLogoPreset,
  DEFAULT_BRANDING,
  ICON_COLOR_MODES,
  IconColorMode,
  PlanCardStyle,
  ProfileNamingSettings,
} from '../interfaces/branding-settings.interface';
/** Hex colour validation: 3, 4, 6 or 8 hex chars after a leading `#`. */
const HEX_PATTERN = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
/** Accepted shapes for an operator-supplied texture image URL. */
const IMAGE_URL_PATTERN = /^(?:data:image\/[a-z0-9+.-]+;base64,[A-Za-z0-9+/=]+|https?:\/\/.+|\/uploads\/[A-Za-z0-9._/-]+)$/i;

export function readBrandingSettings(value: unknown): BrandingSettingsInterface {
  const record = readRecord(value);
  return {
    brandName: readString(record, 'brandName', DEFAULT_BRANDING.brandName),
    tagline: readNullableString(record, 'tagline'),
    logoUrl: readNullableString(record, 'logoUrl'),
    pwaIconUrl: readNullableString(record, 'pwaIconUrl'),
    primary: readHex(record, 'primary', DEFAULT_BRANDING.primary),
    primaryFg: readHex(record, 'primaryFg', DEFAULT_BRANDING.primaryFg),
    bgPrimary: readHex(record, 'bgPrimary', DEFAULT_BRANDING.bgPrimary),
    bgSecondary: readHex(record, 'bgSecondary', DEFAULT_BRANDING.bgSecondary),
    cardGradient: readString(record, 'cardGradient', DEFAULT_BRANDING.cardGradient),
    cardPattern: readNullableString(record, 'cardPattern'),
    cardLogo: readCardLogo(record, DEFAULT_BRANDING.cardLogo),
    cardLogoUrl: readNullableString(record, 'cardLogoUrl'),
    cardEffect: readCardEffect(record, DEFAULT_BRANDING.cardEffect),
    cardEffectProps: readJsonRecord(record, 'cardEffectProps'),
    cardEffectOpacity: readClampedNumber(record, 'cardEffectOpacity', 0.05, 1, DEFAULT_BRANDING.cardEffectOpacity),
    cardEffectsByIndex: readCardEffectSlots(record, 'cardEffectsByIndex'),
    bgEffect: readBgEffect(record, DEFAULT_BRANDING.bgEffect),
    appBackground: readAppBackground(record),
    iconColorMode: readIconColorMode(record, DEFAULT_BRANDING.iconColorMode),
    iconColors: readHexMap(record, 'iconColors'),
    borderRadius: readString(record, 'borderRadius', DEFAULT_BRANDING.borderRadius),
    fontFamily: readString(record, 'fontFamily', DEFAULT_BRANDING.fontFamily),
    planCardStyles: readPlanCardStyles(record),
    profileNaming: readProfileNaming(record),
  };
}

/**
 * Merges a partial branding patch over the existing JSON value, returning a
 * shape suitable for storing in `Prisma.InputJsonValue`. Any field not present
 * on the patch is left untouched (existing value preserved).
 */
export function mergeBrandingSettings(input: {
  readonly existing: unknown;
  readonly patch: Partial<Record<keyof BrandingSettingsInterface, unknown>>;
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

function readCardLogo(
  record: Record<string, unknown>,
  fallback: CardLogoPreset,
): CardLogoPreset {
  const value = record['cardLogo'];
  if (typeof value === 'string') {
    const upper = value.toUpperCase() as CardLogoPreset;
    if ((CARD_LOGO_PRESETS as readonly string[]).includes(upper)) {
      return upper;
    }
  }
  return fallback;
}

function readCardEffect(
  record: Record<string, unknown>,
  fallback: CardEffect,
): CardEffect {
  const value = record['cardEffect'];
  if (typeof value === 'string' && (CARD_EFFECTS as readonly string[]).includes(value)) {
    return value as CardEffect;
  }
  return fallback;
}

/**
 * Reads the per-position card-effect slots array. Each entry is normalized
 * like the global card effect (valid effect id, clamped opacity, object
 * props). Invalid/non-object entries are dropped. Capped at 20 slots to bound
 * the persisted payload. Returns `[]` when absent.
 */
function readCardEffectSlots(
  record: Record<string, unknown>,
  key: string,
): CardEffectSlot[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    return [];
  }
  const out: CardEffectSlot[] = [];
  for (const entry of value.slice(0, 20)) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      continue;
    }
    const slot = entry as Record<string, unknown>;
    const effect = slot['cardEffect'];
    if (typeof effect !== 'string' || !(CARD_EFFECTS as readonly string[]).includes(effect)) {
      continue;
    }
    out.push({
      cardEffect: effect as CardEffect,
      cardEffectProps: readJsonRecord(slot, 'cardEffectProps'),
      cardEffectOpacity: readClampedNumber(slot, 'cardEffectOpacity', 0.05, 1, 1),
    });
  }
  return out;
}

/**
 * Reads the site-wide app background block. Normalizes `kind`, the effect id
 * (unknown → `NONE`), gradient string, and texture sub-block. Backward-compat:
 * a payload with only `effect`/`props`/`opacity` (no `kind`) infers
 * `kind = effect !== 'NONE' ? 'effect' : 'none'`. Absent/invalid → default.
 */
function readAppBackground(record: Record<string, unknown>): AppBackgroundSettings {
  const value = record['appBackground'];
  const fallback = DEFAULT_BRANDING.appBackground;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fallback;
  }
  const slot = value as Record<string, unknown>;

  const effectRaw = slot['effect'];
  const effect =
    typeof effectRaw === 'string' && (CARD_EFFECTS as readonly string[]).includes(effectRaw)
      ? (effectRaw as CardEffect)
      : 'NONE';

  // Infer kind for legacy payloads (no `kind` field).
  const kindRaw = slot['kind'];
  const kind: AppBackgroundKind =
    typeof kindRaw === 'string' && (APP_BACKGROUND_KINDS as readonly string[]).includes(kindRaw)
      ? (kindRaw as AppBackgroundKind)
      : effect !== 'NONE'
        ? 'effect'
        : 'none';

  return {
    kind,
    effect,
    props: readJsonRecord(slot, 'props'),
    opacity: readClampedNumber(slot, 'opacity', 0.05, 1, 1),
    gradient: readString(slot, 'gradient', fallback.gradient),
    texture: readAppBackgroundTexture(slot['texture'], fallback.texture),
  };
}

function readAppBackgroundTexture(
  value: unknown,
  fallback: AppBackgroundTextureSettings,
): AppBackgroundTextureSettings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fallback;
  }
  const slot = value as Record<string, unknown>;
  const patternRaw = slot['pattern'];
  const pattern =
    typeof patternRaw === 'string' &&
    (APP_BACKGROUND_TEXTURES as readonly string[]).includes(patternRaw)
      ? (patternRaw as AppBackgroundTexture)
      : fallback.pattern;
  return {
    pattern,
    color: readHex(slot, 'color', fallback.color),
    background: readHex(slot, 'background', fallback.background),
    scale: Math.round(readClampedNumber(slot, 'scale', 8, 256, fallback.scale)),
    opacity: readClampedNumber(slot, 'opacity', 0.05, 1, fallback.opacity),
  };
}

function readIconColorMode(
  record: Record<string, unknown>,
  fallback: IconColorMode,
): IconColorMode {
  const value = record['iconColorMode'];
  if (typeof value === 'string' && (ICON_COLOR_MODES as readonly string[]).includes(value)) {
    return value as IconColorMode;
  }
  return fallback;
}

/**
 * Reads a `{ key: hexColor }` map, keeping only string values that pass hex
 * validation. Defends the SPA against malformed/oversized payloads (the values
 * are injected into inline styles, so we never store non-hex strings).
 */
function readHexMap(
  record: Record<string, unknown>,
  key: string,
): Record<string, string> {
  const value = record[key];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string' && HEX_PATTERN.test(v.trim())) {
      out[k] = v.trim();
    }
  }
  return out;
}

function readJsonRecord(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = record[key];
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function readClampedNumber(
  record: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
  fallback: number,
): number {
  const value = record[key];
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.min(Math.max(value, min), max);
  }
  return fallback;
}

/**
 * Reads the per-plan tariff-card styles map (`planCardStyles`), keyed by
 * `planId`. Each entry is normalized: gradient (string, capped), accent (hex),
 * texturePreset (allowlisted pattern), textureUrl (data:/http(s)/uploads).
 * Empty/invalid sub-values are dropped; an entry with no usable field is
 * skipped. Orphaned plan ids are kept as-is (harmless; readers ignore unknown
 * ids). Capped at 500 entries to bound the persisted payload.
 */
function readPlanCardStyles(
  record: Record<string, unknown>,
): Record<string, PlanCardStyle> {
  const value = record['planCardStyles'];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }
  const out: Record<string, PlanCardStyle> = {};
  let count = 0;
  for (const [planId, raw] of Object.entries(value as Record<string, unknown>)) {
    if (count >= 500) break;
    if (typeof planId !== 'string' || planId.length === 0 || planId.length > 64) continue;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue;
    const slot = raw as Record<string, unknown>;

    const style: { -readonly [K in keyof PlanCardStyle]: PlanCardStyle[K] } = {};

    const gradient = slot['gradient'];
    if (typeof gradient === 'string' && gradient.trim().length > 0 && gradient.length <= 512) {
      style.gradient = gradient.trim();
    }
    const accent = slot['accent'];
    if (typeof accent === 'string' && HEX_PATTERN.test(accent.trim())) {
      style.accent = accent.trim();
    }
    const texturePreset = slot['texturePreset'];
    if (
      typeof texturePreset === 'string' &&
      (APP_BACKGROUND_TEXTURES as readonly string[]).includes(texturePreset)
    ) {
      style.texturePreset = texturePreset as AppBackgroundTexture;
    }
    const textureUrl = slot['textureUrl'];
    if (
      typeof textureUrl === 'string' &&
      textureUrl.trim().length > 0 &&
      textureUrl.length <= 524288 &&
      IMAGE_URL_PATTERN.test(textureUrl.trim())
    ) {
      style.textureUrl = textureUrl.trim();
    }

    // Skip entries that carry no usable styling at all.
    if (Object.keys(style).length === 0) continue;
    out[planId] = style;
    count += 1;
  }
  return out;
}

function readProfileNaming(record: Record<string, unknown>): ProfileNamingSettings {
  const naming = readRecord(record['profileNaming']);
  const fallback = DEFAULT_BRANDING.profileNaming;
  const read = (key: keyof ProfileNamingSettings, max: number): string => {
    const value = naming[key];
    if (typeof value === 'string' && value.length > 0 && value.length <= max) {
      return value;
    }
    return fallback[key];
  };
  return {
    prefix: read('prefix', 16),
    separator: read('separator', 2),
    suffixBase: read('suffixBase', 32),
  };
}
