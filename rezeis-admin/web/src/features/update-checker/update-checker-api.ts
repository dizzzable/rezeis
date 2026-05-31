import { api } from '@/lib/api'

export interface UpdateCheckResult {
  current: string
  latest: string | null
  hasUpdate: boolean
  publishedAt: string | null
  htmlUrl: string | null
  notes: string | null
  checkedAt: string
  source: 'github' | 'unknown'
  error: string | null
}

/**
 * Full update status: the panel fields are spread at the top level (legacy
 * shape) and `components` carries the per-service breakdown (panel + reiwa).
 */
export interface UpdateStatus extends UpdateCheckResult {
  components?: {
    panel: UpdateCheckResult
    reiwa: UpdateCheckResult
  }
}

export async function getUpdateStatus(refresh = false): Promise<UpdateStatus> {
  const response = await api.get<UpdateStatus>(
    `/admin/update-checker/status${refresh ? '?refresh=true' : ''}`,
  )
  return response.data
}

export async function refreshUpdateStatus(): Promise<UpdateStatus> {
  const response = await api.post<UpdateStatus>('/admin/update-checker/refresh')
  return response.data
}
