import type { QueryKey } from '@tanstack/react-query'

import { adminQueryKeys } from '@/lib/admin-query-keys'

import type { RealtimeEvent } from './realtime-types'

type InvalidationKey = QueryKey

const TYPE_TO_QUERY_KEYS: Record<string, readonly InvalidationKey[]> = {
  // User domain
  'user.registered': [adminQueryKeys.dashboard.summary, adminQueryKeys.users.all],
  'user.web_registered': [adminQueryKeys.dashboard.summary, adminQueryKeys.users.all],
  'user.blocked': [adminQueryKeys.users.all],
  'user.unblocked': [adminQueryKeys.users.all],
  'user.deleted': [adminQueryKeys.users.all, adminQueryKeys.dashboard.summary],

  // Subscription domain
  'subscription.created': [adminQueryKeys.subscriptions.all, adminQueryKeys.dashboard.summary],
  'subscription.renewed': [adminQueryKeys.subscriptions.all, adminQueryKeys.dashboard.summary],
  'subscription.upgraded': [adminQueryKeys.subscriptions.all, adminQueryKeys.dashboard.summary],
  'subscription.expired': [adminQueryKeys.subscriptions.all, adminQueryKeys.dashboard.summary],
  'subscription.deleted': [adminQueryKeys.subscriptions.all, adminQueryKeys.dashboard.summary],
  'subscription.synced': [adminQueryKeys.subscriptions.all],
  'subscription.trial_granted': [adminQueryKeys.subscriptions.all, adminQueryKeys.dashboard.summary],

  // Payment domain
  'payment.checkout_created': [
    adminQueryKeys.payments.transactions.all,
    adminQueryKeys.payments.analytics.all,
    adminQueryKeys.dashboard.summary,
  ],
  'payment.completed': [
    adminQueryKeys.payments.transactions.all,
    adminQueryKeys.payments.analytics.all,
    adminQueryKeys.dashboard.summary,
  ],
  'payment.failed': [
    adminQueryKeys.payments.transactions.all,
    adminQueryKeys.payments.analytics.all,
    adminQueryKeys.dashboard.summary,
  ],
  'payment.webhook_received': [
    adminQueryKeys.payments.webhooks.all,
    adminQueryKeys.payments.analytics.all,
  ],

  // Referral / partner / promo domains
  'referral.attached': [['admin', 'referrals'] as const],
  'referral.qualified': [['admin', 'referrals'] as const],
  'referral.reward_issued': [['admin', 'referrals'] as const],
  'partner.created': [['admin', 'partners'] as const],
  'partner.activated': [['admin', 'partners'] as const],
  'partner.deactivated': [['admin', 'partners'] as const],
  'partner.balance_adjusted': [['admin', 'partners'] as const],
  'partner.earning': [['admin', 'partners'] as const],
  'partner.withdrawal_requested': [['admin', 'partners'] as const],
  'partner.withdrawal_approved': [['admin', 'partners'] as const],
  'partner.withdrawal_rejected': [['admin', 'partners'] as const],
  'promocode.activated': [['admin', 'promocodes'] as const],
  'promocode.created': [['admin', 'promocodes'] as const],

  // Fraud signals
  'fraud.signal_transitioned': [['admin', 'fraud', 'signals'] as const, ['admin', 'fraud', 'stats'] as const],
  'system.error': [['admin', 'fraud', 'signals'] as const, ['admin', 'fraud', 'stats'] as const],

  // Admin settings / notifications
  'settings.notifications.updated': [adminQueryKeys.settings.all],
  'settings.telegramDelivery.updated': [adminQueryKeys.settings.all],
  'settings.email.updated': [adminQueryKeys.email.settings],
  'notification.template.created': [adminQueryKeys.notifications.templates],
  'notification.template.updated': [adminQueryKeys.notifications.templates],
  'notification.template.deleted': [adminQueryKeys.notifications.templates],
  'notification.template.seeded': [adminQueryKeys.notifications.templates],

  // System
  'system.backup_completed': [adminQueryKeys.backups.all],
  'system.broadcast_sent': [adminQueryKeys.broadcast.all, adminQueryKeys.dashboard.summary],

  // Support tickets (operator queue realtime — Phase 4). A guest/user message
  // fires a SUPPORT event the operator socket receives; invalidate the queue
  // list + any open thread so the operator sees it without waiting on the
  // 5s poll. Polling remains as the fallback when the socket is down.
  'support.ticket_created': [['support-tickets'] as const, adminQueryKeys.dashboard.summary],
  'support.ticket_user_reply': [['support-tickets'] as const, ['support-ticket'] as const],
}

/**
 * Every event also lands in the audit log via `SystemEventsService.persistEvent`,
 * so any received event triggers an audit refresh.
 */
const ALWAYS_INVALIDATE: readonly InvalidationKey[] = [adminQueryKeys.audit.all]

export function getRealtimeInvalidationKeys(event: Pick<RealtimeEvent, 'type'>): readonly InvalidationKey[] {
  return [...(TYPE_TO_QUERY_KEYS[event.type] ?? []), ...ALWAYS_INVALIDATE]
}
