import { PaymentGatewayType, PurchaseType, TransactionStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsDateString, IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';

export class ListTransactionsQueryDto {
  @IsOptional()
  @IsUUID('4')
  public userId?: string;

  @IsOptional()
  @IsString()
  public userSearch?: string;

  @IsOptional()
  @IsEnum(TransactionStatus)
  public status?: TransactionStatus;

  @IsOptional()
  @IsEnum(PaymentGatewayType)
  public gatewayType?: PaymentGatewayType;

  @IsOptional()
  @IsEnum(PurchaseType)
  public purchaseType?: PurchaseType;

  @IsOptional()
  @IsDateString()
  public dateFrom?: string;

  @IsOptional()
  @IsDateString()
  public dateTo?: string;

  @IsOptional()
  @Type((): NumberConstructor => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  public limit?: number;

  @IsOptional()
  @Type((): NumberConstructor => Number)
  @IsInt()
  @Min(0)
  public offset?: number;
}
