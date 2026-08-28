import { api } from '@/lib/api'

export type BulkUserAction =
  | 'block'
  | 'unblock'
  | 'delete'
  | 'set_language'
  | 'set_max_subscriptions'
  | 'reset_traffic'
  | 'resync_profiles'
  | 'revoke_devices'
  | 'extend_subscription'

export interface BulkUserOperationItem {
  userId: string
  status: 'ok' | 'error' | 'skipped'
  message?: string
}

export interface BulkUserOperationResult {
  action: BulkUserAction
  total: number
  succeeded: number
  failed: number
  skipped: number
  items: readonly BulkUserOperationItem[]
  startedAt: string
  finishedAt: string
}

export interface BulkUserOperationInput {
  userIds: readonly string[]
  action: BulkUserAction
  payload?: Record<string, unknown>
}

/**
 * How long the browser waits for a bulk run before giving up on the answer.
 *
 * The shared client's 30 seconds is a sane default for a screen that fetches a
 * page; it is the wrong one here, and the difference costs money.
 *
 * The endpoint is synchronous and strictly sequential — up to a thousand
 * customers, and for the panel actions one live HTTPS call per profile, so a
 * few hundred users routinely runs past thirty seconds. Nest does not cancel
 * the handler when the browser walks away, so the work COMPLETES; only the
 * report is lost. The operator sees `timeout of 30000ms exceeded`, cannot tell
 * whether anything landed, and runs it again — and `extend_subscription` is not
 * idempotent, so every customer in that batch gets the days twice.
 *
 * Two minutes matches `proxy_read_timeout` on the deploy proxies, which is the
 * real ceiling: waiting longer than the proxy holds the connection only moves
 * the same failure one layer out.
 */
const BULK_OPERATION_TIMEOUT_MS = 120_000

export async function executeBulkUserOperation(
  input: BulkUserOperationInput,
): Promise<BulkUserOperationResult> {
  const response = await api.post<BulkUserOperationResult>('/admin/users/bulk', input, {
    timeout: BULK_OPERATION_TIMEOUT_MS,
  })
  return response.data
}
