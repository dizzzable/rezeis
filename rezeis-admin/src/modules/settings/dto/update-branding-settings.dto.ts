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
  CARD_EFFECTS,
  CARD_LOGO_PRESETS,
  BrandingThemeMode,
  BrandingThemeModePolicy,
  CardEffect,
  CardLogoPreset,
  ICON_COLOR_MODES,
  IconColorMode,
  NAV_DESTINATIONS,
  NavDestinationId,
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

function hasOnlyAllowedPlanTextureUrls(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return true;
  }
  return Object.values(value as Record<string, unknown>).every((style) => {
    if (typeof style !== 'object' || style === null || Array.isArray(style)) {
      return true;
    }
    const textureUrl = (style as Record<string, unknown>)['textureUrl'];
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
        validate: (value: unknown): boolean => {
          if (
            typeof value !== 'object' ||
            value === null ||
            Array.isArray(value)
          ) {
            return true;
          }
          return Object.values(value as Record<string, unknown>).every(
            (style) => {
              if (
                typeof style !== 'object' ||
                style === null ||
                Array.isArray(style)
              ) {
                return true;
              }
              const gradient = (style as Record<string, unknown>)['gradient'];
              return (
                gradient === undefined ||
                gradient === null ||
                isSafeBrandingGradient(gradient)
              );
            },
          );
        },
        defaultMessage: (): string =>
          'planCardStyles gradient values must contain only valid CSS gradient layers',
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
  @IsIn(CARD_EFFECTS as readonly string[])
  public cardEffect!: CardEffect;

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
  @IsHexColor()
  public color?: string;

  @IsOptional()
  @IsHexColor()
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
 * selects a plain colour (`none`), a static gradient, a static texture, or an
 * animated effect (reuses the card-effect registry). All sub-fields optional
 * so partial patches work; only the fields for the chosen `kind` matter.
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
  @IsHexColor()
  public foreground?: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsHexColor()
  public mutedForeground?: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsHexColor()
  public surface?: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsHexColor()
  public surfaceHigh?: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsHexColor()
  public borderSoft?: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsHexColor()
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

/** One fully resolved light/dark representation of an operator concept. */
export class BrandingThemeVariantDto {
  @IsHexColor()
  public primary!: string;

  @IsHexColor()
  public primaryFg!: string;

  @IsHexColor()
  public bgPrimary!: string;

  @IsHexColor()
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

  @IsString()
  @Length(1, 64)
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
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @ValidateIf((_, value: unknown) => typeof value === 'string' && value.length > 0)
  @IsString()
  @MaxLength(524288)
  @IsBrandingImageUrl()
  public adminPwaIconUrl?: string | null;

  @IsOptional()
  @IsHexColor()
  public primary?: string;

  @IsOptional()
  @IsHexColor()
  public primaryFg?: string;

  @IsOptional()
  @IsHexColor()
  public bgPrimary?: string;

  @IsOptional()
  @IsHexColor()
  public bgSecondary?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  @IsBrandingGradient()
  public cardGradient?: string;

  @IsOptional()
  @ValidateIf((_, value: unknown) => typeof value === 'string' && value.length > 0)
  @IsString()
  @MaxLength(512)
  @IsBrandingGradient({ allowNone: true })
  public cardPattern?: string | null;

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
  public iconColors?: Record<string, string>;

  @IsOptional()
  @IsString()
  @Length(1, 64)
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
   * caps, hex accent, texture-preset allowlist, orphan-tolerant).
   */
  @IsOptional()
  @IsObject()
  @HasAllowedPlanTextureUrls()
  @HasSafePlanGradients()
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
