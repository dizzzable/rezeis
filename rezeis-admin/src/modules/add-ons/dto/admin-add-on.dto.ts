import { AddOnType, Currency } from '@prisma/client';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

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
  @ValidateIf((_object: object, value: unknown): boolean => value !== null)
  @IsString()
  @MaxLength(64)
  public icon?: string | null;

  @IsNumber()
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
  @ValidateIf((_object: object, value: unknown): boolean => value !== null)
  @IsString()
  @MaxLength(64)
  public icon?: string | null;

  @IsOptional()
  @IsNumber()
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
