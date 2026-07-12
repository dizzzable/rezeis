import { IsString, IsOptional } from 'class-validator';

export class UpdateAiConfigDto {
  @IsOptional()
  @IsString()
  readonly baseUrl?: string;

  @IsOptional()
  @IsString()
  readonly apiKey?: string;

  @IsOptional()
  @IsString()
  readonly model?: string;

  @IsOptional()
  @IsString()
  readonly modelsEndpoint?: string;
}
