import { PaymentGatewayType, PurchaseChannel } from '@prisma/client';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Currency } from '@prisma/client';

export const SUBSCRIPTION_QUOTE_ACTIONS = ['NEW', 'ADDITIONAL', 'RENEW', 'UPGRADE', 'TRIAL'] as const;
export type SubscriptionQuoteAction = (typeof SUBSCRIPTION_QUOTE_ACTIONS)[number];

/**
 * Quote request. Identity is the canonical `reiwa_id` (`User.id`, a
 * CUID). Either `userId` (reiwa_id) or `telegramId` must be supplied —
 * the service resolves whichever is present to the canonical user, so
 * both the admin panel (userId) and the reiwa edge (userId for web /
 * web-first users, telegramId for Telegram-only flows) work against the
 * same endpoint.
 */
export class SubscriptionQuoteDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  public userId?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d+$/, { message: 'telegramId must be a valid integer string' })
  public telegramId?: string;

  @IsIn(SUBSCRIPTION_QUOTE_ACTIONS)
  public purchaseType!: SubscriptionQuoteAction;

  @IsOptional()
  @IsEnum(PurchaseChannel)
  public channel?: PurchaseChannel;

  @IsOptional()
  @IsEnum(PaymentGatewayType)
  public gatewayType?: PaymentGatewayType;

  /**
   * When set, the quote is priced in this currency directly (using the plan's
   * price row for it), bypassing gateway-currency resolution. Used by the
   * partner-balance payment flow, where the "currency" is the partner's
   * balance currency rather than a gateway's.
   */
  @IsOptional()
  @IsEnum(Currency)
  public currencyOverride?: Currency;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  public subscriptionId?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  public planId?: string;

  @IsOptional()
  @IsInt()
  @Min(-1)
  public durationDays?: number;
}
