import {
  IsHexColor,
  IsIn,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

import {
  BG_EFFECTS,
  BgEffect,
} from '../interfaces/branding-settings.interface';

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
export class UpdateBrandingSettingsDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  public brandName?: string;

  @IsOptional()
  @ValidateIf((_, value: unknown) => typeof value === 'string' && value.length > 0)
  @IsString()
  @MaxLength(8192)
  @Matches(/^(?:data:image\/[a-z0-9+.-]+;base64,[A-Za-z0-9+/=]+|https?:\/\/.+)$/i, {
    message: 'logoUrl must be a data: URI or an http(s) URL',
  })
  public logoUrl?: string | null;

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
  @MaxLength(8192)
  public cardPattern?: string | null;

  @IsOptional()
  @IsIn(BG_EFFECTS as readonly string[])
  public bgEffect?: BgEffect;

  @IsOptional()
  @IsString()
  @Length(1, 64)
  public borderRadius?: string;

  @IsOptional()
  @IsString()
  @Length(1, 256)
  public fontFamily?: string;
}
