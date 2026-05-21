import { api } from '@/lib/api'

export type LogLevel = 'fatal' | 'error' | 'warn' | 'log' | 'debug' | 'verbose'

export interface SystemLogEntry {
  id: number
  timestamp: string
  level: LogLevel
  context: string | null
  message: string
  stack?: string | null
}

export interface SystemLogsListResponse {
  entries: readonly SystemLogEntry[]
  latestId: number
}

export interface SystemLogsQuery {
  limit?: number
  afterId?: number
  level?: LogLevel
  context?: string
  search?: string
}

export async function listSystemLogs(query: SystemLogsQuery = {}): Promise<SystemLogsListResponse> {
  const params = new URLSearchParams()
  if (query.limit) params.set('limit', String(query.limit))
  if (query.afterId !== undefined) params.set('afterId', String(query.afterId))
  if (query.level) params.set('level', query.level)
  if (query.context) params.set('context', query.context)
  if (query.search) params.set('search', query.search)
  const qs = params.toString()
  const response = await api.get<SystemLogsListResponse>(
    `/admin/system-logs${qs ? `?${qs}` : ''}`,
  )
  return response.data
}

export async function getSystemLogLevel(): Promise<{ level: LogLevel }> {
  const response = await api.get<{ level: LogLevel }>('/admin/system-logs/level')
  return response.data
}

export async function setSystemLogLevel(level: LogLevel): Promise<{ level: LogLevel }> {
  const response = await api.patch<{ level: LogLevel }>('/admin/system-logs/level', { level })
  return response.data
}

export async function clearSystemLogs(): Promise<void> {
  await api.delete('/admin/system-logs')
}
