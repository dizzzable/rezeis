/**
 * Reconciliation health.
 * ──────────────────────
 * Reader for `GET /admin/payments/reconciliation/health`
 * (`AdminPaymentReconciliationController.getHealth`, gated on
 * `payments:view`), which had no caller anywhere in the SPA.
 *
 * What the payload actually says, and why it sits HERE:
 *   - `eventsByStatus` is a group-by over the very rows the webhook events
 *     table below lists, so the counts and the list are the same data at two
 *     zoom levels — the table answers "what came in", this answers "is any of
 *     it stuck".
 *   - `staleEnqueuedCount` / `staleProcessingCount` are the actionable half:
 *     an event that was queued and never picked up, or started and never
 *     finished, is a payment the customer has made and the panel has not
 *     applied. Non-zero and growing means the reconciliation worker is not
 *     running — that is a thing an operator can go and fix.
 *   - `queue.*` are BullMQ job counts; diagnostic rather than actionable on
 *     their own, but they are what distinguishes "worker is down" (waiting
 *     climbs, active stays 0) from "worker is failing" (failed climbs).
 *
 * The numbers are deliberately shown together: either half alone is
 * ambiguous.
 */
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, CheckCircle2, RefreshCw } from 'lucide-react'

import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { useHasPermission } from '@/features/rbac'
import { cn } from '@/lib/utils'
import { reconciliationHealthQueryKey } from './payments-ops-keys'

/** Mirrors `PaymentReconciliationQueueCountsInterface`. */
interface ReconciliationQueueCounts {
  readonly waiting: number
  readonly active: number
  readonly delayed: number
  readonly completed: number
  readonly failed: number
}

/** Mirrors `PaymentReconciliationHealthInterface`. */
interface ReconciliationHealth {
  readonly queue: ReconciliationQueueCounts
  readonly eventsByStatus: Readonly<Record<string, number>>
  readonly staleProcessingCount: number
  readonly staleEnqueuedCount: number
  readonly generatedAt: string
}

const EVENT_STATUSES = ['RECEIVED', 'ENQUEUED', 'PROCESSING', 'PROCESSED', 'FAILED'] as const
const QUEUE_KEYS = ['waiting', 'active', 'delayed', 'completed', 'failed'] as const

function toCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function Stat({
  label,
  value,
  emphasise = false,
}: {
  readonly label: string
  readonly value: number
  readonly emphasise?: boolean
}) {
  return (
    <div className="min-w-[5.5rem]">
      <p
        className={cn(
          'text-lg font-semibold tabular-nums',
          emphasise && value > 0 ? 'text-destructive' : undefined,
        )}
      >
        {value}
      </p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  )
}

export function ReconciliationHealthCard() {
  const { t } = useTranslation()
  // The route demands `payments:view`. The tab only renders behind the page's
  // own gate today, but the check is repeated here so the request cannot go
  // out from a future mount point that forgets it.
  const canView = useHasPermission('payments', 'view')

  const { data, isLoading, isFetching, refetch } = useQuery<ReconciliationHealth>({
    queryKey: reconciliationHealthQueryKey,
    queryFn: async ({ signal }) =>
      (await api.get<ReconciliationHealth>('/admin/payments/reconciliation/health', { signal }))
        .data,
    enabled: canView,
  })

  if (!canView) return null

  const queue = data?.queue
  const eventsByStatus = data?.eventsByStatus
  const staleEnqueued = toCount(data?.staleEnqueuedCount)
  const staleProcessing = toCount(data?.staleProcessingCount)
  const stuck = staleEnqueued + staleProcessing
  const hasPayload = queue !== undefined || eventsByStatus !== undefined

  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">{t('paymentsReconciliation.title')}</p>
            <p className="text-xs text-muted-foreground">{t('paymentsReconciliation.hint')}</p>
          </div>
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8 shrink-0"
            onClick={() => refetch()}
            disabled={isFetching}
            aria-label={t('paymentsReconciliation.refresh')}
          >
            <RefreshCw className={cn('h-4 w-4', isFetching && 'animate-spin')} />
          </Button>
        </div>

        {isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : !hasPayload ? (
          <p className="text-sm text-muted-foreground">{t('paymentsReconciliation.unavailable')}</p>
        ) : (
          <div className="space-y-4">
            <div>
              <p className="mb-1.5 text-xs font-medium text-muted-foreground">
                {t('paymentsReconciliation.events.title')}
              </p>
              <div className="flex flex-wrap gap-x-6 gap-y-2">
                {EVENT_STATUSES.map((status) => (
                  <Stat
                    key={status}
                    label={t(`paymentsReconciliation.events.${status}`)}
                    value={toCount(eventsByStatus?.[status])}
                    emphasise={status === 'FAILED'}
                  />
                ))}
              </div>
            </div>

            <div>
              <p className="mb-1.5 text-xs font-medium text-muted-foreground">
                {t('paymentsReconciliation.queue.title')}
              </p>
              <div className="flex flex-wrap gap-x-6 gap-y-2">
                {QUEUE_KEYS.map((key) => (
                  <Stat
                    key={key}
                    label={t(`paymentsReconciliation.queue.${key}`)}
                    value={toCount(queue?.[key])}
                    emphasise={key === 'failed'}
                  />
                ))}
              </div>
            </div>

            <div className="rounded-md border border-border/60 p-3">
              <div className="mb-1.5 flex items-center gap-2">
                {stuck > 0 ? (
                  <AlertTriangle className="h-4 w-4 text-destructive" />
                ) : (
                  <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
                )}
                <p className="text-xs font-medium text-muted-foreground">
                  {t('paymentsReconciliation.stuck.title')}
                </p>
              </div>
              {stuck > 0 ? (
                <div className="space-y-2">
                  <div className="flex flex-wrap gap-x-6 gap-y-2">
                    <Stat
                      label={t('paymentsReconciliation.stuck.enqueued')}
                      value={staleEnqueued}
                      emphasise
                    />
                    <Stat
                      label={t('paymentsReconciliation.stuck.processing')}
                      value={staleProcessing}
                      emphasise
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t('paymentsReconciliation.stuck.action')}
                  </p>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {t('paymentsReconciliation.stuck.healthy')}
                </p>
              )}
            </div>

            {data?.generatedAt ? (
              <p className="text-[11px] text-muted-foreground">
                {t('paymentsReconciliation.generatedAt', {
                  time: new Date(data.generatedAt).toLocaleString(),
                })}
              </p>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export default ReconciliationHealthCard
