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

export type MiniAppRoute =
  | '/dashboard'
  | '/renew'
  | '/referrals'
  | '/partner'
  | '/promo'
  | '/subscribe';

/**
 * Resolve a template `type` (e.g. `expires_in_3_days`,
 * `partner.earning`) to its terminal Mini App route. Defaults to the
 * dashboard when no rule matches — the operator can always wire a
 * specific button override on the template itself, which the composer
 * surfaces as an explicit edge.
 */
export function resolveTerminalRouteFor(type: string): MiniAppRoute {
  const t = type.toLowerCase();
  if (t.includes('expir') || t.includes('limited')) return '/renew';
  if (t.includes('partner')) return '/partner';
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
