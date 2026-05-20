import { Type } from 'class-transformer';
import {
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumberString,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { PromocodeAvailability, PromocodeRewardType } from '@prisma/client';

import { PromocodePlanSnapshotDto } from './promocode-plan-snapshot.dto';

export class CreatePromocodeDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  public code!: string;

  @IsOptional()
  @IsBoolean()
  public isActive?: boolean;

  @IsEnum(PromocodeAvailability)
  public availability!: PromocodeAvailability;

  @IsEnum(PromocodeRewardType)
  public rewardType!: PromocodeRewardType;

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

  /**
   * Telegram ids are passed as decimal strings on the wire to avoid losing
   * precision over JSON. The lifecycle service casts them to BigInt before
   * persisting.
   */
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
