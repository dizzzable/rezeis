import { Currency, TariffConstructorModuleType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsString,
  Matches,
  Min,
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
  @Min(0)
  public minValue!: number;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  public maxValue!: number;

  @Type(() => Number)
  @IsInt()
  @Min(0)
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
  @Min(0)
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
