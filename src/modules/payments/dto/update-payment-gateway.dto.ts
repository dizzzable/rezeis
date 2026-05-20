import { Type } from 'class-transformer';
import { Currency, PaymentGatewayType } from '@prisma/client';
import { IsBoolean, IsEnum, IsInt, IsOptional, Min } from 'class-validator';

export class UpdatePaymentGatewayDto {
  @IsOptional()
  @IsEnum(PaymentGatewayType)
  public type?: PaymentGatewayType;

  @IsOptional()
  @IsEnum(Currency)
  public currency?: Currency;

  @IsOptional()
  @IsBoolean()
  public isActive?: boolean;

  @IsOptional()
  @Type((): NumberConstructor => Number)
  @IsInt()
  @Min(0)
  public orderIndex?: number;

  @IsOptional()
  public settings?: unknown;
}
