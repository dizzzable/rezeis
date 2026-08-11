import { IsIn, IsISO8601, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';

export const OLCRTC_ADMIN_SESSION_STATUSES = [
  'PROVISIONING',
  'PENDING_AGENT',
  'STARTING',
  'ACTIVE',
  'IDLE',
  'STOPPING',
  'STOPPED',
  'FAILED',
  'EXPIRED',
] as const;

export class OlcrtcUpdateSessionDto {
  @IsOptional()
  @IsIn(OLCRTC_ADMIN_SESSION_STATUSES)
  public readonly status?: (typeof OLCRTC_ADMIN_SESSION_STATUSES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  public readonly lastError?: string | null;

  @IsOptional()
  @IsISO8601()
  public readonly expiresAt?: string | null;

  @IsOptional()
  @IsISO8601()
  public readonly stoppedAt?: string | null;

  @IsOptional()
  @IsObject()
  public readonly metadata?: Record<string, unknown>;
}
