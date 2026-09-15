import { useCallback, useEffect, useEffectEvent, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Loader2 } from 'lucide-react'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useHasPermission } from '@/features/rbac'
import { cn } from '@/lib/utils'

import { describePlanReferences, describePlanReferencesAfterMove, type PlanDeleteOutcome } from './plan-delete'
import { PlanUsageDetails } from './plan-delete-usage'
import { plansListOptions, usePlanReferences, type Plan, type PlanReference } from './plans-api'
import { readProductCode, readServerMessage } from './plan-write-refusals'
import {
  fetchPlanMigrationCurrent,
  fetchPlanSubscriptionsPage,
  planMigrationQueryKeys,
  PLAN_SUBSCRIPTIONS_PAGE_SIZE,
  retryPlanMigration,
  startPlanMigration,
  useMigrationSquadNames,
  usePlanMigrationCurrent,
  usePlanMigrationPreview,
  usePlanMigrationRun,
  usePlanSubscriptions,
  type PlanMigrationRequest,
  type PlanMigrationRetryScope,
  type PlanSubscriptionsPage,
} from './plan-migration-api'
import {
  classifyMigrationRun,
  EMPTY_MIGRATION_ASSIGNMENT,
  isAwaitingRetryEcho,
  isKnownMigrationRefusal,
  isNoResponseError,
  listMigrationTargets,
  mayHaveStartedAnyway,
  PLAN_MIGRATION_REFUSAL_I18N_KEYS,
  PLAN_MIGRATION_TARGET_REFUSALS,
  type MigrationAssignment,
} from './plan-migration'
import { PlanMigrationChooseStep } from './plan-migration-choose-step'
import { useReducedMotionPreference } from './plan-migration-motion'
import { PlanMigrationPreviewStep } from './plan-migration-preview-step'
import {
  PlanMigrationProblemsView,
  PlanMigrationRunningView,
  PlanMigrationSuccessView,
  type MigrationAfterSuccessPhase,
} from './plan-migration-run-step'
import { PLAN_MIGRATION_RETRY_ECHO_MS, PLAN_MIGRATION_SEARCH_DEBOUNCE_MS } from './plan-migration-timing'

type DialogPlan = Pick<Plan, 'id' | 'name' | 'isActive' | 'isArchived'>

export interface PlanDeleteDialogProps {
  /**
   * The plan the dialog is about. Kept by the page after the dialog closes, so
   * the content does not blank out while it animates away. Its sale flags pick
   * the lead for an unused plan: one still on sale is hidden, not removed.
   */
  readonly plan: DialogPlan | null
  readonly open: boolean
  /** A delete is in flight: every button holds, and the dialog cannot be dismissed. */
  readonly deleting: boolean
  /**
   * Sends the DELETE and resolves with how it ended. The page owns it — its
   * toasts, its list refresh, closing the dialog; the dialog needs the outcome
   * because after a move the delete is its own last step (see `PlanDeleteOutcome`).
   */
  readonly onConfirm: (planId: string) => Promise<PlanDeleteOutcome>
  readonly onOpenChange: (open: boolean) => void
}

/**
 * Confirms deleting a plan, says what the delete will do to it — and, when
 * subscriptions are still on it, moves them to other plans first (owner
 * decisions of 15.09.2026, spec §7 and §9 A6).
 *
 * The delete is never refused (plan-deletion contract v2), so nothing here
 * gates it on an answer: the references and the subscriptions are fetched to
 * INFORM the operator. While they load, Delete waits — the point of asking is
 * that the operator sees the answer before confirming. When they cannot be
 * loaded, Delete is released with a warning, because a failed count is no
 * reason to make a delete that the server would accept impossible.
 *
 * The steps: checking → no subscriptions (today's dialog, unchanged) or choose
 * → preview → running → success (then the delete) or problems. A move already
 * running for the plan is followed straight away.
 */
export function PlanDeleteDialog({ plan, open, deleting, onConfirm, onOpenChange }: PlanDeleteDialogProps) {
  return (
    <AlertDialog
      open={open && plan !== null}
      onOpenChange={(next) => {
        // Escape must not walk away from a delete whose answer is still coming.
        if (!next && deleting) return
        onOpenChange(next)
      }}
    >
      {plan !== null && (
        // Keyed by plan: a different plan starts from fresh queries and a fresh
        // step, never from the previous plan's counts or assignments.
        <PlanDeleteDialogShell key={plan.id} plan={plan} open={open} deleting={deleting} onConfirm={onConfirm} />
      )}
    </AlertDialog>
  )
}

interface DialogChrome {
  /** A step that needs room: the list, the preview, the move. */
  readonly wide: boolean
  /** Escape may not close the dialog: a move, a retry or the delete after a move is under way. */
  readonly locked: boolean
}

const RESTING_CHROME: DialogChrome = { wide: false, locked: false }

/**
 * The content box. Its width and its Escape handling belong to the Radix
 * content element, while what decides them lives in the body INSIDE it — the
 * body has to be inside, because Radix unmounts the content when the dialog
 * closes, and that unmount is what makes every opening start from fresh counts
 * (`gcTime: 0` on the queries). So the body reports the two facts up.
 */
function PlanDeleteDialogShell({
  plan,
  open,
  deleting,
  onConfirm,
}: {
  readonly plan: DialogPlan
  readonly open: boolean
  readonly deleting: boolean
  readonly onConfirm: (planId: string) => Promise<PlanDeleteOutcome>
}) {
  const [chrome, setChrome] = useState<DialogChrome>(RESTING_CHROME)
  const reportChrome = useCallback((next: DialogChrome) => {
    setChrome((current) => (current.wide === next.wide && current.locked === next.locked ? current : next))
  }, [])

  return (
    <AlertDialogContent
      className={cn(
        chrome.wide &&
          // A plain column whose middle scrolls (`overflow-y-auto` inside each
          // step), not a ScrollArea with only a max height.
          'flex max-h-[min(92vh,880px)] w-[calc(100%-1.5rem)] max-w-3xl flex-col overflow-hidden',
      )}
      onEscapeKeyDown={(event) => {
        // AlertDialog already ignores clicks outside. Escape is a stray key, and
        // it must not walk away from a move halfway to the delete — leaving is
        // the explicit «Закрыть», which says what leaving means.
        if (chrome.locked || deleting) event.preventDefault()
      }}
    >
      <TooltipProvider delayDuration={150}>
        <PlanDeleteDialogBody
          plan={plan}
          open={open}
          deleting={deleting}
          onConfirm={onConfirm}
          onChromeChange={reportChrome}
        />
      </TooltipProvider>
    </AlertDialogContent>
  )
}

type DialogStep =
  /** Decided by what the checks found: checking, today's dialog, or choose. */
  | { readonly kind: 'auto' }
  /** «Удалить без переноса»: today's dialog, with a way back. */
  | { readonly kind: 'withoutMove' }
  | { readonly kind: 'preview'; readonly request: PlanMigrationRequest }
  | { readonly kind: 'run'; readonly runId: string }

function useDebouncedSearch(value: string, delayMs: number): string {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs)
    return () => window.clearTimeout(timer)
  }, [value, delayMs])
  // Clearing the box applies at once: nothing to wait for on the way back to the full list.
  return value.length === 0 ? '' : debounced
}

function PlanDeleteDialogBody({
  plan,
  open,
  deleting,
  onConfirm,
  onChromeChange,
}: {
  readonly plan: DialogPlan
  readonly open: boolean
  readonly deleting: boolean
  readonly onConfirm: (planId: string) => Promise<PlanDeleteOutcome>
  readonly onChromeChange: (chrome: DialogChrome) => void
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const canListSubscriptions = useHasPermission('subscriptions', 'view')
  const canEditSubscriptions = useHasPermission('subscriptions', 'edit')
  const reducedMotion = useReducedMotionPreference()
  const title = t('plansPage.deleteDialog.title', { name: plan.name })

  // Whether the dialog is still what the operator is looking at. False once it
  // is closing (the content stays mounted for its exit animation) or gone:
  // nothing is deleted, and no run is followed, on behalf of a closed dialog.
  const activeRef = useRef(open)
  useEffect(() => {
    activeRef.current = open
    return () => {
      activeRef.current = false
    }
  }, [open])

  // ── 1. Checking: the references, the first page of subscriptions and the move
  // already under way, in parallel.
  const references = usePlanReferences(plan.id)
  const [searchInput, setSearchInput] = useState('')
  const search = useDebouncedSearch(searchInput.trim(), PLAN_MIGRATION_SEARCH_DEBOUNCE_MS)
  const base = usePlanSubscriptions(plan.id, '', canListSubscriptions)
  const searched = usePlanSubscriptions(plan.id, search, canListSubscriptions && search.length > 0)
  const current = usePlanMigrationCurrent(plan.id, canListSubscriptions)
  const list = search.length > 0 ? searched : base
  const basePage = base.data?.pages[0]
  const total = basePage?.total ?? 0
  const listChecking = canListSubscriptions && basePage === undefined && !base.isError
  // A current-run answer that cannot be had holds nothing up: the dialog
  // simply does not attach, as before the route existed.
  const currentChecking = canListSubscriptions && current.data === undefined && !current.isError
  const checking = references.isPending || listChecking || currentChecking
  const migrationPossible = canListSubscriptions && basePage !== undefined && total > 0

  const [chosenStep, setChosenStep] = useState<DialogStep>({ kind: 'auto' })
  // Until the operator (or the dialog itself) moves to a step, a move already
  // running for this plan — a reload, a reopened dialog, another operator — IS
  // the step: the dialog follows it instead of listing subscriptions that are
  // moving already.
  const [attachable, setAttachable] = useState(true)
  const runningRunId = chosenStep.kind === 'auto' && attachable ? (current.data?.runId ?? null) : null
  const step: DialogStep = runningRunId !== null ? { kind: 'run', runId: runningRunId } : chosenStep
  const setStep = (next: DialogStep) => {
    setAttachable(false)
    setChosenStep(next)
  }
  const [assignment, setAssignment] = useState<MigrationAssignment>(EMPTY_MIGRATION_ASSIGNMENT)
  const [newSubscriptionsNotice, setNewSubscriptionsNotice] = useState<number | null>(null)

  // The catalogue the targets come from, read afresh once a move is possible:
  // the page's copy may be five minutes old, and a move onto a plan deleted
  // since is refused.
  const plansQuery = useQuery({ ...plansListOptions(), staleTime: 0, enabled: migrationPossible })
  const targets = listMigrationTargets(plansQuery.data, plan.id)
  const plansById = new Map((plansQuery.data ?? []).map((listed) => [listed.id, listed] as const))
  const refetchPlans = plansQuery.refetch

  // ── 5. The run (declared before the preview, which can hand over to it).
  const [retryRequestedAt, setRetryRequestedAt] = useState<number | null>(null)
  const [afterSuccess, setAfterSuccess] = useState<MigrationAfterSuccessPhase>('hold')
  const [retrying, setRetrying] = useState<PlanMigrationRetryScope | null>(null)
  // The status, as read then, that a retry which FAILED was asked from. The
  // failure is told only while the run, read again, still answers exactly that.
  const [retryFailedOn, setRetryFailedOn] = useState<string | null>(null)
  const runId = step.kind === 'run' ? step.runId : null
  const run = usePlanMigrationRun(plan.id, runId, retryRequestedAt)
  const runStatus = run.data
  const awaitingRetryEcho = isAwaitingRetryEcho(
    runStatus,
    run.dataUpdatedAt,
    retryRequestedAt,
    PLAN_MIGRATION_RETRY_ECHO_MS,
  )
  const outcome = runStatus === undefined ? null : awaitingRetryEcho ? 'running' : classifyMigrationRun(runStatus)

  const beginRun = (startedRunId: string) => {
    setRetryRequestedAt(null)
    setRetryFailedOn(null)
    setAfterSuccess('hold')
    setNewSubscriptionsNotice(null)
    setStep({ kind: 'run', runId: startedRunId })
  }

  /**
   * Follows the plan's running move, if there is one — after a start or a retry
   * refused with `MIGRATION_ALREADY_RUNNING`, whose safe-error body names no run;
   * after a preview that got NO answer; and after a start that got none, or only
   * a 408 or 504 (`mayHaveStartedAnyway`), which may have committed all the same
   * (§9 A6.2).
   */
  const followCurrentRun = async (): Promise<boolean> => {
    const running = await fetchPlanMigrationCurrent(plan.id).then(
      (answer) => answer.runId,
      () => null,
    )
    if (running === null || !activeRef.current) return false
    beginRun(running)
    return true
  }

  // ── 4. Preview.
  const previewRequest = step.kind === 'preview' ? step.request : null
  const preview = usePlanMigrationPreview(plan.id, previewRequest)
  const squadNames = useMigrationSquadNames(step.kind === 'preview')
  const previewCode = preview.isError ? readProductCode(preview.error) : null
  // Only a refusal this dialog names is final. The safe error filter writes a
  // generic `errorCode` on EVERY error — a 500 reads `INTERNAL_SERVER_ERROR` —
  // so "has a code" says nothing about whether asking again can help.
  const previewRefused = isKnownMigrationRefusal(previewCode)
  useEffect(() => {
    if (previewCode !== null && PLAN_MIGRATION_TARGET_REFUSALS.has(previewCode)) void refetchPlans()
  }, [previewCode, refetchPlans])
  const previewUnanswered = preview.isError && isNoResponseError(preview.error)
  const followRunAfterUnansweredPreview = useEffectEvent(() => {
    void followCurrentRun()
  })
  useEffect(() => {
    if (previewUnanswered) followRunAfterUnansweredPreview()
  }, [previewUnanswered])

  const refusalMessage = (error: unknown, fallbackKey: string): string => {
    const code = readProductCode(error)
    const key = code === null ? undefined : PLAN_MIGRATION_REFUSAL_I18N_KEYS.get(code)
    if (key !== undefined) return t(key)
    // A refusal this build cannot name keeps the server's own sentence — the
    // rolling-deploy case, where it is the only line saying what happened.
    const serverMessage = readServerMessage(error)
    return serverMessage === null ? t(fallbackKey) : `${t(fallbackKey)} (${serverMessage})`
  }

  const startMutation = useMutation({
    mutationFn: (request: PlanMigrationRequest) => startPlanMigration(plan.id, request),
    onSuccess: (started) => beginRun(started.runId),
    onError: async (error) => {
      const code = readProductCode(error)
      // Awaited here, the start stays pending until the answer: the refusal or
      // the failure shows only if there is no run to follow after all. A 408 or
      // 504 is asked about too — the handler behind it may have gone on and
      // committed, and the dialog must not sit on the preview while the move runs.
      if (code === 'MIGRATION_ALREADY_RUNNING' || mayHaveStartedAnyway(error)) {
        if (await followCurrentRun()) return
      }
      if (code !== null && PLAN_MIGRATION_TARGET_REFUSALS.has(code)) void refetchPlans()
    },
  })

  /**
   * Follows the run again after a retry was asked for: the answers of the next
   * moments may predate it (`PLAN_MIGRATION_RETRY_ECHO_MS`), so they are shown as
   * the run in progress and polling goes on through them.
   */
  const followRetry = (retriedRunId: string) => {
    setRetryRequestedAt(Date.now())
    setAfterSuccess('hold')
    void queryClient.invalidateQueries({ queryKey: planMigrationQueryKeys.run(plan.id, retriedRunId) })
  }

  const retry = async (scope: PlanMigrationRetryScope) => {
    if (runId === null || runStatus === undefined) return
    const askedFrom = JSON.stringify(runStatus)
    setRetrying(scope)
    setRetryFailedOn(null)
    try {
      await retryPlanMigration(plan.id, runId, scope)
      followRetry(runId)
    } catch (error) {
      // A retry that failed may have been accepted all the same — its answer lost
      // after the commit, or the app's 408 while the handler went on — so the
      // settled status on screen proves nothing, and «Удалить всё равно» on it
      // could delete the plan under a run reopened with pending items. Refused
      // because another run of the plan is open, it is that run to follow.
      if (readProductCode(error) === 'MIGRATION_ALREADY_RUNNING' && (await followCurrentRun())) return
      if (!activeRef.current) return
      setRetryFailedOn(askedFrom)
      followRetry(runId)
    } finally {
      setRetrying(null)
    }
  }

  /**
   * «Выбрать другой тариф для оставшихся»: back to choosing, for what is still
   * on the plan. The list is read again from its first page — the moved
   * subscriptions have left it — and nothing stays assigned.
   */
  const chooseAnotherTarget = () => {
    // Reset first: the list must never show the moved subscriptions again, even
    // for the one render before the fresh first page arrives.
    void queryClient.resetQueries({ queryKey: planMigrationQueryKeys.subscriptionsOfPlan(plan.id) })
    void references.refetch()
    void refetchPlans()
    setAssignment(EMPTY_MIGRATION_ASSIGNMENT)
    setSearchInput('')
    setNewSubscriptionsNotice(null)
    setRetryRequestedAt(null)
    setRetryFailedOn(null)
    setStep({ kind: 'auto' })
  }

  // ── 6. After a successful move: re-read the plan, then delete it.
  const deleteAfterMove = async () => {
    if (!activeRef.current) return
    setAfterSuccess('deleting')
    const deleted = await onConfirm(plan.id)
    if (activeRef.current && deleted === 'failed') setAfterSuccess('deleteFailed')
  }

  const continueAfterSuccess = async () => {
    if (!activeRef.current) return
    setAfterSuccess('checking')
    let recheck: PlanSubscriptionsPage
    try {
      // The references are refreshed alongside: every count they showed
      // before the move is out of date now.
      const [page] = await Promise.all([
        fetchPlanSubscriptionsPage(plan.id, { limit: PLAN_SUBSCRIPTIONS_PAGE_SIZE }),
        references.refetch(),
      ])
      recheck = page
    } catch {
      if (activeRef.current) setAfterSuccess('checkFailed')
      return
    }
    if (!activeRef.current) return
    if (recheck.total > 0) {
      // Subscriptions landed on the plan while the move ran. Back to choosing,
      // with the fresh first page in place and nothing left assigned.
      queryClient.setQueryData(planMigrationQueryKeys.subscriptions(plan.id, ''), {
        pages: [recheck],
        pageParams: [null],
      })
      setSearchInput('')
      setAssignment(EMPTY_MIGRATION_ASSIGNMENT)
      setNewSubscriptionsNotice(recheck.total)
      setRetryRequestedAt(null)
      setStep({ kind: 'auto' })
      return
    }
    await deleteAfterMove()
  }

  // ── Chrome: width and whether Escape may close.
  const runHoldsDialog =
    step.kind === 'run' &&
    (outcome === null || outcome === 'running'
      ? !run.isError
      : outcome === 'success'
        ? afterSuccess === 'hold' || afterSuccess === 'checking' || afterSuccess === 'deleting'
        : false)
  const locked = deleting || startMutation.isPending || retrying !== null || runHoldsDialog
  const choosing = step.kind === 'auto' && !checking && migrationPossible
  const wide = choosing || step.kind === 'preview' || step.kind === 'run'
  useEffect(() => {
    onChromeChange({ wide, locked })
  }, [onChromeChange, wide, locked])
  useEffect(() => () => onChromeChange(RESTING_CHROME), [onChromeChange])

  // ── What a screen reader hears: milestones only (§9 A6.4) — never a count
  // that changes on every poll — through ONE region that stays mounted whatever
  // view is on screen, so a change of view never takes the announcement with it.
  let announcement = ''
  if (step.kind === 'run') {
    if (outcome === 'success') announcement = t('plansPage.deleteDialog.migrate.announce.succeeded')
    else if (outcome === 'problems') announcement = t('plansPage.deleteDialog.migrate.announce.problems')
    else announcement = t('plansPage.deleteDialog.migrate.announce.started')
  } else if (choosing && newSubscriptionsNotice !== null) {
    announcement = t('plansPage.deleteDialog.migrate.announce.newSubscriptions', { count: newSubscriptionsNotice })
  }

  let view: ReactNode
  if (step.kind === 'run') {
    if (outcome === 'success' && runStatus !== undefined) {
      view = (
        <PlanMigrationSuccessView
          title={title}
          status={runStatus}
          phase={afterSuccess}
          reducedMotion={reducedMotion}
          deleting={deleting}
          onHoldElapsed={() => void continueAfterSuccess()}
          onDelete={() => void deleteAfterMove()}
        />
      )
    } else if (outcome === 'problems' && runStatus !== undefined) {
      view = (
        <PlanMigrationProblemsView
          key={run.dataUpdatedAt}
          title={title}
          planId={plan.id}
          status={runStatus}
          plansById={plansById}
          canEditSubscriptions={canEditSubscriptions}
          retrying={retrying}
          retryFailed={retryFailedOn !== null && JSON.stringify(runStatus) === retryFailedOn}
          deleting={deleting}
          onRetry={(scope) => void retry(scope)}
          onChooseAnotherTarget={chooseAnotherTarget}
          onDeleteAnyway={() => void onConfirm(plan.id)}
        />
      )
    } else {
      view = (
        <PlanMigrationRunningView
          title={title}
          status={runStatus}
          statusFailed={run.isError}
          reducedMotion={reducedMotion}
        />
      )
    }
  } else if (step.kind === 'preview') {
    const previewPages = preview.data?.pages ?? []
    view = (
      <PlanMigrationPreviewStep
        title={title}
        // Later pages carry no summary (§9 A3): the first page's stands.
        summary={previewPages[0]?.summary ?? []}
        rows={previewPages.flatMap((page) => page.rows)}
        state={{
          loading: preview.isPending,
          failedMessage:
            preview.isError && preview.data === undefined
              ? refusalMessage(preview.error, 'plansPage.deleteDialog.migrate.refusals.previewFailed')
              : null,
          hasMore: preview.hasNextPage,
          loadingMore: preview.isFetchingNextPage,
          loadMoreFailed: preview.isFetchNextPageError,
        }}
        onLoadMore={() => void preview.fetchNextPage()}
        // A refusal is about the request itself; asking again changes nothing.
        onRetry={previewRefused ? null : () => void preview.refetch()}
        plansById={plansById}
        squadNames={squadNames}
        // The delete comes on its own after the move: what else uses the plan is
        // said here, before «Перенести и удалить», as today's dialog says it
        // before «Удалить».
        usage={{
          failed: references.isError,
          impact: references.data === undefined ? null : describePlanReferencesAfterMove(references.data),
        }}
        canEditSubscriptions={canEditSubscriptions}
        starting={startMutation.isPending}
        startError={
          startMutation.isError
            ? refusalMessage(startMutation.error, 'plansPage.deleteDialog.migrate.refusals.startFailed')
            : null
        }
        onBack={() => setStep({ kind: 'auto' })}
        onStart={() => startMutation.mutate(step.request)}
      />
    )
  } else if (choosing) {
    const listPages = list.data?.pages ?? []
    view = (
      <PlanMigrationChooseStep
        title={title}
        total={total}
        newSubscriptionsNotice={newSubscriptionsNotice}
        searchInput={searchInput}
        onSearchInputChange={setSearchInput}
        search={search}
        rows={listPages.flatMap((page) => page.items)}
        listState={{
          loading: list.data === undefined && !list.isError,
          searching:
            searchInput.trim() !== search || (search.length > 0 && searched.isFetching && !searched.isFetchingNextPage),
          failed: list.data === undefined && list.isError,
          // The previous search's rows stand in while the next one loads; their
          // cursor belongs to that search, not to this one.
          hasMore: list.hasNextPage && !list.isPlaceholderData,
          loadingMore: list.isFetchingNextPage,
          loadMoreFailed: list.isFetchNextPageError,
        }}
        onLoadMore={() => void list.fetchNextPage()}
        onRetryList={() => void list.refetch()}
        targets={targets}
        targetsState={plansQuery.data !== undefined ? 'ready' : plansQuery.isError ? 'failed' : 'loading'}
        plansById={plansById}
        assignment={assignment}
        onAssignmentChange={setAssignment}
        canEditSubscriptions={canEditSubscriptions}
        onDeleteWithoutMove={() => setStep({ kind: 'withoutMove' })}
        onNext={(request) => {
          startMutation.reset()
          setStep({ kind: 'preview', request })
        }}
      />
    )
  } else {
    const subscriptionsReferenced = (references.data ?? []).some(
      (reference: PlanReference) => reference.kind === 'subscriptions' && reference.count > 0,
    )
    view = (
      <PlanDeleteOverview
        plan={plan}
        title={title}
        references={references}
        checking={step.kind === 'auto' && checking}
        deleting={deleting}
        subscriptionsUnavailable={step.kind === 'auto' && canListSubscriptions && base.isError}
        needsSubscriptionAccess={!canListSubscriptions && subscriptionsReferenced}
        onDelete={() => void onConfirm(plan.id)}
        onBack={step.kind === 'withoutMove' ? () => setStep({ kind: 'auto' }) : null}
      />
    )
  }

  return (
    <>
      {view}
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </>
  )
}

/**
 * Today's dialog: the lead, what still uses the plan, and what the delete does
 * about it. Shown while checking, for a plan with no subscriptions, when the
 * subscriptions cannot be listed, and behind «Удалить без переноса».
 */
function PlanDeleteOverview({
  plan,
  title,
  references,
  checking,
  deleting,
  subscriptionsUnavailable,
  needsSubscriptionAccess,
  onDelete,
  onBack,
}: {
  readonly plan: DialogPlan
  readonly title: string
  readonly references: ReturnType<typeof usePlanReferences>
  readonly checking: boolean
  readonly deleting: boolean
  /** The subscriptions could not be listed, so none can be moved. */
  readonly subscriptionsUnavailable: boolean
  /** Subscriptions are on the plan and this operator cannot list them. */
  readonly needsSubscriptionAccess: boolean
  readonly onDelete: () => void
  /** Present behind «Удалить без переноса»: the way back to choosing. */
  readonly onBack: (() => void) | null
}) {
  const { t } = useTranslation()
  const impact = references.data === undefined ? null : describePlanReferences(references.data)

  let lead: string
  if (checking) lead = t('plansPage.deleteDialog.checking')
  else if (references.isError) lead = t('plansPage.deleteDialog.checkFailed')
  else if (impact?.keepsPlan === true) lead = t('plansPage.deleteDialog.used')
  // Nothing uses it — and still an unused plan ON SALE is only hidden: the
  // server keeps the row for a checkout that may be writing its invoice right
  // now, and the nightly sweep removes it. "Deleted permanently" is for a plan
  // already off sale.
  else if (plan.isActive && !plan.isArchived) lead = t('plansPage.deleteDialog.unusedOnSale', { name: plan.name })
  else lead = t('plansPage.deleteDialog.unused', { name: plan.name })

  const referencesFailed = !checking && references.isError

  return (
    <>
      <AlertDialogHeader>
        <AlertDialogTitle>{title}</AlertDialogTitle>
        <AlertDialogDescription className={cn(referencesFailed && 'text-amber-600 dark:text-amber-500')}>
          {checking && <Loader2 className="mr-1.5 inline h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
          {referencesFailed && <AlertTriangle className="mr-1.5 inline h-3.5 w-3.5" aria-hidden="true" />}
          {lead}
        </AlertDialogDescription>
      </AlertDialogHeader>

      {referencesFailed && (
        <p className="text-sm text-muted-foreground">{t('plansPage.deleteDialog.checkFailedHint')}</p>
      )}

      {!checking && impact !== null && <PlanUsageDetails impact={impact} />}

      {subscriptionsUnavailable && !checking && (
        <p className="flex items-start gap-1.5 text-sm text-amber-600 dark:text-amber-500">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {t('plansPage.deleteDialog.migrate.subscriptionsUnavailable')}
        </p>
      )}
      {needsSubscriptionAccess && !checking && (
        <p className="text-sm text-muted-foreground">{t('plansPage.deleteDialog.migrate.needsSubscriptionAccess')}</p>
      )}

      <AlertDialogFooter>
        {onBack === null ? (
          <AlertDialogCancel disabled={deleting}>{t('common.cancel')}</AlertDialogCancel>
        ) : (
          <Button type="button" variant="outline" className="mt-2 sm:mt-0" disabled={deleting} onClick={onBack}>
            {t('plansPage.deleteDialog.migrate.withoutMove.back')}
          </Button>
        )}
        <AlertDialogAction
          className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          disabled={deleting || checking}
          onClick={(event) => {
            // Radix closes the dialog on Action by default. It stays open until
            // the server answers, so a failure is reported over the dialog the
            // operator is still looking at rather than after it has vanished.
            event.preventDefault()
            onDelete()
          }}
        >
          {deleting && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
          {t('plansPage.deleteDialog.confirm')}
        </AlertDialogAction>
      </AlertDialogFooter>
    </>
  )
}
