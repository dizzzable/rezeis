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
  /**
   * VIP exemption: this user's invites ignore the TTL and slot caps entirely.
   * Kept separate from `useGlobalSettings` so an operator can hand out the
   * exemption without having to clone the whole limits block onto the user.
   */
  bypassInviteGate: boolean;
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

/**
 * Smallest invite TTL this service will act on, in seconds.
 *
 * Zero is the value that had to go: `now + 0` is `expiresAt === now`, an
 * invite already expired at the instant it was written - the same silent
 * product as a past `expiresAt`. Negatives were worse and were reachable,
 * because the global value is raw JSON read by a helper that accepted any
 * finite number.
 *
 * One MINUTE rather than one second, and rather than something larger:
 *   - Below a minute the link dies before a human can copy it out and paste
 *     it into a chat, so no such value can be intentional.
 *   - `ReferralsService.findReusableInvite` only reuses a LIVE invite, so a
 *     sub-minute TTL makes every invite-hub view mint a fresh invite and burn
 *     a slot - the exact failure already documented on `getCapacity`.
 *   - It clears any plausible latency between computing this expiry and
 *     writing the row by ~60x, which is what lets `ReferralsService` refuse a
 *     non-future `expiresAt` outright instead of intermittently.
 *   - Anything larger (five minutes, an hour, a day) would start legislating
 *     product policy: a timed campaign or a support test can legitimately
 *     want a two-minute window. A minute is the smallest bound that removes
 *     the defect without deciding that question.
 *
 * The operator surfaces are asymmetric: the GLOBAL form works in whole days
 * (it writes `days * 86400`, maps an EMPTY box to `null` = no expiry, and
 * clamps a zero or negative box up to its own one-day floor - see
 * `parseBoundedInt` in `referral-settings-page.tsx`), so it cannot produce
 * anything under a day and this floor rejects nothing it can make. The
 * PER-USER override is a raw seconds field, and that is where sub-minute
 * values came from.
 */
export const MIN_LINK_TTL_SECONDS = 60;

/**
 * Floor for the three slot-accounting settings (`initialSlots`,
 * `refillThresholdQualified`, `refillAmount`).
 *
 * ZERO, not one. The defect in these is NEGATIVE, and zero means something
 * real and DIFFERENT in each of them:
 *   - `initialSlots: 0` - this user gets no invite slots. A deliberate
 *     lockout, and an operator may well want it.
 *   - `refillThresholdQualified: 0` - no refills. `getCapacity` already skips
 *     refilling unless the threshold is `> 0`, which is also what keeps it
 *     from dividing by zero.
 *   - `refillAmount: 0` - refills trigger but add nothing.
 * Bounding at 1 would forbid all three legitimate settings. A negative is
 * coherent in none of them, and is what actually broke things:
 * `totalSlots = initialSlots + refillsEarned * refillAmount`, then
 * `remainingSlots = Math.max(0, totalSlots - usedSlots)`. A negative
 * `initialSlots` floors remaining at 0 and locks the user out of creating
 * invites with NO invite and NO explanation - strictly worse than the TTL bug,
 * which at least produced a visibly dead link. A negative `refillAmount` is
 * worse still: it takes slots AWAY as the user qualifies more referrals,
 * inverting the incentive the feature exists for.
 */
export const MIN_INVITE_COUNT_SETTING = 0;

const DEFAULT_LIMITS: InviteLimitsConfig = {
  linkTtlEnabled: false,
  linkTtlSeconds: null,
  slotsEnabled: false,
  initialSlots: null,
  refillThresholdQualified: null,
  refillAmount: null,
  bypassInviteGate: false,
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
    return this.normalizeLimits(
      {
        linkTtlEnabled: bool('linkTtlEnabled', 'link_ttl_enabled'),
        linkTtlSeconds: num('linkTtlSeconds', 'link_ttl_seconds'),
        slotsEnabled: bool('slotsEnabled', 'slots_enabled'),
        initialSlots: num('initialSlots', 'initial_slots'),
        refillThresholdQualified: num('refillThresholdQualified', 'refill_threshold_qualified'),
        refillAmount: num('refillAmount', 'refill_amount'),
        // Global config has no bypass — it is a per-user exemption only.
        bypassInviteGate: false,
      },
      'global referralSettings.inviteLimits',
    );
  }

  /**
   * Enforce the floors on whatever is ACTUALLY STORED.
   *
   * The per-user DTO (`UpdateUserInviteSettingsDto`) stops new out-of-range
   * values, but this reader still meets rows written before those bounds
   * existed - and the GLOBAL values are raw JSON that never passed a DTO at
   * all, because `PATCH /admin/settings/referral` takes a bare
   * `Record<string, unknown>`.
   *
   * The panel form is no longer the hole it was. `referral-settings-page.tsx`
   * now clamps every invite-limit box through `parseBoundedInt`
   * (`Math.max(floor, Math.trunc(Number(raw)))`, empty box -> `null`) and
   * disables Save while a box sits below its floor, so nothing typed THERE
   * reaches storage negative. That leaves this reader guarding everything
   * else - rows written before the bounds, direct DB edits, imports, and any
   * future writer of that JSON - rather than duplicating a check the SPA
   * already performs.
   *
   * CLAMPED, not rejected. This runs on every invite-hub view and every
   * capacity check, so throwing would turn one bad number in
   * `Settings.referralSettings` into a total outage of the referral feature
   * for every user at once - and it would surface to THEM as a broken bot
   * screen, not to the operator who can actually fix it. Clamping keeps the
   * bot working on a sane value and preserves the invariant
   * `ReferralsService` relies on: a resolved expiry is always strictly future.
   *
   * Not silent - every clamp warns with the stored value and the value used.
   * Values behind a disabled toggle are left alone: nothing reads them, and
   * warning about them would be noise.
   */
  private normalizeLimits(config: InviteLimitsConfig, source: string): InviteLimitsConfig {
    const next = { ...config };
    if (config.linkTtlEnabled) {
      next.linkTtlSeconds = this.normalizeSetting({
        stored: config.linkTtlSeconds,
        floor: MIN_LINK_TTL_SECONDS,
        key: 'linkTtlSeconds',
        source,
        consequence: 'A TTL of 0 or less mints invites that are already expired.',
      });
    }
    if (config.slotsEnabled) {
      next.initialSlots = this.normalizeSetting({
        stored: config.initialSlots,
        floor: MIN_INVITE_COUNT_SETTING,
        key: 'initialSlots',
        source,
        consequence:
          'A negative slot count silently locks the user out of creating invites.',
      });
      next.refillThresholdQualified = this.normalizeSetting({
        stored: config.refillThresholdQualified,
        floor: MIN_INVITE_COUNT_SETTING,
        key: 'refillThresholdQualified',
        source,
        consequence: 'A negative refill threshold disables refills without saying so.',
      });
      next.refillAmount = this.normalizeSetting({
        stored: config.refillAmount,
        floor: MIN_INVITE_COUNT_SETTING,
        key: 'refillAmount',
        source,
        consequence:
          'A negative refill takes slots AWAY as the user qualifies more referrals.',
      });
    }
    return next;
  }

  private normalizeSetting(input: {
    readonly stored: number | null;
    readonly floor: number;
    readonly key: string;
    readonly source: string;
    readonly consequence: string;
  }): number | null {
    // `null` is a real setting ('no expiry' / 'unlimited'), not a bad number.
    if (input.stored === null) {
      return null;
    }
    const normalized = Math.max(input.floor, Math.trunc(input.stored));
    if (normalized === input.stored) {
      return input.stored;
    }
    this.logger.warn(
      `${input.key}=${input.stored} from ${input.source} is not a usable value (minimum ${input.floor}, whole numbers); using ${normalized} instead. ${input.consequence}`,
    );
    return normalized;
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
    // Clamped again AFTER the merge: `global` is already normalised, but a
    // per-user override can replace ANY of these with whatever
    // `parseNullableInt` accepted - it truncates any finite number, negatives
    // included - so an override written before the DTO gained its bounds can
    // still reintroduce a bad value on top of a clean global config.
    return this.normalizeLimits(
      mergeUserInviteOverride(global, user?.referralInviteSettings ?? null),
      `user override for ${userId}`,
    );
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

    // VIP exemption — unlimited capacity regardless of the global slot config.
    if (limits.bypassInviteGate || !limits.slotsEnabled || limits.initialSlots === null) {
      return { totalSlots: null, usedSlots: 0, remainingSlots: null, canCreateInvite: true };
    }

    const [inviteCount, qualifiedCount] = await Promise.all([
      // Only LIVE invites occupy a slot — matching what the setting promises
      // ("limit how many *active* invite links each user can have"). Counting
      // every invite ever created meant an expired or already-redeemed link
      // held its slot forever: with a short TTL a user burned through their
      // allowance just by opening the invite screen, and after N successful
      // referrals they could never invite again even though refills were on.
      this.prismaService.referralInvite.count({
        where: {
          inviterId: userId,
          revokedAt: null,
          consumedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
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
    // VIP exemption — never expire this user's invites.
    if (limits.bypassInviteGate || !limits.linkTtlEnabled || limits.linkTtlSeconds === null) {
      return null;
    }
    const expiresAt = new Date();
    expiresAt.setSeconds(expiresAt.getSeconds() + limits.linkTtlSeconds);
    if (Number.isNaN(expiresAt.getTime())) {
      // The floor bounds this below; nothing bounds it above, and a large
      // enough TTL walks Date past its representable range and comes back
      // Invalid rather than throwing. Left alone it reaches Prisma as one.
      throw new BadRequestException(
        `INVITE_LINK_TTL_OUT_OF_RANGE: linkTtlSeconds=${limits.linkTtlSeconds} does not resolve to a valid date`,
      );
    }
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
  // The bypass is deliberately read BEFORE the `useGlobalSettings` shortcut:
  // an operator grants the exemption on its own, without wanting to fork the
  // whole limits block for that user.
  const bypassInviteGate = parsed?.bypassInviteGate === true;
  if (parsed === null || parsed.useGlobalSettings === true) {
    return bypassInviteGate ? { ...global, bypassInviteGate } : global;
  }
  return {
    bypassInviteGate,
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
