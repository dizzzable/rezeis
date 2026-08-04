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

  /**
   * Turning a gateway on is additionally gated by
   * `PaymentGatewayRegistryService.updateGateway`, which rejects
   * `PAYMENT_GATEWAY_NOT_CONFIGURED` unless the post-update settings satisfy
   * `isGatewayConfigured`. That check needs the stored row (and the `settings`
   * this very request may be changing), so it cannot live in the DTO.
   */
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
