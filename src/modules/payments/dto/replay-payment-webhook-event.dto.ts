import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class ReplayPaymentWebhookEventDto {
  @IsString()
  @MinLength(3)
  @MaxLength(512)
  public reason!: string;

  @IsOptional()
  @Type((): BooleanConstructor => Boolean)
  @IsBoolean()
  public force?: boolean;
}
