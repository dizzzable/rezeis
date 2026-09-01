import { Type } from 'class-transformer';
import {
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNumberString,
  IsOptional,
  IsString,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { PromocodeAvailability, PromocodeRewardType } from '@prisma/client';

import { PromocodeActionDto } from './promocode-action.dto';
import { PromocodePlanSnapshotDto } from './promocode-plan-snapshot.dto';

/**
 * Partial update payload. Every field is optional so the caller can patch
 * only what it needs. The lifecycle service applies extra invariants such as
 * "SUBSCRIPTION rewardType requires a non-null plan snapshot".
 */
export class UpdatePromocodeDto {
  @IsOptional()
  @IsBoolean()
  public isActive?: boolean;

  @IsOptional()
  @IsEnum(PromocodeAvailability)
  public availability?: PromocodeAvailability;

  @IsOptional()
  @IsEnum(PromocodeRewardType)
  public rewardType?: PromocodeRewardType;

  @IsOptional()
  @IsInt()
  public reward?: number | null;

  @IsOptional()
  @ValidateNested()
  @Type((): typeof PromocodePlanSnapshotDto => PromocodePlanSnapshotDto)
  public plan?: PromocodePlanSnapshotDto | null;

  /**
   * What the code DOES, as a list — "-10% on the next purchase AND +7 days" is
   * one code now, not two with a line of copy telling the customer to enter
   * both.
   *
   * OPTIONAL, and `rewardType` / `reward` / `plan` above stay accepted: an
   * older panel still sends only those, and a request that omits actions is
   * read as one action built from them. Sending both is fine — the list wins,
   * and the legacy fields are rewritten from its first entry so anything that
   * still reads them sees something true.
   */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type((): typeof PromocodeActionDto => PromocodeActionDto)
  public actions?: PromocodeActionDto[];

  @IsOptional()
  @IsInt()
  @Min(-1)
  public lifetime?: number | null;

  /** Absolute expiry date+time (ISO 8601); `null` clears it. */
  @IsOptional()
  @ValidateIf((_, value: unknown) => value !== null)
  @IsDateString()
  public expiresAt?: string | null;

  @IsOptional()
  @IsInt()
  @Min(-1)
  public maxActivations?: number | null;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsNumberString({ no_symbols: true }, { each: true })
  public allowedTelegramIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  public allowedPlanIds?: string[];
}
