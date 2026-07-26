import {
  AdOwnerType,
  AdPlatform,
  AdPlacementStatus,
  AdSignupBonusType,
} from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * Ceiling for an advertising budget in minor units — 20 million major units.
 * A fat-fingered extra digit used to be accepted and then divided into every
 * ratio on the placement.
 */
const MAX_SPEND_MINOR = 2_000_000_000;

export class AdSignupBonusDto {
  @IsEnum(AdSignupBonusType)
  public readonly type!: AdSignupBonusType;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(730)
  public readonly trialDurationDays?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  public readonly trialTrafficGb?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  public readonly trialDeviceLimit?: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  public readonly trialSquadUuids?: string[];

  @IsOptional()
  @IsString()
  @Length(1, 64)
  public readonly tariffPlanId?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(730)
  public readonly tariffDurationDays?: number;
}

export class CreateCampaignDto {
  @IsString()
  @Length(3, 100)
  public readonly name!: string;

  @IsOptional()
  @IsString()
  @Length(0, 2000)
  public readonly notes?: string;
}

export class UpdateCampaignDto {
  @IsOptional()
  @IsString()
  @Length(3, 100)
  public readonly name?: string;

  @IsOptional()
  @IsEnum(AdPlacementStatus)
  public readonly status?: AdPlacementStatus;

  @IsOptional()
  @IsString()
  @Length(0, 2000)
  public readonly notes?: string;
}

export class CreatePlacementDto {
  @IsString()
  @Length(1, 64)
  public readonly campaignId!: string;

  @IsEnum(AdPlatform)
  public readonly platform!: AdPlatform;

  @IsOptional()
  @IsString()
  @Length(0, 200)
  public readonly channel?: string;

  @IsOptional()
  @IsEnum(AdOwnerType)
  public readonly ownerType?: AdOwnerType;

  @IsOptional()
  @IsString()
  @Length(1, 64)
  public readonly partnerId?: string;

  @IsInt()
  @Min(1)
  @Max(365)
  public readonly attributionWindowDays!: number;

  @IsOptional()
  @IsString()
  @Length(1, 64)
  public readonly promoCodeId?: string;

  /**
   * `null` clears the budget. `@IsOptional()` skips validation for both null and
   * undefined, and the two mean different things downstream: undefined leaves the
   * stored value alone, null erases it. Without the nullable type the operator
   * could set a wrong budget but never remove it — the UI reported success and
   * silently kept the old number, so CAC and ROAS stayed wrong by that factor.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_SPEND_MINOR)
  public readonly spendAmountMinor?: number | null;

  @IsOptional()
  @IsString()
  @Length(3, 8)
  public readonly spendCurrency?: string | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => AdSignupBonusDto)
  public readonly signupBonus?: AdSignupBonusDto;
}

export class UpdatePlacementDto {
  @IsOptional()
  @IsString()
  @Length(0, 200)
  public readonly channel?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  public readonly attributionWindowDays?: number;

  @IsOptional()
  @IsString()
  @Length(1, 64)
  public readonly promoCodeId?: string;

  /**
   * `null` clears the budget. `@IsOptional()` skips validation for both null and
   * undefined, and the two mean different things downstream: undefined leaves the
   * stored value alone, null erases it. Without the nullable type the operator
   * could set a wrong budget but never remove it — the UI reported success and
   * silently kept the old number, so CAC and ROAS stayed wrong by that factor.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_SPEND_MINOR)
  public readonly spendAmountMinor?: number | null;

  @IsOptional()
  @IsString()
  @Length(3, 8)
  public readonly spendCurrency?: string | null;

  @IsOptional()
  @IsEnum(AdPlacementStatus)
  public readonly status?: AdPlacementStatus;

  @IsOptional()
  @ValidateNested()
  @Type(() => AdSignupBonusDto)
  public readonly signupBonus?: AdSignupBonusDto;
}

export class ModerateRequestDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  public readonly approvedWindowDays?: number;

  @IsOptional()
  @IsString()
  @Length(0, 2000)
  public readonly notes?: string;
}

export class CreateAdRequestDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsEnum(AdPlatform, { each: true })
  public readonly platforms!: AdPlatform[];

  @IsOptional()
  @IsString()
  @Length(0, 200)
  public readonly channel?: string;

  @IsOptional()
  @IsString()
  @Length(0, 2000)
  public readonly notes?: string;

  @IsInt()
  @Min(1)
  @Max(365)
  public readonly proposedWindowDays!: number;

  @IsOptional()
  @IsString()
  @Length(0, 200)
  public readonly selfFundedBudgetNote?: string;
}

/** Operator-owned reporting rate: 1 `quote` = `rate` units of the base currency. */
export class SetFxRateDto {
  @IsString()
  @Length(2, 8)
  public readonly quote!: string;

  @IsNumber()
  @Min(0.000000000001)
  @Max(1_000_000_000)
  public readonly rate!: number;
}

export class IngestClickDto {
  @IsString()
  @Length(3, 32)
  public readonly code!: string;

  @IsOptional()
  @IsString()
  @Length(1, 32)
  public readonly telegramId?: string;

  /** Web-only users may attribute via rezeis user id when telegramId is absent. */
  @IsOptional()
  @IsString()
  @Length(1, 64)
  public readonly userId?: string;

  /** Optional utm params from the deep link payload (e.g. utm_source, utm_medium). */
  @IsOptional()
  @IsString()
  @Length(1, 64)
  public readonly utmSource?: string;

  @IsOptional()
  @IsString()
  @Length(1, 64)
  public readonly utmMedium?: string;

  @IsOptional()
  @IsString()
  @Length(1, 64)
  public readonly utmCampaign?: string;

  @IsOptional()
  @IsString()
  @Length(1, 64)
  public readonly utmContent?: string;

  @IsOptional()
  @IsString()
  @Length(1, 64)
  public readonly utmCreative?: string;

  /** BOT | MINIAPP | WEB — defaults to BOT when omitted. */
  @IsOptional()
  @IsString()
  @Length(1, 16)
  public readonly surface?: string;

  @IsOptional()
  @IsBoolean()
  public readonly isNewUser?: boolean;

  /**
   * Binds the user to the placement without recording a second open. The web
   * funnel records the open anonymously on landing and calls back with the
   * account at registration.
   */
  @IsOptional()
  @IsBoolean()
  public readonly attributeOnly?: boolean;
}
