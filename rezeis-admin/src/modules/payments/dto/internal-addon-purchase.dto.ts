import { PaymentGatewayType, PurchaseChannel } from '@prisma/client';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Add-on purchase checkout request (reiwa user edge → rezeis).
 *
 * `addOnId` selects the extra-traffic / extra-devices product,
 * `subscriptionId` is the active subscription to top up. Pricing is
 * resolved from the gateway's currency upstream.
 */
export class InternalAddOnPurchaseDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  public userId?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d+$/, { message: 'telegramId must be a valid integer string' })
  public telegramId?: string;

  @IsString()
  @MaxLength(64)
  public addOnId!: string;

  @IsString()
  @MaxLength(64)
  public subscriptionId!: string;

  @IsEnum(PaymentGatewayType)
  public gatewayType!: PaymentGatewayType;

  /**
   * Contract version. Absent/1 = legacy keyless behaviour; 2 = the client
   * sends an idempotency key and may pin the expected add-on revision.
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  public contractVersion?: number;

  /**
   * Client-generated idempotency key for this logical checkout attempt. A
   * repeat with the same key + same composition returns the same draft.
   */
  @IsOptional()
  @IsString()
  @MaxLength(128)
  public idempotencyKey?: string;

  /**
   * Optional optimistic concurrency guard: the catalog revision the client
   * believes it is buying. A mismatch is rejected so a repriced add-on is
   * never silently sold at a stale composition.
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  public expectedAddOnRevision?: number;

  @IsOptional()
  @IsEnum(PurchaseChannel)
  public channel?: PurchaseChannel;

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
