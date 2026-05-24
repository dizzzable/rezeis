import { Type } from 'class-transformer';
import {
  IsBooleanString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { ReferralRewardType } from '@prisma/client';

export class ListRewardsQueryDto {
  @IsOptional()
  @IsString()
  public userId?: string;

  @IsOptional()
  @IsString()
  public referralId?: string;

  @IsOptional()
  @IsEnum(ReferralRewardType)
  public type?: ReferralRewardType;

  @IsOptional()
  @IsBooleanString()
  public issued?: 'true' | 'false';

  @IsOptional()
  @Type((): NumberConstructor => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  public limit?: number;

  @IsOptional()
  @Type((): NumberConstructor => Number)
  @IsInt()
  @Min(0)
  @Max(100_000)
  public offset?: number;
}
