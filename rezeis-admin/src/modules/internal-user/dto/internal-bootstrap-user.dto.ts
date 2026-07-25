import { IsOptional, IsString, Length, Matches } from 'class-validator';

/**
 * Bot-facing payload for `POST /api/internal/user/bootstrap`.
 *
 * `telegramId` is validated as a numeric string of reasonable length —
 * Telegram ids fit inside a 64-bit signed integer (max 19 digits) and we
 * never accept zero/negative ids. `language` is matched loosely (2-letter
 * ISO codes) and case-normalised to upper-case in the service.
 */
export class InternalBootstrapUserDto {
  @IsString()
  @Matches(/^\d{1,19}$/, { message: 'telegramId must be a positive numeric string up to 19 digits' })
  public readonly telegramId!: string;

  @IsOptional()
  @IsString()
  @Length(0, 64)
  public readonly username?: string;

  @IsString()
  @Length(0, 256)
  public readonly name!: string;

  @IsOptional()
  @IsString()
  @Length(2, 8)
  public readonly language?: string;

  /**
   * Optional referral token carried by a `t.me/<bot>?start=ref_<token>`
   * deep-link. Bound to the inviting user ONLY on a brand-new bootstrap
   * (first `/start`). Accepts the same identifiers as the web register
   * flow (reiwa_id / telegramId / username / referralCode). Loosely
   * length-bounded — resolution is best-effort and never fails bootstrap.
   */
  @IsOptional()
  @IsString()
  @Length(1, 128)
  public readonly referralCode?: string;
}
