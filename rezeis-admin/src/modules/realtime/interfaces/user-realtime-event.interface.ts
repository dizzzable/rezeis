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
   * WHAT THE CUSTOMER READS. Required, and that is the fix.
   *
   * It was optional, described as being for "when the admin event text is not
   * public-safe" — which assumed the admin text usually is. It is not. Eleven
   * of the twelve whitelisted events had no override, so
   * `projection.message ?? event.message` forwarded the operator's own sentence
   * to a customer's screen as a toast, and those sentences are written for an
   * operator's feed:
   *
   *   "Remnawave profile created: rz_<their login>_vpn" — the operator's
   *   configured profile naming scheme, wrapped around the customer's own
   *   identifier.
   *
   *   "Payment completed for a BLOCKED customer: SUBSCRIPTION" — telling the
   *   customer they are blocked, with an internal purchase type.
   *
   *   "Promocode X reward synced with delay (enqueue failed: …)" — an internal
   *   queue failure, reason included.
   *
   * Required means a new entry cannot arrive without somebody deciding what a
   * customer should see, which is the only thing that stops this recurring.
   *
   * ── Why these strings are English ────────────────────────────────────────
   *
   * The cabinet localises by TYPE and falls back to this string, so an upgraded
   * cabinet shows the customer their own language and never renders these at
   * all. They exist for a cabinet that predates that — and those cabinets show
   * English today, so English here is the one choice that regresses nobody
   * while removing the leak.
   */
  readonly message: string;
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
  // Account lifecycle. This is intentionally terminal for the cabinet: the
  // client closes EventSource, clears its session, and redirects to sign-in.
  // Never project admin identity or any deleted-user PII.
  'user.deleted': {
    category: 'NOTIFICATION',
    severity: 'WARNING',
    message: 'Account deleted',
    project: (metadata, target) => {
      if (!matchesUser(metadata, target)) return null;
      return {};
    },
  },

  // Subscription lifecycle
  'subscription.created': {
    message: 'Your subscription is ready',
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
    message: 'Your subscription has been extended',
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
    message: 'Your subscription has ended',
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
    message: 'Your subscription has been removed',
    category: 'SUBSCRIPTION',
    project: (metadata, target) => {
      if (!matchesUser(metadata, target)) return null;
      return {
        subscriptionId: asString(metadata, 'subscriptionId'),
      };
    },
  },
  'subscription.upgraded': {
    message: 'Your subscription has been upgraded',
    category: 'SUBSCRIPTION',
    project: (metadata, target) => {
      if (!matchesUser(metadata, target)) return null;
      return {
        subscriptionId: asString(metadata, 'subscriptionId'),
        planName: asString(metadata, 'planName'),
      };
    },
  },
  // `subscription.trial_granted` IS DELIBERATELY NOT HERE.
  //
  // It was, while nothing emitted it — the entry was written ahead of an event
  // that did not exist. Giving it an emitter made the entry live, and it
  // carried two defects at once.
  //
  // The message. `message: projection.message ?? event.message` forwards the
  // event's own sentence when a projection does not override it, and this
  // event's sentence is written for the operator's feed: English, and naming
  // the Remnawave profile — the operator's configured prefix and suffix around
  // the customer's own identifier. A customer has no business reading their
  // provider's profile naming scheme, in a language they may not have chosen.
  //
  // The duplication. `subscription.created` is emitted one line before it for
  // the same act, and is on this list. The customer would be told twice.
  //
  // The customer's channel for this moment is the POP-UP: the ready-made
  // `tpl-trial-granted` template, in their own language, with a button to the
  // connect screen. Adding this back means writing a `message` override here
  // AND deciding what the second notification is for.
  'user_hwid_revoked': {
    message: 'A device has been unlinked from your subscription',
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
    message: 'Payment received',
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
    message: 'The payment did not go through',
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
    message: 'Your promo code has been applied',
    category: 'PROMOCODE',
    project: (metadata, target) => {
      if (!matchesUser(metadata, target)) return null;
      return {
        rewardType: asString(metadata, 'rewardType'),
      };
    },
  },
  'referral.qualified': {
    message: 'Your referral has been confirmed',
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
    message: 'A referral reward has been credited',
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
