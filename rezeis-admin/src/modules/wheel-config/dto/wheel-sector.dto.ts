import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PromocodeRewardType, WheelRarity, WheelSectorKind } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

import { LocalizedTextDto } from '../../quests/dto/quest-payload.dto';

/** A hundred thousand: room to express a one-in-ten-thousand jackpot. */
export const MAX_SECTOR_WEIGHT = 100_000;
/** `Int` in the database; the amounts here are days, GB, points or percent. */
export const MAX_SECTOR_AMOUNT = 1_000_000;

export class WheelSectorDto {
  @ApiProperty({ enum: WheelSectorKind })
  @IsEnum(WheelSectorKind)
  public kind!: WheelSectorKind;

  @ApiProperty({ description: 'Локализованное название: { ru, en }.' })
  @ValidateNested()
  @Type((): typeof LocalizedTextDto => LocalizedTextDto)
  public title!: LocalizedTextDto;

  @ApiPropertyOptional({ enum: ['PRESET', 'SVG'] })
  @IsOptional()
  @IsEnum({ PRESET: 'PRESET', SVG: 'SVG' })
  public iconKind?: 'PRESET' | 'SVG';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  public iconRef?: string;

  @ApiPropertyOptional({ enum: WheelRarity })
  @IsOptional()
  @IsEnum(WheelRarity)
  public rarity?: WheelRarity;

  /**
   * The relative weight, never a percent. The percentage the panel shows is
   * `weight / Σweight`, which is why the column always totals exactly 100 —
   * see the migration for the whole argument.
   */
  @ApiProperty({ minimum: 0, maximum: MAX_SECTOR_WEIGHT })
  @IsInt()
  @Min(0)
  @Max(MAX_SECTOR_WEIGHT)
  public weight!: number;

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

  @ApiPropertyOptional({ type: [String], description: 'Тарифы, на которых код действует. Пусто — любые.' })
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

  @ApiPropertyOptional({ nullable: true, minimum: 1, description: 'Сколько раз ОДИН человек может выиграть.' })
  @IsOptional()
  @Type((): NumberConstructor => Number)
  @IsInt()
  @Min(1)
  public maxWinsPerUser?: number | null;

  @ApiPropertyOptional({ nullable: true, minimum: 1, description: 'Сколько раз сектор может быть выигран вообще.' })
  @IsOptional()
  @Type((): NumberConstructor => Number)
  @IsInt()
  @Min(1)
  public maxWinsTotal?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  public enabled?: boolean;
}

export class ReorderSectorsDto {
  @ApiProperty({ type: [String], description: 'Все секторы ровно по одному разу, в порядке колеса.' })
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  public orderedIds!: string[];
}

export class UpdateWheelSettingsDto {
  @ApiPropertyOptional({ description: 'Общий выключатель колеса.' })
  @IsOptional()
  @IsBoolean()
  public enabled?: boolean;

  /**
   * `null` — и, намеренно, `0` — означают, что бесплатных прокрутов нет:
   * кулдаун в ноль читался бы как «бесплатный прокрут на каждый запрос».
   */
  @ApiPropertyOptional({ nullable: true, minimum: 1, description: 'Часы между бесплатными прокрутами.' })
  @IsOptional()
  @Type((): NumberConstructor => Number)
  @IsInt()
  @Min(1)
  public freeSpinCooldownHours?: number | null;

  @ApiPropertyOptional({ nullable: true, minimum: 1, description: 'Цена прокрута в баллах.' })
  @IsOptional()
  @Type((): NumberConstructor => Number)
  @IsInt()
  @Min(1)
  public spinPricePoints?: number | null;
}
