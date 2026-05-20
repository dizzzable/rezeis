import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsInt, Min, ValidateNested } from 'class-validator';

import { AdminPlanPriceDto } from './admin-plan-price.dto';

export class AdminPlanDurationDto {
  @Type((): NumberConstructor => Number)
  @IsInt()
  @Min(1)
  public days!: number;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type((): typeof AdminPlanPriceDto => AdminPlanPriceDto)
  public prices!: AdminPlanPriceDto[];
}
