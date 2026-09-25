/**
 * notification-target-resolver
 * ────────────────────────────
 * Pure helper that maps a `NotificationTemplate.type` to its primary
 * Mini App terminal route — the cabinet page the user is most likely
 * trying to reach when they tap on a notification's action button.
 *
 * Mirrors `resolveNotificationPushUrl` in
 * `user-notifications.service.ts` so the canvas list and the cabinet
 * web-push deep-link agree on destinations. Kept separate so the
 * bot-map module doesn't import from notifications/ (which would
 * create a module dependency cycle through future broadcast features).
 */

import type { MiniAppRoute } from '../catalogs/mini-app-terminals.catalog';

// One list of cabinet routes: the catalog's. This file used to keep a copy of
// the union, which two lists of routes would have let drift apart.
export type { MiniAppRoute };

/**
 * Resolve a template `type` (e.g. `expires_in_3_days`,
 * `partner.earning`) to its terminal Mini App route. Defaults to the
 * dashboard when no rule matches — the operator can always wire a
 * specific button override on the template itself, which the composer
 * surfaces as an explicit edge.
 */
export function resolveTerminalRouteFor(type: string): MiniAppRoute {
  const t = type.toLowerCase();
  // «Помощь с подключением»: its deep link is `/dashboard?connect=help`, and
  // the dashboard is the page that opens the connection screen from it.
  if (isConnectHelpType(t)) return '/dashboard';
  // «Докупка не применена»: support, where «мы разберёмся» happens.
  if (t === ADD_ON_NOT_APPLIED_TYPE) return '/support';
  // An add-on's end, or its approach: the add-on page, where it is bought again.
  if (isAddOnNoticeType(t)) return '/addons';
  if (t.includes('support')) return '/support';
  if (t.includes('expir') || t.includes('limited')) return '/renew';
  if (t.includes('partner')) return '/partner';
  // Points before referrals: a points row belongs on the exchange, and
  // `points_cashback_*` carries neither word, so it would otherwise land on
  // the dashboard. Kept in step with `resolveNotificationPushUrl`.
  if (t.includes('points') || t.includes('cashback')) return '/referrals';
  if (t.includes('referral')) return '/referrals';
  if (t.includes('promocode')) return '/promo';
  if (t.includes('broadcast') || t.includes('news')) return '/dashboard';
  return '/dashboard';
}

/**
 * Bucket a template into one of a handful of categories used by the
 * left rail's grouping. The same prefix logic as the SPA notifications
 * page so the order in the rail matches what operators already know.
 */
export type NotificationCategory =
  | 'expires'
  | 'referral'
  | 'partner'
  | 'promocode'
  | 'system'
  | 'other';

export function resolveNotificationCategory(type: string): NotificationCategory {
  const t = type.toLowerCase();
  // A notice about the state of a subscription, so it sits with the other
  // subscription notices (expiry, traffic) rather than under «Прочее». The
  // rail has no group of its own for them; one would need the SPA's group
  // list and labels as well as this function.
  if (isConnectHelpType(t)) return 'expires';
  // An add-on of a subscription ending: with the subscription's own notices.
  if (isAddOnNoticeType(t)) return 'expires';
  if (t.startsWith('expires_') || t === 'expired' || t === 'limited' || t.startsWith('expired_')) {
    return 'expires';
  }
  if (t.startsWith('referral')) return 'referral';
  if (t.startsWith('partner')) return 'partner';
  if (t.startsWith('promocode')) return 'promocode';
  if (
    t.startsWith('bot_') ||
    t.startsWith('user_') ||
    t.startsWith('web_') ||
    t === 'access_policy' ||
    t === 'subscription' ||
    t === 'node_status' ||
    t === 'trial_getted'
  ) {
    return 'system';
  }
  return 'other';
}

/** Both types of «Помощь с подключением»: paid, and trial or gift. */
function isConnectHelpType(lowerCaseType: string): boolean {
  return lowerCaseType === 'connect_help' || lowerCaseType === 'connect_help_trial';
}

/**
 * A dated add-on three days before its end, or at it — the six `addon_*` types.
 * «Докупка не применена» (`addon_not_applied`) shares the prefix: it is filed
 * with them, but `resolveTerminalRouteFor` routes it before it asks this.
 */
function isAddOnNoticeType(lowerCaseType: string): boolean {
  return lowerCaseType.startsWith('addon_');
}

/**
 * «Докупка не применена»: a payment an inactive subscription could not take.
 * The same literal as the catalogue's `ADD_ON_NOT_APPLIED_NOTICE_TYPE` — this
 * file does not import from notifications/ (see the header).
 */
const ADD_ON_NOT_APPLIED_TYPE = 'addon_not_applied';
