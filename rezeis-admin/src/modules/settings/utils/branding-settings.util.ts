/**
 * Reads and merges the `Settings.brandingSettings` JSON column into a typed
 * `BrandingSettingsInterface`, supplying safe defaults for any missing fields.
 *
 * The persisted JSON is always merged on top of `DEFAULT_BRANDING`, so the
 * caller can reason about a complete object regardless of how recently the
 * row was migrated.
 */

import { isDeepStrictEqual } from 'node:util';

import {
  AppBackgroundKind,
  APP_BACKGROUND_KINDS,
  AppBackgroundSettings,
  AppBackgroundTexture,
  APP_BACKGROUND_TEXTURES,
  AppBackgroundTextureSettings,
  BG_EFFECTS,
  BgEffect,
  BORDER_RADIUS_CLASSES,
  BRAND_LOGO_FRAMES,
  BrandLogoFrame,
  BrandLogoSettings,
  BrandingThemeMode,
  BrandingThemeModePolicy,
  BrandingThemeVariant,
  BrandingThemeVariants,
  BrandingSettingsInterface,
  BrandPaletteSource,
  CARD_EFFECTS,
  CARD_LOGO_PRESETS,
  CardEffect,
  CardGradientSource,
  CardEffectSlot,
  CardLogoPreset,
  CardLogoStyleSettings,
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
  PlanCardTextMode,
  PlanCardTextSettings,
  PLAN_CARD_TEXT_MODES,
  ProfileNamingSettings,
  SubscriptionCardTextMode,
  SubscriptionCardTextSettings,
  SubscriptionCardGlassSettings,
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

/**
 * Anything that is not an explicit `custom` reads as `concept`.
 *
 * The default has to be `concept` rather than `custom`: every install that
 * predates this field stored a gradient with no source, and those installs
 * were being served the variant's value. Defaulting to `custom` would change
 * how every one of their cards looks the moment they upgrade.
 */
function readCardGradientSource(value: unknown): CardGradientSource {
  return value === 'custom' ? 'custom' : 'concept';
}

/**
 * Anything that is not an explicit `custom` reads as `concept`.
 *
 * Same reasoning as `readCardGradientSource` above, and the same default for
 * the same reason: every install predating this field stored a palette with no
 * source and was being served the concept variant's colours. Defaulting to
 * `custom` would repaint every one of those cabinets on upgrade.
 */
function readBrandPaletteSource(value: unknown): BrandPaletteSource {
  return value === 'custom' ? 'custom' : 'concept';
}

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
    brandLogo: readBrandLogo(record),
    adminPwaIconUrl: readNullableImageUrl(record, 'adminPwaIconUrl'),
    primary: readHex(record, 'primary', DEFAULT_BRANDING.primary),
    primaryFg: readHex(record, 'primaryFg', DEFAULT_BRANDING.primaryFg),
    bgPrimary: readHex(record, 'bgPrimary', DEFAULT_BRANDING.bgPrimary),
    bgSecondary: readHex(record, 'bgSecondary', DEFAULT_BRANDING.bgSecondary),
    brandPaletteSource: readBrandPaletteSource(record['brandPaletteSource']),
    cardGradient: readGradient(record, 'cardGradient', DEFAULT_BRANDING.cardGradient),
    cardGradientSource: readCardGradientSource(record['cardGradientSource']),
    cardPattern: readNullableGradient(record, 'cardPattern'),
    subscriptionCardText: readSubscriptionCardText(record),
    subscriptionCardGlass: readSubscriptionCardGlass(record),
    cardLogo: readCardLogo(record, DEFAULT_BRANDING.cardLogo),
    cardLogoUrl: readNullableImageUrl(record, 'cardLogoUrl'),
    cardLogoStyle: readCardLogoStyle(record),
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
    borderRadius: readBorderRadius(record),
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
 * The fields a brightness snapshot and the root both carry, and therefore the
 * only ones the merge below can ever copy from one to the other.
 */
type SynchronizedVisualField = keyof BrandingThemeVariant &
  keyof BrandingSettingsInterface;

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
      } else if (key === 'subscriptionCardGlass') {
        merged[key] = readSubscriptionCardGlass({
          subscriptionCardGlass: {
            ...current.subscriptionCardGlass,
            ...readRecord(value),
          },
        });
      } else if (key === 'brandLogo') {
        merged[key] = readBrandLogo({
          brandLogo: {
            ...current.brandLogo,
            ...readRecord(value),
          },
        });
      } else if (key === 'cardLogoStyle') {
        merged[key] = readCardLogoStyle({
          cardLogoStyle: {
            ...current.cardLogoStyle,
            ...readRecord(value),
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
  // A card effect and its parameters are ONE decision, and only `cardEffect`
  // says which parameters mean anything. They travel as two sibling patch
  // fields, so the documented partial-patch rule — whatever is absent is
  // preserved — carried the replaced effect's tuning onto the new one:
  // `{ cardEffect: 'NONE' }` kept aurora's colour stops, amplitude, blend and
  // speed, and the next `{ cardEffect: 'threads' }` drew threads with them.
  //
  // `readCardEffectSlots` and `readPlanCardStyles` need no equivalent rule
  // because they cannot have the defect, not because they were written more
  // carefully: a slot and a plan style each arrive as ONE object, so an absent
  // `cardEffectProps` is an empty one, and their `NONE` guards only have to drop
  // what the request itself carried. The global effect is the only one whose two
  // halves can be updated apart, which is why the repair belongs here and not in
  // `readBrandingSettings`: at read time there is no request to compare against,
  // so a stored `threads` + aurora parameters is indistinguishable from a
  // deliberate configuration, and a `NONE`-only guard would still let
  // aurora → threads through.
  //
  // Only a real change resets. The panel resends every dirty field, so a save
  // about something else repeats the current effect, and the parameters the
  // operator tuned have to survive that. The panel also sends fresh defaults on
  // every effect change of its own — that is what has been hiding this — so this
  // rule is what any OTHER client of the API gets.
  const cardEffectPropsReset =
    input.patch.cardEffect !== undefined &&
    input.patch.cardEffectProps === undefined &&
    readCardEffect(merged, current.cardEffect) !== current.cardEffect;
  if (cardEffectPropsReset) {
    merged.cardEffectProps = {};
  }
  // A direct root visual edit is an explicit operator override. Theme
  // variants are complete snapshots, so leaving an old value in either
  // snapshot would make the cabinet revive it whenever the user changes
  // light/dark mode.
  //
  // What this block must NOT do is read a concept as an override. A concept
  // ships two genuinely different renderings, the panel sends both, and it also
  // copies the DEFAULT brightness one onto the root — the root is the cabinet's
  // non-variant fallback and the panel's own preview source, so it cannot be
  // left behind. The comment here used to assert that "a theme-only PATCH
  // intentionally does not enter this branch". No such request exists:
  // `applyConceptVisualPatch` writes `cardGradient`, `cardEffectProps`,
  // `bgEffect` and `appBackground` to the root every time, so every concept
  // application entered the branch the comment excused it from, and the second
  // rendering of all 104 concepts died here on the first Save. The brightness
  // selector copies a snapshot onto the root for the same reason and lost the
  // other one the same way.
  //
  // The question is therefore asked per field: does the root carry something
  // this payload's snapshots do not describe?
  //
  //   - root ≠ the snapshot for the default brightness — nothing here put that
  //     value there, so it is an operator override and both snapshots take it.
  //   - root = that snapshot — the root is a COPY of a rendering the payload
  //     already contains, so the other brightness keeps its own.
  //
  // Two alternatives were weighed and rejected. An ownership marker in the
  // shape of `cardGradientSource` / `brandPaletteSource` answers a question that
  // OUTLIVES the request — which of two stored values the cabinet resolves,
  // forever — and pays for it with a persisted field whose value must be guessed
  // for every install predating it. Here the question is asked once, at save
  // time, and the request already contains the answer; a marker would be durable
  // state maintained for a decision that never leaves this function. The bare
  // presence of `themeVariants` is not enough either: one request can carry a
  // concept's snapshots AND an operator decision the snapshots know nothing
  // about — apply a concept, change the animation, save — and "snapshots always
  // win" would silently drop the second half.
  //
  // Comparing against the DEFAULT brightness specifically, rather than "either
  // snapshot", is what makes the equality mean "copy" instead of coincidence:
  // `applyConceptPreset` writes `themeDefaultMode` and the root in one go, and
  // the brightness selector copies the newly selected snapshot onto the root
  // while setting the same field.
  //
  // This block only ever writes the GLOBAL fields of a snapshot. The
  // per-position array is never rewritten from a sibling field, and the root
  // `cardEffectsByIndex` is never touched here at all — see the note on
  // `cardEffectsByIndex` below for why.
  const hasDirectVisualPatch =
    input.patch.cardGradient !== undefined ||
    input.patch.cardPattern !== undefined ||
    input.patch.cardEffect !== undefined ||
    input.patch.cardEffectProps !== undefined ||
    input.patch.cardEffectOpacity !== undefined ||
    input.patch.cardEffectsByIndex !== undefined ||
    input.patch.bgEffect !== undefined ||
    input.patch.appBackground !== undefined;
  if (hasDirectVisualPatch) {
    const rootVisuals = readBrandingSettings(merged);
    const variants = readThemeVariants({ themeVariants: merged.themeVariants });
    if (variants) {
      // The DEFAULT brightness, read from the payload being saved — not a fixed
      // `light`. `themeDefaultMode` defaults to `dark`, and the whole test above
      // is "is the root a copy of the rendering the panel just put there": the
      // panel copies the DEFAULT brightness onto the root, so comparing against
      // the other one reports every concept application as an operator override
      // and destroys the second rendering — the exact defect this block is here
      // to stop.
      const defaultVariant = variants[readThemeDefaultMode(merged)];
      const overrides: Partial<Record<SynchronizedVisualField, unknown>> = {};
      /**
       * Copies one root value into both snapshots, but only when the request
       * changed it AND it is not simply the default-brightness rendering
       * copied onto the root.
       */
      const synchronizeField = (
        key: SynchronizedVisualField,
        patched: boolean,
      ): void => {
        if (patched && !isDeepStrictEqual(rootVisuals[key], defaultVariant[key])) {
          overrides[key] = rootVisuals[key];
        }
      };
      synchronizeField('cardGradient', input.patch.cardGradient !== undefined);
      synchronizeField('cardPattern', input.patch.cardPattern !== undefined);
      synchronizeField('cardEffect', input.patch.cardEffect !== undefined);
      // A reset counts as a change: the snapshots must not go on rendering the
      // new effect with the parameters of the one it replaced.
      synchronizeField(
        'cardEffectProps',
        input.patch.cardEffectProps !== undefined || cardEffectPropsReset,
      );
      synchronizeField(
        'cardEffectOpacity',
        input.patch.cardEffectOpacity !== undefined,
      );
      synchronizeField('bgEffect', input.patch.bgEffect !== undefined);
      synchronizeField('appBackground', input.patch.appBackground !== undefined);
      // A supplied array is a deliberate new slot configuration and must
      // survive a combined root-gradient + slot PATCH.
      //
      // A PATCH that does NOT carry the array leaves every slot exactly as
      // stored, in this snapshot and in the root array — including a PATCH that
      // changes `cardGradient`.
      //
      // This used to null every slot's `cardGradient` on a gradient-only PATCH,
      // justified by "a root gradient has no slot mode discriminator, so a stale
      // per-slot copy would mask the new global choice". Both halves are false.
      // `readCardEffectSlots` stamps `mode` on every slot it returns, legacy
      // entries that never had one included, so the discriminator always exists.
      // And a slot gradient is not a stale copy: Reiwa resolves it ahead of the
      // global gradient WITHOUT consulting `mode` (reiwa
      // `subscription-card-visual.ts`), and the only writer of one is the
      // operator's own per-position control — a concept/card preset never
      // touches `cardEffectsByIndex`. So the rule deleted operator work on the
      // next Save after any preset click, because a preset PATCHes
      // `cardGradient` while the untouched slot array stays out of the request.
      //
      // Nothing unusable survives instead: `readCardEffectSlots` has already
      // replaced any gradient `isSafeBrandingGradient` rejects (`url(...)`,
      // `image-set(...)`, a declaration break) with `null` in both
      // `rootVisuals` and `variant` before this runs.
      synchronizeField(
        'cardEffectsByIndex',
        input.patch.cardEffectsByIndex !== undefined,
      );
      const synchronizeVariant = (variant: BrandingThemeVariant) => ({
        ...variant,
        ...overrides,
      });
      merged.themeVariants = {
        light: synchronizeVariant(variants.light),
        dark: synchronizeVariant(variants.dark),
      };
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
    borderRadius: readBorderRadius(record),
    cornerRadii: readCornerRadii(record),
    fontFamily: readString(record, 'fontFamily', DEFAULT_BRANDING.fontFamily),
    surfaceTheme: readSurfaceTheme(record),
  };
}

/**
 * Reads `borderRadius` — at the root and inside each brightness snapshot, which
 * is why it takes the containing record rather than the whole settings object.
 *
 * WHY THIS EXISTS. `borderRadius` used to be the only branding vocabulary
 * checked on the way IN (`@IsBorderRadiusClass()` on the DTO) but not on the way
 * OUT: a bare `readString` passed any non-empty string through. Every other
 * vocabulary in this file — `bgEffect`, `cardEffect`, `cardLogo`,
 * `iconColorMode`, `appBackground.kind`, `texturePreset`, `navItems[].id` — is
 * enforced twice, and the DTO is not the only way a value gets into the column:
 * a legacy row, a restored backup, a seed, a direct DB edit or a future
 * migration all arrive here having never seen a validator.
 *
 * WHAT AN UNKNOWN VALUE COSTS. The cabinet checks this token in two places
 * (`public-config-persistence.port.ts`: at the branding root, and inside
 * `isThemeVariant` for each snapshot) and reacts to either failure by refusing
 * the ENTIRE public config — it then keeps serving whatever snapshot it last
 * accepted, silently and indefinitely. One unrenderable token therefore costs
 * every colour, logo, font and nav decision the operator has.
 *
 * WHY REJECT MEANS SUBSTITUTE, NOT PROPAGATE. Merely refusing to emit the value
 * — throwing, or returning nothing and letting the caller drop branding —
 * reproduces the cabinet's own all-or-nothing reaction one layer earlier and
 * leaves the cabinet just as dark. Substituting `DEFAULT_BRANDING.borderRadius`
 * (`rounded-2xl`) costs exactly one wrong corner radius on a configuration that
 * was already unrenderable, and keeps every other branding value alive. The
 * default is itself a member of `BORDER_RADIUS_CLASSES`, so the reader's output
 * is always something the cabinet accepts. It is the same trade `readCardLogo`,
 * `readBgEffect` and `readAppBackground` already make for their own
 * vocabularies; this field was the outlier.
 *
 * A VALID VALUE IS UNCHANGED, trimming included — `'  rounded-3xl  '` still
 * reads as `'rounded-3xl'`, exactly as `readString` has always returned it and
 * exactly what the DTO's `@Transform` produces on the write path.
 *
 * NOT CHANGED HERE: the presence gate in `readThemeVariant` above, which drops
 * an entire variant pair when `borderRadius` is absent, non-string or blank.
 * That gate asks "is this snapshot complete", and widening it to a membership
 * test would make one unknown token destroy both snapshots — the opposite of
 * the trade above.
 */
function readBorderRadius(record: Record<string, unknown>): string {
  const value = readString(record, 'borderRadius', DEFAULT_BRANDING.borderRadius);
  return (BORDER_RADIUS_CLASSES as readonly string[]).includes(value)
    ? value
    : DEFAULT_BRANDING.borderRadius;
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

function readSubscriptionCardGlass(
  record: Record<string, unknown>,
): SubscriptionCardGlassSettings {
  const value = readRecord(record['subscriptionCardGlass']);
  const fallback = DEFAULT_BRANDING.subscriptionCardGlass;
  return {
    enabled: typeof value['enabled'] === 'boolean' ? value['enabled'] : fallback.enabled,
    tint: readOpaqueHex(value, 'tint', fallback.tint),
    opacity: readClampedNumber(value, 'opacity', 0, 1, fallback.opacity),
    blurPx: readClampedNumber(value, 'blurPx', 0, 40, fallback.blurPx),
    borderOpacity: readClampedNumber(
      value,
      'borderOpacity',
      0,
      1,
      fallback.borderOpacity,
    ),
  };
}

function readBrandLogo(record: Record<string, unknown>): BrandLogoSettings {
  const value = readRecord(record['brandLogo']);
  const fallback = DEFAULT_BRANDING.brandLogo;
  const frame = value['frame'];
  return {
    size: readClampedNumber(value, 'size', 1, 1.75, fallback.size),
    fill: readClampedNumber(value, 'fill', 0.4, 1, fallback.fill),
    frame:
      typeof frame === 'string' && (BRAND_LOGO_FRAMES as readonly string[]).includes(frame)
        ? (frame as BrandLogoFrame)
        : fallback.frame,
    // `null` is a value here, not an absence: it is the operator saying
    // "follow the theme". Only a usable number overrides it, so a legacy row
    // and an explicit reset land in the same place.
    radius:
      typeof value['radius'] === 'number' && Number.isFinite(value['radius'])
        ? Math.min(50, Math.max(0, value['radius']))
        : null,
    glow: readClampedNumber(value, 'glow', 0, 1, fallback.glow),
  };
}

function readCardLogoStyle(record: Record<string, unknown>): CardLogoStyleSettings {
  const value = readRecord(record['cardLogoStyle']);
  const fallback = DEFAULT_BRANDING.cardLogoStyle;
  return {
    scale: readClampedNumber(value, 'scale', 0.5, 2, fallback.scale),
    // The floor is 0.02, not 0. A watermark the operator cannot see is what
    // `cardLogo: 'NONE'` is for, and it says so in the picker; an opacity of
    // zero would be the same outcome reached by a control that still claims a
    // mark is selected.
    opacity: readClampedNumber(value, 'opacity', 0.02, 0.4, fallback.opacity),
  };
}

function readOpaqueHex(
  record: Record<string, unknown>,
  key: string,
  fallback: string,
): string {
  const value = record[key];
  return typeof value === 'string' && OPAQUE_HEX_PATTERN.test(value.trim())
    ? value.trim()
    : fallback;
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
    const mode = slot['mode'] === 'override' ? 'override' : 'inherit';
    const gradientRaw = slot['cardGradient'];
    const cardGradient = isSafeBrandingGradient(gradientRaw)
      ? gradientRaw.trim()
      : null;
    if (mode === 'inherit') {
      out.push({ mode, cardGradient });
      continue;
    }
    const effect = slot['cardEffect'];
    if (typeof effect !== 'string' || !(CARD_EFFECTS as readonly string[]).includes(effect)) {
      // A malformed explicit override must not turn into an invisible stale
      // winner. Keep only its safe static gradient and inherit the effect.
      out.push({ mode: 'inherit', cardGradient });
      continue;
    }
    out.push({
      mode,
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
 *
 * THE `none` FALLBACK IS LOAD-BEARING and must never become `plain`. `none` is
 * the cabinet's built-in `<NetworkBg>` pattern, `plain` is the flat colour, and
 * every stored payload that has no `kind` — plus every one that has `kind:
 * 'none'` — has been rendering the pattern since the day it was written.
 * Redirecting either of them to `plain` would strip the background off every
 * installation that never opened this control, which is exactly the change this
 * rework exists to avoid: the operator-visible text was wrong, the picture was
 * not.
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
 * texturePreset (allowlisted pattern), textureUrl (data:/http(s)/uploads),
 * text (per-plan foreground policy). Empty/invalid sub-values are dropped; an
 * entry with no usable field is skipped. Orphaned plan ids are kept as-is
 * (harmless; readers ignore unknown ids). Capped at 500 entries to bound the
 * persisted payload.
 *
 * `text` counts as a usable field on its own: a plan whose only per-plan
 * decision is "this card gets light text" is a fully configured plan, and
 * skipping it would throw that decision away on the very save that made it.
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
    const text = readPlanCardText(slot['text']);
    if (text) {
      style.text = text;
    }

    // Skip entries that carry no usable styling at all.
    if (Object.keys(style).length === 0) continue;
    out[planId] = style;
    count += 1;
  }
  return out;
}

/**
 * Normalizes one per-plan text policy, or returns `undefined` for anything that
 * carries no decision.
 *
 * `undefined` is returned for three different inputs on purpose, because all
 * three mean the same thing downstream and storing them apart would be a
 * distinction without a difference:
 *
 *   - an absent/garbled value — nothing was ever chosen;
 *   - `inherit` — the operator chose to follow the global
 *     `subscriptionCardText`, which is precisely what an absent key already
 *     does, so persisting it would make an inherit-selecting install's payload
 *     differ from an untouched one for no behavioural reason;
 *   - `custom` without a usable opaque hex — the same defect
 *     `readSubscriptionCardText` guards: a `custom` mode with no colour would
 *     otherwise resolve to an arbitrary or invisible foreground. Dropping the
 *     whole field (rather than just the colour) returns the card to the global
 *     policy, which is the operator's own most recent explicit decision.
 *
 * Alpha hex is rejected for the same reason it is on the global control: a
 * translucent foreground renders differently over every gradient, so the
 * cabinet and the admin preview could not agree on the result.
 */
function readPlanCardText(value: unknown): PlanCardTextSettings | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const mode = record['mode'];
  if (
    typeof mode !== 'string' ||
    !(PLAN_CARD_TEXT_MODES as readonly string[]).includes(mode) ||
    mode === 'inherit'
  ) {
    return undefined;
  }
  if (mode !== 'custom') {
    return { mode: mode as PlanCardTextMode, color: null };
  }
  const color = record['color'];
  if (typeof color !== 'string' || !OPAQUE_HEX_PATTERN.test(color.trim())) {
    return undefined;
  }
  return { mode: 'custom', color: color.trim() };
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
 * OPTIONAL visible destinations at `NAV_MAX_VISIBLE` minus the essentials
 * (overflow → hidden, operator order decides which survive).
 * Absent/non-array → the built-in default nav.
 *
 * THE CAP IS ON THE OPTIONAL DESTINATIONS, and that distinction is what the
 * cabinet actually draws. `normalizeNavItems`
 * (`reiwa/web/src/components/layout/nav-config.ts`) shows the two essentials
 * unconditionally and keeps `.slice(0, 3)` of the visible optional ones: two
 * plus three, five tabs — which is what `NAV_MAX_VISIBLE` has always meant.
 *
 * This used to count the essentials toward the budget AND exempt them from it,
 * so the real optional budget was `NAV_MAX_VISIBLE` minus however many
 * essentials happened to sort before the overflow point: order-dependent, and
 * FOUR with the usual layout (`subscriptions` first, `settings` last). The
 * panel then persisted four optional destinations and reported them all
 * enabled while the cabinet drew three, with nothing anywhere naming the one it
 * dropped. The panel's own picker (`web/.../nav-config-section.tsx`) blocks the
 * fourth, so this was only reachable through a payload the picker did not
 * build — an API client, a legacy row, a restored backup, a seed — which is
 * exactly the class of input this reader exists to normalize.
 *
 * The budget is DERIVED from the two constants rather than written as `3`, so
 * that a third essential keeps the two sides agreeing instead of silently
 * moving the panel's answer only.
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
  // Force essentials visible, then spend the optional budget in operator order.
  // The essentials are subtracted from the budget ONCE, here, instead of each
  // consuming a slot wherever it happens to sit in the list.
  const optionalBudget = Math.max(
    0,
    NAV_MAX_VISIBLE - NAV_ESSENTIAL_DESTINATIONS.length,
  );
  let visibleOptional = 0;
  return out.map((item) => {
    if ((NAV_ESSENTIAL_DESTINATIONS as readonly string[]).includes(item.id)) {
      return { id: item.id, visible: true };
    }
    if (!item.visible) {
      return { id: item.id, visible: false };
    }
    visibleOptional += 1;
    return { id: item.id, visible: visibleOptional <= optionalBudget };
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
