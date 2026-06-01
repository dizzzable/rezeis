import { Type } from 'class-transformer';
import { PlanAvailability, PlanType } from '@prisma/client';
import {
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

import { AdminPlanDurationDto } from './admin-plan-duration.dto';
import { TrialSettingsDto } from './create-plan.dto';
import { ArchivedPlanRenewModeValue } from '../utils/archived-plan-renew-mode.util';
import { TrafficLimitStrategyValue } from './traffic-limit-strategy.dto';

export class UpdatePlanDto {
  @IsOptional()
  @IsString()
  @MaxLength(128)
  public name?: string;

  @IsOptional()
  @ValidateIf((_object: object, value: unknown): boolean => value !== null)
  @IsString()
  @MaxLength(4096)
  public description?: string | null;

  @IsOptional()
  @ValidateIf((_object: object, value: unknown): boolean => value !== null)
  @IsString()
  @MaxLength(64)
  public tag?: string | null;

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

  @IsOptional()
  @IsEnum(PlanType)
  public type?: PlanType;

  @IsOptional()
  @IsEnum(PlanAvailability)
  public availability?: PlanAvailability;

  @IsOptional()
  @ValidateIf((_object: object, value: unknown): boolean => value !== null)
  @Type((): NumberConstructor => Number)
  @IsInt()
  @Min(1)
  public trafficLimit?: number | null;

  @IsOptional()
  @Type((): NumberConstructor => Number)
  @IsInt()
  @Min(-1)
  public deviceLimit?: number;

  @IsOptional()
  @IsEnum(TrafficLimitStrategyValue)
  public trafficLimitStrategy?: TrafficLimitStrategyValue;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  public internalSquads?: string[];

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

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type((): typeof AdminPlanDurationDto => AdminPlanDurationDto)
  public durations?: AdminPlanDurationDto[];
}
