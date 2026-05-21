import { api } from '@/lib/api'

export type BulkUserAction =
  | 'block'
  | 'unblock'
  | 'delete'
  | 'set_language'
  | 'set_max_subscriptions'

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

export async function executeBulkUserOperation(
  input: BulkUserOperationInput,
): Promise<BulkUserOperationResult> {
  const response = await api.post<BulkUserOperationResult>('/admin/users/bulk', input)
  return response.data
}
