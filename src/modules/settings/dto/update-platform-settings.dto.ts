import { AccessMode, Currency } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';

/**
 * Validates partial updates for platform settings.
 */
export class UpdatePlatformSettingsDto {
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
}
