import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { ReferralRewardType } from '@prisma/client';

/**
 * Admin manually grants a reward to a user, attached to an existing
 * referral edge. Used for support cases ("we forgot to issue the reward
 * after the campaign") or manual top-ups.
 */
export class CreateRewardDto {
  @IsString()
  @MaxLength(64)
  public referralId!: string;

  /**
   * Either `userId` (cuid) or `userTelegramId` (numeric string) must be
   * provided. The service resolves them in this order: userId first.
   */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  public userId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  public userTelegramId?: string;

  @IsEnum(ReferralRewardType)
  public type!: ReferralRewardType;

  @IsInt()
  @Min(1)
  public amount!: number;
}
