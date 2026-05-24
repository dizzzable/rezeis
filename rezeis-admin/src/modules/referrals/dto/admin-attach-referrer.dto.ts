import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Admin attaches a referrer to a user retroactively. Identifiers are
 * resolved in priority order: `userId`/`referrerId` (cuid) → telegram id.
 *
 * The SPA "Attach referrer" dialog submits `referredTelegramId` +
 * `referrerTelegramId`. We accept both spellings to keep parity with the
 * historical `manual-attach` route which took raw cuids.
 */
export class AdminAttachReferrerDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  public userId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  public referrerId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  public referredTelegramId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  public referrerTelegramId?: string;
}
