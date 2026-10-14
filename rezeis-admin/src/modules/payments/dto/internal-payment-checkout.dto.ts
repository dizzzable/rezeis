import { PaymentGatewayType, PurchaseChannel, PurchaseType } from '@prisma/client';
import {
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
} from 'class-validator';

const LIVE_PAYMENT_PURCHASE_TYPES: readonly PurchaseType[] = [
  PurchaseType.NEW,
  PurchaseType.RENEW,
  PurchaseType.UPGRADE,
  PurchaseType.ADDITIONAL,
] as const;

/**
 * Checkout request. Identity is the canonical `reiwa_id` (`User.id`, a
 * CUID). Either `userId` (reiwa_id) or `telegramId` must be supplied;
 * the service resolves to the canonical user so web / web-first users
 * (no Telegram) and Telegram-only users both check out through the same
 * endpoint.
 */
export class InternalPaymentCheckoutDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  public userId?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d+$/, { message: 'telegramId must be a valid integer string' })
  public telegramId?: string;

  @IsEnum(PurchaseType)
  @IsIn(LIVE_PAYMENT_PURCHASE_TYPES)
  public purchaseType!: PurchaseType;

  @IsString()
  @MinLength(1)
  @MaxLength(64)
  public planId!: string;

  @IsInt()
  @Min(-1)
  public durationDays!: number;

  @IsEnum(PaymentGatewayType)
  public gatewayType!: PaymentGatewayType;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  public subscriptionId?: string;

  @IsOptional()
  @IsEnum(PurchaseChannel)
  public channel?: PurchaseChannel;

  /** Device the user intends to use the subscription on (cosmetic hint). */
  @IsOptional()
  @IsIn(['ANDROID', 'IPHONE', 'WINDOWS', 'MAC', 'OTHER'] as readonly string[])
  public deviceType?: string;

  /**
   * URL the payment provider redirects the customer to on a successful payment.
   * Reiwa supplies a context-aware URL (web origin for browser, Telegram deep link for Mini App).
   * When not provided: the cabinet's `<cabinet>/payment-return?paymentId=...` if the panel
   * knows the cabinet's address (`ReiwaPublicLinksModule`), otherwise the panel's own
   * `${REZEIS_DOMAIN}/payments/result?paymentId=...` as before (logged once at warn).
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

  /**
   * Local SavedPaymentMethod.id owned by the user. When set for YOOKASSA,
   * checkout charges the stored `payment_method_id` off-session (no redirect
   * page unless the provider still requires 3DS confirmation).
   */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  public savedPaymentMethodId?: string;

  /**
   * Per-request YooKassa bind-card intent (interactive checkout only).
   * - `true`  → request `save_payment_method` (requires consent below)
   * - `false` → do not bind a card for this payment
   * - omit    → do not bind (fail-closed; cabinets send explicit true + consent)
   * Ignored for off-session charges (`savedPaymentMethodId` set).
   * Operators can still force-off globally via gateway `savePaymentMethod: false`.
   */
  @IsOptional()
  @IsBoolean()
  public savePaymentMethod?: boolean;

  /**
   * Explicit user consent to save the payment method for future autopay.
   * Required when `savePaymentMethod` resolves to true. Cabinets should
   * only send `true` after the user ticks the consent checkbox.
   */
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
