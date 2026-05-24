import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  Max,
  Min,
} from 'class-validator';

/** Time-range query for partner analytics endpoints. */
export class PartnerAnalyticsRangeQueryDto {
  @IsOptional()
  @IsISO8601()
  public from?: string;

  @IsOptional()
  @IsISO8601()
  public to?: string;
}

export class PartnerAnalyticsTimeseriesQueryDto extends PartnerAnalyticsRangeQueryDto {
  @IsOptional()
  @IsIn(['day', 'week'] as const)
  public granularity?: 'day' | 'week';
}

export class PartnerAnalyticsTopPartnersQueryDto extends PartnerAnalyticsRangeQueryDto {
  @IsOptional()
  @Type((): NumberConstructor => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  public limit?: number;
}
