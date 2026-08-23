import { PartnerAccrualStrategy, PartnerRewardType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  Max,
  Min,
} from 'class-validator';

/**
 * Body payload for `PATCH /admin/users/:telegramId/partner/settings`.
 *
 * Donor parity: altshop's `PartnerIndividualSettingsDto`. Stored as
 * typed columns in `partners` (see migration
 * `20260519130000_partner_individual_settings`).
 */
export class UpdatePartnerSettingsDto {
  @IsOptional()
  @IsBoolean()
  public useGlobalSettings?: boolean;

  @IsOptional()
  @IsEnum(PartnerAccrualStrategy)
  public accrualStrategy?: PartnerAccrualStrategy;

  @IsOptional()
  @IsEnum(PartnerRewardType)
  public rewardType?: PartnerRewardType;

  @IsOptional()
  @Type((): NumberConstructor => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  public level1Percent?: number | null;

  @IsOptional()
  @Type((): NumberConstructor => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  public level2Percent?: number | null;

  @IsOptional()
  @Type((): NumberConstructor => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  public level3Percent?: number | null;

  @IsOptional()
  @Type((): NumberConstructor => Number)
  @IsInt()
  @Min(0)
  public level1FixedAmount?: number | null;

  @IsOptional()
  @Type((): NumberConstructor => Number)
  @IsInt()
  @Min(0)
  public level2FixedAmount?: number | null;

  @IsOptional()
  @Type((): NumberConstructor => Number)
  @IsInt()
  @Min(0)
  public level3FixedAmount?: number | null;

  /**
   * Per-level accrual mode. Omit the field to leave the level as it is;
   * send `null` to clear the override so the level goes back to inheriting
   * the partner-wide `accrualStrategy` above. Never send a value merely to
   * echo what `accrualStrategy` already says - a stored value stops
   * following that toggle, an inherited one keeps following it.
   *
   * `ONCE_PER_USER` = pay only on the referral's FIRST payment at this
   * level; `ON_EACH_PAYMENT` = pay on every payment. Only consulted when
   * `useGlobalSettings` is false.
   */
  @IsOptional()
  @IsEnum(PartnerAccrualStrategy)
  public level1AccrualStrategy?: PartnerAccrualStrategy | null;

  @IsOptional()
  @IsEnum(PartnerAccrualStrategy)
  public level2AccrualStrategy?: PartnerAccrualStrategy | null;

  @IsOptional()
  @IsEnum(PartnerAccrualStrategy)
  public level3AccrualStrategy?: PartnerAccrualStrategy | null;
}
