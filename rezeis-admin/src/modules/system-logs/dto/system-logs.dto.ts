import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class SystemLogsQueryDto {
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? Number.parseInt(value, 10) : value,
  )
  @IsInt()
  @Min(1)
  @Max(1_000)
  public limit?: number;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? Number.parseInt(value, 10) : value,
  )
  @IsInt()
  @Min(0)
  public afterId?: number;

  @IsOptional()
  @IsIn(['fatal', 'error', 'warn', 'log', 'debug', 'verbose'])
  public level?: 'fatal' | 'error' | 'warn' | 'log' | 'debug' | 'verbose';

  @IsOptional()
  @IsString()
  @MaxLength(120)
  public context?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  public search?: string;
}

export class SetLogLevelDto {
  @IsIn(['fatal', 'error', 'warn', 'log', 'debug', 'verbose'])
  public level!: 'fatal' | 'error' | 'warn' | 'log' | 'debug' | 'verbose';
}
