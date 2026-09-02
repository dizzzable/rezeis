import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { WheelSpinStatus } from '@prisma/client';

import { MANUAL_PRIZE_MAX_LIMIT } from '../services/wheel-manual-prize.service';

/** How long an operator's note may be. Long enough for a tracking number. */
export const SETTLEMENT_NOTE_MAX = 2000;

export class IssueManualPrizeDto {
  @ApiPropertyOptional({
    description: 'Заметка оператора: как именно вручён приз. Попадает в переписку с победителем.',
    maxLength: SETTLEMENT_NOTE_MAX,
  })
  @IsOptional()
  @IsString()
  @MaxLength(SETTLEMENT_NOTE_MAX)
  public note?: string;
}

export class RefuseManualPrizeDto {
  /**
   * Required, and required on purpose: a refusal the person cannot see the
   * reason for is a refusal nobody can appeal or audit. It is written into the
   * conversation as-is.
   */
  @ApiProperty({
    description: 'Причина отказа. Показывается победителю в переписке.',
    minLength: 3,
    maxLength: SETTLEMENT_NOTE_MAX,
  })
  @IsString()
  @MinLength(3)
  @MaxLength(SETTLEMENT_NOTE_MAX)
  public reason!: string;
}

export class ListManualPrizesDto {
  @ApiPropertyOptional({
    enum: WheelSpinStatus,
    description: 'Что показывать. По умолчанию — только то, что ещё должны.',
  })
  @IsOptional()
  @IsEnum(WheelSpinStatus)
  public status?: WheelSpinStatus;

  @ApiPropertyOptional({ description: 'Курсор: id последней строки предыдущей страницы.' })
  @IsOptional()
  @IsString()
  public cursor?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: MANUAL_PRIZE_MAX_LIMIT })
  @IsOptional()
  @Type((): NumberConstructor => Number)
  @IsInt()
  @Min(1)
  @Max(MANUAL_PRIZE_MAX_LIMIT)
  public limit?: number;
}
