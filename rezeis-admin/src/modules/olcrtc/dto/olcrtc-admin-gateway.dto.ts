import { IsIn, IsInt, IsObject, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export const OLCRTC_GATEWAY_STATUSES = ['ACTIVE', 'DRAINING', 'DISABLED', 'UNHEALTHY'] as const;

export class OlcrtcUpdateGatewayDto {
  @IsOptional()
  @IsString()
  @MaxLength(512)
  public readonly managementUrl?: string;

  @IsOptional()
  @IsIn(OLCRTC_GATEWAY_STATUSES)
  public readonly status?: (typeof OLCRTC_GATEWAY_STATUSES)[number];

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100_000)
  public readonly capacity?: number;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  public readonly version?: string | null;

  @IsOptional()
  @IsObject()
  public readonly health?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  public readonly metadata?: Record<string, unknown>;
}
