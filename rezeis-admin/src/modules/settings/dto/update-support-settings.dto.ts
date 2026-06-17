import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/**
 * Panel-managed anonymous support chat settings. Every field is optional —
 * the SPA sends only what changed. Numeric bounds mirror the merge clamps.
 * `turnstileSecret` is write-only: an empty string clears it; it is never
 * echoed back (the GET exposes only a `turnstileConfigured` flag).
 */
export class UpdateSupportSettingsDto {
  @IsOptional()
  @IsBoolean()
  public readonly enabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(8760)
  public readonly guestTokenTtlHours?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  public readonly attachmentMaxMb?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  public readonly attachmentMaxPerMsg?: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  public readonly turnstileSiteKey?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  public readonly turnstileSecret?: string;
}
