import { Type } from 'class-transformer';
import {
  IsBooleanString,
  IsEnum,
  IsInt,
  IsOptional,
  Max,
  Min,
} from 'class-validator';
import { SubscriptionStatus } from '@prisma/client';

export class ListSubscriptionsQueryDto {
  @IsOptional()
  @IsEnum(SubscriptionStatus)
  public status?: SubscriptionStatus;

  @IsOptional()
  @IsBooleanString()
  public isTrial?: 'true' | 'false';

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
