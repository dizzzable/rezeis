/**
 * Duplicate subscription merge — operator surface.
 * ───────────────────────────────────────────────
 * The only caller of `POST /admin/profile-sync/duplicate-subscription-merge`
 * (`AdminDuplicateSubscriptionMergeController`, `subscriptions:edit`), which
 * was built, tested and documented and then had ZERO callers anywhere in the
 * SPA — the same shape of hole its neighbour `PanelLinkReconciliationPanel`
 * was written to close. The repair existed; the way to ask for it did not, so
 * duplicate pairs were being cleaned by hand in production, which is the one
 * thing the owner said must stop.
 *
 * WHY IT LIVES HERE, BESIDE THE RECONCILIATION PANEL. Four reasons:
 *
 *  • Same authority. The controller demands `subscriptions:edit`, the identical
 *    token the sweep next door asks for, expressed the identical way
 *    (`useHasPermission('subscriptions', 'edit')` and a `null` render).
 *  • Same population. The merge DISCOVERS its pairs by running the
 *    reconciliation sweep in dry-run and reading its `duplicatePair` verdicts,
 *    so the two surfaces are literally looking at the same rows. The sweep
 *    diagnoses a pair and stops; this is the action it stops short of, and the
 *    sweep's own warning ("merging the two subscriptions … is a separate
 *    action") now points at something the operator can actually press.
 *  • No route means no nav entry and no guard list to touch.
 *  • The rows it retires are subscriptions, and the stat tiles at the top of
 *    this page count the states those rows are in.
 *
 * WHAT THE SURFACE HAS TO DO, and why no part of it is decoration:
 *
 *  1. DRY BY DEFAULT, AND THE DEFAULT IS A DIFFERENT BUTTON. A first press
 *    previews and can never write. `duplicate-subscription-merge-api.ts` owns
 *    the guarantee that `dryRun` reaches the wire as a real boolean; the string
 *    `'false'` would turn a preview into a live write, and that coercion is a
 *    documented defect class in this repository.
 *  2. A REAL RUN NEEDS AN EXPLICIT CONFIRMATION THAT SAYS WHAT IT WRITES. Not
 *    "are you sure" — the number of pairs, and the fact that a merge moves a
 *    customer's payments, receipt lines, promocode activations, referral spends
 *    and trial claim from one row to another and retires the row they came off.
 *    This is the most consequential write the panel can ask for.
 *  3. `reattached` PER ROW, ITEMISED. "3 transactions, 1 promocode activation
 *    and the trial claim followed the survivor" IS the audit trail; a single
 *    counter throws away the only thing that lets an operator trust the merge
 *    afterwards, or reconstruct it by hand if it went to the wrong pair.
 *  4. SURVIVOR AND DUPLICATE NAMED UNMISTAKABLY, plus which of them holds the
 *    live panel identity RIGHT NOW. Getting this backwards is how somebody
 *    destroys a paying customer's profile: on the pair a broken link produces
 *    the polarity is inverted from instinct — the older, legitimate-looking row
 *    is bound to nothing and the wrong-looking duplicate is the one the customer
 *    is actually using. And on the pair the SHARED-IDENTITY arm produces there is
 *    no unbound half at all: both rows already store the same identity, so the
 *    cell says BOTH rather than picking one and implying the other is spare.
 *  5. RETRYABLE AND NEVER-RETRY REFUSALS ARE SEPARATED. An operator must not
 *    keep pressing a refusal that will never change, and must not give up on
 *    one that would have cleared by itself. See `DuplicateMergeRetryClass`.
 *  6. `hasMore` IS LOUD. A backlog needs more than one invocation, and a UI
 *    that stops at page one lets the operator believe the job is done.
 */
import { useCallback, useMemo, useState, type JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { TFunction } from 'i18next'
import { GitMerge, Loader2, PlayCircle, ShieldAlert, Wrench } from 'lucide-react'
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
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useHasPermission } from '@/features/rbac'
import { adminQueryKeys } from '@/lib/admin-query-keys'
import { translateApiError } from '@/lib/translate-error'
import {
  DUPLICATE_MERGE_DEFAULT_LIMIT,
  DUPLICATE_MERGE_MAX_LIMIT,
  isKnownRefusal,
  liveIdentityHolder,
  refusalClass,
  refusalRank,
  runDuplicateSubscriptionMerge,
  type DuplicateMergeReattachment,
  type DuplicateMergeReport,
  type DuplicateMergeRequest,
  type DuplicateMergeRow,
} from './duplicate-subscription-merge-api'
import {
  PANEL_ERA_2X,
  PANEL_ERA_3X,
  PANEL_LINK_RECONCILIATION_DEFAULT_CHUNK,
  PANEL_LINK_RECONCILIATION_MAX_CHUNK,
} from './panel-link-reconciliation-api'

/**
 * Everything the operator has learned in this sweep, across however many
 * invocations it took.
 *
 * Accumulated rather than replaced, for the reason its neighbour accumulates:
 * a paged sweep is ONE piece of work to the person running it, and showing only
 * the newest page scrolls the named pairs of page one off the screen, which is
 * the same as not reporting them. Totals add up; `hasMore` / `nextCursor` /
 * `panelEra` come from the newest page only and `hasMore` is never latched.
 */
interface MergeSweep {
  readonly dryRun: boolean
  readonly runs: number
  readonly pairsExamined: number
  readonly merged: number
  readonly wouldMerge: number
  readonly refused: number
  readonly rows: readonly DuplicateMergeRow[]
  readonly hasMore: boolean
  readonly nextCursor: string | null
  readonly panelEra: string | null
}

function appendPage(
  previous: MergeSweep | null,
  report: DuplicateMergeReport,
  startAfterId: string | undefined,
): MergeSweep {
  // A run WITHOUT a cursor is a fresh sweep, and a run whose mode differs from
  // what is on screen is a different piece of work. Either one starts over.
  const base =
    previous !== null && startAfterId !== undefined && previous.dryRun === report.dryRun
      ? previous
      : null
  return {
    dryRun: report.dryRun,
    runs: (base?.runs ?? 0) + 1,
    pairsExamined: (base?.pairsExamined ?? 0) + report.pairsExamined,
    merged: (base?.merged ?? 0) + report.merged,
    wouldMerge: (base?.wouldMerge ?? 0) + report.wouldMerge,
    refused: (base?.refused ?? 0) + report.refused,
    rows: [...(base?.rows ?? []), ...report.rows],
    hasMore: report.hasMore,
    nextCursor: report.nextCursor,
    panelEra: report.panelEra,
  }
}

/**
 * One report row plus the React key it renders under.
 *
 * KEYED BY THE PAIR, not by the array index. Rows arrive page by page, so every
 * position shifts as the sweep continues and an index key would let React reuse
 * a mounted row for a DIFFERENT pair — an operator reading one pair's survivor
 * against another pair's reattachment list, on the screen whose entire job is to
 * say which subscription keeps which customer's payments. A pair can also
 * legitimately repeat across pages (a refused pair re-examined on a later run),
 * so an occurrence suffix is appended where the same pair genuinely repeats.
 */
interface KeyedMergeRow {
  readonly key: string
  readonly row: DuplicateMergeRow
}

function keyPairs(rows: readonly DuplicateMergeRow[]): readonly KeyedMergeRow[] {
  const seen = new Map<string, number>()
  return rows.map((row) => {
    const survivor = row.survivorSubscriptionId.length > 0 ? row.survivorSubscriptionId : 'unnamed'
    const duplicate =
      row.duplicateSubscriptionId.length > 0 ? row.duplicateSubscriptionId : 'unnamed'
    const id = `${survivor}->${duplicate}`
    const occurrence = (seen.get(id) ?? 0) + 1
    seen.set(id, occurrence)
    return { key: occurrence === 1 ? id : `${id}#${occurrence}`, row }
  })
}

interface RefusalGroup {
  readonly refusal: string
  readonly rows: readonly KeyedMergeRow[]
}

/** Refused rows, grouped by their named refusal, in the declared order. */
function groupByRefusal(rows: readonly DuplicateMergeRow[]): readonly RefusalGroup[] {
  const groups = new Map<string, DuplicateMergeRow[]>()
  for (const row of rows) {
    // A refusal with no code still has to reach the screen: a refused pair that
    // silently vanished is the exact silence this whole family of code exists
    // to stop producing.
    const refusal = row.refusal ?? ''
    const existing = groups.get(refusal)
    if (existing === undefined) groups.set(refusal, [row])
    else existing.push(row)
  }
  return [...groups.entries()]
    .map(([refusal, grouped]) => ({ refusal, rows: keyPairs(grouped) }))
    .sort((a, b) => {
      const byRank = refusalRank(a.refusal) - refusalRank(b.refusal)
      return byRank !== 0 ? byRank : a.refusal.localeCompare(b.refusal)
    })
}

/**
 * A refusal this build does not recognise renders its RAW wire value rather
 * than being hidden or lumped into "other" — a refusal nobody can name is a
 * refusal nobody can act on.
 */
function refusalLabel(t: TFunction, refusal: string): string {
  if (isKnownRefusal(refusal)) return t(`duplicateMerge.refusals.${refusal}`)
  return refusal.length > 0 ? refusal : t('duplicateMerge.refusalUnnamed')
}

/**
 * The relation label, or the wire spelling when a relation is added
 * server-side. `model`.`column` is appended for the unknown case because that
 * pair is what an operator would grep the schema for.
 */
function relationLabel(t: TFunction, moved: DuplicateMergeReattachment): string {
  const known = [
    'transactions',
    'transactionItems',
    'promocodeActivations',
    'referralPointsExchanges',
    'trialClaim',
    'currentSubscriptionOf',
    'syncJobs',
  ]
  if (known.includes(moved.relation)) return t(`duplicateMerge.relations.${moved.relation}`)
  const wire = moved.relation.length > 0 ? moved.relation : t('duplicateMerge.fieldMissing')
  const column =
    moved.model.length > 0 && moved.column.length > 0 ? ` (${moved.model}.${moved.column})` : ''
  return `${wire}${column}`
}

/**
 * What to show for a failed run.
 *
 * `expectArray` rejects with a DICTIONARY KEY (`errors.unexpectedResponsePayload`)
 * rather than a sentence, and `translateApiError` looks its input up under an
 * `errors.` prefix — so handing it that key searches for
 * `errors.errors.unexpectedResponsePayload`, misses, and puts the raw key on
 * screen. Resolving an already-qualified key first is the whole fix.
 */
function describeRunFailure(t: TFunction, error: unknown): string {
  if (error instanceof Error && error.message.startsWith('errors.')) {
    const translated: string = t(error.message)
    if (translated !== error.message) return translated
  }
  return translateApiError(t, error)
}

/** A bound the operator typed, as a number or nothing at all — never a string. */
function parseBound(raw: string): number | undefined {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return undefined
  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed) || parsed < 1) return undefined
  return Math.floor(parsed)
}

export function DuplicateSubscriptionMergePanel(): JSX.Element | null {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const canMerge = useHasPermission('subscriptions', 'edit')

  const [limitInput, setLimitInput] = useState(String(DUPLICATE_MERGE_DEFAULT_LIMIT))
  const [chunkInput, setChunkInput] = useState(String(PANEL_LINK_RECONCILIATION_DEFAULT_CHUNK))
  const [sweep, setSweep] = useState<MergeSweep | null>(null)

  const runMutation = useMutation({
    mutationFn: (request: DuplicateMergeRequest) => runDuplicateSubscriptionMerge(request),
    onSuccess: (report, request) => {
      setSweep((previous) => appendPage(previous, report, request.startAfterId))
      if (!report.dryRun) {
        // A real run retires rows and moves payments between them, so the list
        // and the stat tiles above this panel are stale the moment it returns —
        // and so is every cached user detail, because a merged pair changes
        // which subscription a customer's history hangs off.
        queryClient.invalidateQueries({ queryKey: adminQueryKeys.subscriptions.all })
        queryClient.invalidateQueries({ queryKey: adminQueryKeys.users.all })
      }
      toast.success(
        report.dryRun
          ? t('duplicateMerge.ranDry', {
              mergeable: report.wouldMerge,
              pairs: report.pairsExamined,
            })
          : t('duplicateMerge.ranReal', {
              merged: report.merged,
              pairs: report.pairsExamined,
            }),
      )
    },
    onError: (error: unknown) => {
      toast.error(describeRunFailure(t, error))
    },
  })

  const { mutate } = runMutation
  const run = useCallback(
    (dryRun: boolean, startAfterId?: string) => {
      mutate({
        dryRun,
        limit: parseBound(limitInput),
        chunkSize: parseBound(chunkInput),
        ...(startAfterId === undefined ? {} : { startAfterId }),
      })
    },
    [mutate, limitInput, chunkInput],
  )

  // `sweep?.rows` rather than a `?? []` local: the fallback array is a fresh
  // identity on every render, so it would defeat every memo below it.
  const mergedRows = useMemo(
    () =>
      keyPairs(
        (sweep?.rows ?? []).filter(
          (row) => row.outcome === 'merged' || row.outcome === 'wouldMerge',
        ),
      ),
    [sweep?.rows],
  )
  const refusedGroups = useMemo(
    () => groupByRefusal((sweep?.rows ?? []).filter((row) => row.outcome === 'refused')),
    [sweep?.rows],
  )
  // An outcome this build has never heard of is neither merged nor refused, and
  // dropping it would hide a pair the server DID examine.
  const unclassifiedRows = useMemo(
    () =>
      keyPairs(
        (sweep?.rows ?? []).filter(
          (row) =>
            row.outcome !== 'merged' && row.outcome !== 'wouldMerge' && row.outcome !== 'refused',
        ),
      ),
    [sweep?.rows],
  )

  // No `subscriptions:edit` → no panel at all, and therefore no way to reach the
  // endpoint the guard would refuse anyway.
  if (!canMerge) return null

  const busy = runMutation.isPending
  const effectiveLimit = parseBound(limitInput) ?? DUPLICATE_MERGE_DEFAULT_LIMIT
  const previewMergeable = sweep !== null && sweep.dryRun ? sweep.wouldMerge : null

  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="max-w-2xl">
            <p className="flex items-center gap-2 text-sm font-semibold">
              <GitMerge className="h-4 w-4" aria-hidden="true" />
              {t('duplicateMerge.title')}
            </p>
            <p className="text-xs text-muted-foreground">{t('duplicateMerge.hint')}</p>
          </div>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="duplicate-merge-limit" className="text-xs">
              {t('duplicateMerge.limitLabel')}
            </Label>
            <Input
              id="duplicate-merge-limit"
              type="number"
              min={1}
              max={DUPLICATE_MERGE_MAX_LIMIT}
              className="h-9 w-32"
              value={limitInput}
              disabled={busy}
              onChange={(event) => setLimitInput(event.target.value)}
            />
            <p className="text-[11px] text-muted-foreground">
              {t('duplicateMerge.limitHint', { max: DUPLICATE_MERGE_MAX_LIMIT })}
            </p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="duplicate-merge-chunk" className="text-xs">
              {t('duplicateMerge.chunkLabel')}
            </Label>
            <Input
              id="duplicate-merge-chunk"
              type="number"
              min={1}
              max={PANEL_LINK_RECONCILIATION_MAX_CHUNK}
              className="h-9 w-32"
              value={chunkInput}
              disabled={busy}
              onChange={(event) => setChunkInput(event.target.value)}
            />
            <p className="text-[11px] text-muted-foreground">
              {t('duplicateMerge.chunkHint', { max: PANEL_LINK_RECONCILIATION_MAX_CHUNK })}
            </p>
          </div>

          <Button size="sm" className="h-9" disabled={busy} onClick={() => run(true)}>
            {busy ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <PlayCircle className="mr-2 h-4 w-4" aria-hidden="true" />
            )}
            {busy ? t('duplicateMerge.running') : t('duplicateMerge.runDryRun')}
          </Button>

          <RealMergeConfirmation
            busy={busy}
            label={t('duplicateMerge.runReal')}
            limit={effectiveLimit}
            startAfterId={undefined}
            previewMergeable={previewMergeable}
            onConfirm={() => run(false)}
          />
        </div>

        <p className="text-[11px] text-muted-foreground">{t('duplicateMerge.dryRunNote')}</p>

        {sweep === null ? null : (
          <div className="space-y-4 border-t pt-4">
            <MergeEraNotice era={sweep.panelEra} />

            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-semibold">{t('duplicateMerge.reportTitle')}</p>
              <Badge variant={sweep.dryRun ? 'secondary' : 'warning'}>
                {sweep.dryRun ? t('duplicateMerge.modeDry') : t('duplicateMerge.modeReal')}
              </Badge>
              <span className="text-xs text-muted-foreground">
                {t('duplicateMerge.pagesRun', { pages: sweep.runs })}
              </span>
            </div>

            <div className="flex flex-wrap gap-x-6 gap-y-2">
              <Metric
                label={t('duplicateMerge.metrics.pairsExamined')}
                value={sweep.pairsExamined}
              />
              <Metric label={t('duplicateMerge.metrics.merged')} value={sweep.merged} />
              <Metric label={t('duplicateMerge.metrics.wouldMerge')} value={sweep.wouldMerge} />
              <Metric
                label={t('duplicateMerge.metrics.refused')}
                value={sweep.refused}
                emphasise={sweep.refused > 0}
              />
            </div>

            <MergeProgress
              sweep={sweep}
              busy={busy}
              limit={effectiveLimit}
              previewMergeable={previewMergeable}
              onContinue={(dryRun, cursor) => run(dryRun, cursor)}
            />

            <PairSection
              title={
                sweep.dryRun
                  ? t('duplicateMerge.mergedTitleDry')
                  : t('duplicateMerge.mergedTitleReal')
              }
              emptyLabel={t('duplicateMerge.emptyMerged')}
              rows={mergedRows}
            />

            <div className="space-y-3">
              <p className="text-sm font-semibold">{t('duplicateMerge.refusedTitle')}</p>
              {refusedGroups.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('duplicateMerge.emptyRefused')}</p>
              ) : (
                refusedGroups.map((group) => (
                  <div key={group.refusal} className="space-y-1">
                    <RefusalHeading refusal={group.refusal} rows={group.rows.length} />
                    <PairTable rows={group.rows} />
                  </div>
                ))
              )}
            </div>

            {unclassifiedRows.length === 0 ? null : (
              <PairSection
                title={t('duplicateMerge.unknownOutcomeTitle')}
                emptyLabel={t('duplicateMerge.emptyMerged')}
                rows={unclassifiedRows}
              />
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/** A counter, rendered plainly. */
function Metric({
  label,
  value,
  emphasise = false,
}: {
  readonly label: string
  readonly value: number
  readonly emphasise?: boolean
}): JSX.Element {
  return (
    <div className="min-w-[7rem]">
      <p
        className={
          emphasise
            ? 'text-lg font-semibold tabular-nums text-destructive'
            : 'text-lg font-semibold tabular-nums'
        }
      >
        {value}
      </p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  )
}

/**
 * Which era of the panel API the DISCOVERY sweep believed it was talking to.
 *
 * `null` is the only one that gets an alert, and it is not a footnote: discovery
 * runs the reconciliation sweep, and a sweep that could not identify the panel
 * refuses to guess which identity spelling is current. "Zero pairs" from such a
 * run means the panel answered nothing — not that there are no duplicates —
 * and those two readings must not look alike.
 */
function MergeEraNotice({ era }: { readonly era: string | null }): JSX.Element {
  const { t } = useTranslation()
  if (era === null) {
    return (
      <Alert variant="destructive">
        <ShieldAlert className="h-4 w-4" aria-hidden="true" />
        <AlertTitle>{t('duplicateMerge.eraUnknownTitle')}</AlertTitle>
        <AlertDescription>{t('duplicateMerge.eraUnknownBody')}</AlertDescription>
      </Alert>
    )
  }
  // An era string the service does not document falls to its own sentence
  // rather than borrowing 2.x's or 3.x's — either would be a claim about which
  // population discovery searched, and this build has no basis for one.
  const scopeKey =
    era === PANEL_ERA_3X
      ? 'duplicateMerge.eraScope3x'
      : era === PANEL_ERA_2X
        ? 'duplicateMerge.eraScope2x'
        : 'duplicateMerge.eraScopeOther'
  return (
    <div className="rounded-lg border p-3">
      <p className="text-sm font-medium">{t('duplicateMerge.eraKnown', { era })}</p>
      <p className="text-xs text-muted-foreground">{t(scopeKey)}</p>
    </div>
  )
}

/**
 * Whether the merge finished, and the way to carry on when it did not.
 *
 * THREE STATES, NOT TWO, because the service produces a third and it is the one
 * that traps an operator. A run truncated by `limit` (more pairs found than this
 * invocation may merge) reports `hasMore: true` with the cursor it STARTED from
 * — deliberately, so the cursor never advances past a pair nobody touched. On a
 * first page that cursor is `null`, and there is nothing to continue FROM: the
 * remedy is to run it again from the beginning, which converges because the
 * pairs merged in this run are no longer live halves. A UI that only knew
 * "finished / continue from cursor" would show a continue button it cannot fill
 * in, or claim the sweep was done.
 */
function MergeProgress({
  sweep,
  busy,
  limit,
  previewMergeable,
  onContinue,
}: {
  readonly sweep: MergeSweep
  readonly busy: boolean
  readonly limit: number
  readonly previewMergeable: number | null
  readonly onContinue: (dryRun: boolean, cursor: string) => void
}): JSX.Element {
  const { t } = useTranslation()
  const cursor = sweep.nextCursor

  if (!sweep.hasMore) {
    return (
      <div className="rounded-lg border p-3">
        <p className="text-sm font-medium">{t('duplicateMerge.finishedTitle')}</p>
        <p className="text-xs text-muted-foreground">
          {cursor === null
            ? t('duplicateMerge.finishedBodyEmpty')
            : t('duplicateMerge.finishedBody', { cursor })}
        </p>
      </div>
    )
  }

  return (
    <Alert>
      <Wrench className="h-4 w-4" aria-hidden="true" />
      <AlertTitle>{t('duplicateMerge.hasMoreTitle')}</AlertTitle>
      <AlertDescription className="space-y-3">
        {cursor === null ? (
          <p>{t('duplicateMerge.hasMoreNoCursorBody')}</p>
        ) : (
          <>
            <p>{t('duplicateMerge.hasMoreBody', { cursor })}</p>
            <div className="flex flex-wrap gap-2">
              {sweep.dryRun ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8"
                  disabled={busy}
                  onClick={() => onContinue(true, cursor)}
                >
                  {t('duplicateMerge.continueDry')}
                </Button>
              ) : (
                <RealMergeConfirmation
                  busy={busy}
                  label={t('duplicateMerge.continueReal')}
                  limit={limit}
                  startAfterId={cursor}
                  previewMergeable={previewMergeable}
                  onConfirm={() => onContinue(false, cursor)}
                />
              )}
            </div>
          </>
        )}
      </AlertDescription>
    </Alert>
  )
}

/**
 * The only way a write can be requested.
 *
 * Both entry points to a real run — the first page and every continuation — go
 * through this component, so "continuing" a sweep cannot become a second,
 * unconfirmed path to the same write. The body states WHAT is written (a
 * customer's payment history moving between two rows, and one row retired) and
 * TO HOW MANY PAIRS, because "are you sure?" is not a statement an operator can
 * check anything against.
 */
function RealMergeConfirmation({
  busy,
  label,
  limit,
  startAfterId,
  previewMergeable,
  onConfirm,
}: {
  readonly busy: boolean
  readonly label: string
  readonly limit: number
  readonly startAfterId: string | undefined
  readonly previewMergeable: number | null
  readonly onConfirm: () => void
}): JSX.Element {
  const { t } = useTranslation()
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button size="sm" variant="destructive" className="h-9" disabled={busy}>
          <GitMerge className="mr-2 h-4 w-4" aria-hidden="true" />
          {label}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('duplicateMerge.confirmTitle')}</AlertDialogTitle>
          <AlertDialogDescription className="space-y-2">
            <span className="block">{t('duplicateMerge.confirmBody')}</span>
            <span className="block">{t('duplicateMerge.confirmHistory')}</span>
            <span className="block">
              {previewMergeable === null
                ? t('duplicateMerge.confirmNoPreview')
                : t('duplicateMerge.confirmMergeable', { pairs: previewMergeable })}
            </span>
            <span className="block">
              {t('duplicateMerge.confirmScope', {
                limit,
                from:
                  startAfterId === undefined
                    ? t('duplicateMerge.confirmFromStart')
                    : t('duplicateMerge.confirmFromCursor', { id: startAfterId }),
              })}
            </span>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>
            {t('duplicateMerge.confirmAction')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/**
 * The heading over one refusal group: what the refusal is, whether pressing it
 * again can ever change the answer, and what to do instead.
 *
 * THE REMEDY IS NOT OPTIONAL. A refusal without one is "something went wrong",
 * and an operator who is told only that goes back to editing rows by hand —
 * which is the practice this endpoint replaces.
 */
function RefusalHeading({
  refusal,
  rows,
}: {
  readonly refusal: string
  readonly rows: number
}): JSX.Element {
  const { t } = useTranslation()
  const known = isKnownRefusal(refusal)
  const cls = refusalClass(refusal)
  const tone =
    cls === 'retryable'
      ? 'warning'
      : cls === 'never'
        ? 'destructive'
        : cls === 'blocked'
          ? 'secondary'
          : 'outline'
  return (
    <div className="space-y-0.5">
      <p className="flex flex-wrap items-center gap-2 text-xs font-medium text-muted-foreground">
        <span>
          {t('duplicateMerge.groupHeading', {
            refusal: refusalLabel(t, refusal),
            rows,
          })}
        </span>
        <Badge variant={tone}>
          {cls === null
            ? t('duplicateMerge.retryClass.unknown')
            : t(`duplicateMerge.retryClass.${cls}`)}
        </Badge>
      </p>
      <p className="text-xs text-muted-foreground">
        {cls === null
          ? t('duplicateMerge.retryNote.unknown')
          : t(`duplicateMerge.retryNote.${cls}`)}
      </p>
      {/* The per-refusal remedy. An unknown refusal has none this build could
          honestly print, so it gets the server's own reason on each row and no
          invented next step. */}
      {known ? (
        <p className="text-xs text-muted-foreground">{t(`duplicateMerge.remedy.${refusal}`)}</p>
      ) : null}
    </div>
  )
}

/** One titled block of pairs. */
function PairSection({
  title,
  emptyLabel,
  rows,
}: {
  readonly title: string
  readonly emptyLabel: string
  readonly rows: readonly KeyedMergeRow[]
}): JSX.Element {
  return (
    <div className="space-y-3">
      <p className="text-sm font-semibold">{title}</p>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{emptyLabel}</p>
      ) : (
        <PairTable rows={rows} />
      )}
    </div>
  )
}

/**
 * The pairs themselves.
 *
 * COLUMN ORDER IS THE SAFETY PROPERTY. The survivor is first and labelled as
 * the row that is KEPT; the duplicate is second and labelled as the row that is
 * RETIRED. An operator reading these two the wrong way round deletes a paying
 * customer's history, so the two ids never share a cell and neither column is
 * called simply "subscription".
 */
function PairTable({ rows }: { readonly rows: readonly KeyedMergeRow[] }): JSX.Element {
  const { t } = useTranslation()
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('duplicateMerge.table.survivor')}</TableHead>
          <TableHead>{t('duplicateMerge.table.duplicate')}</TableHead>
          <TableHead>{t('duplicateMerge.table.customer')}</TableHead>
          <TableHead>{t('duplicateMerge.table.liveIdentity')}</TableHead>
          <TableHead>{t('duplicateMerge.table.holder')}</TableHead>
          <TableHead>{t('duplicateMerge.table.reattached')}</TableHead>
          <TableHead>{t('duplicateMerge.table.reason')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map(({ key, row }) => (
          <TableRow key={key}>
            <TableCell className="font-mono text-xs">
              {row.survivorSubscriptionId.length > 0
                ? row.survivorSubscriptionId
                : t('duplicateMerge.fieldMissing')}
            </TableCell>
            <TableCell className="font-mono text-xs">
              {row.duplicateSubscriptionId.length > 0
                ? row.duplicateSubscriptionId
                : t('duplicateMerge.fieldMissing')}
            </TableCell>
            <TableCell className="font-mono text-xs">
              {row.userId ?? t('duplicateMerge.fieldMissing')}
            </TableCell>
            <TableCell className="font-mono text-xs">
              {row.remnawaveId ?? t('duplicateMerge.fieldMissing')}
              {row.remnawavePanelId === null ? null : (
                <span className="block text-muted-foreground">
                  {t('duplicateMerge.panelIdInline', { id: row.remnawavePanelId })}
                </span>
              )}
              {row.panelUsername === null ? null : (
                <span className="block text-muted-foreground">{row.panelUsername}</span>
              )}
            </TableCell>
            <TableCell className="text-xs">
              <LiveIdentityHolderCell row={row} />
            </TableCell>
            <TableCell className="text-xs">
              <ReattachedCell row={row} />
            </TableCell>
            <TableCell className="max-w-md text-xs text-muted-foreground">
              {row.reason ?? t('duplicateMerge.fieldMissing')}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

/**
 * Which half is bound to the live panel profile, stated in the operator's own
 * words rather than left to be inferred from two identity strings.
 *
 * THE POLARITY IS BACKWARDS FROM INSTINCT, which is the entire reason this
 * column exists: in the pair a broken link produces, the OLDER row carrying the
 * customer's history stores a dead 2.x uuid and is bound to nothing, while the
 * NEWER, wrong-looking duplicate is the one actually pointing at the live
 * profile. An operator who tidies up the wrong-looking card issues a panel
 * DELETE against a paying customer.
 *
 * FOUR ANSWERS, NOT TWO, and the fourth is the dangerous one. A pair from the
 * shared-identity arm has BOTH halves bound to the same profile, and naming
 * either one of them alone would tell the operator the other is spare. It is
 * not, and deleting it takes the live profile with it.
 *
 * After a real merge the answer has changed — the survivor holds it now — so a
 * merged row says so instead of reporting the pre-merge state as if it were
 * current.
 */
function LiveIdentityHolderCell({ row }: { readonly row: DuplicateMergeRow }): JSX.Element {
  const { t } = useTranslation()
  const holder = liveIdentityHolder(row)

  if (row.outcome === 'merged') {
    // THREE ANSWERS, NOT TWO. Once the write lands the survivor holds the
    // identity either way, so the only thing this cell can still tell an
    // operator is where it CAME FROM — and that is precisely the field an undo
    // needs. A binary `? :` over a tri-state answers "the survivor already had
    // it" for a report that never said, which is a confident false statement
    // about a paying customer's live profile.
    const provenance =
      holder === null
        ? 'duplicateMerge.holder.cameFromUnknown'
        : holder === 'both'
          ? 'duplicateMerge.holder.cameFromBoth'
          : holder === 'duplicate'
            ? 'duplicateMerge.holder.cameFromDuplicate'
            : 'duplicateMerge.holder.cameFromSurvivor'
    return (
      <div className="space-y-0.5">
        <Badge variant="warning">{t('duplicateMerge.holder.survivorNow')}</Badge>
        <span className="block text-muted-foreground">{t(provenance)}</span>
      </div>
    )
  }

  if (holder === null) {
    return (
      <span className="italic text-muted-foreground">{t('duplicateMerge.holder.unknown')}</span>
    )
  }
  return (
    <Badge variant="warning">
      {holder === 'both'
        ? t('duplicateMerge.holder.both')
        : holder === 'duplicate'
          ? t('duplicateMerge.holder.duplicate')
          : t('duplicateMerge.holder.survivor')}
    </Badge>
  )
}

/**
 * The audit trail for one pair, ITEMISED.
 *
 * "3 transactions, 1 promocode activation and the trial claim followed the
 * survivor" is what lets an operator trust the merge — and, if it went to the
 * wrong pair, reconstruct it by hand from the audit log. A single count throws
 * that away: it cannot distinguish four payments from four sync-job rows, and
 * those two need entirely different repairs.
 *
 * Relations that moved NOTHING are listed too, quietly. An operator checking a
 * merge needs to see that the trial claim was considered and found absent, not
 * to wonder whether it was considered at all.
 */
function ReattachedCell({ row }: { readonly row: DuplicateMergeRow }): JSX.Element {
  const { t } = useTranslation()
  const moved = row.reattached

  if (moved === null) {
    return (
      <span className="italic text-muted-foreground">{t('duplicateMerge.reattachedUnreported')}</span>
    )
  }

  const carrying = moved.filter((entry) => entry.moved > 0)
  const empty = moved.filter((entry) => entry.moved === 0)

  return (
    <div className="space-y-0.5">
      {carrying.length === 0 ? (
        <span className="block text-muted-foreground">{t('duplicateMerge.reattachedNone')}</span>
      ) : (
        <ul className="list-none space-y-0.5">
          {carrying.map((entry) => (
            <li key={`${entry.model}.${entry.column}.${entry.relation}`}>
              {t('duplicateMerge.reattachedItem', {
                relation: relationLabel(t, entry),
                moved: entry.moved,
              })}
            </li>
          ))}
        </ul>
      )}
      {empty.length === 0 ? null : (
        <span className="block text-muted-foreground">
          {t('duplicateMerge.reattachedEmpty', {
            relations: empty.map((entry) => relationLabel(t, entry)).join(', '),
          })}
        </span>
      )}
      {row.supersededSyncJobs === null ? (
        <span className="block italic text-muted-foreground">
          {t('duplicateMerge.supersededUnreported')}
        </span>
      ) : (
        <span className="block text-muted-foreground">
          {t('duplicateMerge.supersededJobs', { jobs: row.supersededSyncJobs })}
        </span>
      )}
    </div>
  )
}

export default DuplicateSubscriptionMergePanel
