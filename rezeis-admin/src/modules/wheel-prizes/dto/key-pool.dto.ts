import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { KEY_LOAD_MAX, KEY_PAGE_MAX_LIMIT } from '../services/wheel-key-pool.service';

export class CreateKeyPoolDto {
  @ApiProperty({ description: 'Как оператор называет пул.', maxLength: 200 })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  public name!: string;

  @ApiPropertyOptional({ description: 'Для чего эти ключи, своими словами.', maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  public note?: string;
}

export class UpdateKeyPoolDto {
  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  public name?: string;

  @ApiPropertyOptional({ maxLength: 1000, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  public note?: string;
}

export class LoadKeysDto {
  /**
   * The pasted batch, one key per entry. The panel splits a textarea on
   * newlines; the server trims and drops blanks but never changes case — a
   * key is case-sensitive, and "helpfully" upper-casing one ruins it.
   */
  @ApiProperty({
    description: 'Ключи, по одному в строке.',
    type: [String],
    maxItems: KEY_LOAD_MAX,
  })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(KEY_LOAD_MAX)
  @IsString({ each: true })
  public values!: string[];
}

export class ListKeysDto {
  @ApiPropertyOptional({
    description: 'true — только выданные, false — только свободные, пусто — все.',
  })
  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  public claimed?: boolean;

  @ApiPropertyOptional({ description: 'Курсор: id последней строки предыдущей страницы.' })
  @IsOptional()
  @IsString()
  public cursor?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: KEY_PAGE_MAX_LIMIT })
  @IsOptional()
  @Type((): NumberConstructor => Number)
  @IsInt()
  @Min(1)
  @Max(KEY_PAGE_MAX_LIMIT)
  public limit?: number;

  /**
   * Ask for the real values. Honoured only for a caller holding
   * `wheel:view_secrets`; everybody else gets them masked whatever they ask.
   *
   * Opt-in rather than the default, so the list an operator opens to check a
   * count does not put fifty redeemable keys on screen.
   */
  @ApiPropertyOptional({ description: 'Показать ключи целиком (нужно право wheel:view_secrets).' })
  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  public reveal?: boolean;
}
