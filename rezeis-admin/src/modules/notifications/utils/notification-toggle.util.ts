/**
 * Notification toggle resolution.
 *
 * The admin panel persists two opt-out maps on the `Settings` singleton:
 *   - `userNotifications`   — gates user-facing delivery (Telegram bot + web-push)
 *   - `systemNotifications` — gates the operator firehose (admin group)
 *
 * Keys in those maps are notification slugs that match the
 * `USER_NOTIFICATION_KEYS` / `SYSTEM_NOTIFICATION_KEYS` arrays in the SPA
 * and the `NotificationTemplate.type` catalog. Emitters, however,
 * historically fired a few divergent `type` strings (e.g. auto-renew used
 * `subscription_expiring_3d` while the toggle/template key is
 * `expires_in_3_days`). This map normalises those legacy aliases so a
 * single canonical key drives the template lookup AND the toggle gate.
 *
 * New emitters should fire the canonical key directly — the alias map is
 * only here to keep older rows / in-flight events working through the
 * transition.
 */
const TYPE_ALIAS_TO_TOGGLE_KEY: Readonly<Record<string, string>> = {
  // Auto-renew expiry warnings — legacy fired strings → catalog keys.
  subscription_expiring_3d: 'expires_in_3_days',
  subscription_expiring_2d: 'expires_in_2_days',
  subscription_expiring_1d: 'expires_in_1_days',
  subscription_expired: 'expired',
  subscription_limited: 'limited',
  // Partner dot-notation events → underscore toggle keys.
  'partner.earning': 'partner_earning',
  'partner.withdrawal_approved': 'partner_withdrawal_completed',
  'partner.withdrawal_rejected': 'partner_withdrawal_rejected',
  'partner.withdrawal_request_created': 'partner_withdrawal_request_created',
  // Referral dot-notation → underscore.
  'referral.attached': 'referral_attached',
  'referral.reward': 'referral_reward',
  'referral.qualified': 'referral_qualified',
};

/**
 * Resolve a fired notification `type` to the canonical toggle / template
 * key. Identity when no alias is registered.
 */
export function resolveToggleKey(type: string): string {
  return TYPE_ALIAS_TO_TOGGLE_KEY[type] ?? type;
}

/**
 * Decide whether a notification of `type` is enabled for user-facing
 * delivery given the operator's `userNotifications` toggle map.
 *
 * Opt-out semantics: a key that is absent / null / anything-but-false is
 * treated as enabled. Only an explicit `false` suppresses delivery. This
 * matches the SPA's `notifSettings[key] ?? true` default so an empty
 * settings record (fresh install) sends every notification.
 *
 * `ADMIN_MESSAGE` and any other operator-initiated explicit sends are
 * never gated here because their type isn't in the toggle catalog —
 * they fall through to the opt-out default and always deliver.
 */
export function isNotificationDeliveryEnabled(
  toggleMap: Record<string, unknown>,
  type: string,
): boolean {
  const key = resolveToggleKey(type);
  const value = toggleMap[key];
  if (value === undefined || value === null) return true;
  return value !== false;
}
