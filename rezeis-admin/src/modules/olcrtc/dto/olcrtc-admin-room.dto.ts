import { IsIn, IsISO8601, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';

export const OLCRTC_ROOM_STATUSES = [
  'CREATING',
  'READY',
  'IN_USE',
  'EXPIRED',
  'INVALID',
  'DELETING',
  'DELETED',
] as const;

export class OlcrtcUpdateRoomDto {
  @IsOptional()
  @IsIn(OLCRTC_ROOM_STATUSES)
  public readonly status?: (typeof OLCRTC_ROOM_STATUSES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(128)
  public readonly leaseSessionId?: string | null;

  @IsOptional()
  @IsISO8601()
  public readonly expiresAt?: string | null;

  @IsOptional()
  @IsISO8601()
  public readonly lastVerifiedAt?: string | null;

  @IsOptional()
  @IsObject()
  public readonly metadata?: Record<string, unknown>;
}
