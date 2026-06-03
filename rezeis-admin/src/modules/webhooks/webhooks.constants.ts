/**
 * Phase 6 webhook subscription queue + dispatcher constants.
 *
 * Centralised so both the producer (SystemEvents bridge) and consumer
 * (BullMQ processor) read from the same source.
 */

export const WEBHOOK_DELIVERY_QUEUE = 'webhook-delivery';

/**
 * Retry schedule (in seconds) — exponential-ish backoff. Five attempts
 * total, after which the delivery is marked `FAILED` and counted toward
 * the consecutive-failure threshold.
 */
export const WEBHOOK_RETRY_DELAYS_SEC: readonly number[] = [
  60,        //  1 minute
  300,       //  5 minutes
  900,       // 15 minutes
  3_600,     //  1 hour
  21_600,    //  6 hours
];

export const MAX_DELIVERY_ATTEMPTS = WEBHOOK_RETRY_DELAYS_SEC.length;

/**
 * Cap on response-body bytes stored alongside a delivery row. Keeps
 * pathological 10MB error pages from filling the table.
 */
export const MAX_RESPONSE_BODY_PREVIEW = 2_048;

/**
 * Auto-disable threshold — once a subscription racks up this many
 * consecutive failed deliveries, the dispatcher flips `isActive=false`
 * and emits a `system.webhook_auto_disabled` event so operators are
 * notified.
 */
export const AUTO_DISABLE_THRESHOLD = 10;

/**
 * Per-attempt HTTP timeout. Webhook receivers should be quick — anything
 * over 15s is almost certainly a hung connection.
 */
export const DELIVERY_TIMEOUT_MS = 15_000;

/**
 * Catalog of pre-defined event types the UI shows in the picker. Mirrors
 * `EVENT_TYPES` in `system-events.service.ts` — stored separately to
 * avoid pulling that whole module into the controller layer.
 */
export const WEBHOOK_EVENT_CATALOG = [
  // User lifecycle
  'user.registered',
  'user.web_registered',
  'user.blocked',
  'user.unblocked',
  'user.deleted',
  'user.role_changed',
  'user.telegram_linked',
  'user.email_linked',
  // Auth
  'auth.web_login',
  'auth.password_changed',
  'auth.password_recovery',
  // Subscription
  'subscription.created',
  'subscription.renewed',
  'subscription.upgraded',
  'subscription.expired',
  'subscription.deleted',
  'subscription.synced',
  'subscription.trial_granted',
  // Payments
  'payment.checkout_created',
  'payment.completed',
  'payment.failed',
  'payment.webhook_received',
  // Referrals
  'referral.attached',
  'referral.qualified',
  'referral.reward_issued',
  'referral.manual_attached',
  // Partners
  'partner.created',
  'partner.activated',
  'partner.deactivated',
  'partner.earning',
  'partner.withdrawal_requested',
  'partner.withdrawal_approved',
  'partner.withdrawal_rejected',
  'partner.balance_adjusted',
  // Promocodes
  'promocode.activated',
  'promocode.created',
  'promocode.depleted',
  // System
  'system.startup',
  'system.backup_completed',
  'system.broadcast_sent',
  'settings.email.updated',
  'notification.template.created',
  'notification.template.updated',
  'notification.template.deleted',
  'notification.template.seeded',
  'system.error',
  'system.remnawave_sync',
  'system.webhook_auto_disabled',
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_CATALOG)[number];
