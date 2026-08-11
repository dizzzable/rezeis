import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class OlcrtcAdminTrafficQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(128)
  public readonly sessionId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  public readonly take?: number;
}
