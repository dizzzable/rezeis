import { IsString, Matches, MaxLength } from 'class-validator';

/**
 * Payload reiwa sends on its version heartbeat. The version is a plain
 * semver-ish string (optionally `v`-prefixed); the service normalizes it.
 */
export class ReportReiwaVersionDto {
  @IsString()
  @MaxLength(32)
  @Matches(/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, {
    message: 'version must be a semver string like 0.7.0',
  })
  public version!: string;
}
