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
 * Template locales (RU/EN) of the retired Telegram templates below. Still
 * validated as they always were, so a body an older admin SPA sends is refused
 * or accepted exactly as before — and then ignored.
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
 * ACCEPTED AND IGNORED — both templates.
 *
 * «Верификация (RU/EN)» and «Сброс пароля (RU/EN)» were never sent by anything
 * in the panel, the cabinet or the bot: a reset link goes out with the bot's
 * own text, and an e-mail code with the e-mail's own. So the Branding card no
 * longer offers them, the panel no longer presents or writes them, and what an
 * install stored stays in `platformPolicy.verification` untouched
 * (`mergePlatformBranding` carries every key it does not own).
 *
 * Still declared because an admin SPA loaded before this release sends both
 * with every Branding save, and the global `ValidationPipe`
 * (`forbidNonWhitelisted`) would answer that save with a 400. An exported
 * configuration does not need them: config import writes the `platformPolicy`
 * column as it is and never meets this DTO.
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
   * IANA time zone, e.g. `Europe/Moscow` — «Часовой пояс» of Settings →
   * «Платформа». `null` or empty: none, UTC everywhere.
   *
   * Only its shape is bounded here. Whether it is a zone is asked on save by
   * `SettingsService.updatePlatformSettings` (`platform-timezone.util.ts`):
   * the zone must be one both `Intl` and PostgreSQL know, and it is stored in
   * its proper IANA spelling — an offset, an abbreviation such as `CET` or a
   * name neither knows is a 400 naming the problem. A value stored before that
   * check, or by a config import, is still read by every reader with its own
   * fallback to UTC: a wrong hour, never a thrown notification.
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

  /** «Восстановление пароля по ссылке подписки» — see `PlatformBrandingInterface`. */
  @IsOptional()
  @IsBoolean()
  public subscriptionLinkRecovery?: boolean;

  /** Accepted and ignored — see `VerificationTemplatesDto`. */
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