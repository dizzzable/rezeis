import { Currency, PaymentGatewayType, PurchaseChannel } from '@prisma/client';
import { Type } from 'class-transformer';
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
  ValidateNested,
} from 'class-validator';

import { RenewalDurationDto } from '../../subscriptions/dto/renewal-duration.dto';
import { RenewalPlanDto } from '../../subscriptions/dto/renewal-plan.dto';

/**
 * One subscription's selected renewal add-ons. `addOnIds` are eligibility-
 * checked and priced server-side; unknown/ineligible ids are rejected.
 */
export class RenewalAddOnSelectionDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  public subscriptionId!: string;

  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  public addOnIds!: string[];
}

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

  /** Optional per-subscription selected renewal add-ons (T-007). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => RenewalAddOnSelectionDto)
  public addOns?: RenewalAddOnSelectionDto[];

  /**
   * Local SavedPaymentMethod.id for off-session YooKassa charge on renewal.
   * Must belong to the same user and match `gatewayType`.
   */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  public savedPaymentMethodId?: string;
}

/**
 * Normalizes the DTO's add-on selections into a `subscriptionId → addOnIds`
 * map for the checkout service. Later entries win on duplicate subscriptionId;
 * empty selections are dropped. Returns `undefined` when nothing is selected.
 */
export function toAddOnSelectionMap(
  selections?: readonly RenewalAddOnSelectionDto[],
): ReadonlyMap<string, readonly string[]> | undefined {
  if (selections === undefined || selections.length === 0) {
    return undefined;
  }
  const map = new Map<string, readonly string[]>();
  for (const selection of selections) {
    if (selection.addOnIds.length > 0) {
      map.set(selection.subscriptionId, [...selection.addOnIds]);
    }
  }
  return map.size > 0 ? map : undefined;
}
