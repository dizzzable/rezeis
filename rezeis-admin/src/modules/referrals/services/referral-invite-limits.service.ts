import { BadRequestException, Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { readJsonObject } from '../../../common/utils/read-json-object.util';

/**
 * Invite limits configuration from `Settings.referralSettings` JSON.
 *
 * Donor: `ReferralInviteLimitsDto` in altshop.
 */
export interface InviteLimitsConfig {
  /** Whether link TTL enforcement is active. */
  linkTtlEnabled: boolean;
  /** TTL in seconds for each invite link. Null = no expiry. */
  linkTtlSeconds: number | null;
  /** Whether slot-based capacity is active. */
  slotsEnabled: boolean;
  /** Initial number of invite slots a user gets. Null = unlimited. */
  initialSlots: number | null;
  /** Number of qualified referrals needed to trigger a slot refill. */
  refillThresholdQualified: number | null;
  /** How many slots are added on each refill. */
  refillAmount: number | null;
}

export interface InviteCapacitySnapshot {
  /** Total slots ever allocated to this user. */
  totalSlots: number | null;
  /** Slots currently consumed (active + consumed invites). */
  usedSlots: number;
  /** Remaining available slots. Null = unlimited. */
  remainingSlots: number | null;
  /** Whether the user can create a new invite right now. */
  canCreateInvite: boolean;
}

const DEFAULT_LIMITS: InviteLimitsConfig = {
  linkTtlEnabled: false,
  linkTtlSeconds: null,
  slotsEnabled: false,
  initialSlots: null,
  refillThresholdQualified: null,
  refillAmount: null,
};

/**
 * Manages invite slot capacity and TTL enforcement.
 *
 * Donor: `referral_invites.get_effective_invite_limits` +
 *        `referral_invites.get_invite_capacity_snapshot`.
 *
 * Slot refill logic:
 *   Every time a referral qualifies (via `ReferralQualificationService`),
 *   we check if the referrer has reached the `refillThresholdQualified`
 *   count. If so, we grant `refillAmount` additional slots by creating
 *   placeholder invite records (or by tracking a counter — we use the
 *   simpler approach of counting existing invites vs qualified referrals).
 */
@Injectable()
export class ReferralInviteLimitsService {
  private readonly logger = new Logger(ReferralInviteLimitsService.name);

  public constructor(private readonly prismaService: PrismaService) {}

  /**
   * Returns the effective invite limits from settings.
   */
  public async getEffectiveLimits(): Promise<InviteLimitsConfig> {
    const settings = await this.prismaService.settings.findFirst({
      select: { referralSettings: true },
    });
    if (!settings) return DEFAULT_LIMITS;
    const json = (settings.referralSettings ?? {}) as Record<string, unknown>;
    // The admin form persists camelCase (`inviteLimits.linkTtlEnabled`, …);
    // the legacy donor shape was snake_case (`invite_limits.link_ttl_enabled`).
    // Prefer the form contract and fall back to the legacy one so operator
    // config actually takes effect (previously the snake_case-only reader
    // silently ignored everything the form saved).
    const inviteLimits = readJsonObject(json.inviteLimits ?? json.invite_limits);
    const bool = (...keys: readonly string[]): boolean =>
      keys.some((key) => inviteLimits[key] === true);
    const num = (...keys: readonly string[]): number | null => {
      for (const key of keys) {
        const value = inviteLimits[key];
        if (typeof value === 'number' && Number.isFinite(value)) return value;
      }
      return null;
    };
    return {
      linkTtlEnabled: bool('linkTtlEnabled', 'link_ttl_enabled'),
      linkTtlSeconds: num('linkTtlSeconds', 'link_ttl_seconds'),
      slotsEnabled: bool('slotsEnabled', 'slots_enabled'),
      initialSlots: num('initialSlots', 'initial_slots'),
      refillThresholdQualified: num('refillThresholdQualified', 'refill_threshold_qualified'),
      refillAmount: num('refillAmount', 'refill_amount'),
    };
  }

  /**
   * Returns the effective invite limits **for a specific user**, layering
   * the per-user override on top of the global configuration.
   *
   * Per-user override is stored on `User.referralInviteSettings` as a
   * shallow JSON object whose keys mirror the global keys (snake_case in
   * DB, camelCase exposed by `parseUserOverride`). Any field present and
   * non-null in the override replaces the corresponding global value.
   *
   * Donor parity: altshop's `ReferralInviteIndividualSettingsDto` +
   * `_resolve_user_invite_limits` helper.
   */
  public async getEffectiveLimitsForUser(userId: string): Promise<InviteLimitsConfig> {
    const [global, user] = await Promise.all([
      this.getEffectiveLimits(),
      this.prismaService.user.findUnique({
        where: { id: userId },
        select: { referralInviteSettings: true },
      }),
    ]);
    return mergeUserInviteOverride(global, user?.referralInviteSettings ?? null);
  }

  /**
   * Returns the current invite capacity for a user.
   */
  public async getCapacity(userId: string): Promise<InviteCapacitySnapshot> {
    // Per-user override layered over the global program limits — an operator
    // can raise/lower a specific user's slot count/TTL and it must actually
    // apply here (previously this read the GLOBAL limits only, so per-user
    // invite overrides were saved but silently ignored at capacity/creation).
    const limits = await this.getEffectiveLimitsForUser(userId);

    if (!limits.slotsEnabled || limits.initialSlots === null) {
      return { totalSlots: null, usedSlots: 0, remainingSlots: null, canCreateInvite: true };
    }

    const [inviteCount, qualifiedCount] = await Promise.all([
      this.prismaService.referralInvite.count({
        where: { inviterId: userId },
      }),
      this.prismaService.referral.count({
        where: { referrerId: userId, qualifiedAt: { not: null } },
      }),
    ]);

    // Calculate total slots: initial + refills earned
    let totalSlots = limits.initialSlots;
    if (limits.refillThresholdQualified !== null && limits.refillThresholdQualified > 0 && limits.refillAmount !== null) {
      const refillsEarned = Math.floor(qualifiedCount / limits.refillThresholdQualified);
      totalSlots += refillsEarned * limits.refillAmount;
    }

    const usedSlots = inviteCount;
    const remainingSlots = Math.max(0, totalSlots - usedSlots);

    return {
      totalSlots,
      usedSlots,
      remainingSlots,
      canCreateInvite: remainingSlots > 0,
    };
  }

  /**
   * Validates that the user can create a new invite (slot check + TTL).
   * Throws BadRequestException if not allowed.
   */
  public async validateCanCreateInvite(userId: string): Promise<void> {
    const capacity = await this.getCapacity(userId);
    if (!capacity.canCreateInvite) {
      throw new BadRequestException(
        'INVITE_SLOT_LIMIT_REACHED: No remaining invite slots. Earn more by qualifying referrals.',
      );
    }
  }

  /**
   * Resolves the expiry date for a new invite based on TTL settings.
   * Returns null if TTL is disabled.
   */
  public async resolveInviteExpiry(
    userId: string,
    explicitExpiresAt?: Date | null,
  ): Promise<Date | null> {
    if (explicitExpiresAt !== undefined && explicitExpiresAt !== null) {
      return explicitExpiresAt;
    }
    // Per-user TTL override applies here too (was global-only before).
    const limits = await this.getEffectiveLimitsForUser(userId);
    if (!limits.linkTtlEnabled || limits.linkTtlSeconds === null) {
      return null;
    }
    const expiresAt = new Date();
    expiresAt.setSeconds(expiresAt.getSeconds() + limits.linkTtlSeconds);
    return expiresAt;
  }
}


// ─────────────────────────────────────────────────────────────────────────────
//  Per-user override merge
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-user override JSON shape, accepted on `User.referralInviteSettings`.
 *
 * Any field that is `undefined` is treated as "use the global value".
 * Boolean `*Enabled` flags follow the same rule — if absent, the global
 * value wins. `useGlobalSettings: true` short-circuits the whole merge
 * and returns the global config untouched.
 */
export interface UserInviteOverride {
  readonly useGlobalSettings?: boolean;
  readonly linkTtlEnabled?: boolean;
  readonly linkTtlSeconds?: number | null;
  readonly slotsEnabled?: boolean;
  readonly initialSlots?: number | null;
  readonly refillThresholdQualified?: number | null;
  readonly refillAmount?: number | null;
  /** When true, this user's referral link admits new sign-ups even
   *  under platform `INVITED` mode + exhausted global TTL / slot caps.
   *  Independent of `useGlobalSettings`. */
  readonly bypassInviteGate?: boolean;
}

export function mergeUserInviteOverride(
  global: InviteLimitsConfig,
  override: unknown,
): InviteLimitsConfig {
  const parsed = parseUserOverride(override);
  if (parsed === null || parsed.useGlobalSettings === true) {
    return global;
  }
  return {
    linkTtlEnabled:
      typeof parsed.linkTtlEnabled === 'boolean' ? parsed.linkTtlEnabled : global.linkTtlEnabled,
    linkTtlSeconds:
      parsed.linkTtlSeconds !== undefined ? parsed.linkTtlSeconds : global.linkTtlSeconds,
    slotsEnabled:
      typeof parsed.slotsEnabled === 'boolean' ? parsed.slotsEnabled : global.slotsEnabled,
    initialSlots:
      parsed.initialSlots !== undefined ? parsed.initialSlots : global.initialSlots,
    refillThresholdQualified:
      parsed.refillThresholdQualified !== undefined
        ? parsed.refillThresholdQualified
        : global.refillThresholdQualified,
    refillAmount:
      parsed.refillAmount !== undefined ? parsed.refillAmount : global.refillAmount,
  };
}

function parseUserOverride(value: unknown): UserInviteOverride | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  return {
    useGlobalSettings: typeof v.useGlobalSettings === 'boolean' ? v.useGlobalSettings : undefined,
    linkTtlEnabled: typeof v.linkTtlEnabled === 'boolean' ? v.linkTtlEnabled : undefined,
    linkTtlSeconds: parseNullableInt(v.linkTtlSeconds),
    slotsEnabled: typeof v.slotsEnabled === 'boolean' ? v.slotsEnabled : undefined,
    initialSlots: parseNullableInt(v.initialSlots),
    refillThresholdQualified: parseNullableInt(v.refillThresholdQualified),
    refillAmount: parseNullableInt(v.refillAmount),
    bypassInviteGate: typeof v.bypassInviteGate === 'boolean' ? v.bypassInviteGate : undefined,
  };
}

/**
 * Reads the `bypassInviteGate` flag from a raw `User.referralInviteSettings`
 * JSON value. Returns `false` when the flag is missing or the value is not
 * a JSON object. Independent of `useGlobalSettings` — the bypass overrides
 * the platform-level `INVITED` gate regardless of global program limits.
 *
 * Used by `consumeReferralCode` (Wave 2) and the admin user-detail UI.
 */
export function readInviteBypassFlag(value: unknown): boolean {
  const parsed = parseUserOverride(value);
  return parsed?.bypassInviteGate === true;
}

function parseNullableInt(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  return undefined;
}
