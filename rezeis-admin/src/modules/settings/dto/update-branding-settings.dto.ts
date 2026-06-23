import {
  IsArray,
  IsHexColor,
  IsIn,
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
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

import {
  APP_BACKGROUND_KINDS,
  APP_BACKGROUND_TEXTURES,
  AppBackgroundKind,
  AppBackgroundTexture,
  BG_EFFECTS,
  BgEffect,
  CARD_EFFECTS,
  CARD_LOGO_PRESETS,
  CardEffect,
  CardLogoPreset,
  ICON_COLOR_MODES,
  IconColorMode,
} from '../interfaces/branding-settings.interface';

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
  public gradient?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => AppBackgroundTextureDto)
  public texture?: AppBackgroundTextureDto;
}

/**
 * Patch payload for `PATCH /admin/settings/branding`.
 *
 * Every field is optional so the admin UI can submit incremental changes.
 * Validation rules are intentionally strict:
 *   - colour fields accept 3 / 4 / 6 / 8-digit hex with leading `#`,
 *   - `cardGradient` accepts any non-empty string (CSS background grammar is
 *     hard to validate in DTOs; the SPA renders it under the same-origin
 *     stylesheet so XSS surface is limited to the admin user themselves),
 *   - `bgEffect` is constrained to the predefined preset list,
 *   - `logoUrl` accepts `data:` URIs (for inline SVGs uploaded through the UI)
 *     OR `http(s)://` URLs.
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

export class UpdateBrandingSettingsDto {
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
  @ValidateIf((_, value: unknown) => typeof value === 'string' && value.length > 0)
  @IsString()
  @MaxLength(524288)
  @Matches(/^(?:data:image\/[a-z0-9+.-]+;base64,[A-Za-z0-9+/=]+|https?:\/\/.+|\/uploads\/[A-Za-z0-9._/-]+)$/i, {
    message: 'logoUrl must be a data: URI, an http(s) URL, or an /uploads/ path',
  })
  public logoUrl?: string | null;

  @IsOptional()
  @ValidateIf((_, value: unknown) => typeof value === 'string' && value.length > 0)
  @IsString()
  @MaxLength(524288)
  @Matches(/^(?:data:image\/[a-z0-9+.-]+;base64,[A-Za-z0-9+/=]+|https?:\/\/.+|\/uploads\/[A-Za-z0-9._/-]+)$/i, {
    message: 'pwaIconUrl must be a data: URI, an http(s) URL, or an /uploads/ path',
  })
  public pwaIconUrl?: string | null;

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
  public cardGradient?: string;

  @IsOptional()
  @ValidateIf((_, value: unknown) => typeof value === 'string' && value.length > 0)
  @IsString()
  @MaxLength(524288)
  public cardPattern?: string | null;

  @IsOptional()
  @IsIn(CARD_LOGO_PRESETS as readonly string[])
  public cardLogo?: CardLogoPreset;

  @IsOptional()
  @ValidateIf((_, value: unknown) => typeof value === 'string' && value.length > 0)
  @IsString()
  @MaxLength(524288)
  @Matches(/^(?:data:image\/[a-z0-9+.-]+;base64,[A-Za-z0-9+/=]+|https?:\/\/.+|\/uploads\/[A-Za-z0-9._/-]+)$/i, {
    message: 'cardLogoUrl must be a data: URI, an http(s) URL, or an /uploads/ path',
  })
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
  @IsString()
  @Length(1, 256)
  public fontFamily?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => ProfileNamingDto)
  public profileNaming?: ProfileNamingDto;
}
