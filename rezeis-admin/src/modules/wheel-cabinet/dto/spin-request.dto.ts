import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

import { HISTORY_MAX_LIMIT, MAX_SPINS_PER_PURCHASE } from '../services/wheel-cabinet.service';

export class SpinRequestDto {
  /**
   * The client's own handle for THIS spin.
   *
   * Required, and required of the client rather than generated here: a handle
   * the server invents is a new one on every retry, which is exactly the case
   * it exists to survive. A double tap or a reconnect carries the same value
   * and is answered with the spin it already has.
   */
  @ApiProperty({ description: 'Ключ идемпотентности запроса (uuid клиента).', maxLength: 100 })
  @IsString()
  @MinLength(8)
  @MaxLength(100)
  public idempotencyKey!: string;
}

export class BuySpinsDto {
  @ApiProperty({ minimum: 1, maximum: MAX_SPINS_PER_PURCHASE })
  @Type((): NumberConstructor => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_SPINS_PER_PURCHASE)
  public count!: number;

  @ApiProperty({ description: 'Ключ идемпотентности покупки.', maxLength: 100 })
  @IsString()
  @MinLength(8)
  @MaxLength(100)
  public idempotencyKey!: string;
}

export class SpinHistoryDto {
  @ApiPropertyOptional({ description: 'Курсор: id последней строки предыдущей страницы.' })
  @IsOptional()
  @IsString()
  public cursor?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: HISTORY_MAX_LIMIT })
  @IsOptional()
  @Type((): NumberConstructor => Number)
  @IsInt()
  @Min(1)
  @Max(HISTORY_MAX_LIMIT)
  public limit?: number;
}
