/**
 * Event constants for the event-driven architecture.
 * Inspired by remnawave backend-main EventEmitter2 pattern.
 *
 * Convention: DOMAIN.ACTION (wildcard support via '.')
 */
export const EVENTS = {
  // ── Admin ───────────────────────────────────────────────────────────────
  ADMIN_LOGGED_IN: 'admin.logged_in',
  ADMIN_CREATED: 'admin.created',
  ADMIN_DELETED: 'admin.deleted',

  // ── Users ───────────────────────────────────────────────────────────────
  USER_CREATED: 'user.created',
  USER_BLOCKED: 'user.blocked',
  USER_UNBLOCKED: 'user.unblocked',

  // ── Subscriptions ───────────────────────────────────────────────────────
  SUBSCRIPTION_CREATED: 'subscription.created',
  SUBSCRIPTION_EXPIRED: 'subscription.expired',
  SUBSCRIPTION_RENEWED: 'subscription.renewed',
  SUBSCRIPTION_CANCELLED: 'subscription.cancelled',

  // ── Payments ────────────────────────────────────────────────────────────
  PAYMENT_COMPLETED: 'payment.completed',
  PAYMENT_FAILED: 'payment.failed',
  PAYMENT_REFUNDED: 'payment.refunded',
  WEBHOOK_RECEIVED: 'webhook.received',

  // ── Promocodes ──────────────────────────────────────────────────────────
  PROMOCODE_ACTIVATED: 'promocode.activated',

  // ── Referrals ───────────────────────────────────────────────────────────
  REFERRAL_QUALIFIED: 'referral.qualified',
  REFERRAL_REWARD_ISSUED: 'referral.reward_issued',

  // ── Partners ────────────────────────────────────────────────────────────
  WITHDRAWAL_APPROVED: 'partner.withdrawal_approved',
  WITHDRAWAL_REJECTED: 'partner.withdrawal_rejected',

  // ── Broadcast ───────────────────────────────────────────────────────────
  BROADCAST_STARTED: 'broadcast.started',
  BROADCAST_COMPLETED: 'broadcast.completed',

  // ── System ──────────────────────────────────────────────────────────────
  BACKUP_CREATED: 'system.backup_created',
  SETTINGS_UPDATED: 'system.settings_updated',
  NODE_STATUS: 'system.node_status',
  USER_FIRST_CONNECTED: 'system.user_first_connected',
} as const;

export type EventName = (typeof EVENTS)[keyof typeof EVENTS];
