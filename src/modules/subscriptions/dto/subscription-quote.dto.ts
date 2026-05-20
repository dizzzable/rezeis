import { PaymentGatewayType, PurchaseChannel } from '@prisma/client';
import { IsEnum, IsIn, IsOptional, IsUUID, IsInt, Min } from 'class-validator';

export const SUBSCRIPTION_QUOTE_ACTIONS = ['NEW', 'ADDITIONAL', 'RENEW', 'UPGRADE', 'TRIAL'] as const;
export type SubscriptionQuoteAction = (typeof SUBSCRIPTION_QUOTE_ACTIONS)[number];

export class SubscriptionQuoteDto {
  @IsUUID('4')
  public userId!: string;

  @IsIn(SUBSCRIPTION_QUOTE_ACTIONS)
  public purchaseType!: SubscriptionQuoteAction;

  @IsOptional()
  @IsEnum(PurchaseChannel)
  public channel?: PurchaseChannel;

  @IsOptional()
  @IsEnum(PaymentGatewayType)
  public gatewayType?: PaymentGatewayType;

  @IsOptional()
  @IsUUID('4')
  public subscriptionId?: string;

  @IsOptional()
  @IsUUID('4')
  public planId?: string;

  @IsOptional()
  @IsInt()
  @Min(-1)
  public durationDays?: number;
}
