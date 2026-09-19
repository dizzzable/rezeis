import { IsBoolean, IsInt, Max, Min, ValidateIf } from 'class-validator';

import {
  CONNECT_HELP_MAX_DELAY_HOURS,
  CONNECT_HELP_MIN_DELAY_HOURS,
} from '../../connect-signal/connect-help-settings';

/**
 * "Absent is fine, null is not": `@IsOptional()` would wave `null` through as
 * well, and a `null` switch in the column reads as OFF by accident rather than
 * by decision. Only an omitted field skips the check.
 */
const unlessOmitted = ValidateIf((_object: object, value: unknown): boolean => value !== undefined);

/**
 * `PATCH /admin/connect-help/settings`. Every field optional; an omitted one
 * keeps what is stored. The hours are a whole number of 1..168 — out of range
 * is a 400, never clamped, so the operator learns what was refused instead of
 * finding a different number saved. Any other key is a 400 through the
 * global `forbidNonWhitelisted`.
 */
export class UpdateConnectHelpSettingsDto {
  @unlessOmitted
  @IsBoolean()
  public readonly enabled?: boolean;

  @unlessOmitted
  @IsInt()
  @Min(CONNECT_HELP_MIN_DELAY_HOURS)
  @Max(CONNECT_HELP_MAX_DELAY_HOURS)
  public readonly delayHours?: number;

  @unlessOmitted
  @IsBoolean()
  public readonly includeTrials?: boolean;
}
