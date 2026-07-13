import { IsString, IsOptional, IsBoolean, MaxLength } from 'class-validator';

export class UpdateAiConfigDto {
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  readonly baseUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4096)
  readonly apiKey?: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  readonly model?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  readonly modelsEndpoint?: string;

  /** Master switch for the user-facing assistant. */
  @IsOptional()
  @IsBoolean()
  readonly enabled?: boolean;

  /** Operator persona / extra instructions (bounded to keep prompt/cost sane). */
  @IsOptional()
  @IsString()
  @MaxLength(8000)
  readonly systemPrompt?: string;
}
