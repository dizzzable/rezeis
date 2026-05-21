import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Trash2, RefreshCw, Pause, Play } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

import {
  clearSystemLogs,
  getSystemLogLevel,
  listSystemLogs,
  setSystemLogLevel,
  type LogLevel,
  type SystemLogEntry,
} from './system-logs-api'

const LEVEL_ORDER: LogLevel[] = ['fatal', 'error', 'warn', 'log', 'debug', 'verbose']

const LEVEL_COLOR: Record<LogLevel, string> = {
  fatal: 'text-red-600',
  error: 'text-destructive',
  warn: 'text-amber-500',
  log: 'text-foreground',
  debug: 'text-blue-500',
  verbose: 'text-muted-foreground',
}

/**
 * Phase 8 — System logs viewer.
 *
 * Backed by the in-memory ring buffer in `SystemLogsService`. The page
 * polls every 2 seconds while live tailing is enabled and uses an
 * `afterId` cursor so the buffer doesn't get re-streamed on every tick.
 */
export default function SystemLogsPage({ embedded = false }: { readonly embedded?: boolean } = {}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const levelQuery = useQuery({
    queryKey: ['system-logs', 'level'],
    queryFn: getSystemLogLevel,
    staleTime: 30_000,
  })

  const [filterLevel, setFilterLevel] = useState<LogLevel | 'ALL'>('ALL')
  const [search, setSearch] = useState('')
  const [paused, setPaused] = useState(false)
  const [entries, setEntries] = useState<SystemLogEntry[]>([])
  const cursor = useRef<number>(0)

  const logsQuery = useQuery({
    queryKey: ['system-logs', filterLevel, search],
    queryFn: async () => {
      const result = await listSystemLogs({
        afterId: cursor.current,
        level: filterLevel === 'ALL' ? undefined : filterLevel,
        search: search.trim() || undefined,
        limit: 500,
      })
      return result
    },
    refetchInterval: paused ? false : 2_000,
    refetchIntervalInBackground: false,
  })

  // Whenever filter/search changes, reset the buffer and cursor.
  const filterKey = `${filterLevel}|${search}`
  const lastFilterKey = useRef(filterKey)
  useEffect(() => {
    if (lastFilterKey.current !== filterKey) {
      setEntries([])
      cursor.current = 0
      lastFilterKey.current = filterKey
    }
  }, [filterKey])

  // Append new entries returned by the latest poll.
  useEffect(() => {
    if (!logsQuery.data) return
    const fresh = logsQuery.data.entries
    if (fresh.length === 0) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- TODO: refactor to derive state
    setEntries((prev) => {
      // The API returns newest first; reverse so we display oldest at top.
      const merged = [...prev, ...[...fresh].reverse()]
      // Keep at most 5_000 lines on screen — same as the backend buffer.
      if (merged.length > 5_000) merged.splice(0, merged.length - 5_000)
      return merged
    })
    cursor.current = Math.max(cursor.current, logsQuery.data.latestId)
  }, [logsQuery.data])

  const setLevelMutation = useMutation({
    mutationFn: setSystemLogLevel,
    onSuccess: (data) => {
      queryClient.setQueryData(['system-logs', 'level'], data)
    },
  })

  const clearMutation = useMutation({
    mutationFn: clearSystemLogs,
    onSuccess: () => {
      setEntries([])
      cursor.current = 0
      queryClient.invalidateQueries({ queryKey: ['system-logs'] })
    },
  })

  const filtered = useMemo(() => entries, [entries])

  return (
    <div className="space-y-4">
      {!embedded && (
        <div>
          <h1 className="text-2xl font-bold">{t('systemLogsPage.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('systemLogsPage.subtitle')}</p>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('systemLogsPage.controls.title')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label>{t('systemLogsPage.controls.activeLevel')}</Label>
            <div className="flex gap-1">
              {LEVEL_ORDER.map((level) => (
                <Button
                  key={level}
                  size="sm"
                  variant={levelQuery.data?.level === level ? 'default' : 'outline'}
                  onClick={() => setLevelMutation.mutate(level)}
                  disabled={setLevelMutation.isPending}
                >
                  {level}
                </Button>
              ))}
            </div>
          </div>

          <div className="space-y-1">
            <Label>{t('systemLogsPage.controls.filter')}</Label>
            <div className="flex gap-1">
              <Button
                size="sm"
                variant={filterLevel === 'ALL' ? 'default' : 'outline'}
                onClick={() => setFilterLevel('ALL')}
              >
                {t('systemLogsPage.controls.all')}
              </Button>
              {LEVEL_ORDER.map((level) => (
                <Button
                  key={level}
                  size="sm"
                  variant={filterLevel === level ? 'default' : 'outline'}
                  onClick={() => setFilterLevel(level)}
                >
                  {level}
                </Button>
              ))}
            </div>
          </div>

          <div className="space-y-1 min-w-[220px] flex-1">
            <Label htmlFor="log-search">{t('systemLogsPage.controls.searchLabel')}</Label>
            <Input
              id="log-search"
              placeholder={t('systemLogsPage.controls.searchPlaceholder')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setPaused((p) => !p)}>
              {paused ? <Play className="mr-2 h-4 w-4" /> : <Pause className="mr-2 h-4 w-4" />}
              {paused ? t('systemLogsPage.controls.resume') : t('systemLogsPage.controls.pause')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => logsQuery.refetch()}
              disabled={logsQuery.isFetching}
            >
              {logsQuery.isFetching ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="mr-2 h-4 w-4" />
              )}
              {t('systemLogsPage.controls.refresh')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                if (confirm(t('systemLogsPage.controls.clearConfirm'))) {
                  clearMutation.mutate()
                }
              }}
              disabled={clearMutation.isPending}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              {t('systemLogsPage.controls.clear')}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {t('systemLogsPage.tail.heading', { count: filtered.length })}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="max-h-[60vh] overflow-y-auto font-mono text-xs">
            {filtered.length === 0 ? (
              <p className="px-4 py-3 text-muted-foreground">
                {t('systemLogsPage.tail.empty')}
              </p>
            ) : (
              <table className="w-full">
                <tbody>
                  {filtered.map((entry) => (
                    <tr key={entry.id} className="border-b align-top last:border-0">
                      <td className="whitespace-nowrap px-3 py-1 text-muted-foreground">
                        {entry.timestamp.slice(11, 19)}
                      </td>
                      <td className={`px-3 py-1 ${LEVEL_COLOR[entry.level]}`}>
                        {entry.level}
                      </td>
                      <td className="whitespace-nowrap px-3 py-1 text-muted-foreground">
                        {entry.context ?? '—'}
                      </td>
                      <td className="px-3 py-1 break-all">
                        {entry.message}
                        {entry.stack && (
                          <details className="text-muted-foreground">
                            <summary className="cursor-pointer text-xs">
                              {t('systemLogsPage.tail.stack')}
                            </summary>
                            <pre className="mt-1 overflow-x-auto whitespace-pre-wrap text-[10px]">
                              {entry.stack}
                            </pre>
                          </details>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
