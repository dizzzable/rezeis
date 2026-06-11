import { IsOptional, IsString, Length, Matches, MaxLength, MinLength } from 'class-validator';

/**
 * User-facing payload for `PATCH /api/internal/user/language`.
 * Accepts EITHER the canonical reiwa_id (`userId`, CUID — used by web /
 * Mini App users with no Telegram) OR a `telegramId`, plus a short ISO
 * locale code; the service resolves `Locale` enum values case-insensitively.
 */
export class InternalUpdateLanguageDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  public readonly userId?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d{1,19}$/, { message: 'telegramId must be a positive numeric string up to 19 digits' })
  public readonly telegramId?: string;

  @IsString()
  @Length(2, 8)
  public readonly language!: string;
}
