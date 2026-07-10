import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  QuestDaysFallback,
  QuestIconKind,
  QuestRepeat,
  QuestRewardType,
  QuestType,
} from '@prisma/client';

export class LocalizedTextDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  public ru?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  public en?: string;
}

/** Reuses the broadcast audience-filter shape (validated leniently). */
export class QuestAudienceFilterDto {
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  public subscription?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  public planIds?: string[];

  @IsOptional()
  @IsInt()
  @Min(1)
  public inactiveDays?: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  public platforms?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  public contact?: string[];
}

export class CreateQuestDto {
  @IsEnum(QuestType)
  public type!: QuestType;

  @ValidateNested()
  @Type((): typeof LocalizedTextDto => LocalizedTextDto)
  public title!: LocalizedTextDto;

  @IsOptional()
  @ValidateNested()
  @Type((): typeof LocalizedTextDto => LocalizedTextDto)
  public description?: LocalizedTextDto;

  @IsOptional()
  @IsEnum(QuestIconKind)
  public iconKind?: QuestIconKind;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  public iconRef?: string;

  @IsEnum(QuestRewardType)
  public rewardType!: QuestRewardType;

  @IsOptional()
  @IsInt()
  @Min(0)
  public rewardAmount?: number;

  @IsOptional()
  @IsString()
  public rewardPlanId?: string | null;

  @IsOptional()
  @IsEnum(QuestDaysFallback)
  public daysFallback?: QuestDaysFallback;

  @IsOptional()
  @ValidateNested()
  @Type((): typeof QuestAudienceFilterDto => QuestAudienceFilterDto)
  public audienceFilter?: QuestAudienceFilterDto | null;

  @IsOptional()
  @IsEnum(QuestRepeat)
  public repeat?: QuestRepeat;

  @IsOptional()
  @IsInt()
  @Min(1)
  public cooldownHours?: number | null;

  @IsOptional()
  @IsString()
  public startAt?: string | null;

  @IsOptional()
  @IsString()
  public endAt?: string | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  public maxCompletionsGlobal?: number | null;

  @IsOptional()
  @IsObject()
  public params?: Record<string, unknown> | null;

  @IsOptional()
  @IsInt()
  public order?: number;

  @IsOptional()
  @IsBoolean()
  public enabled?: boolean;
}

/** Every field optional — a partial patch of a draft quest. */
export class UpdateQuestDto {
  @IsOptional()
  @IsEnum(QuestType)
  public type?: QuestType;

  @IsOptional()
  @ValidateNested()
  @Type((): typeof LocalizedTextDto => LocalizedTextDto)
  public title?: LocalizedTextDto;

  @IsOptional()
  @ValidateNested()
  @Type((): typeof LocalizedTextDto => LocalizedTextDto)
  public description?: LocalizedTextDto;

  @IsOptional()
  @IsEnum(QuestIconKind)
  public iconKind?: QuestIconKind;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  public iconRef?: string;

  @IsOptional()
  @IsEnum(QuestRewardType)
  public rewardType?: QuestRewardType;

  @IsOptional()
  @IsInt()
  @Min(0)
  public rewardAmount?: number;

  @IsOptional()
  @IsString()
  public rewardPlanId?: string | null;

  @IsOptional()
  @IsEnum(QuestDaysFallback)
  public daysFallback?: QuestDaysFallback;

  @IsOptional()
  @ValidateNested()
  @Type((): typeof QuestAudienceFilterDto => QuestAudienceFilterDto)
  public audienceFilter?: QuestAudienceFilterDto | null;

  @IsOptional()
  @IsEnum(QuestRepeat)
  public repeat?: QuestRepeat;

  @IsOptional()
  @IsInt()
  @Min(1)
  public cooldownHours?: number | null;

  @IsOptional()
  @IsString()
  public startAt?: string | null;

  @IsOptional()
  @IsString()
  public endAt?: string | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  public maxCompletionsGlobal?: number | null;

  @IsOptional()
  @IsObject()
  public params?: Record<string, unknown> | null;

  @IsOptional()
  @IsInt()
  public order?: number;

  @IsOptional()
  @IsBoolean()
  public enabled?: boolean;
}

export class ReorderQuestsDto {
  @IsArray()
  @IsString({ each: true })
  public orderedIds!: string[];
}
