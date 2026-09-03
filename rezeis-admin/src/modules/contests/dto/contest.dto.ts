import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PromocodeRewardType, WheelSectorKind } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDate,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

import { LocalizedTextDto, QuestAudienceFilterDto } from '../../quests/dto/quest-payload.dto';
import { MAX_SECTOR_AMOUNT } from '../../wheel-config/dto/wheel-sector.dto';

/** Enough places for a real giveaway; more than this is a lottery, not a contest. */
export const MAX_PRIZES = 50;

/**
 * A contest description has room for the rules; a title does not.
 *
 * Both are bounded, which the bare `@IsObject()` they replaced was not: the
 * shape is copied verbatim into every winner's `prizeSnapshot`, so an
 * unbounded string here is unbounded rows on the busiest table in the
 * feature.
 */
export class LocalizedLongTextDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  public ru?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  public en?: string;
}

export class ContestPrizeDto {
  @ApiProperty({ minimum: 1, maximum: MAX_PRIZES })
  @IsInt()
  @Min(1)
  @Max(MAX_PRIZES)
  public place!: number;

  @ApiProperty({ enum: WheelSectorKind })
  @IsEnum(WheelSectorKind)
  public kind!: WheelSectorKind;

  @ApiProperty({ description: 'Локализованное название: { ru, en }.' })
  @ValidateNested()
  @Type((): typeof LocalizedTextDto => LocalizedTextDto)
  public title!: LocalizedTextDto;

  @ApiProperty({ minimum: 0, maximum: MAX_SECTOR_AMOUNT })
  @IsInt()
  @Min(0)
  @Max(MAX_SECTOR_AMOUNT)
  public amount!: number;

  @ApiPropertyOptional({ enum: PromocodeRewardType, nullable: true })
  @IsOptional()
  @IsEnum(PromocodeRewardType)
  public promoRewardType?: PromocodeRewardType | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  public promoPlanId?: string | null;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  public promoPlanIds?: string[];

  @ApiPropertyOptional({ nullable: true, minimum: 1 })
  @IsOptional()
  @Type((): NumberConstructor => Number)
  @IsInt()
  @Min(1)
  public promoLifetime?: number | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  public keyPoolId?: string | null;

  @ApiPropertyOptional({ nullable: true, maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  public manualInstructions?: string | null;
}

export class ContestDto {
  @ApiProperty({ description: 'Локализованное название: { ru, en }.' })
  @ValidateNested()
  @Type((): typeof LocalizedTextDto => LocalizedTextDto)
  public title!: LocalizedTextDto;

  @ApiPropertyOptional({ description: 'Локализованное описание: { ru, en }.' })
  @IsOptional()
  @ValidateNested()
  @Type((): typeof LocalizedLongTextDto => LocalizedLongTextDto)
  public description?: LocalizedLongTextDto;

  @ApiProperty({ type: String, format: 'date-time' })
  @Type((): DateConstructor => Date)
  @IsDate()
  public startAt!: Date;

  @ApiProperty({ type: String, format: 'date-time', description: 'Когда закрываются заявки и должен пройти розыгрыш.' })
  @Type((): DateConstructor => Date)
  @IsDate()
  public endAt!: Date;

  @ApiPropertyOptional({ nullable: true, description: 'Кто может участвовать — тот же фильтр, что у рассылок и заданий.' })
  @IsOptional()
  @ValidateNested()
  @Type((): typeof QuestAudienceFilterDto => QuestAudienceFilterDto)
  public audienceFilter?: QuestAudienceFilterDto | null;

  @ApiPropertyOptional({ nullable: true, minimum: 1, description: 'Потолок заявок. Пусто — без потолка.' })
  @IsOptional()
  @Type((): NumberConstructor => Number)
  @IsInt()
  @Min(1)
  public maxEntries?: number | null;

  @ApiProperty({ type: [ContestPrizeDto], description: 'Призы по местам: место 1 — первый приз.' })
  @IsArray()
  @ArrayMaxSize(MAX_PRIZES)
  @ValidateNested({ each: true })
  @Type((): typeof ContestPrizeDto => ContestPrizeDto)
  public prizes!: ContestPrizeDto[];
}

export class SettleContestWinnerDto {
  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  public note?: string;
}

export class RefuseContestWinnerDto {
  @ApiProperty({ minLength: 3, maxLength: 2000 })
  @IsString()
  @MinLength(3)
  @MaxLength(2000)
  public reason!: string;
}
