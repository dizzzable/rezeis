import { Currency, PaymentGatewayType, PurchaseChannel, PurchaseType, TariffConstructorModuleType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsIn,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class TariffConstructorDurationDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  public days!: number;

  @IsEnum(Currency)
  public currency!: Currency;

  @IsString()
  @Matches(/^\d+(?:\.\d{1,8})?$/)
  public baseAmount!: string;
}

export class TariffConstructorPriceDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  public days!: number;

  @IsEnum(Currency)
  public currency!: Currency;

  @IsString()
  @Matches(/^\d+(?:\.\d{1,8})?$/)
  public perStepAmount!: string;
}

export class TariffConstructorModuleDto {
  @IsEnum(TariffConstructorModuleType)
  public type!: TariffConstructorModuleType;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  public minValue!: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  public maxValue!: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  public defaultValue!: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  public step!: number;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => TariffConstructorPriceDto)
  public prices!: TariffConstructorPriceDto[];
}

export class SaveTariffConstructorDraftDto {
  @IsString()
  public basePlanId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => TariffConstructorDurationDto)
  public durations!: TariffConstructorDurationDto[];

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => TariffConstructorModuleDto)
  public modules!: TariffConstructorModuleDto[];
}

export class ToggleTariffConstructorDto {
  @IsBoolean()
  public enabled!: boolean;
}

export class TariffConstructorSelectionDto {
  @IsEnum(TariffConstructorModuleType)
  public type!: TariffConstructorModuleType;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  public value!: number;
}

export class QuoteTariffConstructorDto {
  @IsString()
  public revisionId!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  public durationDays!: number;

  @IsEnum(Currency)
  public currency!: Currency;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TariffConstructorSelectionDto)
  public selections!: TariffConstructorSelectionDto[];
}

const CONSTRUCTOR_PURCHASE_TYPES = [PurchaseType.NEW, PurchaseType.ADDITIONAL] as const;
const CONSTRUCTOR_CHANNELS = [PurchaseChannel.WEB, PurchaseChannel.TELEGRAM] as const;

export class CheckoutTariffConstructorDto extends QuoteTariffConstructorDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(64)
  public userId?: string;

  @IsOptional() @IsString() @Matches(/^\d+$/)
  public telegramId?: string;

  @IsEnum(PurchaseType) @IsIn(CONSTRUCTOR_PURCHASE_TYPES)
  public purchaseType!: 'NEW' | 'ADDITIONAL';

  @IsEnum(PaymentGatewayType)
  public gatewayType!: PaymentGatewayType;

  @IsEnum(PurchaseChannel) @IsIn(CONSTRUCTOR_CHANNELS)
  public channel!: 'WEB' | 'TELEGRAM';

  @IsString() @MinLength(1) @MaxLength(128)
  public idempotencyKey!: string;

  @IsString() @Matches(/^\d+(?:\.\d{1,8})?$/)
  public expectedAmount!: string;

  @IsEnum(Currency)
  public expectedCurrency!: Currency;

  @IsOptional() @IsString() @IsUrl({ require_protocol: true, protocols: ['http', 'https'] }) @MaxLength(2048)
  public successUrl?: string;

  @IsOptional() @IsString() @IsUrl({ require_protocol: true, protocols: ['http', 'https'] }) @MaxLength(2048)
  public failUrl?: string;

  @IsOptional() @IsString() @MinLength(1) @MaxLength(64)
  public savedPaymentMethodId?: string;

  @IsOptional() @IsBoolean()
  public savePaymentMethod?: boolean;

  @IsOptional() @IsBoolean()
  public savePaymentMethodConsent?: boolean;
}
