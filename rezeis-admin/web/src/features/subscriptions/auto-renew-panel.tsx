/**
 * Auto-renewal operator surface.
 * ──────────────────────────────
 * Reader for `admin/auto-renew` (`AdminAutoRenewController`), which had no
 * caller anywhere in the SPA:
 *
 *   GET  admin/auto-renew/status  → `auto_renew:view` (class-level)
 *   POST admin/auto-renew/run     → `auto_renew:run`  (handler-level)
 *
 * `RbacGuard` resolves the decorator with `reflector.getAllAndOverride`, so
 * the handler-level `@RequirePermission` on `run` REPLACES the class-level
 * one rather than adding to it: `run` alone is what the POST demands. The two
 * are gated separately here for the same reason — the stock `operator` role
 * ships with `auto_renew:view` and no `run`.
 *
 * Why it lives on the Subscriptions page: the cycle is subscription
 * lifecycle. It marks subscriptions expired, sends the 3-day/1-day expiry
 * warnings and charges saved payment methods — exactly the states the stat
 * tiles above it count. The controller's own docblock says the run button is
 * for "investigating support reports", and a support report about a
 * subscription that did not renew is read on this page.
 *
 * `POST run` is SYNCHRONOUS: `AutoRenewScheduler.runOnce()` awaits
 * `AutoRenewService.runCycle()` and returns its result — it does not enqueue.
 * So the interaction is: confirm first (it moves real money), keep the button
 * disabled for the whole request (a second cycle in parallel would race the
 * per-subscription idempotency keys rather than being cleanly deduped), and
 * report the returned numbers when it lands.
 */
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, PlayCircle, RefreshCw, RotateCw } from 'lucide-react'
import { toast } from 'sonner'

import { api } from '@/lib/api'
import { adminQueryKeys } from '@/lib/admin-query-keys'
import { getErrorMessage } from '@/lib/http-errors'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { PermissionGate, useHasPermission } from '@/features/rbac'
import { cn } from '@/lib/utils'

/** Mirrors `AutoRenewCycleResult`. */
interface AutoRenewCycleResult {
  readonly expired: number
  readonly warnings3d: number
  readonly warnings1d: number
  readonly autopayAttempted: number
  readonly autopaySucceeded: number
  readonly autopayFailed: number
  readonly autopaySkipped: number
  readonly finishedAt: string
  readonly durationMs: number
}

/** Mirrors `AutoRenewScheduler.getStatus()`. */
interface AutoRenewStatus {
  readonly lastResult: AutoRenewCycleResult | null
  readonly cron: string
}

const METRIC_KEYS = [
  'expired',
  'warnings3d',
  'warnings1d',
  'autopayAttempted',
  'autopaySucceeded',
  'autopayFailed',
  'autopaySkipped',
] as const

/**
 * Prefix-compatible with the `['admin', …]` convention used by
 * `adminQueryKeys`. Kept local — nothing else reads auto-renew status.
 */
const AUTO_RENEW_STATUS_KEY = ['admin', 'auto-renew', 'status'] as const

function toCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

export function AutoRenewPanel() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const canView = useHasPermission('auto_renew', 'view')

  const { data, isLoading, isFetching, refetch } = useQuery<AutoRenewStatus>({
    queryKey: AUTO_RENEW_STATUS_KEY,
    queryFn: async ({ signal }) =>
      (await api.get<AutoRenewStatus>('/admin/auto-renew/status', { signal })).data,
    enabled: canView,
  })

  const runMutation = useMutation({
    mutationFn: async () =>
      (await api.post<AutoRenewCycleResult>('/admin/auto-renew/run', {})).data,
    onSuccess: (result) => {
      // The cycle rewrites subscription statuses, so the list and the stat
      // tiles on this page are stale the moment it returns.
      queryClient.invalidateQueries({ queryKey: AUTO_RENEW_STATUS_KEY })
      queryClient.invalidateQueries({ queryKey: adminQueryKeys.subscriptions.all })
      toast.success(
        t('autoRenewPanel.ranOk', {
          expired: toCount(result?.expired),
          charged: toCount(result?.autopaySucceeded),
        }),
      )
    },
    onError: (err) => toast.error(getErrorMessage(err, t('autoRenewPanel.runFailed'))),
  })

  // No `auto_renew:view` → no panel and, because the query is disabled, no
  // request either.
  if (!canView) return null

  const last = data?.lastResult ?? null
  const cronLabel =
    data?.cron === 'every-minute' ? t('autoRenewPanel.cronEveryMinute') : (data?.cron ?? '')

  return (
    <Card>
      <CardContent className="space-y-3 pt-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">{t('autoRenewPanel.title')}</p>
            <p className="text-xs text-muted-foreground">{t('autoRenewPanel.hint')}</p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8"
              onClick={() => refetch()}
              disabled={isFetching}
              aria-label={t('autoRenewPanel.refresh')}
            >
              <RefreshCw className={cn('h-4 w-4', isFetching && 'animate-spin')} />
            </Button>
            <PermissionGate resource="auto_renew" action="run">
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button size="sm" className="h-8" disabled={runMutation.isPending}>
                    {runMutation.isPending ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <PlayCircle className="h-4 w-4 mr-2" />
                    )}
                    {runMutation.isPending ? t('autoRenewPanel.running') : t('autoRenewPanel.run')}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>{t('autoRenewPanel.confirmTitle')}</AlertDialogTitle>
                    <AlertDialogDescription>
                      {t('autoRenewPanel.confirmBody')}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                    <AlertDialogAction onClick={() => runMutation.mutate()}>
                      <RotateCw className="h-4 w-4 mr-2" />
                      {t('autoRenewPanel.confirmAction')}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </PermissionGate>
          </div>
        </div>

        {isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : data === undefined ? (
          <p className="text-sm text-muted-foreground">{t('autoRenewPanel.unavailable')}</p>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              {t('autoRenewPanel.schedule', { cron: cronLabel })}
            </p>
            {last === null ? (
              <p className="text-sm text-muted-foreground">{t('autoRenewPanel.never')}</p>
            ) : (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  {t('autoRenewPanel.lastRun', {
                    time: new Date(last.finishedAt).toLocaleString(),
                    duration: toCount(last.durationMs),
                  })}
                </p>
                <div className="flex flex-wrap gap-x-6 gap-y-2">
                  {METRIC_KEYS.map((key) => (
                    <div key={key} className="min-w-[6rem]">
                      <p
                        className={cn(
                          'text-lg font-semibold tabular-nums',
                          key === 'autopayFailed' && toCount(last[key]) > 0
                            ? 'text-destructive'
                            : undefined,
                        )}
                      >
                        {toCount(last[key])}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {t(`autoRenewPanel.metrics.${key}`)}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export default AutoRenewPanel
