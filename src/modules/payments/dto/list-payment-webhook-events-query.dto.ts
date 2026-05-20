import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import {
  PaymentGatewayType,
  PaymentWebhookLifecycleStatus,
} from '@prisma/client';

export class ListPaymentWebhookEventsQueryDto {
  @IsOptional()
  @IsEnum(PaymentGatewayType)
  public gatewayType?: PaymentGatewayType;

  @IsOptional()
  @IsEnum(PaymentWebhookLifecycleStatus)
  public status?: PaymentWebhookLifecycleStatus;

  @IsOptional()
  @IsString()
  public paymentId?: string;

  @IsOptional()
  @IsString()
  public providerEventId?: string;

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
  @Max(500)
  public limit?: number;

  @IsOptional()
  @Type((): NumberConstructor => Number)
  @IsInt()
  @Min(0)
  @Max(2000)
  public offset?: number;
}

export class PaymentWebhookEventDetailQueryDto {
  @IsOptional()
  @Type((): BooleanConstructor => Boolean)
  public includeRaw?: boolean;
}

export class ReplayPaymentWebhookEventParamsDto {
  @IsUUID('4')
  public eventId!: string;
}
