import { IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

/**
 * Body DTO for `POST /internal/user/surface-seen` — reiwa reports the surface
 * the user is currently using (once per cabinet session).
 *
 * Carries the canonical identity (reiwa_id preferred, telegramId fallback) plus
 * the client-detected `surface` / `formFactor` / `os`. Unknown values are
 * clamped server-side, so the enums here are a soft guard only.
 */
export class InternalSurfaceSeenDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  public readonly userId?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d{1,19}$/, { message: 'telegramId must be a positive numeric string up to 19 digits' })
  public readonly telegramId?: string;

  @IsOptional()
  @IsIn(['tma', 'pwa', 'browser'])
  public readonly surface?: 'tma' | 'pwa' | 'browser';

  @IsOptional()
  @IsIn(['mobile', 'tablet', 'desktop'])
  public readonly formFactor?: 'mobile' | 'tablet' | 'desktop';

  @IsOptional()
  @IsIn(['ios', 'android', 'windows', 'macos', 'linux', 'other'])
  public readonly os?: 'ios' | 'android' | 'windows' | 'macos' | 'linux' | 'other';
}
