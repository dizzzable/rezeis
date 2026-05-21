import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';
import { FraudSignalSeverity, FraudSignalStatus } from '@prisma/client';

/**
 * Query DTO for `GET /admin/fraud/signals`. Cursor pagination uses the
 * row id as a stable seek key (rows are sorted by detectedAt DESC, id
 * DESC server-side).
 */
export class ListFraudSignalsQueryDto {
  @IsOptional()
  @IsEnum(FraudSignalStatus)
  status?: FraudSignalStatus;

  @IsOptional()
  @IsEnum(FraudSignalSeverity)
  severity?: FraudSignalSeverity;

  @IsOptional()
  @IsString()
  @Length(1, 64)
  code?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @IsOptional()
  @IsString()
  @Length(1, 64)
  cursor?: string;
}
