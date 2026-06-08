import { PaymentGatewayType, PurchaseChannel } from '@prisma/client';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Creates one combined provider checkout that renews several subscriptions.
 * Each id in `subscriptionIds` renews on its original (or replacement) plan
 * for its original duration; the provider is charged the summed total.
 */
export class InternalRenewalCheckoutDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  public userId?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d+$/, { message: 'telegramId must be a valid integer string' })
  public telegramId?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  public subscriptionIds!: string[];

  @IsEnum(PaymentGatewayType)
  public gatewayType!: PaymentGatewayType;

  @IsOptional()
  @IsEnum(PurchaseChannel)
  public channel?: PurchaseChannel;

  /**
   * URL the provider redirects to on success. Reiwa supplies a
   * context-aware URL (web origin for browser, Telegram deep link for the
   * Mini App). Falls back to the rezeis default when omitted.
   */
  @IsOptional()
  @IsString()
  @IsUrl({ require_protocol: true, protocols: ['http', 'https', 'tg', 'tgapp'] })
  @MaxLength(2048)
  public successUrl?: string;

  @IsOptional()
  @IsString()
  @IsUrl({ require_protocol: true, protocols: ['http', 'https', 'tg', 'tgapp'] })
  @MaxLength(2048)
  public failUrl?: string;
}
