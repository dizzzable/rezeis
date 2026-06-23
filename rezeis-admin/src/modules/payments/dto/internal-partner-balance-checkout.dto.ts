import { PurchaseChannel, PurchaseType } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsEnum, IsIn, IsInt, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';

const BALANCE_PURCHASE_TYPES: readonly PurchaseType[] = [
  PurchaseType.NEW,
  PurchaseType.ADDITIONAL,
  PurchaseType.RENEW,
  PurchaseType.UPGRADE,
];

const DEVICE_TYPES = ['ANDROID', 'IPHONE', 'WINDOWS', 'MAC', 'OTHER'] as const;

/**
 * Payload for paying for a subscription with the partner balance. Identity is
 * the canonical reiwa_id (`userId`) or the Telegram id, like other internal
 * payment endpoints.
 */
export class InternalPartnerBalanceCheckoutDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  public userId?: string;

  @IsOptional()
  @IsString()
  public telegramId?: string;

  @IsEnum(PurchaseType)
  @IsIn(BALANCE_PURCHASE_TYPES)
  public purchaseType!: PurchaseType;

  @IsString()
  @MinLength(1)
  @MaxLength(64)
  public planId!: string;

  @Type((): NumberConstructor => Number)
  @IsInt()
  @Min(-1)
  public durationDays!: number;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  public subscriptionId?: string;

  @IsOptional()
  @IsEnum(PurchaseChannel)
  public channel?: PurchaseChannel;

  @IsOptional()
  @IsIn(DEVICE_TYPES as readonly string[])
  public deviceType?: string;
}
