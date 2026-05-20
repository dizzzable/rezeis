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

export async function getUpdateStatus(refresh = false): Promise<UpdateCheckResult> {
  const response = await api.get<UpdateCheckResult>(
    `/admin/update-checker/status${refresh ? '?refresh=true' : ''}`,
  )
  return response.data
}

export async function refreshUpdateStatus(): Promise<UpdateCheckResult> {
  const response = await api.post<UpdateCheckResult>('/admin/update-checker/refresh')
  return response.data
}
