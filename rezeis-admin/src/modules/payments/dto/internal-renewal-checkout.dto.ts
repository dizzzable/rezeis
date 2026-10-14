import { Currency, PaymentGatewayType, PurchaseChannel } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

import { RenewalDurationDto } from '../../subscriptions/dto/renewal-duration.dto';
import { RenewalPlanDto } from '../../subscriptions/dto/renewal-plan.dto';

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

  /** Optional explicit renewal-duration choices, one entry per subscription. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => RenewalDurationDto)
  public durations?: RenewalDurationDto[];

  /** Optional explicit plan choices (for plan-less subscriptions). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => RenewalPlanDto)
  public plans?: RenewalPlanDto[];

  /** Review quote pin. Optional only for rolling compatibility with an older
   * Reiwa deployment; when either field is present the service requires both
   * and compares them before creating any draft/provider checkout. */
  @IsOptional()
  @IsString()
  @Matches(/^\d+(?:\.\d{1,8})?$/, { message: 'expectedAmount must be a non-negative decimal string' })
  @MaxLength(64)
  public expectedAmount?: string;

  @IsOptional()
  @IsEnum(Currency)
  public expectedCurrency?: Currency;

  /**
   * Optional client idempotency key. A retry with the same key + composition
   * replays the existing draft; the same key with a different composition is
   * an `IDEMPOTENCY_KEY_CONFLICT`.
   */
  @IsOptional()
  @IsString()
  @MaxLength(128)
  public idempotencyKey?: string;

  /**
   * Local SavedPaymentMethod.id for off-session YooKassa charge on renewal.
   * Must belong to the same user and match `gatewayType`.
   */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  public savedPaymentMethodId?: string;

  /** Per-request YooKassa bind-card intent (interactive renew only). See checkout DTO. */
  @IsOptional()
  @IsBoolean()
  public savePaymentMethod?: boolean;

  /** Explicit consent to save the method for autopay. Required when save is true. */
  @IsOptional()
  @IsBoolean()
  public savePaymentMethodConsent?: boolean;

  /**
   * Antilopay only: how the payer signs up for «для автоматического списания»,
   * CARD or SBP. The two are different categories of recurrent payment and the
   * payer chooses before the payment form opens. Read only with
   * `savePaymentMethodConsent`, and only on Antilopay; refused there when
   * absent (`METHOD`).
   */
  @IsOptional()
  @IsIn(['CARD', 'SBP'])
  public autopayMethod?: 'CARD' | 'SBP';

  /**
   * Antilopay SBP only: the delay of the first charge the payer was SHOWN, as
   * Antilopay's own word (`DAY`, `WEEK`, `MONTH`, `QUARTER`, `YEAR`, upper-case)
   * and a count. Sent by a cabinet that declares `web.autopay-first-charge-delay`,
   * and only when the panel's list of gateways offered a delay. The checkout is
   * made with exactly that delay or refused (`DELAY_CHANGED`); a request that
   * names none is charged at activation, as it always was. A cabinet older than
   * this field never sends it, and a panel older than it would refuse the field,
   * which is why a cabinet sends it only on the panel's own word.
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(366)
  public autopayDelayCount?: number;

  @IsOptional()
  @IsIn(['DAY', 'WEEK', 'MONTH', 'QUARTER', 'YEAR'])
  public autopayDelayUnit?: 'DAY' | 'WEEK' | 'MONTH' | 'QUARTER' | 'YEAR';
}
