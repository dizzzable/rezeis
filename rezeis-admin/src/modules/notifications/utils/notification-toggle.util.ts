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

/**
 * The notification types a SUBSCRIBER may switch off for themselves.
 *
 * A closed list on purpose. `support_reply`, `ADMIN_MESSAGE` and the
 * operator's own sends are conversations somebody started with this person —
 * an opt-out there would let a customer silence the answer to their own
 * question. What is here is the expiry family: reminders the system sends on
 * its own schedule, which is exactly the kind a person is entitled to stop.
 *
 * The cabinet's switches are keyed by these values, so adding one here is
 * also what makes a new switch possible.
 */
export const SUBSCRIBER_MUTABLE_NOTIFICATION_TYPES = [
  'expires_in_3_days',
  'expires_in_2_days',
  'expires_in_1_days',
  'expired',
  'expired_1_day_ago',
] as const;

export type SubscriberMutableNotificationType =
  (typeof SUBSCRIBER_MUTABLE_NOTIFICATION_TYPES)[number];

/**
 * Whether this subscriber still wants the PUSH channels for `type`.
 *
 * Opt-OUT, like the operator map above: an absent key, a malformed column and
 * a customer who never opened the screen all mean "send it". The direction
 * matters — the inverse would silence every subscriber who predates the
 * feature.
 *
 * The cabinet feed row is written regardless, and that is deliberate: the
 * switch says "stop pushing this at me", not "hide it from me". A customer
 * who opens the app should still find out their subscription ended.
 */
export function isSubscriberNotificationEnabled(prefs: unknown, type: string): boolean {
  // Canonicalize FIRST, exactly as the operator gate above does. An event
  // fired under a legacy alias (`subscription_expiring_3d` and friends)
  // renders fine, because `fetchTemplate` canonicalizes too — so without this
  // the alias would sail past a switch the subscriber had turned off, and the
  // one delivery a person explicitly asked to stop is the one that arrives.
  const key = resolveToggleKey(type);
  if (!isSubscriberMutableType(key)) return true;
  if (prefs === null || typeof prefs !== 'object' || Array.isArray(prefs)) return true;
  return (prefs as Record<string, unknown>)[key] !== false;
}

/** Whether `key` is one of the switches a subscriber owns. Canonical keys only. */
function isSubscriberMutableType(key: string): boolean {
  return (SUBSCRIBER_MUTABLE_NOTIFICATION_TYPES as readonly string[]).includes(key);
}

/**
 * Whether a notification of `type` may be sent to a customer's INBOX.
 *
 * Deliberately the same closed list the subscriber's switches are built from,
 * and that is the whole point: most addresses on file were given to sign in,
 * not to hear from the product. Mail is the one channel a person cannot
 * dismiss with a swipe, so the product may only use it for messages the
 * recipient can also switch off — anything else is a letter with no "stop"
 * on the other end of it.
 *
 * Without this the operator's single `notifyUsers` switch opened the inbox to
 * every active template — cashback, referrals, promo codes, partner payouts,
 * placement approvals — while the cabinet offered a way to stop exactly five.
 */
export function isSubscriberMailableType(type: string): boolean {
  return isSubscriberMutableType(resolveToggleKey(type));
}

/**
 * Narrow an arbitrary payload down to the switches this build knows, so a
 * client cannot store keys nobody reads — or mute a type it was never
 * allowed to.
 */
export function readSubscriberNotificationPrefs(input: unknown): Record<string, boolean> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return {};
  const source = input as Record<string, unknown>;
  const out: Record<string, boolean> = {};
  for (const type of SUBSCRIBER_MUTABLE_NOTIFICATION_TYPES) {
    const value = source[type];
    if (typeof value === 'boolean') out[type] = value;
  }
  return out;
}
