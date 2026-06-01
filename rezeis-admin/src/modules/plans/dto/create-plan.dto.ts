import { Transform, Type } from 'class-transformer';
import { PlanAvailability, PlanType } from '@prisma/client';
import {
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

import { AdminPlanDurationDto } from './admin-plan-duration.dto';
import { ArchivedPlanRenewModeValue } from '../utils/archived-plan-renew-mode.util';
import { TrafficLimitStrategyValue } from './traffic-limit-strategy.dto';

function trimString(value: unknown): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

/**
 * Trial-plan tunables (only meaningful when `availability = TRIAL`).
 */
export class TrialSettingsDto {
  @IsOptional()
  @Type((): NumberConstructor => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  public maxClaims?: number;

  @IsOptional()
  @IsBoolean()
  public free?: boolean;

  @IsOptional()
  @IsIn(['ALL', 'INVITED'])
  public availabilityScope?: 'ALL' | 'INVITED';
}

export class CreatePlanDto {
  @Transform(({ value }: { readonly value: unknown }): unknown => trimString(value))
  @IsString()
  @MaxLength(128)
  public name!: string;

  @Transform(({ value }: { readonly value: unknown }): unknown => trimString(value))
  @IsOptional()
  @ValidateIf((_object: object, value: unknown): boolean => value !== null)
  @IsString()
  @MaxLength(4096)
  public description?: string | null;

  @Transform(({ value }: { readonly value: unknown }): unknown => trimString(value))
  @IsOptional()
  @ValidateIf((_object: object, value: unknown): boolean => value !== null)
  @IsString()
  @MaxLength(64)
  public tag?: string | null;

  @Transform(({ value }: { readonly value: unknown }): unknown => trimString(value))
  @IsOptional()
  @ValidateIf((_object: object, value: unknown): boolean => value !== null)
  @IsString()
  @MaxLength(64)
  public icon?: string | null;

  @IsOptional()
  @IsBoolean()
  public isActive?: boolean;

  @IsOptional()
  @IsBoolean()
  public isArchived?: boolean;

  @IsOptional()
  @IsEnum(ArchivedPlanRenewModeValue)
  public archivedRenewMode?: ArchivedPlanRenewModeValue;

  @IsEnum(PlanType)
  public type!: PlanType;

  @IsEnum(PlanAvailability)
  public availability!: PlanAvailability;

  @IsOptional()
  @ValidateIf((_object: object, value: unknown): boolean => value !== null)
  @Type((): NumberConstructor => Number)
  @IsInt()
  @Min(1)
  public trafficLimit?: number | null;

  @Type((): NumberConstructor => Number)
  @IsInt()
  @Min(-1)
  public deviceLimit!: number;

  @IsOptional()
  @IsEnum(TrafficLimitStrategyValue)
  public trafficLimitStrategy?: TrafficLimitStrategyValue;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  public internalSquads?: string[];

  @Transform(({ value }: { readonly value: unknown }): unknown => trimString(value))
  @IsOptional()
  @ValidateIf((_object: object, value: unknown): boolean => value !== null)
  @IsString()
  @MaxLength(128)
  public externalSquad?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  public upgradeToPlanIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  public replacementPlanIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  public allowedUserIds?: string[];

  @IsOptional()
  @ValidateNested()
  @Type((): typeof TrialSettingsDto => TrialSettingsDto)
  public trialSettings?: TrialSettingsDto;

  @IsArray()
  @ValidateNested({ each: true })
  @Type((): typeof AdminPlanDurationDto => AdminPlanDurationDto)
  public durations!: AdminPlanDurationDto[];
}
