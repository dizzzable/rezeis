/**
 * «Бессрочные подписки с датой» — lifetime subscriptions that carry an end
 * date, and «Вернуть бессрочность» for the ones the operator chooses.
 * ──────────────────────────────────────────────────────────────────────────
 * For a subscription sold without an end, the panel used to send Remnawave
 * "created + 30 days", took that date back as its own, and from then on every
 * lifetime guard stopped applying — on day 30 Remnawave switched the customer
 * off. The census lists live rows that still carry such a date, each with the
 * EVIDENCE that it was sold without an end and two hints about the date.
 *
 * NOTHING IS RESTORED BY ITSELF. The owner's decision: the operator presses.
 * Three things make that safe rather than a formality:
 *
 *  1. THE PRE-SELECTION IS THE SERVER'S, AND ONLY IT. Rows the server marks
 *     `suggested` — the old defect's fingerprint (date = creation + 30 days)
 *     with no payment for a term after it — are selected on load, and no
 *     other row is. A row whose date may have been PAID for is never selected
 *     on the operator's behalf.
 *  2. A SELECTION IS NEVER RE-APPLIED. After a run, the ids that were sent
 *     leave the selection and the refetched list does not bring the
 *     suggestions back: an operator who unticked a row must not find it ticked
 *     again the next time they press.
 *  3. THE CONFIRMATION SAYS WHAT HAPPENS AND WHAT DOES NOT — the end date goes,
 *     an expired row wakes, ended add-ons come back, one sync tells Remnawave;
 *     and no message, no money, no deleted rows, no limits, nothing automatic.
 *
 * There is deliberately no "select all": going beyond the fingerprint rows is
 * a decision per row.
 */
import { useMemo, useState, type JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { TFunction } from 'i18next'
import { CalendarClock, InfinityIcon, Loader2 } from 'lucide-react'
import { toast } from 'sonner'

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
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useHasPermission } from '@/features/rbac'
import { adminQueryKeys } from '@/lib/admin-query-keys'
import { formatDate } from '@/lib/utils'
import { describeFailure } from './describe-failure'
import {
  fetchLifetimeCensus,
  LIFETIME_EVIDENCE_KINDS,
  LIFETIME_RESTORE_NO_ANSWER,
  LIFETIME_RESTORE_NOT_SENT,
  LIFETIME_RESTORE_OUTCOMES,
  restoreLifetime,
  suggestedLifetimeIds,
  type LifetimeCensusRow,
  type LifetimeEvidence,
  type LifetimeRestoreResult,
  type LifetimeRestoreRun,
} from './lifetime-restore-api'
import { subscriptionToolsQueryKeys } from './query-keys'
import { CustomerCell, SubscriptionStatusText, ToolLoadFailure } from './tool-parts'

function evidenceSentence(t: TFunction, evidence: LifetimeEvidence): string {
  const missing = t('subscriptionTools.common.fieldMissing')
  if (!(LIFETIME_EVIDENCE_KINDS as readonly string[]).includes(evidence.kind)) {
    return t('subscriptionTools.lifetime.evidence.unknown', { kind: evidence.kind })
  }
  return t(`subscriptionTools.lifetime.evidence.${evidence.kind}`, {
    paymentId: evidence.paymentId ?? missing,
    planId: evidence.planId ?? missing,
  })
}

/** A finished run, with the rows as they were when it was sent. */
interface RestoreReport {
  readonly run: LifetimeRestoreRun
  readonly rowsById: ReadonlyMap<string, LifetimeCensusRow>
}

export function LifetimeRestoreTab(): JSX.Element | null {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const allowed = useHasPermission('subscriptions', 'edit')

  const query = useQuery({
    queryKey: subscriptionToolsQueryKeys.lifetime,
    queryFn: fetchLifetimeCensus,
    enabled: allowed,
    retry: false,
  })
  const rows = query.data?.rows

  // `null` until the operator touches a checkbox or a run finishes: until then
  // the selection IS the server's suggestion for whatever list is loaded, so it
  // is derived, never copied into state during render.
  const [picked, setPicked] = useState<ReadonlySet<string> | null>(null)
  const [report, setReport] = useState<RestoreReport | null>(null)

  const selected = useMemo(() => {
    const present = rows ?? []
    const base = picked ?? suggestedLifetimeIds(present)
    return new Set(present.map((row) => row.subscriptionId).filter((id) => base.has(id)))
  }, [picked, rows])

  const mutation = useMutation({
    mutationFn: (ids: readonly string[]) => restoreLifetime(ids),
    onSuccess: (run, ids) => {
      setReport({
        run,
        rowsById: new Map((rows ?? []).map((row) => [row.subscriptionId, row])),
      })
      // The sent ids leave the selection, and the selection stops following
      // the server's suggestion — a refetch must not tick anything again.
      const sent = new Set(ids)
      setPicked(new Set([...selected].filter((id) => !sent.has(id))))
      void queryClient.invalidateQueries({ queryKey: adminQueryKeys.subscriptions.all })
      void queryClient.invalidateQueries({ queryKey: adminQueryKeys.users.all })

      const restored = run.results.filter((result) => result.outcome === 'restored').length
      const summary = t('subscriptionTools.lifetime.results.summary', {
        restored,
        sent: run.results.length,
      })
      if (run.error !== null) toast.error(`${summary} ${describeFailure(t, run.error)}`)
      else if (restored === run.results.length) toast.success(summary)
      else toast.warning(summary)
    },
    onError: (error: unknown) => toast.error(describeFailure(t, error)),
  })

  if (!allowed) return null

  const census = query.data
  const busy = mutation.isPending
  const toggle = (id: string, on: boolean): void => {
    const next = new Set(selected)
    if (on) next.add(id)
    else next.delete(id)
    setPicked(next)
  }
  // In table order, so the request reads like the screen.
  const selectedIds = (rows ?? [])
    .filter((row) => selected.has(row.subscriptionId))
    .map((row) => row.subscriptionId)

  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        <div className="max-w-3xl space-y-1">
          <p className="flex items-center gap-2 text-sm font-semibold">
            <CalendarClock className="h-4 w-4" aria-hidden="true" />
            {t('subscriptionTools.tabs.lifetime')}
          </p>
          <p className="text-xs text-muted-foreground">{t('subscriptionTools.lifetime.intro')}</p>
        </div>

        {report === null ? null : <RestoreResults report={report} />}

        {query.isError ? (
          <ToolLoadFailure
            error={query.error}
            retrying={query.isFetching}
            onRetry={() => void query.refetch()}
          />
        ) : census === undefined ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, index) => (
              <Skeleton key={index} className="h-10 w-full" />
            ))}
          </div>
        ) : census.rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('subscriptionTools.lifetime.empty')}</p>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">{t('subscriptionTools.lifetime.preselectNote')}</p>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">
                {t('subscriptionTools.lifetime.count', {
                  total: census.total ?? census.rows.length,
                  selected: selectedIds.length,
                })}
                {census.truncated
                  ? ` ${t('subscriptionTools.common.truncated', {
                      shown: census.rows.length,
                      total: census.total ?? census.rows.length,
                    })}`
                  : ''}
              </p>
              <RestoreConfirmation
                ids={selectedIds}
                busy={busy}
                triggerLabel={t('subscriptionTools.lifetime.restoreSelected', {
                  selected: selectedIds.length,
                })}
                title={t('subscriptionTools.lifetime.confirm.titleMany', {
                  selected: selectedIds.length,
                })}
                emphasised
                onConfirm={() => mutation.mutate(selectedIds)}
              />
            </div>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8">
                      <span className="sr-only">{t('subscriptionTools.common.actionColumn')}</span>
                    </TableHead>
                    <TableHead>{t('subscriptionTools.lifetime.table.customer')}</TableHead>
                    <TableHead>{t('subscriptionTools.lifetime.table.plan')}</TableHead>
                    <TableHead>{t('subscriptionTools.lifetime.table.expiresAt')}</TableHead>
                    <TableHead>{t('subscriptionTools.lifetime.table.status')}</TableHead>
                    <TableHead>{t('subscriptionTools.lifetime.table.evidence')}</TableHead>
                    <TableHead>{t('subscriptionTools.lifetime.table.hints')}</TableHead>
                    <TableHead>
                      <span className="sr-only">{t('subscriptionTools.common.actionColumn')}</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {census.rows.map((row) => (
                    <TableRow key={row.subscriptionId} data-state={selected.has(row.subscriptionId) ? 'selected' : undefined}>
                      <TableCell className="align-top">
                        <Checkbox
                          checked={selected.has(row.subscriptionId)}
                          disabled={busy}
                          onCheckedChange={(checked) => toggle(row.subscriptionId, checked === true)}
                          aria-label={t('subscriptionTools.lifetime.selectRow', { id: row.subscriptionId })}
                        />
                      </TableCell>
                      <TableCell className="align-top">
                        <CustomerCell
                          userId={row.userId}
                          userName={row.userName}
                          userTelegramId={row.userTelegramId}
                        />
                      </TableCell>
                      <TableCell className="align-top text-xs">
                        <p className="text-sm">{row.planName ?? t('subscriptionTools.common.planMissing')}</p>
                        <p className="font-mono text-muted-foreground">{row.subscriptionId}</p>
                      </TableCell>
                      <TableCell className="whitespace-nowrap align-top text-xs">
                        {formatDate(row.expiresAt)}
                      </TableCell>
                      <TableCell className="align-top text-xs">
                        <SubscriptionStatusText status={row.status} />
                        {row.linked ? null : (
                          <p className="text-muted-foreground">{t('subscriptionTools.lifetime.notLinked')}</p>
                        )}
                      </TableCell>
                      <TableCell className="max-w-xs align-top text-xs">
                        <ul className="list-disc space-y-0.5 pl-4">
                          {row.evidence.map((evidence, index) => (
                            <li key={`${evidence.kind}-${index}`}>{evidenceSentence(t, evidence)}</li>
                          ))}
                        </ul>
                      </TableCell>
                      <TableCell className="max-w-xs align-top text-xs">
                        <div className="flex flex-col items-start gap-1">
                          {row.thirtyDaysAfterCreate ? (
                            <Badge variant="warning" className="font-normal">
                              {t('subscriptionTools.lifetime.hints.thirtyDaysAfterCreate')}
                            </Badge>
                          ) : null}
                          {row.datedPaymentAfter ? (
                            <Badge variant="destructive" className="font-normal">
                              {t('subscriptionTools.lifetime.hints.datedPaymentAfter')}
                            </Badge>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell className="align-top">
                        <RestoreConfirmation
                          ids={[row.subscriptionId]}
                          busy={busy}
                          triggerLabel={t('subscriptionTools.lifetime.restoreOne')}
                          title={t('subscriptionTools.lifetime.confirm.titleOne', { id: row.subscriptionId })}
                          onConfirm={() => mutation.mutate([row.subscriptionId])}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/**
 * The only way a restore can be requested — for one row or for the selection.
 * The body is what it does and what it does not do, in that order, because an
 * operator deciding about a paying customer's end date needs both halves.
 */
function RestoreConfirmation({
  ids,
  busy,
  triggerLabel,
  title,
  emphasised = false,
  onConfirm,
}: {
  readonly ids: readonly string[]
  readonly busy: boolean
  readonly triggerLabel: string
  readonly title: string
  readonly emphasised?: boolean
  readonly onConfirm: () => void
}): JSX.Element {
  const { t } = useTranslation()
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          size="sm"
          variant={emphasised ? 'default' : 'outline'}
          className="h-8 gap-1.5 whitespace-nowrap"
          disabled={busy || ids.length === 0}
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <InfinityIcon className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          {busy && emphasised ? t('subscriptionTools.lifetime.running') : triggerLabel}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3 text-left">
              <div>
                <p className="font-medium text-foreground">{t('subscriptionTools.lifetime.confirm.doesTitle')}</p>
                <ul className="list-disc space-y-0.5 pl-5">
                  <li>{t('subscriptionTools.lifetime.confirm.does.endDate')}</li>
                  <li>{t('subscriptionTools.lifetime.confirm.does.status')}</li>
                  <li>{t('subscriptionTools.lifetime.confirm.does.addOns')}</li>
                  <li>{t('subscriptionTools.lifetime.confirm.does.sync')}</li>
                </ul>
              </div>
              <div>
                <p className="font-medium text-foreground">{t('subscriptionTools.lifetime.confirm.doesNotTitle')}</p>
                <ul className="list-disc space-y-0.5 pl-5">
                  <li>{t('subscriptionTools.lifetime.confirm.doesNot.message')}</li>
                  <li>{t('subscriptionTools.lifetime.confirm.doesNot.money')}</li>
                  <li>{t('subscriptionTools.lifetime.confirm.doesNot.deleted')}</li>
                  <li>{t('subscriptionTools.lifetime.confirm.doesNot.limits')}</li>
                  <li>{t('subscriptionTools.lifetime.confirm.doesNot.automatic')}</li>
                </ul>
              </div>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>
            {t('subscriptionTools.lifetime.confirm.action')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function outcomeSentence(t: TFunction, result: LifetimeRestoreResult, runError: unknown): string {
  if (result.outcome === 'failed') {
    return t('subscriptionTools.lifetime.results.outcomes.failed', {
      message: result.error ?? t('subscriptionTools.lifetime.results.failedNoMessage'),
    })
  }
  if (result.outcome === LIFETIME_RESTORE_NO_ANSWER) {
    return t('subscriptionTools.lifetime.results.outcomes.noAnswer', {
      message:
        runError === null
          ? t('subscriptionTools.lifetime.results.notNamedInAnswer')
          : describeFailure(t, runError),
    })
  }
  if (
    result.outcome === LIFETIME_RESTORE_NOT_SENT ||
    (LIFETIME_RESTORE_OUTCOMES as readonly string[]).includes(result.outcome)
  ) {
    return t(`subscriptionTools.lifetime.results.outcomes.${result.outcome}`)
  }
  return t('subscriptionTools.lifetime.results.outcomes.unknown', {
    code: result.outcome.length > 0 ? result.outcome : t('subscriptionTools.common.fieldMissing'),
  })
}

function statusWord(t: TFunction, status: string): string {
  return String(t(`subscriptionsPage.statuses.${status}`, { defaultValue: status }))
}

/** What changed for a restored row, in the operator's words. */
function restoredDetails(t: TFunction, result: LifetimeRestoreResult): string[] {
  const details: string[] = []
  if (result.previousExpiresAt !== null) {
    details.push(
      t('subscriptionTools.lifetime.results.previousDate', { date: formatDate(result.previousExpiresAt) }),
    )
  }
  if (result.statusBefore !== null && result.statusAfter !== null && result.statusBefore !== result.statusAfter) {
    details.push(
      t('subscriptionTools.lifetime.results.statusChanged', {
        before: statusWord(t, result.statusBefore),
        after: statusWord(t, result.statusAfter),
      }),
    )
  }
  if (result.revivedAddOns !== null && result.revivedAddOns > 0) {
    details.push(t('subscriptionTools.lifetime.results.revivedAddOns', { revived: result.revivedAddOns }))
  }
  if (result.syncQueued) details.push(t('subscriptionTools.lifetime.results.syncQueued'))
  return details
}

/**
 * One line per id the run was given — restored or not, and why. Kept on screen
 * after the refetch, which drops the restored rows from the census: the result
 * is the only place the operator can still see what happened to them.
 */
function RestoreResults({ report }: { readonly report: RestoreReport }): JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="space-y-2 rounded-lg border p-3">
      <p className="text-sm font-semibold">{t('subscriptionTools.lifetime.results.title')}</p>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('subscriptionTools.lifetime.results.table.subscription')}</TableHead>
              <TableHead>{t('subscriptionTools.lifetime.results.table.outcome')}</TableHead>
              <TableHead>{t('subscriptionTools.lifetime.results.table.details')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {report.run.results.map((result) => {
              const row = report.rowsById.get(result.subscriptionId)
              return (
                <TableRow key={result.subscriptionId}>
                  <TableCell className="align-top text-xs">
                    <p className="text-sm">
                      {row?.userName ?? t('subscriptionTools.common.customerUnnamed')}
                    </p>
                    <p className="font-mono text-muted-foreground">{result.subscriptionId}</p>
                  </TableCell>
                  <TableCell className="align-top text-xs">
                    <Badge
                      variant={
                        result.outcome === 'restored'
                          ? 'success'
                          : result.outcome === 'alreadyLifetime'
                            ? 'secondary'
                            : 'destructive'
                      }
                      className="font-normal"
                    >
                      {outcomeSentence(t, result, report.run.error)}
                    </Badge>
                  </TableCell>
                  <TableCell className="align-top text-xs text-muted-foreground">
                    {result.outcome === 'restored' ? restoredDetails(t, result).join('; ') : null}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
