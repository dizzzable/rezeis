import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

import {
  MIN_INVITE_COUNT_SETTING,
  MIN_LINK_TTL_SECONDS,
} from '../../referrals/services/referral-invite-limits.service';

/**
 * Patch payload for `PATCH /admin/settings/referral`.
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
 *
 * The route took `@Body() body: Record<string, unknown>`. A metatype of
 * `Object` makes the global `ValidationPipe` in `main.ts` SKIP THE ROUTE
 * ENTIRELY — not one class-validator decorator runs on such a handler, and
 * `forbidNonWhitelisted` never sees the body either. So the endpoint accepted
 * anything at all and wrote it verbatim into `Settings.referralSettings`.
 *
 * The only guard was in the panel: `parseBoundedInt` in
 * `referral-settings-page.tsx` clamps every invite-limit box before it is
 * submitted. That is a UI clamp and nothing more — `curl`, a script, or an
 * older SPA build writes a negative straight through it.
 * `ReferralInviteLimitsService.normalizeLimits` catches part of the damage on
 * READ, but only for values behind an ENABLED toggle: values behind a disabled
 * one are deliberately left unclamped and unread, so the bad number sits in the
 * column until somebody flips the switch that starts reading it.
 *
 * ── OMITTED, `null`, AND ZERO ARE THREE DIFFERENT REQUESTS ───────────────────
 *
 * `SettingsService.updateReferralSettings` merges this patch over the stored
 * JSON: top-level keys are replaced, `inviteLimits` and `pointsExchange` are
 * spread one level deeper. So the three states reach storage as three different
 * outcomes, and the DTO has to be able to express all of them:
 *
 *   • OMITTED — the key is never written; whatever is stored survives. Every
 *     field here is `@IsOptional()`, and none has an initialiser, so an absent
 *     key leaves the property absent from the instance rather than present as
 *     `undefined`. `mergeReferralSettings` iterates `Object.entries`, so an
 *     absent property is genuinely invisible to it.
 *   • `null` — written as `null`, which every reader treats as "no value":
 *     `linkTtlSeconds: null` is *no expiry*, `initialSlots: null` is
 *     *unlimited*, a null `pointsExchange` number falls back to its built-in
 *     default. Clearing a setting is therefore a thing this endpoint can do,
 *     and it is not the same request as omitting the field.
 *   • ZERO — a real, documented value in most of these, and the one a "tidy"
 *     `@Min(1)` sweep would quietly outlaw. `initialSlots: 0` means *this user
 *     gets no invite slots*; `refillThresholdQualified: 0` means *no refills*;
 *     `refillAmount: 0` means *refills add nothing*; `level1Reward: 0` means
 *     *no reward*. See `MIN_INVITE_COUNT_SETTING`, whose doc block spells out
 *     why the floor for those is zero and not one.
 *
 * BOOLEANS ARE THE EXCEPTION and are deliberately NOT nullable. No reader
 * distinguishes a null flag from `false` — `pickBool` returns `obj[key] ===
 * true` and `bool()` in the limits service is the same test — so admitting
 * `null` would offer a third state that means nothing and invite a caller to
 * read it as "inherit".
 *
 * ── HOW THE FIELD LIST WAS DERIVED ───────────────────────────────────────────
 *
 * `forbidNonWhitelisted: true` is on globally, so an over-narrow DTO turns a
 * working save into a 400. Three sources were reconciled:
 *
 *   1. Everything the panel form submits (`referral-settings-page.tsx`,
 *      `saveMutation`). Non-negotiable: each of these must validate.
 *   2. Everything `ReferralInviteLimitsService.getEffectiveLimits` reads —
 *      which includes `refillThresholdQualified` and `refillAmount`, live
 *      product knobs the form does not render. This endpoint is their only
 *      write path, so leaving them out would make them permanently unsettable.
 *   3. Everything `ReferralPointsExchangeService.loadConfig` reads — the
 *      per-section `minPoints`/`maxPoints` and the three program-wide numbers,
 *      for the same reason.
 *
 * DELIBERATELY EXCLUDED: the snake_case aliases (`invite_limits`,
 * `link_ttl_seconds`, `eligible_plan_ids`, …), the legacy `enable` flag, the
 * legacy nested `reward: { type, strategy, config }`, and the flat
 * `inviteLinkTtlDays` / `inviteSlots`. Every one of those exists as a READ
 * fallback for data written before the current form contract, and nothing
 * writes them through this route. Admitting them would let a caller install a
 * shape the panel cannot display or edit, and two spellings of one setting
 * whose precedence is decided by the order of a `??` chain.
 *
 * Out-of-range input is REJECTED (400 naming the field), never clamped. The
 * reader's clamp stays where it is: it guards rows written before this DTO
 * existed, direct database edits and imports, and it must keep clamping rather
 * than throwing, because it runs on every invite-hub view.
 */

/** The two values the panel's accrual selector can produce. */
const ACCRUAL_STRATEGIES = ['ON_FIRST_PAYMENT', 'ON_EACH_PAYMENT'] as const;

/** The two reward units the panel offers. */
const REWARD_TYPES = ['EXTRA_DAYS', 'POINTS'] as const;

/**
 * `-1` is not a stray negative — it is the documented "no cap" sentinel for
 * every ceiling in the points-exchange config (`DEFAULT_CONFIG` sets
 * `maxExchangePoints: -1` and `maxPoints: -1`, and the gate that reads them is
 * `typeConfig.maxPoints > 0 && …`). A blanket `@Min(0)` on the ceilings would
 * refuse the value the product ships with.
 */
const NO_CAP = -1;

/**
 * `pointsCost` is a DIVISOR: `Math.floor(input.points / typeConfig.pointsCost)`
 * in `ReferralPointsExchangeService.exchange`, with no zero guard on that path.
 * Zero yields `Infinity` and a negative inverts the exchange, so this is the
 * one number here whose floor is genuinely one.
 */
const MIN_POINTS_COST = 1;

class UpdateReferralInviteLimitsDto {
  @IsOptional() @IsBoolean()
  public readonly linkTtlEnabled?: boolean;

  /** `null` = no expiry. The floor is the service's own, not a copy of it. */
  @IsOptional() @ValidateIf((_o, v) => v !== null)
  @IsInt() @Min(MIN_LINK_TTL_SECONDS)
  public readonly linkTtlSeconds?: number | null;

  @IsOptional() @IsBoolean()
  public readonly slotsEnabled?: boolean;

  /** `null` = unlimited, `0` = no slots at all. Both are real settings. */
  @IsOptional() @ValidateIf((_o, v) => v !== null)
  @IsInt() @Min(MIN_INVITE_COUNT_SETTING)
  public readonly initialSlots?: number | null;

  /**
   * Read by `getEffectiveLimits`, rendered by no form. Without it here the only
   * way to set it would be a direct database edit.
   */
  @IsOptional() @ValidateIf((_o, v) => v !== null)
  @IsInt() @Min(MIN_INVITE_COUNT_SETTING)
  public readonly refillThresholdQualified?: number | null;

  /** Its pair, and the one whose negative inverts the incentive outright. */
  @IsOptional() @ValidateIf((_o, v) => v !== null)
  @IsInt() @Min(MIN_INVITE_COUNT_SETTING)
  public readonly refillAmount?: number | null;
}

class UpdateReferralExchangeSectionDto {
  @IsOptional() @IsBoolean()
  public readonly enabled?: boolean;

  @IsOptional() @ValidateIf((_o, v) => v !== null)
  @IsInt() @Min(MIN_POINTS_COST)
  public readonly pointsCost?: number | null;

  @IsOptional() @ValidateIf((_o, v) => v !== null)
  @IsInt() @Min(0)
  public readonly minPoints?: number | null;

  @IsOptional() @ValidateIf((_o, v) => v !== null)
  @IsInt() @Min(NO_CAP)
  public readonly maxPoints?: number | null;
}

class UpdateReferralGiftSectionDto extends UpdateReferralExchangeSectionDto {
  /** `null` = no gift plan chosen; the panel sends exactly that for an empty picker. */
  @IsOptional() @ValidateIf((_o, v) => v !== null)
  @IsString()
  public readonly giftPlanId?: string | null;

  @IsOptional() @ValidateIf((_o, v) => v !== null)
  @IsInt() @Min(1)
  public readonly giftDurationDays?: number | null;
}

class UpdateReferralDiscountSectionDto extends UpdateReferralExchangeSectionDto {
  /**
   * `@Max(100)` mirrors the form's own `max="100"`. The floor is zero rather
   * than the form's `min="1"`: a ceiling of zero is coherent (it caps the
   * discount at nothing) and refusing it would be this DTO legislating product
   * policy, which is not what it is for.
   */
  @IsOptional() @ValidateIf((_o, v) => v !== null)
  @IsInt() @Min(0) @Max(100)
  public readonly maxDiscountPercent?: number | null;
}

class UpdateReferralTrafficSectionDto extends UpdateReferralExchangeSectionDto {
  @IsOptional() @ValidateIf((_o, v) => v !== null)
  @IsInt() @Min(0)
  public readonly maxTrafficGb?: number | null;
}

class UpdateReferralPointsExchangeDto {
  @IsOptional() @IsBoolean()
  public readonly exchangeEnabled?: boolean;

  @IsOptional() @ValidateIf((_o, v) => v !== null)
  @IsInt() @Min(0)
  public readonly pointsPerDay?: number | null;

  @IsOptional() @ValidateIf((_o, v) => v !== null)
  @IsInt() @Min(0)
  public readonly minExchangePoints?: number | null;

  @IsOptional() @ValidateIf((_o, v) => v !== null)
  @IsInt() @Min(NO_CAP)
  public readonly maxExchangePoints?: number | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateReferralExchangeSectionDto)
  public readonly subscriptionDays?: UpdateReferralExchangeSectionDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateReferralGiftSectionDto)
  public readonly giftSubscription?: UpdateReferralGiftSectionDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateReferralDiscountSectionDto)
  public readonly discount?: UpdateReferralDiscountSectionDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateReferralTrafficSectionDto)
  public readonly traffic?: UpdateReferralTrafficSectionDto;
}

export class UpdateReferralSettingsDto {
  @IsOptional() @IsBoolean()
  public readonly enabled?: boolean;

  @IsOptional() @IsBoolean()
  public readonly invitedOnly?: boolean;

  @IsOptional() @IsIn(ACCRUAL_STRATEGIES)
  public readonly accrualStrategy?: (typeof ACCRUAL_STRATEGIES)[number];

  @IsOptional() @IsIn(REWARD_TYPES)
  public readonly rewardType?: (typeof REWARD_TYPES)[number];

  /**
   * `null` is reachable from the panel and is not a mistake: the form sends
   * `parseInt(box, 10)` for a non-empty box, and `parseInt('abc', 10)` is
   * `NaN`, which `JSON.stringify` writes as `null`. It reads as "no value" and
   * the reward falls back to `pointsPerReferral`, then to zero.
   */
  @IsOptional() @ValidateIf((_o, v) => v !== null)
  @IsInt() @Min(0)
  public readonly level1Reward?: number | null;

  @IsOptional() @ValidateIf((_o, v) => v !== null)
  @IsInt() @Min(0)
  public readonly level2Reward?: number | null;

  @IsOptional() @ValidateIf((_o, v) => v !== null)
  @IsInt() @Min(0)
  public readonly pointsPerReferral?: number | null;

  /**
   * Plan ids whose purchase qualifies a referral. An EMPTY array is the real
   * setting "every plan qualifies" (`ReferralQualificationService` only filters
   * when the list is non-empty), so nothing here may require a minimum size.
   */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  public readonly eligiblePlanIds?: string[];

  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateReferralInviteLimitsDto)
  public readonly inviteLimits?: UpdateReferralInviteLimitsDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateReferralPointsExchangeDto)
  public readonly pointsExchange?: UpdateReferralPointsExchangeDto;
}
