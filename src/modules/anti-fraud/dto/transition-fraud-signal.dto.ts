import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { FraudSignalStatus } from '@prisma/client';

/**
 * Body for `POST /admin/fraud/signals/:id/transition`. The note is
 * optional and stored on the row to give context to future operators.
 */
export class TransitionFraudSignalDto {
  @IsEnum(FraudSignalStatus)
  status!: FraudSignalStatus;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
