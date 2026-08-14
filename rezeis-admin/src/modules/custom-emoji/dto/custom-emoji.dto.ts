import { IsOptional, IsString, Matches, MaxLength, ValidateIf } from 'class-validator';

export class ImportBySetLinkDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  public packName?: string;

  @IsString()
  @MaxLength(256)
  public link!: string;
}

export class UpdateEmojiDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  public name?: string;

  @IsOptional()
  @ValidateIf((_o: object, v: unknown): boolean => v !== null)
  @IsString()
  @MaxLength(32)
  public fallback?: string | null;

  /**
   * Telegram `custom_emoji_id`: a decimal 64-bit id. Anything non-numeric is
   * stripped when the `<tg-emoji>` tag is built, so it is rejected here rather
   * than stored and silently ignored at delivery time. `null` clears it.
   */
  @IsOptional()
  @ValidateIf((_o: object, v: unknown): boolean => v !== null)
  @IsString()
  @MaxLength(32)
  @Matches(/^[0-9]+$/, {
    message: 'customEmojiId must be the numeric Telegram custom_emoji_id (digits only)',
  })
  public customEmojiId?: string | null;
}
