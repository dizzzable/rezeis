import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

/**
 * Self-service subscription deletion requested by the owning user through the
 * reiwa edge. Identity is the canonical `reiwa_id` (`userId`) or a
 * `telegramId`; `subscriptionId` is the subscription to delete. Ownership is
 * enforced server-side before any mutation.
 */
export class InternalSubscriptionDeleteDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  public userId?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d+$/, { message: 'telegramId must be a valid integer string' })
  public telegramId?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(64)
  public subscriptionId!: string;
}
