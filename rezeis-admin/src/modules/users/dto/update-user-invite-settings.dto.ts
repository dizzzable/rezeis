import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, Min } from 'class-validator';

import {
  MIN_INVITE_COUNT_SETTING,
  MIN_LINK_TTL_SECONDS,
} from '../../referrals/services/referral-invite-limits.service';

/**
 * Body payload for `PATCH /admin/users/:telegramId/invite-settings`.
 *
 * Donor parity: altshop's `ReferralInviteIndividualSettingsDto`, plus
 * a rezeis-only `bypassInviteGate` flag used by the platform-wide
 * `INVITED` access mode (see `.kiro/specs/access-mode-enforcement`).
 *
 * Semantics:
 *   • `useGlobalSettings = true` (or unset) → store/keep the user with no
 *     override; `getEffectiveLimitsForUser` will return the global config.
 *   • Any other field omitted → it falls back to the global value.
 *   • Numeric fields accept `null` to explicitly mean "no limit".
 *   • `bypassInviteGate` is independent of `useGlobalSettings`: when
 *     `true`, this user's referral link admits new sign-ups even when
 *     the platform is in `INVITED` mode and the global program has run
 *     out of TTL / slots. Used to mark VIP / partner accounts.
 */
export class UpdateUserInviteSettingsDto {
  @IsOptional()
  @IsBoolean()
  public useGlobalSettings?: boolean;

  @IsOptional()
  @IsBoolean()
  public linkTtlEnabled?: boolean;

  /**
   * Seconds a new invite link stays valid, or `null` for no expiry.
   *
   * Floored at `MIN_LINK_TTL_SECONDS`, not 0. `@Min(0)` explicitly permitted a
   * TTL of zero, and `ReferralInviteLimitsService.resolveInviteExpiry`
   * computes `now + linkTtlSeconds` - so zero produced `expiresAt === now`, an
   * invite already expired the instant it was created, with no error anywhere.
   * See that constant for why the floor is a minute.
   *
   * `@IsOptional()` is correct HERE, unlike on `CreateReferralInviteDto.
   * expiresInDays`: it skips `null` as well as `undefined`, and on this field
   * `null` is a real, meaningful setting ('no expiry'), not a malformed
   * number. Absent means 'inherit the global value'.
   */
  @IsOptional()
  @Type((): NumberConstructor => Number)
  @IsInt()
  @Min(MIN_LINK_TTL_SECONDS)
  public linkTtlSeconds?: number | null;

  @IsOptional()
  @IsBoolean()
  public slotsEnabled?: boolean;

  /**
   * Invite slots this user starts with, or `null` for unlimited.
   *
   * Floored at zero rather than one: `0` is a coherent setting ('this user
   * gets none'). A NEGATIVE is the broken case - `getCapacity` computes
   * `remainingSlots = Math.max(0, totalSlots - usedSlots)`, so it floors to a
   * silent lockout with no invite and no explanation. Already bounded here;
   * `ReferralInviteLimitsService` clamps stored values that predate this.
   */
  @IsOptional()
  @Type((): NumberConstructor => Number)
  @IsInt()
  @Min(MIN_INVITE_COUNT_SETTING)
  public initialSlots?: number | null;

  /**
   * Qualified referrals needed to earn a refill. `0` or `null` = no refills;
   * `getCapacity` only refills when this is `> 0`, which is also what stops it
   * dividing by zero.
   */
  @IsOptional()
  @Type((): NumberConstructor => Number)
  @IsInt()
  @Min(MIN_INVITE_COUNT_SETTING)
  public refillThresholdQualified?: number | null;

  /**
   * Slots added per refill. `0` is coherent (refills trigger but add nothing).
   * A NEGATIVE inverts the whole feature - it takes slots away as the user
   * qualifies more referrals.
   */
  @IsOptional()
  @Type((): NumberConstructor => Number)
  @IsInt()
  @Min(MIN_INVITE_COUNT_SETTING)
  public refillAmount?: number | null;

  @IsOptional()
  @IsBoolean()
  public bypassInviteGate?: boolean;
}
