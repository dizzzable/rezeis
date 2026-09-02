import { IsIn, IsInt, IsOptional, IsString, MaxLength, NotEquals } from 'class-validator';

import {
  POINTS_ADJUSTMENT_REASONS,
  PointsAdjustmentReason,
} from '../../points/points-adjustment-reasons';

/**
 * Signed points adjustment. `@IsInt` rejects NaN / Infinity / non-integer /
 * string payloads that would otherwise flow into a Prisma `{ increment }` and
 * corrupt the balance (NaN passes a naive `< 0` guard). Zero is a no-op and
 * rejected so every adjustment is meaningful and auditable.
 *
 * `reason` and `note` are optional so the panel that predates them keeps
 * working: an adjustment without a reason is recorded as OTHER. The reason is
 * a code the subscriber sees in their own history, rendered in their language;
 * the note is free text for the panel only and never leaves it.
 */
export class AdjustUserPointsDto {
  @IsInt({ message: 'delta must be an integer' })
  @NotEquals(0, { message: 'delta must not be zero' })
  public delta!: number;

  @IsOptional()
  @IsIn(POINTS_ADJUSTMENT_REASONS, { message: 'reason must be one of the known adjustment reasons' })
  public reason?: PointsAdjustmentReason;

  @IsOptional()
  @IsString()
  @MaxLength(500, { message: 'note must be at most 500 characters' })
  public note?: string;
}
