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
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

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

  @IsOptional()
  @IsInt()
  @Min(0)
  public readonly spendAmountMinor?: number;

  @IsOptional()
  @IsString()
  @Length(3, 8)
  public readonly spendCurrency?: string;

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

  @IsOptional()
  @IsInt()
  @Min(0)
  public readonly spendAmountMinor?: number;

  @IsOptional()
  @IsString()
  @Length(3, 8)
  public readonly spendCurrency?: string;

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

  /** BOT | MINIAPP | WEB — defaults to BOT when omitted. */
  @IsOptional()
  @IsString()
  @Length(1, 16)
  public readonly surface?: string;

  @IsOptional()
  @IsBoolean()
  public readonly isNewUser?: boolean;
}
