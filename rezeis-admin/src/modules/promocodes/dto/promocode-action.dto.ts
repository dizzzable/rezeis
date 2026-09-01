import { Type } from 'class-transformer';
import {
  ArrayUnique,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { PromocodeRewardType } from '@prisma/client';

import { MAX_DISCOUNT_PERCENT } from '../../../common/utils/discount.util';
import { PromocodePlanSnapshotDto } from './promocode-plan-snapshot.dto';

/**
 * One thing a promocode does.
 *
 * ── Why `allowedPlanIds` lives here as well as on the promocode ───────────
 *
 * They answer different questions at different moments, and conflating them is
 * the reason "-20%, but only on the six-month plan" could not be expressed:
 *
 *  - `CreatePromocodeDto.allowedPlanIds` is a CONDITION — which existing
 *    subscription the code may be activated against, checked when the customer
 *    enters the code.
 *  - `allowedPlanIds` HERE travels with the granted discount and is checked
 *    again at the checkout it is finally spent at, which may be weeks later and
 *    on an entirely different plan.
 *
 * Only `PURCHASE_DISCOUNT` reads it. The panel prefills it from the condition
 * so the ordinary case needs no extra thought, and lets it be narrowed.
 */
export class PromocodeActionDto {
  @IsEnum(PromocodeRewardType)
  public type!: PromocodeRewardType;

  /**
   * Days / GB / device slots / percent, exactly as the single `reward` was
   * read. `null` only for SUBSCRIPTION, which carries its plan instead.
   *
   * The upper bound is NOT enforced here: a percentage is bounded by the
   * shared ceiling on the way in and again on the way out, and a days or GB
   * value has no ceiling. Rejecting 200 days because a discount cannot be 200
   * percent is the kind of shared validation that reads as a bug.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  public value?: number | null;

  /** SUBSCRIPTION only: the plan this action grants. */
  @IsOptional()
  @ValidateNested()
  @Type((): typeof PromocodePlanSnapshotDto => PromocodePlanSnapshotDto)
  public plan?: PromocodePlanSnapshotDto | null;

  /** PURCHASE_DISCOUNT only: plans the GRANTED discount may be spent on. */
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  public discountAllowedPlanIds?: string[];

  /**
   * PURCHASE_DISCOUNT only: how long the grant stays spendable. Omitted or
   * `null` means it does not expire on its own — which is how the single
   * `user.purchaseDiscount` always behaved.
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3650)
  public discountValidForDays?: number | null;
}

/** Shared so the DTO and the panel agree on the ceiling. */
export const PROMOCODE_MAX_DISCOUNT_PERCENT = MAX_DISCOUNT_PERCENT;
