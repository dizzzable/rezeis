import { PaymentGatewayType, PurchaseChannel, PurchaseType } from '@prisma/client';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

const LIVE_PAYMENT_PURCHASE_TYPES: readonly PurchaseType[] = [
  PurchaseType.NEW,
  PurchaseType.RENEW,
  PurchaseType.UPGRADE,
  PurchaseType.ADDITIONAL,
] as const;

export class InternalPaymentCheckoutDto {
  @IsUUID('4')
  public userId!: string;

  @IsEnum(PurchaseType)
  @IsIn(LIVE_PAYMENT_PURCHASE_TYPES)
  public purchaseType!: PurchaseType;

  @IsUUID('4')
  public planId!: string;

  @IsInt()
  @Min(-1)
  public durationDays!: number;

  @IsEnum(PaymentGatewayType)
  public gatewayType!: PaymentGatewayType;

  @IsOptional()
  @IsUUID('4')
  public subscriptionId?: string;

  @IsOptional()
  @IsEnum(PurchaseChannel)
  public channel?: PurchaseChannel;

  /**
   * URL the payment provider redirects the customer to on a successful payment.
   * Reiwa supplies a context-aware URL (web origin for browser, Telegram deep link for Mini App).
   * Falls back to `${REZEIS_DOMAIN}/payments/result?paymentId=...` when not provided.
   */
  @IsOptional()
  @IsString()
  @IsUrl({ require_protocol: true, protocols: ['http', 'https', 'tg', 'tgapp'] })
  @MaxLength(2048)
  public successUrl?: string;

  /**
   * URL the payment provider redirects the customer to on a failed/cancelled payment.
   * Defaults to `successUrl` when omitted, mirroring most providers' behaviour.
   */
  @IsOptional()
  @IsString()
  @IsUrl({ require_protocol: true, protocols: ['http', 'https', 'tg', 'tgapp'] })
  @MaxLength(2048)
  public failUrl?: string;
}
