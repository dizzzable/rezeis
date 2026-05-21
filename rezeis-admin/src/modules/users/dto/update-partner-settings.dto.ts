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
}
