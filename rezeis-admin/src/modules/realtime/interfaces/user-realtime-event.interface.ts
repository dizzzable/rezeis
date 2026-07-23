import type { SystemEventSeverity } from '../../../common/services/system-events.service';

/**
 * Subset of `SystemEventCategory` we expose to user-facing clients
 * (reiwa BFF → user PWA / Telegram Mini App).
 *
 * Why a smaller set?
 *   The admin realtime channel ships every domain event (auth attempts,
 *   payment webhook drilldown, fraud signals, partner withdrawals …).
 *   The user channel **must not** leak any of that. We re-classify each
 *   safe event into one of these public categories and apply a strict
 *   whitelist of `event.type` values per category.
 */
export type UserRealtimeCategory =
  | 'SUBSCRIPTION'
  | 'PAYMENT'
  | 'PROMOCODE'
  | 'REFERRAL'
  | 'NOTIFICATION';

export interface UserRealtimeEventInterface {
  /** Public event identifier — see `USER_EVENT_WHITELIST`. */
  readonly type: string;
  readonly category: UserRealtimeCategory;
  readonly severity: SystemEventSeverity;
  /** Operator-friendly summary line, safe to render to end users. */
  readonly message: string;
  /**
   * Sanitised, user-facing metadata. Whatever is included here MUST be
   * safe to ship to the browser: subscription id, plan name, amount,
   * currency, expiry timestamp. Never internal ids, raw provider data,
   * Telegram-delivery identifiers or admin context.
   */
  readonly metadata: Readonly<Record<string, unknown>>;
  /** ISO timestamp when the event was emitted by the bus. */
  readonly timestamp: string;
}

/**
 * Whitelist of admin event types that are safe to forward to user
 * clients, and the projection function that decides:
 *   - whether the event belongs to a given userId / telegramId
 *   - which fields from `metadata` are safe to expose
 *
 * If a type is not in this whitelist, the user channel never emits it,
 * even when the underlying system event is broadcast. This is the
 * single source of truth for "can the user see this".
 */
export interface UserEventProjection {
  readonly category: UserRealtimeCategory;
  readonly severity?: SystemEventSeverity;
  /**
   * Decide whether the admin event belongs to the user identified by
   * `userId` / `telegramId`. Return the sanitised metadata to ship, or
   * `null` to drop the event entirely.
   */
  readonly project: (
    metadata: Readonly<Record<string, unknown>>,
    target: { readonly userId: string | null; readonly telegramId: string | null },
  ) => Readonly<Record<string, unknown>> | null;
}

function asString(metadata: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = metadata[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asNumber(metadata: Readonly<Record<string, unknown>>, key: string): number | null {
  const value = metadata[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function matchesUser(
  metadata: Readonly<Record<string, unknown>>,
  target: { readonly userId: string | null; readonly telegramId: string | null },
): boolean {
  const userId = asString(metadata, 'userId');
  if (userId !== null && target.userId !== null && userId === target.userId) return true;
  // Telegram id may arrive as number or string in metadata — accept both.
  const tgRaw = metadata['telegramId'];
  if (target.telegramId !== null) {
    if (typeof tgRaw === 'string' && tgRaw === target.telegramId) return true;
    if (typeof tgRaw === 'number' && String(tgRaw) === target.telegramId) return true;
  }
  return false;
}

/**
 * Whitelist mapping. Add a new entry only after auditing every metadata
 * field for "is this safe to ship to the browser?" — no Telegram delivery
 * ids, no admin ids, no provider tokens.
 */
export const USER_EVENT_WHITELIST: Readonly<Record<string, UserEventProjection>> = {
  // Subscription lifecycle
  'subscription.created': {
    category: 'SUBSCRIPTION',
    project: (metadata, target) => {
      if (!matchesUser(metadata, target)) return null;
      return {
        subscriptionId: asString(metadata, 'subscriptionId'),
        planName: asString(metadata, 'planName'),
        durationDays: asNumber(metadata, 'durationDays'),
      };
    },
  },
  'subscription.renewed': {
    category: 'SUBSCRIPTION',
    project: (metadata, target) => {
      if (!matchesUser(metadata, target)) return null;
      return {
        subscriptionId: asString(metadata, 'subscriptionId'),
        planName: asString(metadata, 'planName'),
        durationDays: asNumber(metadata, 'durationDays'),
      };
    },
  },
  'subscription.expired': {
    category: 'SUBSCRIPTION',
    severity: 'WARNING',
    project: (metadata, target) => {
      if (!matchesUser(metadata, target)) return null;
      return {
        subscriptionId: asString(metadata, 'subscriptionId'),
        planName: asString(metadata, 'planName'),
      };
    },
  },
  'subscription.deleted': {
    category: 'SUBSCRIPTION',
    project: (metadata, target) => {
      if (!matchesUser(metadata, target)) return null;
      return {
        subscriptionId: asString(metadata, 'subscriptionId'),
      };
    },
  },
  'subscription.upgraded': {
    category: 'SUBSCRIPTION',
    project: (metadata, target) => {
      if (!matchesUser(metadata, target)) return null;
      return {
        subscriptionId: asString(metadata, 'subscriptionId'),
        planName: asString(metadata, 'planName'),
      };
    },
  },
  'subscription.trial_granted': {
    category: 'SUBSCRIPTION',
    project: (metadata, target) => {
      if (!matchesUser(metadata, target)) return null;
      return {
        subscriptionId: asString(metadata, 'subscriptionId'),
        planName: asString(metadata, 'planName'),
      };
    },
  },
  'user_hwid_revoked': {
    category: 'SUBSCRIPTION',
    project: (metadata, target) => {
      if (!matchesUser(metadata, target)) return null;
      return {
        hwid: asString(metadata, 'hwid'),
        remainingDevices: asNumber(metadata, 'remainingDevices'),
      };
    },
  },

  // Payment lifecycle
  'payment.completed': {
    category: 'PAYMENT',
    project: (metadata, target) => {
      if (!matchesUser(metadata, target)) return null;
      return {
        paymentId: asString(metadata, 'paymentId'),
        amount: asNumber(metadata, 'amount'),
        currency: asString(metadata, 'currency'),
        gatewayType: asString(metadata, 'gatewayType'),
      };
    },
  },
  'payment.failed': {
    category: 'PAYMENT',
    severity: 'WARNING',
    project: (metadata, target) => {
      if (!matchesUser(metadata, target)) return null;
      return {
        paymentId: asString(metadata, 'paymentId'),
        gatewayType: asString(metadata, 'gatewayType'),
      };
    },
  },

  // Promocode + referral feedback
  'promocode.activated': {
    category: 'PROMOCODE',
    project: (metadata, target) => {
      if (!matchesUser(metadata, target)) return null;
      return {
        rewardType: asString(metadata, 'rewardType'),
      };
    },
  },
  'referral.qualified': {
    category: 'REFERRAL',
    project: (metadata, target) => {
      // Only the referrer should see this — match by referrerId, not the
      // referred user.
      const referrerId = asString(metadata, 'referrerId');
      if (referrerId === null || target.userId === null || referrerId !== target.userId) {
        return null;
      }
      return {
        referralId: asString(metadata, 'referralId'),
      };
    },
  },
  'referral.reward_issued': {
    category: 'REFERRAL',
    project: (metadata, target) => {
      const referrerId = asString(metadata, 'referrerId');
      if (referrerId === null || target.userId === null || referrerId !== target.userId) {
        return null;
      }
      return {
        rewardType: asString(metadata, 'rewardType'),
        rewardValue: asNumber(metadata, 'rewardValue'),
      };
    },
  },
};
