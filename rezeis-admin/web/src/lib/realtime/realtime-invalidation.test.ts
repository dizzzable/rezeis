import { describe, expect, it } from 'vitest'

import { adminQueryKeys } from '@/lib/admin-query-keys'

import { getRealtimeInvalidationKeys } from './realtime-invalidation'

describe('realtime query invalidation keys', () => {
  it('invalidates payment lists, analytics, dashboard, and audit for payment changes', () => {
    expect(getRealtimeInvalidationKeys({ type: 'payment.completed' })).toEqual([
      adminQueryKeys.payments.transactions.all,
      adminQueryKeys.payments.analytics.all,
      adminQueryKeys.dashboard.summary,
      adminQueryKeys.audit.all,
    ])
  })

  it('invalidates webhook event lists and webhook analytics for payment webhooks', () => {
    expect(getRealtimeInvalidationKeys({ type: 'payment.webhook_received' })).toEqual([
      adminQueryKeys.payments.webhooks.all,
      adminQueryKeys.payments.analytics.all,
      adminQueryKeys.audit.all,
    ])
  })

  it('invalidates the real backup, broadcast, subscription, and notification keys', () => {
    expect(getRealtimeInvalidationKeys({ type: 'system.backup_completed' })).toEqual([
      adminQueryKeys.backups.all,
      adminQueryKeys.audit.all,
    ])
    expect(getRealtimeInvalidationKeys({ type: 'system.broadcast_sent' })).toEqual([
      adminQueryKeys.broadcast.all,
      adminQueryKeys.dashboard.summary,
      adminQueryKeys.audit.all,
    ])
    expect(getRealtimeInvalidationKeys({ type: 'subscription.renewed' })).toEqual([
      adminQueryKeys.subscriptions.all,
      adminQueryKeys.dashboard.summary,
      adminQueryKeys.audit.all,
    ])
    expect(getRealtimeInvalidationKeys({ type: 'notification.template.updated' })).toEqual([
      adminQueryKeys.notifications.templates,
      adminQueryKeys.audit.all,
    ])
    expect(getRealtimeInvalidationKeys({ type: 'settings.email.updated' })).toEqual([
      adminQueryKeys.email.settings,
      adminQueryKeys.audit.all,
    ])
  })

  it('always invalidates audit for unmapped events', () => {
    expect(getRealtimeInvalidationKeys({ type: 'unknown.event' })).toEqual([
      adminQueryKeys.audit.all,
    ])
  })
})
