import { Type } from 'class-transformer';
import { IsInt, IsISO8601, IsOptional, Max, Min } from 'class-validator';

/**
 * Query for the partner cohort retention endpoint. The horizon is
 * bounded so we never run an unbounded `partner_transactions` JOIN.
 */
export class PartnerAnalyticsCohortQueryDto {
  @IsOptional()
  @IsISO8601()
  public from?: string;

  @IsOptional()
  @IsISO8601()
  public to?: string;

  @IsOptional()
  @Type((): NumberConstructor => Number)
  @IsInt()
  @Min(1)
  @Max(26)
  public horizonWeeks?: number;
}
