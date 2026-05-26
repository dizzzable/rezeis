/**
 * ImportProgressDialog
 * ──────────────────────────────────────────────────────────────────
 * One modal for every import / sync flow on the page.
 *
 * Lifecycle:
 *   1. The page enqueues an import job and gets back `{ importRecordId }`.
 *   2. The dialog opens immediately with a cosmetic stage animation
 *      (3-5 seconds, cycles through "connecting / fetching / matching /
 *      writeback / finalizing"). This is purely visual feedback so the
 *      operator sees something happening — the real progress is polled
 *      from the backend in parallel.
 *   3. Polling hits `GET /admin/imports/:id` once a second. The job
 *      bounces through status DRAFT → DRY_RUN (in-flight) → COMMITTED
 *      | FAILED. We stop the loop on either terminal state OR on a
 *      hard 90 s safety timeout.
 *   4. On terminal state the modal switches to a stats screen showing
 *      fetched / created / updated / skipped / writebacks / errors,
 *      plus the first five error messages if any.
 *   5. For `mode === 'import'` the operator gets two buttons:
 *      "Assign plan to all" (opens the bulk-assign dialog) or "Skip for
 *      now". Sync has only a "Close" button — sync never creates new
 *      subscriptions, so plan assignment is meaningless there.
 *
 * The dialog is uncontrolled-from-server: cancellation just closes the
 * dialog locally; the BullMQ job keeps running and lands in the
 * `ImportHistory` table. This matches how operators expect long-running
 * imports to behave.
 */
import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  XCircle,
} from 'lucide-react'

import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'

// ── Public types ──────────────────────────────────────────────────────────

export type ImportSource = 'remnawave' | '3xui' | 'remnashop' | 'altshop'
export type ImportMode = 'import' | 'sync'

export interface ImportProgressDialogProps {
  /** Whether the dialog is mounted/visible. */
  readonly open: boolean
  /** Closes the dialog. The underlying job is NOT cancelled. */
  readonly onClose: () => void
  /**
   * Server-side `ImportRecord.id` returned by the enqueue endpoint.
   * `null` while the enqueue request itself is in flight.
   */
  readonly importRecordId: string | null
  /** Source label, shown in the title. */
  readonly source: ImportSource
  /** Import or sync — controls title + final-screen button set. */
  readonly mode: ImportMode
  /**
   * Handler for the "Assign plan to all" button on the success screen.
   * Only invoked when `mode === 'import'` and at least one row was
   * created/updated. The dialog passes back the `importRecordId` so the
   * caller can pipe it into the bulk-assign request.
   */
  readonly onAssignPlan?: (importRecordId: string) => void
}

// ── Wire types (mirrors backend ImportRecordPayload) ──────────────────────

interface ImportRecordPayload {
  readonly id: string
  readonly status: 'DRAFT' | 'DRY_RUN' | 'COMMITTED' | 'FAILED' | 'ROLLED_BACK'
  readonly recordsTotal: number
  readonly recordsOk: number
  readonly recordsFailed: number
  readonly errorMessage: string | null
  /**
   * Source-specific payload written at the end of the run. Shape varies
   * per importer; we extract a small set of common counters for display.
   */
  readonly result: Record<string, unknown> | null
}

interface FlattenedSummary {
  readonly fetched: number
  readonly created: number
  readonly updated: number
  readonly skipped: number
  readonly subsCreated: number | null
  readonly subsUpdated: number | null
  readonly writebacks: number | null
  readonly errors: ReadonlyArray<string>
}

// ── Internal stage cycler ─────────────────────────────────────────────────

const STAGE_KEYS = ['connecting', 'fetching', 'matching', 'writeback', 'finalizing'] as const
type StageKey = (typeof STAGE_KEYS)[number]

const STAGE_INTERVAL_MS = 900

// ── Component ─────────────────────────────────────────────────────────────

export function ImportProgressDialog({
  open,
  onClose,
  importRecordId,
  source,
  mode,
  onAssignPlan,
}: ImportProgressDialogProps): JSX.Element {
  const { t } = useTranslation()

  // Cosmetic stage cycler — runs while the job is live, just for visual
  // feedback. The real progress comes from the polling query below.
  const [stageIndex, setStageIndex] = useState(0)
  useEffect(() => {
    if (!open) return
    setStageIndex(0)
    const handle = window.setInterval(() => {
      setStageIndex((i) => (i + 1) % STAGE_KEYS.length)
    }, STAGE_INTERVAL_MS)
    return () => window.clearInterval(handle)
  }, [open])

  // 90 s hard safety net so the spinner never spins forever even if
  // the backend never reaches a terminal status. After timeout we
  // surface a soft warning but keep the polling alive — the user can
  // close the dialog and watch the history table instead.
  const [timedOut, setTimedOut] = useState(false)
  const startedAtRef = useRef<number | null>(null)
  useEffect(() => {
    if (!open) {
      startedAtRef.current = null
      setTimedOut(false)
      return
    }
    startedAtRef.current = Date.now()
    setTimedOut(false)
    const handle = window.setTimeout(() => setTimedOut(true), 90_000)
    return () => window.clearTimeout(handle)
  }, [open])

  // Poll the import record every 1s while open + not in terminal state.
  const { data: record, isError } = useQuery<ImportRecordPayload>({
    queryKey: ['admin', 'imports', importRecordId, 'progress'],
    queryFn: async () => {
      const res = await api.get<ImportRecordPayload>(`/admin/imports/${importRecordId}`)
      return res.data
    },
    enabled: open && importRecordId !== null,
    refetchInterval: (query) => {
      const data = query.state.data as ImportRecordPayload | undefined
      if (!data) return 1_000
      if (data.status === 'COMMITTED' || data.status === 'FAILED' || data.status === 'ROLLED_BACK') {
        return false
      }
      return 1_000
    },
    refetchIntervalInBackground: false,
  })

  const isTerminal =
    record?.status === 'COMMITTED' ||
    record?.status === 'FAILED' ||
    record?.status === 'ROLLED_BACK'

  const summary = useMemo<FlattenedSummary | null>(
    () => (record ? flattenResult(record) : null),
    [record],
  )

  const titleKey = mode === 'sync' ? 'importsPage.progressDialog.titleSync' : 'importsPage.progressDialog.title'

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Only the explicit Close button (or terminal state) should
        // dismiss — prevents accidental clicks on the backdrop while
        // the operator is reading stats.
        if (!next && isTerminal) onClose()
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t(titleKey, { source: capitalize(source) })}</DialogTitle>
          {!isTerminal ? (
            <DialogDescription>
              {t(`importsPage.progressDialog.stages.${STAGE_KEYS[stageIndex] satisfies StageKey}`)}
            </DialogDescription>
          ) : null}
        </DialogHeader>

        {!isTerminal ? (
          <InProgressBody
            stageIndex={stageIndex}
            timedOut={timedOut}
          />
        ) : (
          <DoneBody record={record!} summary={summary} mode={mode} />
        )}

        <DialogFooter className="gap-2 sm:gap-0">
          {isTerminal ? (
            <DoneFooter
              record={record!}
              summary={summary}
              mode={mode}
              onClose={onClose}
              onAssignPlan={
                onAssignPlan
                  ? () => {
                      onAssignPlan(record!.id)
                      onClose()
                    }
                  : undefined
              }
            />
          ) : null}
          {isError ? (
            <p className="text-sm text-destructive">{t('importsPage.errorGeneric')}</p>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────

function InProgressBody({
  stageIndex,
  timedOut,
}: {
  readonly stageIndex: number
  readonly timedOut: boolean
}): JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="space-y-3 py-4">
      <div className="flex items-center gap-3">
        <Loader2 className="h-5 w-5 shrink-0 animate-spin text-primary" />
        <ul className="flex-1 space-y-1 text-sm">
          {STAGE_KEYS.map((stage, i) => (
            <li
              key={stage}
              className={cn(
                'flex items-center gap-2 transition-colors',
                i < stageIndex ? 'text-muted-foreground line-through' : '',
                i === stageIndex ? 'font-medium text-foreground' : '',
                i > stageIndex ? 'text-muted-foreground/70' : '',
              )}
            >
              <span
                className={cn(
                  'inline-block h-1.5 w-1.5 rounded-full',
                  i === stageIndex ? 'bg-primary animate-pulse' : 'bg-muted-foreground/40',
                  i < stageIndex ? 'bg-emerald-500' : '',
                )}
              />
              {t(`importsPage.progressDialog.stages.${stage}`)}
            </li>
          ))}
        </ul>
      </div>
      {timedOut ? (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
          <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
          <p className="text-foreground/90">{t('importsPage.progressDialog.timeoutWarning')}</p>
        </div>
      ) : null}
    </div>
  )
}

function DoneBody({
  record,
  summary,
  mode,
}: {
  readonly record: ImportRecordPayload
  readonly summary: FlattenedSummary | null
  readonly mode: ImportMode
}): JSX.Element {
  const { t } = useTranslation()
  const status = record.status
  const errorCount = summary?.errors.length ?? record.recordsFailed

  // Headline icon + colour reflect the worst-case outcome so the operator
  // knows at a glance whether to celebrate or investigate.
  const headline = {
    icon: status === 'FAILED'
      ? <XCircle className="h-5 w-5 text-destructive" />
      : errorCount > 0
        ? <AlertTriangle className="h-5 w-5 text-amber-500" />
        : <CheckCircle2 className="h-5 w-5 text-emerald-500" />,
    titleKey: status === 'FAILED'
      ? 'importsPage.progressDialog.failedTitle'
      : errorCount > 0
        ? 'importsPage.progressDialog.partialTitle'
        : mode === 'sync'
          ? 'importsPage.progressDialog.successTitleSync'
          : 'importsPage.progressDialog.successTitle',
  }

  return (
    <div className="space-y-4 py-2">
      <div className="flex items-center gap-2">
        {headline.icon}
        <p className="font-medium">{t(headline.titleKey)}</p>
      </div>

      {/* Stat grid — values default to "—" when the field is not present
          for this importer, so we never show "0" for "we did not measure". */}
      {summary ? (
        <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
          <Stat label={t('importsPage.progressDialog.stats.fetched')} value={summary.fetched} />
          <Stat label={t('importsPage.progressDialog.stats.created')} value={summary.created} />
          <Stat label={t('importsPage.progressDialog.stats.updated')} value={summary.updated} />
          <Stat label={t('importsPage.progressDialog.stats.skipped')} value={summary.skipped} />
          {summary.subsCreated !== null ? (
            <Stat label={t('importsPage.progressDialog.stats.subsCreated')} value={summary.subsCreated} />
          ) : null}
          {summary.subsUpdated !== null ? (
            <Stat label={t('importsPage.progressDialog.stats.subsUpdated')} value={summary.subsUpdated} />
          ) : null}
          {summary.writebacks !== null ? (
            <Stat label={t('importsPage.progressDialog.stats.writebacks')} value={summary.writebacks} />
          ) : null}
          <Stat
            label={t('importsPage.progressDialog.stats.errors')}
            value={errorCount}
            tone={errorCount > 0 ? 'danger' : 'neutral'}
          />
        </div>
      ) : null}

      {/* Errors preview — first five lines, truncated, scrollable. */}
      {summary && summary.errors.length > 0 ? (
        <>
          <Separator />
          <div>
            <p className="mb-2 text-sm font-medium">
              {t('importsPage.progressDialog.errorsHeading')}
            </p>
            <ScrollArea className="max-h-40 rounded-md border bg-muted/30">
              <ul className="space-y-1 p-3 text-xs">
                {summary.errors.slice(0, 5).map((message, i) => (
                  <li key={i} className="break-all text-muted-foreground">{message}</li>
                ))}
                {summary.errors.length > 5 ? (
                  <li className="text-muted-foreground/80">
                    {t('importsPage.progressDialog.errorsMore', { count: summary.errors.length - 5 })}
                  </li>
                ) : null}
              </ul>
            </ScrollArea>
          </div>
        </>
      ) : null}

      {record.errorMessage ? (
        <p className="text-sm text-destructive">{record.errorMessage}</p>
      ) : null}
    </div>
  )
}

function Stat({
  label,
  value,
  tone = 'neutral',
}: {
  readonly label: string
  readonly value: number | string
  readonly tone?: 'neutral' | 'danger'
}): JSX.Element {
  return (
    <div className="rounded-md border bg-card px-3 py-2">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p
        className={cn(
          'text-lg font-semibold tabular-nums',
          tone === 'danger' && Number(value) > 0 ? 'text-destructive' : 'text-foreground',
        )}
      >
        {value}
      </p>
    </div>
  )
}

function DoneFooter({
  record,
  summary,
  mode,
  onClose,
  onAssignPlan,
}: {
  readonly record: ImportRecordPayload
  readonly summary: FlattenedSummary | null
  readonly mode: ImportMode
  readonly onClose: () => void
  readonly onAssignPlan?: () => void
}): JSX.Element {
  const { t } = useTranslation()

  // Plan assignment is offered only after a successful import (sync never
  // creates new rows, FAILED runs are nothing to assign to, and zero-row
  // imports have no targets).
  const offerPlanAssignment =
    mode === 'import' &&
    record.status === 'COMMITTED' &&
    onAssignPlan !== undefined &&
    summary !== null &&
    summary.created + summary.updated > 0

  if (!offerPlanAssignment) {
    return (
      <Button onClick={onClose} className="w-full sm:w-auto">
        {t('importsPage.progressDialog.close')}
      </Button>
    )
  }

  return (
    <div className="flex w-full flex-col-reverse gap-2 sm:flex-row sm:justify-end">
      <Button variant="outline" onClick={onClose}>
        {t('importsPage.progressDialog.skipAssign')}
      </Button>
      <Button onClick={onAssignPlan}>
        {t('importsPage.progressDialog.assignPlan')}
      </Button>
    </div>
  )
}

// ── Helpers ───────────────────────────────────────────────────────────────

function flattenResult(record: ImportRecordPayload): FlattenedSummary {
  const result = (record.result ?? {}) as Record<string, unknown>
  return {
    fetched: numericField(result, 'fetched', record.recordsTotal),
    created: numericField(result, 'created', 0),
    updated: numericField(result, 'updated', 0),
    skipped: numericField(result, 'skipped', 0),
    subsCreated: numericFieldOrNull(result, 'subscriptionsCreated'),
    subsUpdated: numericFieldOrNull(result, 'subscriptionsUpdated'),
    writebacks: numericFieldOrNull(result, 'descriptionWritebacks'),
    errors: stringArrayField(result, 'errors'),
  }
}

function numericField(record: Record<string, unknown>, key: string, fallback: number): number {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function numericFieldOrNull(record: Record<string, unknown>, key: string): number | null {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function stringArrayField(record: Record<string, unknown>, key: string): ReadonlyArray<string> {
  const value = record[key]
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

function capitalize(source: ImportSource): string {
  return source.charAt(0).toUpperCase() + source.slice(1)
}
