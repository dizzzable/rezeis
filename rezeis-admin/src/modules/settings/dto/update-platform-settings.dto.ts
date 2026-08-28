import { AccessMode, Currency } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

/**
 * Multi-subscription policy block (persisted to `Settings.multiSubscriptionSettings`).
 */
export class MultiSubscriptionSettingsDto {
  @IsOptional()
  @IsBoolean()
  public enabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  public defaultMaxSubscriptions?: number;
}

/**
 * Verification template locales (RU/EN). Each is optional and nullable; a
 * cleared field is sent as null/empty and falls back to the default message.
 */
export class VerificationLocalesDto {
  @IsOptional()
  @ValidateIf((_o: object, value: unknown): boolean => value !== null)
  @IsString()
  @MaxLength(2048)
  public ru?: string | null;

  @IsOptional()
  @ValidateIf((_o: object, value: unknown): boolean => value !== null)
  @IsString()
  @MaxLength(2048)
  public en?: string | null;
}

/**
 * Telegram verification / password-reset message templates.
 */
export class VerificationTemplatesDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => VerificationLocalesDto)
  public telegramTemplate?: VerificationLocalesDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => VerificationLocalesDto)
  public passwordResetTelegramTemplate?: VerificationLocalesDto;
}

/**
 * Platform-branding texts block (persisted to `Settings.platformPolicy`).
 * Separate from the visual branding (`Settings.brandingSettings`).
 */
export class PlatformBrandingDto {
  @IsOptional()
  @ValidateIf((_o: object, value: unknown): boolean => value !== null)
  @IsString()
  @MaxLength(128)
  public projectName?: string | null;

  /**
   * IANA time zone, e.g. `Europe/Moscow`.
   *
   * Not validated against the zone database here: the list ships with the
   * runtime and differs between Node builds, so a check here could refuse a
   * zone the formatter would have accepted. The renderer validates it where it
   * is used and falls back to UTC — a wrong hour, never a thrown notification.
   */
  @IsOptional()
  @ValidateIf((_o: object, value: unknown): boolean => value !== null)
  @IsString()
  @MaxLength(64)
  public timezone?: string | null;

  @IsOptional()
  @ValidateIf((_o: object, value: unknown): boolean => value !== null)
  @IsString()
  @MaxLength(128)
  public webTitle?: string | null;

  @IsOptional()
  @ValidateIf((_o: object, value: unknown): boolean => value !== null)
  @IsString()
  @MaxLength(128)
  public channelUsername?: string | null;

  @IsOptional()
  @IsBoolean()
  public channelRecheck?: boolean;

  @IsOptional()
  @IsBoolean()
  public requireTelegramWebCredentials?: boolean;

  @IsOptional()
  @ValidateNested()
  @Type(() => VerificationTemplatesDto)
  public verification?: VerificationTemplatesDto;
}

/**
 * Validates partial updates for platform settings.
 */export class UpdatePlatformSettingsDto {
  @IsOptional()
  @IsBoolean()
  public rulesRequired?: boolean;

  @IsOptional()
  @ValidateIf((_object: object, value: unknown): boolean => value !== null)
  @IsString()
  @MaxLength(2048)
  @IsUrl({ require_tld: false }, { message: 'rulesLink must be a valid URL' })
  public rulesLink?: string | null;

  @IsOptional()
  @IsBoolean()
  public channelRequired?: boolean;

  @IsOptional()
  @ValidateIf((_object: object, value: unknown): boolean => value !== null)
  @IsString()
  @Matches(/^-?\d+$/, { message: 'channelId must be a valid integer string' })
  public channelId?: string | null;

  @IsOptional()
  @ValidateIf((_object: object, value: unknown): boolean => value !== null)
  @IsString()
  @MaxLength(2048)
  @IsUrl({ require_tld: false }, { message: 'channelLink must be a valid URL' })
  public channelLink?: string | null;

  @IsOptional()
  @IsEnum(AccessMode)
  public accessMode?: AccessMode;

  @IsOptional()
  @ValidateIf((_object: object, value: unknown): boolean => value !== null)
  @IsString()
  @MaxLength(128)
  @Matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/, {
    message: 'inviteModeStartedAt must be a valid ISO-8601 UTC string',
  })
  public inviteModeStartedAt?: string | null;

  @IsOptional()
  @IsEnum(Currency)
  public defaultCurrency?: Currency;

  @IsOptional()
  @ValidateNested()
  @Type(() => MultiSubscriptionSettingsDto)
  public multiSubscriptionSettings?: MultiSubscriptionSettingsDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => PlatformBrandingDto)
  public platformBranding?: PlatformBrandingDto;

  /**
   * Admin bot token used for direct media broadcast delivery. Stored
   * AES-256-GCM-encrypted; an empty string clears it. Never echoed back.
   */
  @IsOptional()
  @ValidateIf((_object: object, value: unknown): boolean => value !== null)
  @IsString()
  @MaxLength(256)
  public botToken?: string | null;
}