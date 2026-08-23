import { AddOnLifetime, AddOnType, Currency } from '@prisma/client';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * How many units this add-on adds — whole GIGABYTES for `EXTRA_TRAFFIC`, whole
 * DEVICE SLOTS for `EXTRA_DEVICES`.
 *
 * It was `@IsNumber()` with no bound, which admits a negative and a fractional
 * value, and neither is a coherent product. The bound is not cosmetic:
 *
 *  - A negative EXTRA_TRAFFIC value reaches
 *    `PaymentSubscriptionMutationService`'s legacy increment, which can land
 *    `Subscription.trafficLimit` on exactly `0`. The panel has no encoding for
 *    "zero bytes" — it decodes an upstream `0` back to `null`, canonical
 *    UNLIMITED — so a row we record as entitled to nothing receives
 *    EVERYTHING, and the projection then reports drift on every sweep forever
 *    because `null` and `0n` never compare equal. "May move no traffic" is
 *    `status: DISABLED`, which the panel can actually express.
 *  - A negative EXTRA_DEVICES value is the mirror of the legacy `0 + N`
 *    footgun: it can take a finite device cap down to `0`, which the product
 *    reads as unlimited devices.
 *  - A fractional value cannot be converted with `BigInt()` at all — the ledger
 *    path would throw a raw `RangeError` inside a money transaction.
 *
 * `readRenewalAddOnLines` in `payment-subscription-mutation.service.ts` already
 * enforces exactly `Number.isInteger(value) && value > 0` on persisted renewal
 * lines; this is the same contract at the point where the product is authored.
 */
const ADD_ON_VALUE_MIN = 1;

export class AddOnPriceDto {
  @IsEnum(Currency)
  public currency!: Currency;

  @IsString()
  @MaxLength(64)
  public price!: string;
}

export class AdminAddOnCreateDto {
  @IsString()
  @MaxLength(255)
  public name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  public description?: string | null;

  @IsEnum(AddOnType)
  public type!: AddOnType;

  @IsOptional()
  @IsEnum(AddOnLifetime)
  public lifetime?: AddOnLifetime;

  @IsOptional()
  @ValidateIf((_object: object, value: unknown): boolean => value !== null)
  @IsString()
  @MaxLength(64)
  public icon?: string | null;

  /** Whole, positive units. See {@link ADD_ON_VALUE_MIN}. */
  @IsInt()
  @Min(ADD_ON_VALUE_MIN)
  public value!: number;

  @IsOptional()
  @IsBoolean()
  public isActive?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  public applicablePlanIds?: string[];

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(64)
  @ValidateNested({ each: true })
  @Type(() => AddOnPriceDto)
  public prices!: AddOnPriceDto[];
}

export class AdminAddOnUpdateDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  public name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  public description?: string | null;

  @IsOptional()
  @IsEnum(AddOnType)
  public type?: AddOnType;

  @IsOptional()
  @IsEnum(AddOnLifetime)
  public lifetime?: AddOnLifetime;

  @IsOptional()
  @ValidateIf((_object: object, value: unknown): boolean => value !== null)
  @IsString()
  @MaxLength(64)
  public icon?: string | null;

  /** Whole, positive units. See {@link ADD_ON_VALUE_MIN}. */
  @IsOptional()
  @IsInt()
  @Min(ADD_ON_VALUE_MIN)
  public value?: number;

  @IsOptional()
  @IsBoolean()
  public isActive?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  public applicablePlanIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(64)
  @ValidateNested({ each: true })
  @Type(() => AddOnPriceDto)
  public prices?: AddOnPriceDto[];
}
