import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsHexColor,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateBy,
  ValidateNested,
  type ValidationArguments,
  type ValidationOptions,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';

import {
  APP_BACKGROUND_KINDS,
  APP_BACKGROUND_TEXTURES,
  AppBackgroundKind,
  AppBackgroundTexture,
  BG_EFFECTS,
  BgEffect,
  BORDER_RADIUS_CLASSES,
  BRAND_LOGO_FRAMES,
  BrandLogoFrame,
  CARD_EFFECTS,
  CARD_EFFECT_SLOT_MODES,
  CARD_LOGO_PRESETS,
  BrandingThemeMode,
  BrandingThemeModePolicy,
  CardEffect,
  CardLogoPreset,
  ICON_COLOR_MODES,
  IconColorMode,
  NAV_DESTINATIONS,
  NavDestinationId,
  SubscriptionCardTextMode,
  SUBSCRIPTION_CARD_TEXT_MODES,
  BRAND_PALETTE_SOURCES,
  BrandPaletteSource,
  CARD_GRADIENT_SOURCES,
  CardGradientSource,
} from '../interfaces/branding-settings.interface';
import {
  isSafeBrandingGradient,
  isSafeBrandingGradientOrNone,
} from '../utils/branding-css.util';

/**
 * Relative branding assets are intentionally confined to the one upload
 * bucket mirrored durably by Reiwa. External HTTPS and inline data images
 * remain supported. Plain HTTP is intentionally excluded: Reiwa is normally
 * served over HTTPS and its CSP blocks mixed-content branding images.
 */
const DATA_IMAGE_BASE64_PATTERN =
  /^data:image\/[a-z0-9+.-]+;base64,[A-Za-z0-9+/=]+$/i;
const BRANDING_UPLOAD_PATH_PATTERN =
  /^\/uploads\/branding\/(?![A-Za-z0-9._-]*\.\.)[A-Za-z0-9][A-Za-z0-9._-]*$/;
// Subscription-card copy must stay opaque. Supporting alpha here would make
// contrast depend on the underlying animated artwork and let the admin
// preview disagree with the runtime compositor.
const OPAQUE_HEX_COLOR_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
/**
 * Every hex spelling the settings reader accepts, character for character the
 * same as `HEX_PATTERN` in `branding-settings.util.ts` and in the panel form
 * schema.
 *
 * It exists because `@IsHexColor()` (validator.js) treats the leading `#` as
 * OPTIONAL: `ff4081`, `abc` and `a1b2c3d4` all pass it. The reader requires
 * the `#` and falls back to the DEFAULT colour when it is missing, so a client
 * that omits it gets `200 OK` and a palette it never asked for. That is not a
 * rejected request the caller can react to — it is a silent substitution.
 * Every `@IsHexColor()` in this file is therefore paired with this pattern.
 */
const HEX_COLOR_PATTERN = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const HEX_COLOR_MESSAGE =
  '$property must be a hexadecimal colour with a leading # (#rgb, #rgba, #rrggbb or #rrggbbaa)';

/**
 * Bounded, echo-safe rendering of a rejected value for an error message.
 *
 * `$`-signs are stripped because class-validator interpolates `$value` (and
 * friends) into the finished message: an attacker-chosen value containing that
 * token would otherwise expand back into the full, unbounded input.
 */
function describeRejectedValue(value: unknown): string {
  if (typeof value !== 'string') return typeof value;
  const snippet = value.slice(0, 40).replace(/\$/g, '');
  return value.length > 40
    ? `"${snippet}…" (${value.length} chars)`
    : `"${snippet}"`;
}

/**
 * Refuses a radius the Reiwa cabinet cannot render, naming the allowed set.
 *
 * The vocabulary itself lives in `branding-settings.interface.ts` and is shared
 * with `readBorderRadius` on the read path, so a request refused here and a
 * persisted row repaired there can never be judged by two lists that have
 * drifted apart. See the comment on `BORDER_RADIUS_CLASSES` for why a value the
 * cabinet rejects costs it every other branding field too.
 */
function IsBorderRadiusClass(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return ValidateBy(
    {
      name: 'isBorderRadiusClass',
      validator: {
        validate: (value: unknown): boolean =>
          typeof value === 'string' &&
          (BORDER_RADIUS_CLASSES as readonly string[]).includes(value),
        defaultMessage: (args?: ValidationArguments): string =>
          `$property must be one of ${BORDER_RADIUS_CLASSES.join(
            ', ',
          )}; received ${describeRejectedValue(args?.value)}`,
      },
    },
    validationOptions,
  );
}

/**
 * `@IsHexColor()` plus the leading `#` the reader insists on. Applied as one
 * decorator so no colour field can pick up half of the pair.
 */
function IsBrandingHexColour(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  const isHexShape = IsHexColor(validationOptions);
  const hasLeadingHash = Matches(HEX_COLOR_PATTERN, {
    message: HEX_COLOR_MESSAGE,
    ...validationOptions,
  });
  return (target: object, propertyKey: string | symbol): void => {
    isHexShape(target, propertyKey);
    hasLeadingHash(target, propertyKey);
  };
}

function isAllowedBrandingImageUrl(value: string): boolean {
  if (
    DATA_IMAGE_BASE64_PATTERN.test(value) ||
    BRANDING_UPLOAD_PATH_PATTERN.test(value)
  ) {
    return true;
  }
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.username.length === 0 &&
      url.password.length === 0
    );
  } catch {
    return false;
  }
}

function IsBrandingImageUrl(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return ValidateBy(
    {
      name: 'isBrandingImageUrl',
      validator: {
        validate: (value: unknown): boolean =>
          typeof value === 'string' && isAllowedBrandingImageUrl(value),
        defaultMessage: (): string =>
          '$property must be a data:image base64 URI, an HTTPS URL, or a safe /uploads/branding/ path',
      },
    },
    validationOptions,
  );
}

function IsBrandingGradient(
  options?: { readonly allowNone?: boolean },
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return ValidateBy(
    {
      name: 'isBrandingGradient',
      validator: {
        validate: (value: unknown): boolean =>
          options?.allowNone === true
            ? isSafeBrandingGradientOrNone(value)
            : isSafeBrandingGradient(value),
        defaultMessage: (): string =>
          '$property must contain only valid CSS gradient layers',
      },
    },
    validationOptions,
  );
}

/**
 * Runs `predicate` over every well-shaped per-plan style in a `planCardStyles`
 * map. A map or an entry of the wrong SHAPE is tolerated here — `@IsObject()`
 * and the orphan-tolerant reader own that — so each validator below judges
 * only the single property it is named for.
 */
function everyPlanCardStyle(
  value: unknown,
  predicate: (style: Record<string, unknown>) => boolean,
): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return true;
  }
  return Object.values(value as Record<string, unknown>).every((style) => {
    if (typeof style !== 'object' || style === null || Array.isArray(style)) {
      return true;
    }
    return predicate(style as Record<string, unknown>);
  });
}

function hasOnlyAllowedPlanTextureUrls(value: unknown): boolean {
  return everyPlanCardStyle(value, (style) => {
    const textureUrl = style['textureUrl'];
    if (textureUrl === undefined || textureUrl === null) return true;
    if (typeof textureUrl !== 'string') return false;
    const normalized = textureUrl.trim();
    return normalized.length === 0 || isAllowedBrandingImageUrl(normalized);
  });
}

function HasAllowedPlanTextureUrls(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return ValidateBy(
    {
      name: 'hasAllowedPlanTextureUrls',
      validator: {
        validate: hasOnlyAllowedPlanTextureUrls,
        defaultMessage: (): string =>
          'planCardStyles textureUrl values must be data:image base64 URIs, HTTPS URLs, or safe /uploads/branding/ paths',
      },
    },
    validationOptions,
  );
}

function HasSafePlanGradients(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return ValidateBy(
    {
      name: 'hasSafePlanGradients',
      validator: {
        validate: (value: unknown): boolean =>
          everyPlanCardStyle(value, (style) => {
            const gradient = style['gradient'];
            return (
              gradient === undefined ||
              gradient === null ||
              isSafeBrandingGradient(gradient)
            );
          }),
        defaultMessage: (): string =>
          'planCardStyles gradient values must contain only valid CSS gradient layers',
      },
    },
    validationOptions,
  );
}

function HasHexPlanAccents(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return ValidateBy(
    {
      name: 'hasHexPlanAccents',
      validator: {
        validate: (value: unknown): boolean =>
          everyPlanCardStyle(value, (style) => {
            const accent = style['accent'];
            if (accent === undefined || accent === null) return true;
            if (typeof accent !== 'string') return false;
            // The reader trims before testing, so a padded colour survives the
            // round trip; an empty string is the "no accent" spelling.
            const normalized = accent.trim();
            return (
              normalized.length === 0 || HEX_COLOR_PATTERN.test(normalized)
            );
          }),
        defaultMessage: (): string =>
          'planCardStyles accent values must be hexadecimal colours with a leading # (#rgb, #rgba, #rrggbb or #rrggbbaa)',
      },
    },
    validationOptions,
  );
}

function HasAllowedPlanTexturePresets(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return ValidateBy(
    {
      name: 'hasAllowedPlanTexturePresets',
      validator: {
        validate: (value: unknown): boolean =>
          everyPlanCardStyle(value, (style) => {
            const texturePreset = style['texturePreset'];
            if (texturePreset === undefined || texturePreset === null) {
              return true;
            }
            if (typeof texturePreset !== 'string') return false;
            // No trim: the reader compares the raw string against the
            // allowlist, so ` dots ` would be dropped just like `plaid`.
            return (
              texturePreset.length === 0 ||
              (APP_BACKGROUND_TEXTURES as readonly string[]).includes(
                texturePreset,
              )
            );
          }),
        defaultMessage: (): string =>
          `planCardStyles texturePreset values must be one of ${APP_BACKGROUND_TEXTURES.join(
            ', ',
          )}`,
      },
    },
    validationOptions,
  );
}

/**
 * `iconColors` is a dynamic-key map, so the reader (`readHexMap`) is what
 * normally shapes it: it keeps the first 100 entries whose key is 1–64 chars
 * and whose value is a hex colour, and drops everything else. Dropping is the
 * problem — a caller that sends `ff4081` or a number is told `200 OK` and then
 * finds the icon still wearing its old colour, with nothing to point at.
 */
function IsBrandingHexColourMap(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return ValidateBy(
    {
      name: 'isBrandingHexColourMap',
      validator: {
        validate: (value: unknown): boolean => {
          if (
            typeof value !== 'object' ||
            value === null ||
            Array.isArray(value)
          ) {
            return true;
          }
          const entries = Object.entries(value as Record<string, unknown>);
          if (entries.length > 100) return false;
          return entries.every(
            ([key, colour]) =>
              key.length > 0 &&
              key.length <= 64 &&
              typeof colour === 'string' &&
              HEX_COLOR_PATTERN.test(colour.trim()),
          );
        },
        defaultMessage: (): string =>
          '$property must map at most 100 keys of 1-64 characters to hexadecimal colours with a leading # (#rgb, #rgba, #rrggbb or #rrggbbaa)',
      },
    },
    validationOptions,
  );
}

/**
 * One per-position card-background slot in `cardEffectsByIndex`. Mirrors the
 * global card-effect fields.
 */
export class CardEffectSlotDto {
  @IsOptional()
  @IsIn(CARD_EFFECT_SLOT_MODES as readonly string[])
  public mode?: 'inherit' | 'override';

  @IsOptional()
  @IsIn(CARD_EFFECTS as readonly string[])
  public cardEffect?: CardEffect;

  @IsOptional()
  @IsObject()
  public cardEffectProps?: Record<string, unknown>;

  @IsOptional()
  @IsNumber()
  @Min(0.05)
  @Max(1)
  public cardEffectOpacity?: number;

  @IsOptional()
  @ValidateIf((_, value: unknown) => value !== null)
  @IsString()
  @MaxLength(512)
  @IsBrandingGradient()
  public cardGradient?: string | null;
}

/**
 * Tiled-texture sub-block for `appBackground.kind === 'texture'`.
 */
export class AppBackgroundTextureDto {
  @IsIn(APP_BACKGROUND_TEXTURES as readonly string[])
  public pattern!: AppBackgroundTexture;

  @IsOptional()
  @IsBrandingHexColour()
  public color?: string;

  @IsOptional()
  @IsBrandingHexColour()
  public background?: string;

  @IsOptional()
  @IsNumber()
  @Min(8)
  @Max(256)
  public scale?: number;

  @IsOptional()
  @IsNumber()
  @Min(0.05)
  @Max(1)
  public opacity?: number;
}

/**
 * Site-wide app background block (`appBackground`). A `kind` discriminator
 * selects the cabinet's built-in pattern (`none` — the default, NOT a blank
 * colour), a flat colour (`plain`), a static gradient, a static texture, or an
 * animated effect (reuses the card-effect registry). All sub-fields optional
 * so partial patches work; only the fields for the chosen `kind` matter.
 *
 * `kind` validates against `APP_BACKGROUND_KINDS`, which is right here: this
 * is the panel refusing a request it wrote itself. It is deliberately NOT the
 * rule the cabinet follows on the way out — see `isAppBackgroundKind` in
 * reiwa's public-config guard.
 */
export class AppBackgroundDto {
  @IsOptional()
  @IsIn(APP_BACKGROUND_KINDS as readonly string[])
  public kind?: AppBackgroundKind;

  @IsOptional()
  @IsIn(CARD_EFFECTS as readonly string[])
  public effect?: CardEffect;

  @IsOptional()
  @IsObject()
  public props?: Record<string, unknown>;

  @IsOptional()
  @IsNumber()
  @Min(0.05)
  @Max(1)
  public opacity?: number;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  @IsBrandingGradient()
  public gradient?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => AppBackgroundTextureDto)
  public texture?: AppBackgroundTextureDto;
}

export class CornerRadiiDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(0)
  @Max(48)
  public cardPx?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(0)
  @Max(32)
  public itemPx?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(0)
  @Max(9999)
  public pillPx?: number;
}

/**
 * Patch payload for `PATCH /admin/settings/branding`.
 *
 * Every field is optional so the admin UI can submit incremental changes.
 * Validation rules are intentionally strict:
 *   - colour fields accept 3 / 4 / 6 / 8-digit hex with leading `#`,
 *   - gradient fields accept only CSS gradient layers and cannot start
 *     external image requests or escape from their property value,
 *   - `bgEffect` is constrained to the predefined preset list,
 *   - image assets accept safe `/uploads/branding/...` paths (mirrored by
 *     Reiwa), external HTTPS URLs, or inline `data:image` base64 values.
 */
/**
 * Remnawave profile-naming template block (persisted under
 * `Settings.brandingSettings.profileNaming`). Controls how panel usernames
 * are generated: `<prefix><sep><login><sep><suffixBase>`.
 */
export class ProfileNamingDto {
  @IsOptional()
  @IsString()
  @MaxLength(16)
  public prefix?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2)
  public separator?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  public suffixBase?: string;
}

/**
 * One cabinet navigation entry (`navItems`): a destination id + visibility.
 * Strict id allowlist; ordering is the array order. Essentials are forced
 * visible by the reader, so the UI can't strand the user.
 */
export class NavItemDto {
  @IsIn(NAV_DESTINATIONS as readonly string[])
  public id!: NavDestinationId;

  @IsBoolean()
  public visible!: boolean;
}

/**
 * Partial patch for the Reiwa cabinet's resolved text/glass surface tokens.
 * Every supplied colour is a real hex value and every alpha/blur value stays
 * within the CSS-safe runtime bounds. Missing fields are preserved by the
 * settings merge utility.
 */
export class SurfaceThemeDto {
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsBrandingHexColour()
  public foreground?: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsBrandingHexColour()
  public mutedForeground?: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsBrandingHexColour()
  public surface?: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsBrandingHexColour()
  public surfaceHigh?: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsBrandingHexColour()
  public borderSoft?: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsBrandingHexColour()
  public borderStrong?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(0)
  @Max(1)
  public surfaceOpacity?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(0)
  @Max(1)
  public surfaceHighOpacity?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(0)
  @Max(1)
  public borderSoftOpacity?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(0)
  @Max(1)
  public borderStrongOpacity?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(0)
  @Max(40)
  public glassBlurPx?: number;
}

/**
 * Presentation of the brand mark on the cabinet's entry screens. Every member
 * is optional: the panel sends only the knob the operator moved, and the
 * reader merges it over the stored object.
 */
export class BrandLogoDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(1)
  @Max(1.75)
  public size?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(0.4)
  @Max(1)
  public fill?: number;

  @IsOptional()
  @IsIn(BRAND_LOGO_FRAMES as readonly string[])
  public frame?: BrandLogoFrame;

  /**
   * `null` is meaningful — it returns the tile to following the cabinet theme's
   * item radius — so it must reach the reader rather than be skipped as
   * "absent". `@ValidateIf` lets it through and bounds every real number.
   */
  @IsOptional()
  @ValidateIf((_, value: unknown) => value !== null)
  @Type(() => Number)
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(0)
  @Max(50)
  public radius?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(0)
  @Max(1)
  public glow?: number;
}

/** Size and weight of the subscription-card watermark. */
export class CardLogoStyleDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(0.5)
  @Max(2)
  public scale?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(0.02)
  @Max(0.4)
  public opacity?: number;
}

/** Explicit subscription-card foreground policy, separate from primary UI text. */
export class SubscriptionCardTextDto {
  @IsIn(SUBSCRIPTION_CARD_TEXT_MODES as readonly string[])
  public mode!: SubscriptionCardTextMode;

  // Non-custom modes intentionally ignore any stale colour left by an older
  // client. Only a literal custom choice needs a valid colour payload.
  @ValidateIf((object: SubscriptionCardTextDto) => object.mode === 'custom')
  @IsString()
  @IsHexColor()
  @Matches(OPAQUE_HEX_COLOR_PATTERN, {
    message: 'subscriptionCardText.color must be an opaque hexadecimal colour',
  })
  public color!: string | null;
}

/** Independent glass film applied above subscription-card artwork. */
export class SubscriptionCardGlassDto {
  @IsOptional()
  @IsBoolean()
  public enabled?: boolean;

  @IsOptional()
  @IsString()
  @IsHexColor()
  @Matches(OPAQUE_HEX_COLOR_PATTERN, {
    message: 'subscriptionCardGlass.tint must be an opaque hexadecimal colour',
  })
  public tint?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(0)
  @Max(1)
  public opacity?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(0)
  @Max(40)
  public blurPx?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(0)
  @Max(1)
  public borderOpacity?: number;
}

/** One fully resolved light/dark representation of an operator concept. */
export class BrandingThemeVariantDto {
  @IsBrandingHexColour()
  public primary!: string;

  @IsBrandingHexColour()
  public primaryFg!: string;

  @IsBrandingHexColour()
  public bgPrimary!: string;

  @IsBrandingHexColour()
  public bgSecondary!: string;

  @IsString()
  @MaxLength(512)
  @IsBrandingGradient()
  public cardGradient!: string;

  @ValidateIf((_, value: unknown) => value !== null)
  @IsString()
  @MaxLength(512)
  @IsBrandingGradient({ allowNone: true })
  public cardPattern!: string | null;

  @ValidateIf((_, value: unknown) => value !== undefined)
  @IsObject()
  @ValidateNested()
  @Type(() => SubscriptionCardTextDto)
  public subscriptionCardText?: SubscriptionCardTextDto;

  @IsIn(CARD_EFFECTS as readonly string[])
  public cardEffect!: CardEffect;

  @IsObject()
  public cardEffectProps!: Record<string, unknown>;

  @IsNumber()
  @Min(0.05)
  @Max(1)
  public cardEffectOpacity!: number;

  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => CardEffectSlotDto)
  public cardEffectsByIndex!: CardEffectSlotDto[];

  @IsIn(BG_EFFECTS as readonly string[])
  public bgEffect!: BgEffect;

  @IsObject()
  @ValidateNested()
  @Type(() => AppBackgroundDto)
  public appBackground!: AppBackgroundDto;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(1, 64)
  @IsBorderRadiusClass()
  public borderRadius!: string;

  @IsObject()
  @ValidateNested()
  @Type(() => CornerRadiiDto)
  public cornerRadii!: CornerRadiiDto;

  @IsString()
  @Length(1, 256)
  public fontFamily!: string;

  @IsObject()
  @ValidateNested()
  @Type(() => SurfaceThemeDto)
  public surfaceTheme!: SurfaceThemeDto;
}

export class BrandingThemeVariantsDto {
  @IsObject()
  @ValidateNested()
  @Type(() => BrandingThemeVariantDto)
  public light!: BrandingThemeVariantDto;

  @IsObject()
  @ValidateNested()
  @Type(() => BrandingThemeVariantDto)
  public dark!: BrandingThemeVariantDto;
}

export class UpdateBrandingSettingsDto {
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, {
    message: 'themePresetId must be a stable alphanumeric preset id',
  })
  public themePresetId?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2_147_483_647)
  public themePresetVersion?: number | null;

  @IsOptional()
  @IsIn(['fixed', 'user-selectable'] as const)
  public themeModePolicy?: BrandingThemeModePolicy;

  @IsOptional()
  @IsIn(['light', 'dark'] as const)
  public themeDefaultMode?: BrandingThemeMode;

  @IsOptional()
  @ValidateIf((_, value: unknown) => value !== null)
  @IsObject()
  @ValidateNested()
  @Type(() => BrandingThemeVariantsDto)
  public themeVariants?: BrandingThemeVariantsDto | null;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  public brandName?: string;

  @IsOptional()
  @ValidateIf((_, value: unknown) => value !== null)
  @IsString()
  @MaxLength(128)
  public tagline?: string | null;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @ValidateIf((_, value: unknown) => typeof value === 'string' && value.length > 0)
  @IsString()
  @MaxLength(524288)
  @IsBrandingImageUrl()
  public logoUrl?: string | null;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @ValidateIf((_, value: unknown) => typeof value === 'string' && value.length > 0)
  @IsString()
  @MaxLength(524288)
  @IsBrandingImageUrl()
  public pwaIconUrl?: string | null;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => BrandLogoDto)
  public brandLogo?: BrandLogoDto;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @ValidateIf((_, value: unknown) => typeof value === 'string' && value.length > 0)
  @IsString()
  @MaxLength(524288)
  @IsBrandingImageUrl()
  public adminPwaIconUrl?: string | null;

  @IsOptional()
  @IsBrandingHexColour()
  public primary?: string;

  @IsOptional()
  @IsBrandingHexColour()
  public primaryFg?: string;

  @IsOptional()
  @IsBrandingHexColour()
  public bgPrimary?: string;

  @IsOptional()
  @IsBrandingHexColour()
  public bgSecondary?: string;

  /**
   * Set by the panel alongside the four colours above: `custom` on a manual
   * edit, `concept` when a preset supplies them. Sending a colour without the
   * source leaves whatever was stored, so a client that predates this control
   * cannot silently detach an operator's concept.
   */
  @IsOptional()
  @IsIn(BRAND_PALETTE_SOURCES)
  public brandPaletteSource?: BrandPaletteSource;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  @IsBrandingGradient()
  public cardGradient?: string;

  /**
   * Set by the panel alongside the gradient itself: `custom` on a manual edit,
   * `concept` when a preset supplies it. Sending the gradient without the
   * source leaves whatever was stored, so a client that predates this control
   * cannot silently detach an operator's concept.
   */
  @IsOptional()
  @IsIn(CARD_GRADIENT_SOURCES)
  public cardGradientSource?: CardGradientSource;

  @IsOptional()
  @ValidateIf((_, value: unknown) => typeof value === 'string' && value.length > 0)
  @IsString()
  @MaxLength(512)
  @IsBrandingGradient({ allowNone: true })
  public cardPattern?: string | null;

  @ValidateIf((_, value: unknown) => value !== undefined)
  @IsObject()
  @ValidateNested()
  @Type(() => SubscriptionCardTextDto)
  public subscriptionCardText?: SubscriptionCardTextDto;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => SubscriptionCardGlassDto)
  public subscriptionCardGlass?: SubscriptionCardGlassDto;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => CardLogoStyleDto)
  public cardLogoStyle?: CardLogoStyleDto;

  @IsOptional()
  @IsIn(CARD_LOGO_PRESETS as readonly string[])
  public cardLogo?: CardLogoPreset;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @ValidateIf((_, value: unknown) => typeof value === 'string' && value.length > 0)
  @IsString()
  @MaxLength(524288)
  @IsBrandingImageUrl()
  public cardLogoUrl?: string | null;

  @IsOptional()
  @IsIn(CARD_EFFECTS as readonly string[])
  public cardEffect?: CardEffect;

  @IsOptional()
  @IsObject()
  public cardEffectProps?: Record<string, unknown>;

  @IsOptional()
  @IsNumber()
  @Min(0.05)
  @Max(1)
  public cardEffectOpacity?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => CardEffectSlotDto)
  public cardEffectsByIndex?: CardEffectSlotDto[];

  @IsOptional()
  @IsIn(BG_EFFECTS as readonly string[])
  public bgEffect?: BgEffect;

  @IsOptional()
  @ValidateNested()
  @Type(() => AppBackgroundDto)
  public appBackground?: AppBackgroundDto;

  @IsOptional()
  @IsIn(ICON_COLOR_MODES as readonly string[])
  public iconColorMode?: IconColorMode;

  @IsOptional()
  @IsObject()
  @IsBrandingHexColourMap()
  public iconColors?: Record<string, string>;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(1, 64)
  @IsBorderRadiusClass()
  public borderRadius?: string;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => CornerRadiiDto)
  public cornerRadii?: CornerRadiiDto;

  @IsOptional()
  @IsString()
  @Length(1, 256)
  public fontFamily?: string;

  @ValidateIf((_, value: unknown) => value !== undefined)
  @IsObject()
  @ValidateNested()
  @Type(() => SurfaceThemeDto)
  public surfaceTheme?: SurfaceThemeDto;

  /**
   * Per-plan tariff-card styles, keyed by `planId`. Loosely validated here
   * (dynamic keys); strictly normalized in `readPlanCardStyles` (gradient/url
   * caps, hex accent, texture-preset allowlist, per-plan `text` policy,
   * orphan-tolerant).
   *
   * `textureUrl` and `gradient` are validated for a property no normalizer can
   * restore afterwards: a `textureUrl` decides whether the cabinet issues an
   * outbound request, and a `gradient` decides whether a value can escape its
   * CSS declaration. Both must be refused at the door rather than repaired.
   *
   * `accent` and `texturePreset` are validated for the opposite reason — they
   * ARE repaired, and that is the defect. `readPlanCardStyles` simply omits an
   * accent that is not a hex colour and a texture preset that is not on the
   * allowlist, so `accent: 'red'` or `texturePreset: 'plaid'` is stored as a
   * card with no accent and no texture and answered with `200 OK`. There is
   * nothing for the caller to react to and nothing in the response that says a
   * property was dropped. Neither field can be produced by the panel, whose
   * schema offers a colour picker and a fixed preset list, so refusing them
   * cannot cost an operator a save.
   *
   * `text` deliberately gets no validator of its own. A refusal here is a 400
   * for the WHOLE branding PATCH — every colour, logo and text in the same
   * submit — and the worst an unreadable text policy can do is be dropped by
   * `readPlanCardStyles`, leaving that one card on the global policy. The panel
   * schema already refuses a malformed colour where the operator can see which
   * control produced it; making the API refuse it a second time would only
   * convert a survivable mistake into an unexplained failed save.
   */
  @IsOptional()
  @IsObject()
  @HasAllowedPlanTextureUrls()
  @HasSafePlanGradients()
  @HasHexPlanAccents()
  @HasAllowedPlanTexturePresets()
  public planCardStyles?: Record<string, unknown>;

  /**
   * Cabinet bottom-navigation layout (ordered destinations + visibility).
   * Normalized in `readNavItems` (allowlist, dedupe, essentials forced
   * visible, visible-count cap).
   */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => NavItemDto)
  public navItems?: NavItemDto[];

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(24)
  public navGap?: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => ProfileNamingDto)
  public profileNaming?: ProfileNamingDto;
}
