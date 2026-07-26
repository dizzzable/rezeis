import { Type } from 'class-transformer';
import {
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateReferralInviteDto {
  @IsString()
  public inviterId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(280)
  public note?: string;

  /**
   * Explicit `null` means "never expires" and is honoured as-is. Only an
   * ABSENT field falls back to the default TTL window — the internal path
   * passes `null` when link-TTL is disabled or the inviter holds the VIP
   * bypass, and silently defaulting there would have re-imposed a 30-day
   * expiry on links that are supposed to be permanent.
   */
  @IsOptional()
  @IsISO8601()
  public expiresAt?: string | null;

  /**
   * Convenience for callers that prefer to specify a TTL instead of an ISO
   * timestamp. When both `expiresAt` and `expiresInDays` are provided the
   * explicit `expiresAt` wins.
   */
  @IsOptional()
  @Type((): NumberConstructor => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  public expiresInDays?: number;
}
