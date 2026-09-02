import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

import { INT4_MAX } from '../../points/points-cashback.util';
import { AdminPlanPriceDto } from './admin-plan-price.dto';

export class AdminPlanDurationDto {
  @Type((): NumberConstructor => Number)
  @IsInt()
  @Min(1)
  public days!: number;

  /**
   * Points paid for a purchase of THIS duration when the plan's `cashbackMode`
   * is FIXED — a year and a month may differ. Under every other mode the
   * normaliser stores NULL whatever was sent; under FIXED, NULL reads as zero.
   */
  @IsOptional()
  @ValidateIf((_object: object, value: unknown): boolean => value !== null)
  @Type((): NumberConstructor => Number)
  @IsInt()
  @Min(0)
  @Max(INT4_MAX)
  public cashbackPoints?: number | null;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type((): typeof AdminPlanPriceDto => AdminPlanPriceDto)
  public prices!: AdminPlanPriceDto[];
}
