import {
  IsEnum,
  IsISO8601,
  IsInt,
  IsOptional,
  Max,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

import { ReferralTimeseriesGranularity } from '../interfaces/admin-referral-analytics.interface';

export class AnalyticsRangeQueryDto {
  @IsOptional()
  @IsISO8601()
  public from?: string;

  @IsOptional()
  @IsISO8601()
  public to?: string;
}

export class AnalyticsTimeseriesQueryDto extends AnalyticsRangeQueryDto {
  @IsOptional()
  @IsEnum(['day', 'week'] as const)
  public granularity?: ReferralTimeseriesGranularity;
}

export class AnalyticsTopReferrersQueryDto extends AnalyticsRangeQueryDto {
  @IsOptional()
  @Type((): NumberConstructor => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  public limit?: number;
}
