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
  BrandingThemeMode,
  BrandingThemeModePolicy,
  BrandingThemeVariant,
  BrandingThemeVariants,
  BrandingSettingsInterface,
  CARD_EFFECTS,
  CARD_LOGO_PRESETS,
  CardEffect,
  CardEffectSlot,
  CardLogoPreset,
  CornerRadiiSettings,
  DEFAULT_BRANDING,
  ICON_COLOR_MODES,
  IconColorMode,
  NAV_DESTINATIONS,
  NAV_ESSENTIAL_DESTINATIONS,
  NAV_MAX_VISIBLE,
  NavDestinationId,
  NavItemSetting,
  PlanCardStyle,
  ProfileNamingSettings,
  SubscriptionCardTextMode,
  SubscriptionCardTextSettings,
  SUBSCRIPTION_CARD_TEXT_MODES,
  SurfaceThemeSettings,
} from '../interfaces/branding-settings.interface';
import {
  isSafeBrandingGradient,
  isSafeBrandingGradientOrNone,
} from './branding-css.util';
/** Hex colour validation: 3, 4, 6 or 8 hex chars after a leading `#`. */
const HEX_PATTERN = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const OPAQUE_HEX_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
/** Stable preset ids are intentionally URL/log/cache-key friendly. */
const THEME_PRESET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const THEME_PRESET_VERSION_MAX = 2_147_483_647;
/** Accepted shapes for an operator-supplied texture image URL. */
const IMAGE_URL_PATTERN =
  /^(?:data:image\/[a-z0-9+.-]+;base64,[A-Za-z0-9+/=]+|https?:\/\/(?![^/\s]+@)[^\s]+|\/uploads\/branding\/(?![A-Za-z0-9._-]*\.\.)[A-Za-z0-9][A-Za-z0-9._-]*)$/i;

export function readBrandingSettings(value: unknown): BrandingSettingsInterface {
  const record = readRecord(value);
  return {
    themePresetId: readThemePresetId(record),
    themePresetVersion: readThemePresetVersion(record),
    themeModePolicy: readThemeModePolicy(record),
    themeDefaultMode: readThemeDefaultMode(record),
    themeVariants: readThemeVariants(record),
    brandName: readString(record, 'brandName', DEFAULT_BRANDING.brandName),
    tagline: readNullableString(record, 'tagline'),
    logoUrl: readNullableImageUrl(record, 'logoUrl'),
    pwaIconUrl: readNullableImageUrl(record, 'pwaIconUrl'),
    adminPwaIconUrl: readNullableImageUrl(record, 'adminPwaIconUrl'),
    primary: readHex(record, 'primary', DEFAULT_BRANDING.primary),
    primaryFg: readHex(record, 'primaryFg', DEFAULT_BRANDING.primaryFg),
    bgPrimary: readHex(record, 'bgPrimary', DEFAULT_BRANDING.bgPrimary),
    bgSecondary: readHex(record, 'bgSecondary', DEFAULT_BRANDING.bgSecondary),
    cardGradient: readGradient(record, 'cardGradient', DEFAULT_BRANDING.cardGradient),
    cardPattern: readNullableGradient(record, 'cardPattern'),
    subscriptionCardText: readSubscriptionCardText(record),
    cardLogo: readCardLogo(record, DEFAULT_BRANDING.cardLogo),
    cardLogoUrl: readNullableImageUrl(record, 'cardLogoUrl'),
    cardEffect: readCardEffect(record, DEFAULT_BRANDING.cardEffect),
    cardEffectProps: readJsonRecord(record, 'cardEffectProps'),
    cardEffectOpacity: readClampedNumber(
      record,
      'cardEffectOpacity',
      0.05,
      1,
      DEFAULT_BRANDING.cardEffectOpacity,
    ),
    cardEffectsByIndex: readCardEffectSlots(record, 'cardEffectsByIndex'),
    bgEffect: readBgEffect(record, DEFAULT_BRANDING.bgEffect),
    appBackground: readAppBackground(record),
    iconColorMode: readIconColorMode(record, DEFAULT_BRANDING.iconColorMode),
    iconColors: readHexMap(record, 'iconColors'),
    borderRadius: readString(record, 'borderRadius', DEFAULT_BRANDING.borderRadius),
    cornerRadii: readCornerRadii(record),
    fontFamily: readString(record, 'fontFamily', DEFAULT_BRANDING.fontFamily),
    surfaceTheme: readSurfaceTheme(record),
    planCardStyles: readPlanCardStyles(record),
    navItems: readNavItems(record),
    navGap: readNavGap(record),
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
      if (key === 'surfaceTheme') {
        const surfacePatch = readRecord(value);
        merged[key] = readSurfaceTheme({
          surfaceTheme: {
            ...current.surfaceTheme,
            ...surfacePatch,
          },
        });
      } else if (key === 'appBackground') {
        const backgroundPatch = readRecord(value);
        const texturePatch = readRecord(backgroundPatch['texture']);
        merged[key] = {
          ...current.appBackground,
          ...backgroundPatch,
          texture: {
            ...current.appBackground.texture,
            ...texturePatch,
          },
        };
      } else if (key === 'cornerRadii') {
        merged[key] = readCornerRadii({
          cornerRadii: {
            ...current.cornerRadii,
            ...readRecord(value),
          },
        });
      } else if (key === 'profileNaming') {
        merged[key] = {
          ...current.profileNaming,
          ...readRecord(value),
        };
      } else {
        merged[key] = value;
      }
    }
  }
  // `subscriptionCardText` is a global operator decision.  Newer variants
  // may contain a copied value for a brightness snapshot, but a direct
  // root-level PATCH must never leave those copies stale.  Legacy variants
  // intentionally have no property at all; they use the root value until an
  // operator explicitly changes this policy, at which point copying it is
  // safe and makes every brightness snapshot deterministic.
  if (
    input.patch.subscriptionCardText !== undefined ||
    input.patch.themeVariants !== undefined
  ) {
    const subscriptionCardText =
      input.patch.subscriptionCardText !== undefined
        ? readSubscriptionCardText({
            subscriptionCardText: input.patch.subscriptionCardText,
          })
        : current.subscriptionCardText;
    // A direct theme-variant PATCH must never turn this global operator
    // policy into a per-brightness setting. The root setting remains the
    // source of truth and its complete copies make the DTO snapshots stable.
    merged.subscriptionCardText = subscriptionCardText;
    const variants = readThemeVariants({ themeVariants: merged.themeVariants });
    if (variants) {
      merged.themeVariants = {
        light: {
          ...variants.light,
          subscriptionCardText: { ...subscriptionCardText },
        },
        dark: {
          ...variants.dark,
          subscriptionCardText: { ...subscriptionCardText },
        },
      };
    }
  }
  // Persist the same bounded, canonical shape that is exposed by the read
  // path. This prevents malformed/oversized nested records from becoming
  // durable state while preserving the documented partial-patch semantics.
  return { ...readBrandingSettings(merged) };
}

function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(record: Record<string, unknown>, key: string, fallback: string): string {
  const value = record[key];
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return fallback;
}

function readNullableString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return null;
}

function readNullableImageUrl(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = record[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 &&
    trimmed.length <= 524_288 &&
    IMAGE_URL_PATTERN.test(trimmed)
    ? trimmed
    : null;
}

function readThemePresetId(record: Record<string, unknown>): string | null {
  const value = record['themePresetId'];
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return THEME_PRESET_ID_PATTERN.test(trimmed) ? trimmed : null;
}

function readThemePresetVersion(record: Record<string, unknown>): number | null {
  const value = record['themePresetVersion'];
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > THEME_PRESET_VERSION_MAX
  ) {
    return null;
  }
  return value;
}

function readThemeModePolicy(
  record: Record<string, unknown>,
): BrandingThemeModePolicy {
  return record['themeModePolicy'] === 'user-selectable'
    ? 'user-selectable'
    : 'fixed';
}

function readThemeDefaultMode(
  record: Record<string, unknown>,
): BrandingThemeMode {
  return record['themeDefaultMode'] === 'light' ? 'light' : 'dark';
}

/**
 * Drops an incomplete variant pair instead of silently mixing operator data
 * with defaults. A brightness switch must be atomic: both representations are
 * either complete and safe, or Reiwa stays on the operator's root branding.
 */
function readThemeVariants(
  record: Record<string, unknown>,
): BrandingThemeVariants | null {
  const value = readRecord(record['themeVariants']);
  const light = readThemeVariant(readRecord(value['light']));
  const dark = readThemeVariant(readRecord(value['dark']));
  return light && dark ? { light, dark } : null;
}

function readThemeVariant(
  record: Record<string, unknown>,
): BrandingThemeVariant | null {
  const requiredHex = ['primary', 'primaryFg', 'bgPrimary', 'bgSecondary'];
  if (
    requiredHex.some((key) => {
      const value = record[key];
      return typeof value !== 'string' || !HEX_PATTERN.test(value.trim());
    }) ||
    !isSafeBrandingGradient(record['cardGradient']) ||
    !Array.isArray(record['cardEffectsByIndex']) ||
    typeof record['cardEffect'] !== 'string' ||
    !(CARD_EFFECTS as readonly string[]).includes(record['cardEffect']) ||
    typeof record['cardEffectProps'] !== 'object' ||
    record['cardEffectProps'] === null ||
    Array.isArray(record['cardEffectProps']) ||
    typeof record['cardEffectOpacity'] !== 'number' ||
    record['cardEffectOpacity'] < 0.05 ||
    record['cardEffectOpacity'] > 1 ||
    typeof record['bgEffect'] !== 'string' ||
    !(BG_EFFECTS as readonly string[]).includes(
      (record['bgEffect'] as string).toUpperCase(),
    ) ||
    Object.keys(readRecord(record['appBackground'])).length === 0 ||
    typeof record['borderRadius'] !== 'string' ||
    record['borderRadius'].trim().length === 0 ||
    Object.keys(readRecord(record['cornerRadii'])).length === 0 ||
    typeof record['fontFamily'] !== 'string' ||
    record['fontFamily'].trim().length === 0 ||
    Object.keys(readRecord(record['surfaceTheme'])).length === 0
  ) {
    return null;
  }

  const subscriptionCardText = readOptionalSubscriptionCardText(record);

  return {
    primary: readHex(record, 'primary', DEFAULT_BRANDING.primary),
    primaryFg: readHex(record, 'primaryFg', DEFAULT_BRANDING.primaryFg),
    bgPrimary: readHex(record, 'bgPrimary', DEFAULT_BRANDING.bgPrimary),
    bgSecondary: readHex(record, 'bgSecondary', DEFAULT_BRANDING.bgSecondary),
    cardGradient: readGradient(record, 'cardGradient', DEFAULT_BRANDING.cardGradient),
    cardPattern: readNullableGradient(record, 'cardPattern'),
    // Do not materialise a missing legacy field to `auto`: Reiwa deliberately
    // falls back to the root policy, including a later global direct PATCH.
    ...(subscriptionCardText ? { subscriptionCardText } : {}),
    cardEffect: readCardEffect(record, DEFAULT_BRANDING.cardEffect),
    cardEffectProps: readJsonRecord(record, 'cardEffectProps'),
    cardEffectOpacity: readClampedNumber(
      record,
      'cardEffectOpacity',
      0.05,
      1,
      DEFAULT_BRANDING.cardEffectOpacity,
    ),
    cardEffectsByIndex: readCardEffectSlots(record, 'cardEffectsByIndex'),
    bgEffect: readBgEffect(record, DEFAULT_BRANDING.bgEffect),
    appBackground: readAppBackground(record),
    borderRadius: readString(record, 'borderRadius', DEFAULT_BRANDING.borderRadius),
    cornerRadii: readCornerRadii(record),
    fontFamily: readString(record, 'fontFamily', DEFAULT_BRANDING.fontFamily),
    surfaceTheme: readSurfaceTheme(record),
  };
}

function readHex(record: Record<string, unknown>, key: string, fallback: string): string {
  const value = record[key];
  if (typeof value === 'string' && HEX_PATTERN.test(value.trim())) {
    return value.trim();
  }
  return fallback;
}

function readSubscriptionCardText(
  record: Record<string, unknown>,
): SubscriptionCardTextSettings {
  const value = readRecord(record['subscriptionCardText']);
  const mode = (SUBSCRIPTION_CARD_TEXT_MODES as readonly string[]).includes(
    value['mode'] as string,
  )
    ? (value['mode'] as SubscriptionCardTextMode)
    : DEFAULT_BRANDING.subscriptionCardText.mode;
  const color = value['color'];
  if (mode !== 'custom') {
    return { mode, color: null };
  }
  if (typeof color !== 'string' || !OPAQUE_HEX_PATTERN.test(color.trim())) {
    // A legacy malformed `custom` value must not behave like an invisible or
    // arbitrary foreground. Return the complete safe policy instead.
    return { ...DEFAULT_BRANDING.subscriptionCardText };
  }
  return {
    mode,
    color: color.trim(),
  };
}

function readOptionalSubscriptionCardText(
  record: Record<string, unknown>,
): SubscriptionCardTextSettings | undefined {
  return Object.prototype.hasOwnProperty.call(record, 'subscriptionCardText')
    ? readSubscriptionCardText(record)
    : undefined;
}

function readSurfaceTheme(record: Record<string, unknown>): SurfaceThemeSettings {
  const value = readRecord(record['surfaceTheme']);
  const fallback = DEFAULT_BRANDING.surfaceTheme;
  return {
    foreground: readHex(value, 'foreground', fallback.foreground),
    mutedForeground: readHex(value, 'mutedForeground', fallback.mutedForeground),
    surface: readHex(value, 'surface', fallback.surface),
    surfaceHigh: readHex(value, 'surfaceHigh', fallback.surfaceHigh),
    borderSoft: readHex(value, 'borderSoft', fallback.borderSoft),
    borderStrong: readHex(value, 'borderStrong', fallback.borderStrong),
    surfaceOpacity: readClampedNumber(value, 'surfaceOpacity', 0, 1, fallback.surfaceOpacity),
    surfaceHighOpacity: readClampedNumber(
      value,
      'surfaceHighOpacity',
      0,
      1,
      fallback.surfaceHighOpacity,
    ),
    borderSoftOpacity: readClampedNumber(
      value,
      'borderSoftOpacity',
      0,
      1,
      fallback.borderSoftOpacity,
    ),
    borderStrongOpacity: readClampedNumber(
      value,
      'borderStrongOpacity',
      0,
      1,
      fallback.borderStrongOpacity,
    ),
    glassBlurPx: readClampedNumber(value, 'glassBlurPx', 0, 40, fallback.glassBlurPx),
  };
}

function readCornerRadii(record: Record<string, unknown>): CornerRadiiSettings {
  const value = readRecord(record['cornerRadii']);
  const fallback = DEFAULT_BRANDING.cornerRadii;
  return {
    cardPx: readClampedNumber(value, 'cardPx', 0, 48, fallback.cardPx),
    itemPx: readClampedNumber(value, 'itemPx', 0, 32, fallback.itemPx),
    pillPx: readClampedNumber(value, 'pillPx', 0, 9999, fallback.pillPx),
  };
}

function readBgEffect(record: Record<string, unknown>, fallback: BgEffect): BgEffect {
  const value = record['bgEffect'];
  if (typeof value === 'string') {
    const upper = value.toUpperCase() as BgEffect;
    if ((BG_EFFECTS as readonly string[]).includes(upper)) {
      return upper;
    }
  }
  return fallback;
}

function readCardLogo(record: Record<string, unknown>, fallback: CardLogoPreset): CardLogoPreset {
  const value = record['cardLogo'];
  if (typeof value === 'string') {
    const upper = value.toUpperCase() as CardLogoPreset;
    if ((CARD_LOGO_PRESETS as readonly string[]).includes(upper)) {
      return upper;
    }
  }
  return fallback;
}

function readCardEffect(record: Record<string, unknown>, fallback: CardEffect): CardEffect {
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
function readCardEffectSlots(record: Record<string, unknown>, key: string): CardEffectSlot[] {
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
    const gradientRaw = slot['cardGradient'];
    const cardGradient = isSafeBrandingGradient(gradientRaw)
      ? gradientRaw.trim()
      : null;
    out.push({
      cardEffect: effect as CardEffect,
      cardEffectProps: readJsonRecord(slot, 'cardEffectProps'),
      cardEffectOpacity: readClampedNumber(slot, 'cardEffectOpacity', 0.05, 1, 1),
      cardGradient,
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
    gradient: readGradient(slot, 'gradient', fallback.gradient),
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
function readHexMap(record: Record<string, unknown>, key: string): Record<string, string> {
  const value = record[key];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
    if (
      k.length > 0 &&
      k.length <= 64 &&
      typeof v === 'string' &&
      HEX_PATTERN.test(v.trim())
    ) {
      out[k] = v.trim();
    }
  }
  return out;
}

function readJsonRecord(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};

  const sanitized = sanitizeJsonValue(value, 0, { remaining: 512 });
  return typeof sanitized === 'object' && sanitized !== null && !Array.isArray(sanitized)
    ? (sanitized as Record<string, unknown>)
    : {};
}

function sanitizeJsonValue(
  value: unknown,
  depth: number,
  budget: { remaining: number },
): unknown {
  if (budget.remaining <= 0) return undefined;
  budget.remaining -= 1;

  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') return value.length <= 4096 ? value : undefined;
  if (depth >= 5 || typeof value !== 'object') return undefined;

  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (const entry of value.slice(0, 64)) {
      const sanitized = sanitizeJsonValue(entry, depth + 1, budget);
      if (sanitized !== undefined) result.push(sanitized);
      if (budget.remaining <= 0) break;
    }
    return result;
  }

  const result: Record<string, unknown> = {};
  let accepted = 0;
  for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
    if (accepted >= 64 || budget.remaining <= 0) break;
    if (entryKey.length === 0 || entryKey.length > 128) continue;
    const sanitized = sanitizeJsonValue(entryValue, depth + 1, budget);
    if (sanitized === undefined) continue;
    result[entryKey] = sanitized;
    accepted += 1;
  }
  return result;
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
function readPlanCardStyles(record: Record<string, unknown>): Record<string, PlanCardStyle> {
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
    if (isSafeBrandingGradient(gradient)) {
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
    const cardEffect = slot['cardEffect'];
    if (
      typeof cardEffect === 'string' &&
      (CARD_EFFECTS as readonly string[]).includes(cardEffect) &&
      cardEffect !== 'NONE'
    ) {
      style.cardEffect = cardEffect as CardEffect;
      style.cardEffectProps = readJsonRecord(slot, 'cardEffectProps');
      style.cardEffectOpacity = readClampedNumber(slot, 'cardEffectOpacity', 0.05, 1, 1);
    }

    // Skip entries that carry no usable styling at all.
    if (Object.keys(style).length === 0) continue;
    out[planId] = style;
    count += 1;
  }
  return out;
}

function readGradient(
  record: Record<string, unknown>,
  key: string,
  fallback: string,
): string {
  const value = record[key];
  return isSafeBrandingGradient(value) ? value.trim() : fallback;
}

function readNullableGradient(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = record[key];
  return isSafeBrandingGradientOrNone(value) ? value.trim() : null;
}

/**
 * Reads the cabinet navigation layout. Keeps only known destination ids
 * (deduped, preserving operator order), defaults `visible` to true, appends
 * any not-yet-listed destinations (hidden) so the admin always sees the full
 * set, forces essentials (`subscriptions`/`settings`) visible, and caps the
 * visible count to `NAV_MAX_VISIBLE` (overflow → hidden, essentials exempt).
 * Absent/non-array → the built-in default nav.
 */
function readNavItems(record: Record<string, unknown>): NavItemSetting[] {
  const value = record['navItems'];
  if (!Array.isArray(value)) {
    return DEFAULT_BRANDING.navItems.map((item) => ({ ...item }));
  }
  const seen = new Set<NavDestinationId>();
  const out: NavItemSetting[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const slot = entry as Record<string, unknown>;
    const id = slot['id'];
    if (typeof id !== 'string' || !(NAV_DESTINATIONS as readonly string[]).includes(id)) continue;
    const did = id as NavDestinationId;
    if (seen.has(did)) continue;
    seen.add(did);
    const visible = typeof slot['visible'] === 'boolean' ? slot['visible'] : true;
    out.push({ id: did, visible });
  }
  // Append destinations not present yet (canonical order), hidden by default.
  for (const id of NAV_DESTINATIONS) {
    if (!seen.has(id)) out.push({ id, visible: false });
  }
  // Force essentials visible + cap the visible count (essentials exempt).
  let visibleCount = 0;
  return out.map((item) => {
    const essential = (NAV_ESSENTIAL_DESTINATIONS as readonly string[]).includes(item.id);
    let visible = essential ? true : item.visible;
    if (visible) {
      visibleCount += 1;
      if (visibleCount > NAV_MAX_VISIBLE && !essential) visible = false;
    }
    return { id: item.id, visible };
  });
}

/**
 * Reads the nav-bar button spacing (px). Clamps to 0–24 and floors to an
 * integer; absent/invalid → the default (2).
 */
function readNavGap(record: Record<string, unknown>): number {
  const value = record['navGap'];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_BRANDING.navGap;
  }
  return Math.max(0, Math.min(24, Math.floor(value)));
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
