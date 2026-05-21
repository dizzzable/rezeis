import { Type } from 'class-transformer';
import {
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumberString,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { PromocodeAvailability, PromocodeRewardType } from '@prisma/client';

import { PromocodePlanSnapshotDto } from './promocode-plan-snapshot.dto';

/**
 * Partial update payload. Every field is optional so the caller can patch
 * only what it needs. The lifecycle service applies extra invariants such as
 * "SUBSCRIPTION rewardType requires a non-null plan snapshot".
 */
export class UpdatePromocodeDto {
  @IsOptional()
  @IsBoolean()
  public isActive?: boolean;

  @IsOptional()
  @IsEnum(PromocodeAvailability)
  public availability?: PromocodeAvailability;

  @IsOptional()
  @IsEnum(PromocodeRewardType)
  public rewardType?: PromocodeRewardType;

  @IsOptional()
  @IsInt()
  public reward?: number | null;

  @IsOptional()
  @ValidateNested()
  @Type((): typeof PromocodePlanSnapshotDto => PromocodePlanSnapshotDto)
  public plan?: PromocodePlanSnapshotDto | null;

  @IsOptional()
  @IsInt()
  @Min(-1)
  public lifetime?: number | null;

  @IsOptional()
  @IsInt()
  @Min(-1)
  public maxActivations?: number | null;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsNumberString({ no_symbols: true }, { each: true })
  public allowedTelegramIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  public allowedPlanIds?: string[];
}
