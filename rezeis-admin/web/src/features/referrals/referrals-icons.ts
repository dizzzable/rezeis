import {
  BadgeCheck,
  CalendarPlus,
  CircleSlash,
  Coins,
  Crown,
  Globe,
  Handshake,
  Link as LinkIcon,
  Link2Off,
  MessageCircle,
  Star,
  TimerReset,
  type LucideIcon,
} from 'lucide-react';

/** Icon + tone for a referral level. Tone is a tailwind text-* utility. */
export interface LevelMeta {
  readonly icon: LucideIcon;
  readonly className: string;
  /**
   * i18n key under `referralsActions.referralsTab.levels`, or null for a level
   * with nothing to explain.
   *
   * Levels 1 and 2 need one, because the table now shows up to TWO rows for a
   * single sign-up and the difference between them is not visible from the
   * cells: a level-1 row is a database record of an invite, a level-2 row is a
   * payout the engine derives at the moment it pays. Level 3 exists only in
   * data imported from donor systems - nothing organic writes it and nothing
   * derives it - so there is no rule to state about it.
   */
  readonly hintKey: string | null;
}

export const REFERRAL_LEVEL_META: Record<number, LevelMeta> = {
  1: {
    icon: Crown,
    className: 'text-amber-500',
    hintKey: 'referralsActions.referralsTab.levels.direct',
  },
  2: {
    icon: Star,
    className: 'text-zinc-400',
    hintKey: 'referralsActions.referralsTab.levels.derived',
  },
  3: { icon: Star, className: 'text-orange-500', hintKey: null },
};

export function getLevelMeta(level: number): LevelMeta {
  return (
    REFERRAL_LEVEL_META[level] ?? {
      icon: Star,
      className: 'text-muted-foreground',
      hintKey: null,
    }
  );
}

/**
 * Wire spelling of `ReferralPayoutBlockerValue` (`referral.interface.ts`).
 *
 * A tuple for the same reason `REFERRAL_INVITE_SOURCES` is one: the zod enum
 * in `referrals-api.ts`, the meta map below and the specs all enumerate the
 * SAME members from a single place, so a third blocker added on the server
 * cannot end up with no icon, no label and a silent fallback.
 */
export const REFERRAL_PAYOUT_BLOCKERS = ['PARTNER_PROGRAMME', 'REWARD_NOT_CONFIGURED'] as const;

export type ReferralPayoutBlocker = (typeof REFERRAL_PAYOUT_BLOCKERS)[number];

export interface PayoutBlockerMeta {
  readonly icon: LucideIcon;
  readonly className: string;
  /** Short badge text: i18n key under `referralsTab.payoutBlockers`. */
  readonly labelKey: string;
  /** The full sentence, shown on hover. Same subtree, `.hint`. */
  readonly hintKey: string;
}

/**
 * Why a row will NOT move money, and who does instead.
 *
 * Only a level-1 row can carry one. A level-2 row is not a database record of
 * anything - it exists solely because a payout happens - so the server omits
 * it entirely rather than showing a blocked one. See `ReferralInterface`.
 */
export const REFERRAL_PAYOUT_BLOCKER_META: Record<ReferralPayoutBlocker, PayoutBlockerMeta> = {
  PARTNER_PROGRAMME: {
    icon: Handshake,
    className: 'text-violet-500',
    labelKey: 'referralsActions.referralsTab.payoutBlockers.partnerProgramme.label',
    hintKey: 'referralsActions.referralsTab.payoutBlockers.partnerProgramme.hint',
  },
  REWARD_NOT_CONFIGURED: {
    icon: CircleSlash,
    className: 'text-muted-foreground',
    labelKey: 'referralsActions.referralsTab.payoutBlockers.rewardNotConfigured.label',
    hintKey: 'referralsActions.referralsTab.payoutBlockers.rewardNotConfigured.hint',
  },
};

/**
 * `null` in, `null` out - and that null is the common case, not an error: it
 * means the referral programme WILL pay this row. An unknown token also
 * answers null rather than a generic badge, because inventing a "this will not
 * pay" marker for a value the panel does not understand is the one wrong
 * answer here: it states something about the operator money that nobody
 * established.
 */
export function getPayoutBlockerMeta(
  blocker: string | null | undefined,
): PayoutBlockerMeta | null {
  if (blocker === null || blocker === undefined) return null;
  return REFERRAL_PAYOUT_BLOCKER_META[blocker as ReferralPayoutBlocker] ?? null;
}

/**
 * Wire spelling of the Prisma enum `ReferralInviteSource` (`BOT | WEB |
 * UNKNOWN`), mirroring `ReferralInviteSourceValue` on the server.
 *
 * A tuple rather than a bare union so the zod enum in `referrals-api.ts`, the
 * meta map below and the specs all enumerate the SAME members from one place.
 * The map this replaces was keyed `TELEGRAM | WEB | MANUAL | UNKNOWN`: two
 * members the enum has never had, and `BOT` - the one the bot actually records
 * - missing, so every bot signup drew the generic link icon while the text
 * beside it read the raw word "BOT".
 */
export const REFERRAL_INVITE_SOURCES = ['BOT', 'WEB', 'UNKNOWN'] as const;

export type ReferralInviteSource = (typeof REFERRAL_INVITE_SOURCES)[number];

export interface SourceMeta {
  readonly icon: LucideIcon;
  readonly className: string;
  /**
   * i18n key under `referralsActions.referralsTab.sources`. The cell used to
   * print `inviteSource` itself, so an operator read "BOT" in a Russian panel.
   */
  readonly labelKey: string;
}

/** Maps `Referral.inviteSource` (`BOT | WEB | UNKNOWN`) to UI. */
export const REFERRAL_SOURCE_META: Record<ReferralInviteSource, SourceMeta> = {
  BOT: {
    icon: MessageCircle,
    className: 'text-sky-500',
    labelKey: 'referralsActions.referralsTab.sources.bot',
  },
  WEB: {
    icon: Globe,
    className: 'text-emerald-500',
    labelKey: 'referralsActions.referralsTab.sources.web',
  },
  UNKNOWN: {
    icon: LinkIcon,
    className: 'text-muted-foreground',
    labelKey: 'referralsActions.referralsTab.sources.unknown',
  },
};

export function getSourceMeta(source: string | null | undefined): SourceMeta {
  if (source === null || source === undefined) return REFERRAL_SOURCE_META.UNKNOWN;
  return REFERRAL_SOURCE_META[source as ReferralInviteSource] ?? REFERRAL_SOURCE_META.UNKNOWN;
}

export interface RewardTypeMeta {
  readonly icon: LucideIcon;
  readonly className: string;
}

export const REWARD_TYPE_META: Record<string, RewardTypeMeta> = {
  POINTS: { icon: Coins, className: 'text-amber-500' },
  EXTRA_DAYS: { icon: CalendarPlus, className: 'text-emerald-500' },
};

export function getRewardTypeMeta(type: string): RewardTypeMeta {
  return REWARD_TYPE_META[type] ?? { icon: BadgeCheck, className: 'text-muted-foreground' };
}

export interface InviteStatusMeta {
  readonly icon: LucideIcon;
  readonly className: string;
}

export const INVITE_STATUS_META: Record<'active' | 'expired' | 'revoked' | 'consumed', InviteStatusMeta> = {
  active: { icon: LinkIcon, className: 'text-emerald-500' },
  expired: { icon: TimerReset, className: 'text-amber-500' },
  revoked: { icon: Link2Off, className: 'text-destructive' },
  consumed: { icon: BadgeCheck, className: 'text-sky-500' },
};

export type InviteStatus = keyof typeof INVITE_STATUS_META;
