import {
  BadgeCheck,
  CalendarPlus,
  Coins,
  Crown,
  Globe,
  Link as LinkIcon,
  Link2Off,
  MessageCircle,
  Star,
  TimerReset,
  UserPlus,
  type LucideIcon,
} from 'lucide-react';

/** Icon + tone for a referral level. Tone is a tailwind text-* utility. */
export interface LevelMeta {
  readonly icon: LucideIcon;
  readonly className: string;
}

export const REFERRAL_LEVEL_META: Record<number, LevelMeta> = {
  1: { icon: Crown, className: 'text-amber-500' },
  2: { icon: Star, className: 'text-zinc-400' },
  3: { icon: Star, className: 'text-orange-500' },
};

export function getLevelMeta(level: number): LevelMeta {
  return REFERRAL_LEVEL_META[level] ?? { icon: Star, className: 'text-muted-foreground' };
}

export interface SourceMeta {
  readonly icon: LucideIcon;
  readonly className: string;
}

/** Maps `Referral.inviteSource` (`TELEGRAM | WEB | UNKNOWN | MANUAL`) to UI. */
export const REFERRAL_SOURCE_META: Record<string, SourceMeta> = {
  TELEGRAM: { icon: MessageCircle, className: 'text-sky-500' },
  WEB: { icon: Globe, className: 'text-emerald-500' },
  MANUAL: { icon: UserPlus, className: 'text-violet-500' },
  UNKNOWN: { icon: LinkIcon, className: 'text-muted-foreground' },
};

export function getSourceMeta(source: string | null | undefined): SourceMeta {
  if (source === null || source === undefined) return REFERRAL_SOURCE_META.UNKNOWN;
  return REFERRAL_SOURCE_META[source] ?? REFERRAL_SOURCE_META.UNKNOWN;
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
