/**
 * Steps 5 and 6 of the plan delete dialog (spec §7): the move while it runs,
 * and its result — success, which plays out and hands over to the delete, or
 * problems, which the operator resolves.
 *
 * These views draw. The orchestrator in `plan-delete-dialog.tsx` owns the run
 * query, the retry and the delete, and decides which view is on screen and
 * whether the dialog may be closed.
 */
import { useEffect, useEffectEvent, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, ArrowRight, Loader2 } from 'lucide-react'

import {
  AlertDialogCancel,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

import type { Plan } from './plans-api'
import {
  fetchPlanMigrationRunStatus,
  type PlanMigrationProblem,
  type PlanMigrationRetryScope,
  type PlanMigrationRunStatus,
} from './plan-migration-api'
import {
  benignSkipCount,
  canChooseAnotherTarget,
  describeMigrationProblemKind,
  describeMigrationProgress,
  describeMigrationReason,
  describeProblemDetail,
  failuresNeedAnotherTarget,
  planLabelOf,
  progressPercent,
} from './plan-migration'
import { MigrationSuccessAnimation, MigrationSyncAnimation } from './plan-migration-animations'
import { SubscriberName, ToneBadge } from './plan-migration-parts'
import { PLAN_MIGRATION_SUCCESS_HOLD_MS } from './plan-migration-timing'

// ── Running ─────────────────────────────────────────────────────────────────

export function PlanMigrationRunningView({
  title,
  status,
  statusFailed,
  reducedMotion,
}: {
  readonly title: string
  /** The last status read; `undefined` until the first answer. */
  readonly status: PlanMigrationRunStatus | undefined
  /** The last poll failed: its answer, if any, is stale. */
  readonly statusFailed: boolean
  readonly reducedMotion: boolean
}) {
  const { t } = useTranslation()
  const progress = status === undefined ? null : describeMigrationProgress(status)

  let headline: string
  if (progress === null) {
    headline = statusFailed
      ? t('plansPage.deleteDialog.migrate.running.statusUnavailable')
      : t('plansPage.deleteDialog.migrate.running.starting')
  } else if (progress.phase === 'moving') {
    headline = t('plansPage.deleteDialog.migrate.running.moving', progress.move)
  } else if (progress.phase === 'syncing') {
    headline = t('plansPage.deleteDialog.migrate.running.syncing', progress.sync)
  } else {
    // Queued — or a settled answer still read as the run before a retry.
    headline = t('plansPage.deleteDialog.migrate.running.queued')
  }

  return (
    <>
      <AlertDialogHeader className="shrink-0">
        <AlertDialogTitle>{title}</AlertDialogTitle>
        <AlertDialogDescription>{t('plansPage.deleteDialog.migrate.running.lead')}</AlertDialogDescription>
      </AlertDialogHeader>

      <div className="flex min-h-0 flex-1 flex-col items-center gap-4 overflow-y-auto py-4">
        <MigrationSyncAnimation reducedMotion={reducedMotion} />
        {/* Not a live region: its counts change on every poll. The dialog
            announces the milestones through its own region (§9 A6.4). */}
        <p
          data-headline=""
          className={cn(
            'text-center text-sm font-medium',
            progress === null && statusFailed && 'text-amber-700 dark:text-amber-400',
          )}
        >
          {headline}
        </p>

        {progress !== null && status !== undefined && (
          <div className="w-full max-w-md space-y-3">
            <ProgressLine
              label={t('plansPage.deleteDialog.migrate.running.moveLabel')}
              done={progress.move.done}
              total={progress.move.total}
              detail={t('plansPage.deleteDialog.migrate.running.moveCounts', {
                moved: status.totals.moved,
                skipped: status.totals.skipped,
                failed: status.totals.failed,
              })}
            />
            {progress.sync.total > 0 && (
              <ProgressLine
                label={t('plansPage.deleteDialog.migrate.running.syncLabel')}
                done={progress.sync.done}
                total={progress.sync.total}
                detail={t('plansPage.deleteDialog.migrate.running.syncCounts', {
                  completed: status.sync.completed,
                  failed: status.sync.failed,
                })}
              />
            )}
          </div>
        )}

        {progress !== null && statusFailed && (
          <p className="text-center text-xs text-amber-700 dark:text-amber-400">
            {t('plansPage.deleteDialog.migrate.running.statusFailed')}
          </p>
        )}
        <p className="max-w-md text-center text-xs text-muted-foreground">
          {t('plansPage.deleteDialog.migrate.running.stayOpen')}
        </p>
      </div>

      {/* Closing is always open to the operator, on purpose and only here: a
          move can stall for a long while (a worker or Redis down) while every
          poll answers. Escape stays blocked; this button is next to the notice
          that says the move goes on and the plan stays. Reopening the dialog
          follows the run again through `…/migrations/current`. */}
      <AlertDialogFooter className="shrink-0">
        <AlertDialogCancel>{t('common.close')}</AlertDialogCancel>
      </AlertDialogFooter>
    </>
  )
}

function ProgressLine({
  label,
  done,
  total,
  detail,
}: {
  readonly label: string
  readonly done: number
  readonly total: number
  readonly detail: string
}) {
  const percent = progressPercent(done, total)
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="font-medium">{label}</span>
        <span className="tabular-nums text-muted-foreground">
          {done} / {total}
        </span>
      </div>
      {/* Not `components/ui/progress`: it keeps `value` from the Radix root, so the
          bar it draws is announced as indeterminate — no `aria-valuenow` at all. */}
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="relative h-2 w-full overflow-hidden rounded-full bg-secondary"
      >
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-500 ease-out motion-reduce:transition-none"
          style={{ width: `${percent}%` }}
        />
      </div>
      <p className="text-[11px] text-muted-foreground">{detail}</p>
    </div>
  )
}

// ── Success ─────────────────────────────────────────────────────────────────

/**
 * What happens between "everything moved" and the dialog closing:
 * `hold` — the success state is on screen; `checking` — the plan's list is read
 * again for subscriptions that landed on it meanwhile; `deleting` — the DELETE
 * is out; `checkFailed` / `deleteFailed` — stopped, the operator decides.
 */
export type MigrationAfterSuccessPhase = 'hold' | 'checking' | 'checkFailed' | 'deleting' | 'deleteFailed'

export function PlanMigrationSuccessView({
  title,
  status,
  phase,
  reducedMotion,
  deleting,
  onHoldElapsed,
  onDelete,
}: {
  readonly title: string
  readonly status: PlanMigrationRunStatus
  readonly phase: MigrationAfterSuccessPhase
  readonly reducedMotion: boolean
  readonly deleting: boolean
  readonly onHoldElapsed: () => void
  readonly onDelete: () => void
}) {
  const { t } = useTranslation()
  const holdElapsed = useEffectEvent(onHoldElapsed)

  // The success state is shown FIRST, for a moment, and only then does the
  // dialog move on to re-checking and deleting — never in the same breath.
  useEffect(() => {
    if (phase !== 'hold') return
    const timer = window.setTimeout(() => holdElapsed(), PLAN_MIGRATION_SUCCESS_HOLD_MS)
    return () => window.clearTimeout(timer)
  }, [phase])

  const stopped = phase === 'checkFailed' || phase === 'deleteFailed'

  return (
    <>
      <AlertDialogHeader className="shrink-0">
        <AlertDialogTitle>{title}</AlertDialogTitle>
        <AlertDialogDescription>
          {t('plansPage.deleteDialog.migrate.success.moved', { count: status.totals.moved })}
        </AlertDialogDescription>
      </AlertDialogHeader>

      <div className="flex min-h-0 flex-1 flex-col items-center gap-3 overflow-y-auto py-6 text-center">
        <MigrationSuccessAnimation reducedMotion={reducedMotion} />
        <p className="text-base font-semibold">{t('plansPage.deleteDialog.migrate.success.title')}</p>
        <p
          data-headline=""
          className={cn(
            'max-w-md text-sm',
            phase === 'checkFailed' && 'text-amber-700 dark:text-amber-400',
            phase === 'deleteFailed' && 'text-destructive',
            !stopped && 'text-muted-foreground',
          )}
        >
          {phase === 'checking' && t('plansPage.deleteDialog.migrate.success.checking')}
          {phase === 'deleting' && t('plansPage.deleteDialog.migrate.success.deleting')}
          {phase === 'checkFailed' && t('plansPage.deleteDialog.migrate.success.checkFailed')}
          {phase === 'deleteFailed' && t('plansPage.deleteDialog.migrate.success.deleteFailed')}
        </p>
      </div>

      <AlertDialogFooter className="shrink-0 gap-2 sm:space-x-0">
        {/* Closing before the delete leaves the plan in place — the moved
            subscriptions stay moved. Only a DELETE already out holds it. */}
        <AlertDialogCancel disabled={deleting}>{t('common.close')}</AlertDialogCancel>
        {stopped && (
          <Button type="button" variant="destructive" disabled={deleting} onClick={onDelete}>
            {deleting && <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden="true" />}
            {t('plansPage.deleteDialog.confirm')}
          </Button>
        )}
      </AlertDialogFooter>
    </>
  )
}

// ── Problems ────────────────────────────────────────────────────────────────

export function PlanMigrationProblemsView({
  title,
  planId,
  status,
  plansById,
  canEditSubscriptions,
  retrying,
  retryFailed,
  deleting,
  onRetry,
  onChooseAnotherTarget,
  onDeleteAnyway,
}: {
  readonly title: string
  readonly planId: string
  readonly status: PlanMigrationRunStatus
  readonly plansById: ReadonlyMap<string, Plan>
  readonly canEditSubscriptions: boolean
  readonly retrying: PlanMigrationRetryScope | null
  readonly retryFailed: boolean
  readonly deleting: boolean
  readonly onRetry: (scope: PlanMigrationRetryScope) => void
  /** Back to choosing, for the subscriptions still on the plan. */
  readonly onChooseAnotherTarget: () => void
  readonly onDeleteAnyway: () => void
}) {
  const { t } = useTranslation()
  // Further pages of the problems, fetched on request. The orchestrator keys
  // this view by the status it read, so a new answer starts from its own page.
  const [more, setMore] = useState<{
    readonly problems: readonly PlanMigrationProblem[]
    readonly cursor: string | null
    readonly loading: boolean
    readonly failed: boolean
  }>({ problems: [], cursor: status.problemsCursor, loading: false, failed: false })

  const loadMore = async () => {
    const cursor = more.cursor
    if (cursor === null) return
    setMore((current) => ({ ...current, loading: true, failed: false }))
    try {
      const next = await fetchPlanMigrationRunStatus(planId, status.runId, { problemsCursor: cursor })
      setMore((current) => ({
        problems: [...current.problems, ...next.problems],
        cursor: next.problemsCursor,
        loading: false,
        failed: false,
      }))
    } catch {
      setMore((current) => ({ ...current, loading: false, failed: true }))
    }
  }

  const problems = [...status.problems, ...more.problems]
  const { totals, sync } = status
  const busy = retrying !== null || deleting
  // Subscriptions the delete would leave on the plan: failures and the skips
  // that are not benign (§9 A2) — not a subscription that already left it.
  const leftOnPlan = totals.failed + totals.skipped - benignSkipCount(totals)
  // A retry of failures it cannot fix would only fail again; offer another plan.
  const retryWouldFailAgain = failuresNeedAnotherTarget(problems, more.cursor === null, totals.failed)

  return (
    <>
      <AlertDialogHeader className="shrink-0">
        <AlertDialogTitle>{title}</AlertDialogTitle>
        <AlertDialogDescription className="flex items-start gap-1.5 text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>
            <span className="font-medium">{t('plansPage.deleteDialog.migrate.problems.title')}.</span>{' '}
            {t('plansPage.deleteDialog.migrate.problems.lead', { moved: totals.moved, total: totals.total })}
          </span>
        </AlertDialogDescription>
      </AlertDialogHeader>

      <div className="flex shrink-0 flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>
          {t('plansPage.deleteDialog.migrate.running.moveCounts', {
            moved: totals.moved,
            skipped: totals.skipped,
            failed: totals.failed,
          })}
        </span>
        {sync.total > 0 && (
          <span>
            {t('plansPage.deleteDialog.migrate.running.syncLabel')}:{' '}
            {t('plansPage.deleteDialog.migrate.running.syncCounts', {
              completed: sync.completed,
              failed: sync.failed,
            })}
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto rounded-md border">
        <ul aria-label={t('plansPage.deleteDialog.migrate.problems.listLabel')} className="divide-y">
          {problems.map((problem, index) => {
            const kind = describeMigrationProblemKind(problem.kind)
            const reason = describeMigrationReason(problem.reason)
            const detail = describeProblemDetail(problem)
            return (
              <li
                key={`${problem.kind}:${problem.subscriptionId}:${index}`}
                className="flex items-start justify-between gap-3 px-3 py-2.5"
              >
                <div className="min-w-0 flex-1 space-y-1">
                  <SubscriberName user={problem.user} subscriptionId={problem.subscriptionId} />
                  <div className="flex flex-wrap items-center gap-1.5 text-xs">
                    <ToneBadge tone={kind.tone}>{t(kind.i18nKey, { code: problem.kind })}</ToneBadge>
                    {/* The reasons are sentence fragments (they also follow a colon in
                        the preview); here one starts the line. */}
                    <span className="inline-block first-letter:uppercase">{t(reason.i18nKey)}</span>
                    {!reason.recognised && (
                      <span className="font-mono text-[10px] text-muted-foreground">{reason.code}</span>
                    )}
                  </div>
                  {detail?.kind === 'blockerReason' && (
                    <p className="text-[11px] text-muted-foreground">
                      {t('plansPage.deleteDialog.migrate.problems.twinReason', { reason: t(detail.reason.i18nKey) })}
                    </p>
                  )}
                  {detail?.kind === 'raw' && (
                    <p className="break-words text-[11px] text-muted-foreground">{detail.text}</p>
                  )}
                </div>
                <span className="inline-flex shrink-0 items-center gap-1 pt-0.5 text-xs font-medium">
                  <ArrowRight className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
                  {planLabelOf(plansById, problem.targetPlanId)}
                </span>
              </li>
            )
          })}
        </ul>
        {more.cursor !== null && (
          <div className="space-y-1 border-t p-2">
            {more.failed && (
              <p className="text-xs text-destructive">{t('plansPage.deleteDialog.migrate.problems.loadMoreFailed')}</p>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-full"
              disabled={more.loading}
              onClick={() => void loadMore()}
            >
              {more.loading && <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden="true" />}
              {t('plansPage.deleteDialog.migrate.problems.loadMore')}
            </Button>
          </div>
        )}
      </div>

      <div className="shrink-0 space-y-1.5">
        {(leftOnPlan > 0 || sync.failed > 0) && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <div className="space-y-1">
              {leftOnPlan > 0 && <p>{t('plansPage.deleteDialog.migrate.problems.deleteAnywayConsequence')}</p>}
              {sync.failed > 0 && <p>{t('plansPage.deleteDialog.migrate.problems.syncConsequence')}</p>}
            </div>
          </div>
        )}
        {retryFailed && (
          <p className="text-xs text-destructive">{t('plansPage.deleteDialog.migrate.problems.retryRefused')}</p>
        )}
        {!canEditSubscriptions && ((totals.failed > 0 && !retryWouldFailAgain) || sync.failed > 0) && (
          <p className="text-xs text-muted-foreground">{t('plansPage.deleteDialog.migrate.problems.retryNeedsEdit')}</p>
        )}
      </div>

      <AlertDialogFooter className="shrink-0 flex-wrap gap-2 sm:space-x-0">
        <AlertDialogCancel disabled={busy}>{t('common.close')}</AlertDialogCancel>
        {canChooseAnotherTarget(totals) && (
          <Button type="button" variant="outline" disabled={busy} onClick={onChooseAnotherTarget}>
            {t('plansPage.deleteDialog.migrate.problems.chooseAnotherTarget')}
          </Button>
        )}
        {sync.failed > 0 && (
          <Button
            type="button"
            variant="outline"
            disabled={!canEditSubscriptions || busy}
            onClick={() => onRetry('sync')}
          >
            {retrying === 'sync' && <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden="true" />}
            {t('plansPage.deleteDialog.migrate.problems.retrySync')}
          </Button>
        )}
        {totals.failed > 0 && !retryWouldFailAgain && (
          <Button
            type="button"
            variant="outline"
            disabled={!canEditSubscriptions || busy}
            onClick={() => onRetry('failed')}
          >
            {retrying === 'failed' && <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden="true" />}
            {t('plansPage.deleteDialog.migrate.problems.retryFailed')}
          </Button>
        )}
        <Button type="button" variant="destructive" disabled={busy} onClick={onDeleteAnyway}>
          {deleting && <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden="true" />}
          {t('plansPage.deleteDialog.migrate.problems.deleteAnyway')}
        </Button>
      </AlertDialogFooter>
    </>
  )
}
