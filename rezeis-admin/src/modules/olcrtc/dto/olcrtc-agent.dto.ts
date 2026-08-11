import {
  IsIn,
  IsInt,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class OlcrtcGatewayHeartbeatDto {
  @IsString()
  @MaxLength(96)
  public readonly name!: string;

  @IsString()
  @MaxLength(512)
  public readonly managementUrl!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  public readonly version?: string;

  @IsInt()
  @Min(0)
  @Max(100_000)
  public readonly capacity!: number;

  @IsInt()
  @Min(0)
  @Max(100_000)
  public readonly activeSessions!: number;

  @IsOptional()
  @IsObject()
  public readonly health?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  public readonly metadata?: Record<string, unknown>;
}

export class OlcrtcClaimSessionDto {
  @IsString()
  @MaxLength(96)
  public readonly gatewayName!: string;
}

export class OlcrtcSessionReportDto {
  @IsIn(['STARTING', 'ACTIVE', 'IDLE', 'FAILED', 'STOPPED'])
  public readonly status!: 'STARTING' | 'ACTIVE' | 'IDLE' | 'FAILED' | 'STOPPED';

  @IsOptional()
  @IsString()
  @MaxLength(128)
  public readonly agentSessionId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  public readonly lastError?: string;

  @IsOptional()
  @IsObject()
  public readonly metadata?: Record<string, unknown>;
}

export class OlcrtcTrafficReportDto {
  @IsString()
  @Matches(/^\d+$/u)
  public readonly rxBytes!: string;

  @IsString()
  @Matches(/^\d+$/u)
  public readonly txBytes!: string;

  @IsString()
  @MaxLength(64)
  public readonly source!: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  public readonly idempotencyKey?: string;

  @IsOptional()
  @IsISO8601()
  public readonly observedAt?: string;

  @IsOptional()
  @IsObject()
  public readonly metadata?: Record<string, unknown>;
}
