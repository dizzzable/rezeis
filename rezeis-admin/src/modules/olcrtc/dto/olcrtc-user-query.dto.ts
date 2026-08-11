import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class OlcrtcUserQueryDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  public readonly userId?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d+$/, { message: 'telegramId must be a valid integer string' })
  public readonly telegramId?: string;
}
