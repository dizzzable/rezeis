import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

/**
 * A bundle is at least two plans by definition — one plan is not a merge, it is
 * just the plan's own subscription URL, and a bundle of one would mint a token
 * for nothing.
 */
export const PLAN_BUNDLE_MIN_PLANS = 2;

/**
 * ...and at most two (the owner, 14.11.2026). Two plans are two halves of one
 * merged link: the card's main row and the «Трафик доп.» row, both of which the
 * bot already captions by itself. Every extra plan would demand a caption of its
 * own and a third row nobody designed, and a plan that is itself a merged
 * tariff would carry no config of its own (its squads and limits belong to the
 * other bundle). One limit, one refusal, no invented copy.
 */
export const PLAN_BUNDLE_MAX_PLANS = 2;

/**
 * The device limit of the merged subscription. The same convention as the plan
 * editor's field: `0` means unlimited (`remnawave`'s own `hwidDeviceLimit: 0`),
 * and the upper bound is a sanity cap, not a panel rule.
 */
export const PLAN_BUNDLE_DEVICE_LIMIT_MAX = 10_000;

/**
 * One member plan's own caption for its «Трафик доп.» line — the operator's
 * words instead of the bot's default `profile.traffic_extra` text.
 *
 * `label` may be empty: an empty string clears the caption back to that default,
 * which is also what an absent entry means. 60 characters is the same order as
 * the other one-line captions the bot prints (`profile.traffic` and friends).
 */
export class AdminPlanBundleMemberTrafficLabelDto {
  @IsString()
  @MaxLength(64)
  public planId!: string;

  @IsString()
  @MaxLength(60)
  public label!: string;
}

export class AdminPlanBundleCreateDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  public name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  public description?: string | null;

  @IsOptional()
  @IsBoolean()
  public isActive?: boolean;

  @IsArray()
  @ArrayMinSize(PLAN_BUNDLE_MIN_PLANS)
  @ArrayMaxSize(PLAN_BUNDLE_MAX_PLANS)
  @ArrayUnique()
  @IsString({ each: true })
  public planIds!: string[];

  /**
   * The plan whose name, limits and expiry the app shows on the merged link.
   * Must be one of `planIds` AND have a traffic limit — an unlimited plan can
   * never face the app. Omitted = the bundle's own default (its first limited
   * plan), decided when the grouping is read.
   */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  public visiblePlanId?: string | null;

  /**
   * Device limit for the merged subscription — set here because it is ONE
   * product: both member profiles get it, and an existing customer who holds
   * two of the bundle's plans has both profiles updated. Omitted on create =
   * the visible member plan's own limit.
   */
  @IsOptional()
  @Type((): NumberConstructor => Number)
  @IsInt()
  @Min(0)
  @Max(PLAN_BUNDLE_DEVICE_LIMIT_MAX)
  public deviceLimit?: number;

  /**
   * The LIMITED member plan whose traffic the cabinet card prints on its second
   * line («0.01/50 ГБ»), or `null`/omitted for "no second line". Must be one of
   * `planIds` and must have a traffic limit — an unlimited plan has no
   * used/limit pair to print.
   */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  public secondaryPlanId?: string | null;

  /**
   * Kept for wire compatibility only. A bundle links exactly
   * `PLAN_BUNDLE_MAX_PLANS` plans and the first two traffic lines of a merged
   * subscription are the main plan and the default «Трафик доп.» row, both
   * captioned by the bot's own texts — so the allowance
   * (`planIds.length - 2`) is always zero and any caption here is refused.
   */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AdminPlanBundleMemberTrafficLabelDto)
  @ArrayMaxSize(48)
  public memberTrafficLabels?: AdminPlanBundleMemberTrafficLabelDto[];
}

export class AdminPlanBundleUpdateDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  public name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  public description?: string | null;

  @IsOptional()
  @IsBoolean()
  public isActive?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(PLAN_BUNDLE_MIN_PLANS)
  @ArrayMaxSize(PLAN_BUNDLE_MAX_PLANS)
  @ArrayUnique()
  @IsString({ each: true })
  public planIds?: string[];

  /** Same contract as on create; `null` clears the choice back to the default. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  public visiblePlanId?: string | null;

  /** Same contract as on create. */
  @IsOptional()
  @Type((): NumberConstructor => Number)
  @IsInt()
  @Min(0)
  @Max(PLAN_BUNDLE_DEVICE_LIMIT_MAX)
  public deviceLimit?: number;

  /** Same contract as on create; `null` clears the second line. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  public secondaryPlanId?: string | null;

  /**
   * Same contract as on create; with exactly two plans the allowance is zero,
   * so a submitted caption is always refused. A save that omits the field keeps
   * every stored caption (a rename must not wipe them).
   */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AdminPlanBundleMemberTrafficLabelDto)
  @ArrayMaxSize(48)
  public memberTrafficLabels?: AdminPlanBundleMemberTrafficLabelDto[];
}
