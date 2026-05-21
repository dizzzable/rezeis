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

  @IsOptional()
  @IsISO8601()
  public expiresAt?: string;

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
