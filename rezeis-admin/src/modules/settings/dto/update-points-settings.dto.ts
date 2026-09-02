import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, Max, Min, ValidateIf, ValidateNested } from 'class-validator';

/**
 * "Absent is fine, null is not": `@IsOptional()` would wave `null` through as
 * well, and a `null` switch stored in the column reads as OFF by accident
 * rather than by decision. Only an omitted field skips the check.
 */
const unlessOmitted = ValidateIf((_object: object, value: unknown): boolean => value !== undefined);

/**
 * `Settings.pointsSettings.cashback` — the global rule every plan and add-on
 * in INHERIT mode follows, and the master switch that turns cashback off for
 * ALL of them whatever their own rule says.
 *
 * Every field optional and without an initialiser, like the referral DTO: an
 * omitted field is not in the patch and the stored value survives; `enabled`
 * is a boolean and never `null`. The percent is a whole number of 0..100 —
 * out of range is a 400, never clamped, so the operator learns what was
 * refused instead of finding a different number saved.
 */
export class UpdatePointsCashbackDto {
  @unlessOmitted
  @IsBoolean()
  public readonly enabled?: boolean;

  @unlessOmitted
  @IsInt()
  @Min(0)
  @Max(100)
  public readonly percent?: number;
}

export class UpdatePointsSettingsDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => UpdatePointsCashbackDto)
  public readonly cashback?: UpdatePointsCashbackDto;
}
