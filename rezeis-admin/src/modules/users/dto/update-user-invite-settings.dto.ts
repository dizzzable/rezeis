import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, Min } from 'class-validator';

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

  @IsOptional()
  @Type((): NumberConstructor => Number)
  @IsInt()
  @Min(0)
  public linkTtlSeconds?: number | null;

  @IsOptional()
  @IsBoolean()
  public slotsEnabled?: boolean;

  @IsOptional()
  @Type((): NumberConstructor => Number)
  @IsInt()
  @Min(0)
  public initialSlots?: number | null;

  @IsOptional()
  @Type((): NumberConstructor => Number)
  @IsInt()
  @Min(0)
  public refillThresholdQualified?: number | null;

  @IsOptional()
  @Type((): NumberConstructor => Number)
  @IsInt()
  @Min(0)
  public refillAmount?: number | null;

  @IsOptional()
  @IsBoolean()
  public bypassInviteGate?: boolean;
}
