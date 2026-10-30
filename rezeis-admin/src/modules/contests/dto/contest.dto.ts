import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ContestKind, ContestMetric, ContestPrizeDelivery, PromocodeRewardType, WheelSectorKind } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
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
import { MAX_PLACES } from '../services/contest.service';

/** Enough prizes for a real giveaway; more than this is a lottery, not a contest. A range is one prize. */
export const MAX_PRIZES = 50;

/** The largest public leaderboard. */
export const MAX_LEADERBOARD_SIZE = 100;

/** A threshold beyond any real score — a petabyte, ten trillion roubles in kopecks. */
export const MAX_MIN_SCORE = 1_000_000_000_000_000;

/** Extra tickets one purchase or one friend can bring. */
export const MAX_TICKETS_PER_ACTION = 100;

/** The highest ceiling an operator may set on one person's tickets. */
export const MAX_TICKETS_PER_USER = 10_000;

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
  @ApiProperty({ minimum: 1, maximum: MAX_PLACES })
  @IsInt()
  @Min(1)
  @Max(MAX_PLACES)
  public place!: number;

  @ApiPropertyOptional({ nullable: true, minimum: 1, maximum: MAX_PLACES, description: 'Последнее место, которое получает этот приз: «4–10 место». Пусто — одно место.' })
  @IsOptional()
  @Type((): NumberConstructor => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PLACES)
  public placeTo?: number | null;

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

  @ApiPropertyOptional({ description: 'Сообщить о конкурсе тем, кто может участвовать, когда он начнётся.' })
  @IsOptional()
  @IsBoolean()
  public announce?: boolean;

  @ApiPropertyOptional({ description: 'Напомнить за сутки до конца: розыгрыш — тем, кто ещё не участвует; рейтинг — призёрам и тем, кто рядом.' })
  @IsOptional()
  @IsBoolean()
  public remind?: boolean;

  @ApiPropertyOptional({ minimum: 0, maximum: MAX_TICKETS_PER_ACTION, description: 'Доп. билетов за каждую оплату в период конкурса. 0 — выключено.' })
  @IsOptional()
  @Type((): NumberConstructor => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_TICKETS_PER_ACTION)
  public ticketsPerPurchase?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: MAX_TICKETS_PER_ACTION, description: 'Доп. билетов за каждого приглашённого, оплатившего в период конкурса. 0 — выключено.' })
  @IsOptional()
  @Type((): NumberConstructor => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_TICKETS_PER_ACTION)
  public ticketsPerReferral?: number;

  @ApiPropertyOptional({ nullable: true, minimum: 1, maximum: MAX_TICKETS_PER_USER, description: 'Потолок билетов на человека, включая билет за участие. Пусто — без потолка.' })
  @IsOptional()
  @Type((): NumberConstructor => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_TICKETS_PER_USER)
  public maxTicketsPerUser?: number | null;

  @ApiPropertyOptional({ nullable: true, maxLength: 200, description: 'Канал, подписка на который нужна для участия: https://t.me/… (публичный или приглашение).' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  public channelLink?: string | null;

  @ApiPropertyOptional({ nullable: true, maxLength: 40, description: 'ID канала (-100…). Обязателен для закрытого канала: по ссылке-приглашению подписку не проверить.' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  public channelId?: string | null;

  @ApiPropertyOptional({ enum: ContestKind, default: ContestKind.DRAW, description: 'Розыгрыш среди участников или рейтинг по показателю.' })
  @IsOptional()
  @IsEnum(ContestKind)
  public kind?: ContestKind;

  @ApiPropertyOptional({ enum: ContestMetric, nullable: true, description: 'По чему считать места рейтинга.' })
  @IsOptional()
  @IsEnum(ContestMetric)
  public metric?: ContestMetric | null;

  @ApiPropertyOptional({ nullable: true, minimum: 0, maximum: MAX_MIN_SCORE, description: 'Наименьший результат, с которым дают место: друзья, копейки базовой валюты, байты, баллы.' })
  @IsOptional()
  @Type((): NumberConstructor => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_MIN_SCORE)
  public minScore?: number | null;

  @ApiPropertyOptional({ minimum: 3, maximum: MAX_LEADERBOARD_SIZE, default: 10, description: 'Сколько мест показывать в таблице рейтинга.' })
  @IsOptional()
  @Type((): NumberConstructor => Number)
  @IsInt()
  @Min(3)
  @Max(MAX_LEADERBOARD_SIZE)
  public leaderboardSize?: number;

  @ApiPropertyOptional({ enum: ContestPrizeDelivery, default: ContestPrizeDelivery.AUTO, description: 'Сразу, после проверки оператором или через поддержку.' })
  @IsOptional()
  @IsEnum(ContestPrizeDelivery)
  public prizeDelivery?: ContestPrizeDelivery;

  @ApiPropertyOptional({ description: 'Когда закончится — начать такой же на следующий месяц.' })
  @IsOptional()
  @IsBoolean()
  public repeatMonthly?: boolean;

  @ApiProperty({ type: [ContestPrizeDto], description: 'Призы по местам: место 1 — первый приз.' })
  @IsArray()
  @ArrayMaxSize(MAX_PRIZES)
  @ValidateNested({ each: true })
  @Type((): typeof ContestPrizeDto => ContestPrizeDto)
  public prizes!: ContestPrizeDto[];
}

export class ContestAudienceCountDto {
  @ApiPropertyOptional({ nullable: true, description: 'Тот же фильтр, что у конкурса. Пусто — все, кроме заблокированных.' })
  @IsOptional()
  @ValidateNested()
  @Type((): typeof QuestAudienceFilterDto => QuestAudienceFilterDto)
  public audienceFilter?: QuestAudienceFilterDto | null;
}

export class ListContestEntrantsDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 200, default: 50 })
  @IsOptional()
  @Type((): NumberConstructor => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  public take?: number;

  @ApiPropertyOptional({ minimum: 0, default: 0 })
  @IsOptional()
  @Type((): NumberConstructor => Number)
  @IsInt()
  @Min(0)
  public skip?: number;
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
