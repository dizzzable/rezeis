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
import { WithdrawalStatus } from '@prisma/client';

export class ListPartnersQueryDto {
  @IsOptional()
  @IsBooleanString()
  public isActive?: 'true' | 'false';

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
  @Max(10_000)
  public offset?: number;
}

export class ListPartnerWithdrawalsQueryDto {
  @IsOptional()
  @IsString()
  public partnerId?: string;

  @IsOptional()
  @IsEnum(WithdrawalStatus)
  public status?: WithdrawalStatus;

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
  @Max(10_000)
  public offset?: number;
}
