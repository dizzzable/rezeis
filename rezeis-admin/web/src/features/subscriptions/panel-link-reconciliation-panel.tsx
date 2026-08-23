/**
 * Panel link repair — operator surface.
 * ─────────────────────────────────────
 * The only caller of `POST /admin/profile-sync/panel-link-reconciliation`
 * (`AdminPanelLinkReconciliationController`, `subscriptions:edit`), which was
 * built, tested and documented and then had zero callers anywhere in the SPA.
 * The repair existed; the way to ask for it did not, so duplicates were being
 * cleaned by hand in production.
 *
 * WHY IT LIVES ON THE SUBSCRIPTIONS PAGE. Three reasons, in order of weight:
 *
 *  • It is the same authority. The controller demands `subscriptions:edit` —
 *    the identical token the SINGLE-row repair already asks for
 *    (`PATCH /admin/users/subscriptions/:id/remnawave-link`, wired up in
 *    `user-detail-panel.tsx`). The bulk counterpart answers to the same
 *    permission and therefore belongs on the same authority's surface, which
 *    is what the controller's own docblock says.
 *  • The rows it repairs are subscriptions, and the stat tiles above it count
 *    the states those rows are in.
 *  • `AutoRenewPanel`, its immediate sibling on this page, is the same shape
 *    for the same reason — a well-built controller with no reader, mounted
 *    here as a self-gating panel. Copying it beats inventing a route, and no
 *    route means no nav entry and no guard list to touch.
 *
 * WHAT THE SURFACE HAS TO DO, and why each part is not optional:
 *
 *  1. DRY BY DEFAULT, AND THE DEFAULT IS A DIFFERENT BUTTON. The preview runs
 *     on one click; the write runs only after a confirmation that names what
 *     it writes. `panel-link-reconciliation-api.ts` owns the guarantee that
 *     `dryRun` reaches the wire as a real boolean.
 *  2. EVERY ROW BY NAME. The report's value is that unrepairable rows are
 *     named with their reason; a wall of counters throws the deliverable away.
 *     `storedRemnawaveId` is shown NEXT TO the resolved identity because an
 *     operator who cannot see what the row holds now cannot check the repair.
 *  3. `hasMore` IS LOUD. A backlog needs more than one invocation, and a UI
 *     that stops at page one lets the operator believe the sweep finished.
 *     That silence is the same class of defect the sweep repairs.
 *  4. `panelEra` IS NOT A FOOTNOTE. "Zero repairs" from a sweep that knew the
 *     era means nothing was broken; from a sweep that did not, it means the
 *     panel answered nothing. Those two readings must not look alike.
 */
import { useCallback, useMemo, useState, type JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { TFunction } from 'i18next'
import { Loader2, Link2, PlayCircle, ShieldAlert, Wrench } from 'lucide-react'
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
  PANEL_ERA_2X,
  PANEL_ERA_3X,
  PANEL_LINK_RECONCILIATION_DEFAULT_CHUNK,
  PANEL_LINK_RECONCILIATION_DEFAULT_LIMIT,
  PANEL_LINK_RECONCILIATION_MAX_CHUNK,
  PANEL_LINK_RECONCILIATION_MAX_LIMIT,
  PANEL_LINK_RESOLVED_BY_SHORT_UUID,
  PANEL_LINK_RESOLVED_BY_STORED_IDENTITY,
  PANEL_LINK_RESOLVED_BY_USERNAME,
  isKnownOutcome,
  outcomeRank,
  runPanelLinkReconciliation,
  type PanelLinkReconciliationReport,
  type PanelLinkReconciliationRequest,
  type PanelLinkReconciliationRow,
} from './panel-link-reconciliation-api'

/**
 * Everything the operator has learned in this sweep, across however many
 * invocations it took.
 *
 * Accumulated rather than replaced because a paged sweep is ONE piece of work
 * to the person running it: showing only the newest page would scroll the
 * named rows of page one off the screen, which is the same as not reporting
 * them. Totals add up; `hasMore` / `nextCursor` / `panelEra` are taken from the
 * newest page only — `hasMore` in particular is never latched, for exactly the
 * reason the service refuses to latch it.
 */
interface Sweep {
  readonly dryRun: boolean
  readonly runs: number
  readonly scanned: number
  readonly linked: number
  readonly wouldLink: number
  readonly staleIdentityScanned: number | null
  readonly duplicatePairs: number | null
  readonly sharedIdentityPairs: number | null
  readonly repaired: readonly PanelLinkReconciliationRow[]
  readonly unrepaired: readonly PanelLinkReconciliationRow[]
  readonly hasMore: boolean
  readonly nextCursor: string | null
  readonly panelEra: string | null
}

/**
 * Adds two counters either of which the server may not have reported.
 * `null + null` stays `null`: a total invented for a number nobody sent is the
 * confident false statement this whole screen exists to stop producing.
 */
function addReported(left: number | null, right: number | null): number | null {
  if (left === null && right === null) return null
  return (left ?? 0) + (right ?? 0)
}

function appendPage(
  previous: Sweep | null,
  report: PanelLinkReconciliationReport,
  startAfterId: string | undefined,
): Sweep {
  // A run WITHOUT a cursor is a fresh sweep, and a run whose mode differs from
  // what is on screen is a different piece of work. Either one starts over.
  const base =
    previous !== null && startAfterId !== undefined && previous.dryRun === report.dryRun
      ? previous
      : null
  return {
    dryRun: report.dryRun,
    runs: (base?.runs ?? 0) + 1,
    scanned: (base?.scanned ?? 0) + report.scanned,
    linked: (base?.linked ?? 0) + report.linked,
    wouldLink: (base?.wouldLink ?? 0) + report.wouldLink,
    staleIdentityScanned: addReported(
      base?.staleIdentityScanned ?? null,
      report.staleIdentityScanned,
    ),
    duplicatePairs: addReported(base?.duplicatePairs ?? null, report.duplicatePairs),
    sharedIdentityPairs: addReported(
      base?.sharedIdentityPairs ?? null,
      report.sharedIdentityPairs,
    ),
    repaired: [...(base?.repaired ?? []), ...report.repaired],
    unrepaired: [...(base?.unrepaired ?? []), ...report.unrepaired],
    hasMore: report.hasMore,
    nextCursor: report.nextCursor,
    panelEra: report.panelEra,
  }
}

/**
 * One report row plus the React key it renders under.
 *
 * THE KEY IS THE SUBSCRIPTION ID, not the array index. A `duplicatePair` emits
 * TWO rows — the scanned half and the partner it collided with — and a
 * multi-page sweep can scan the partner in its own right on a later page, so a
 * subscription id is not unique within a group and an id-only key would be a
 * React duplicate. An INDEX key is the worse answer: rows arrive page by page,
 * so every position shifts as the sweep continues and React would reuse a
 * mounted row for a different subscription — an operator reading one row's
 * identity against another row's reason, on the screen whose entire job is to
 * say which identity belongs to which subscription. So the id leads and a
 * `#n` occurrence suffix is appended only where the same id genuinely repeats.
 */
interface KeyedRow {
  readonly key: string
  readonly row: PanelLinkReconciliationRow
}

interface OutcomeGroup {
  readonly outcome: string
  readonly rows: readonly KeyedRow[]
}

/** Known outcomes in their declared order; anything newer sorts after them. */
function groupByOutcome(rows: readonly PanelLinkReconciliationRow[]): readonly OutcomeGroup[] {
  const groups = new Map<string, PanelLinkReconciliationRow[]>()
  for (const row of rows) {
    const existing = groups.get(row.outcome)
    if (existing === undefined) groups.set(row.outcome, [row])
    else existing.push(row)
  }
  return [...groups.entries()]
    .map(([outcome, grouped]) => {
      const seen = new Map<string, number>()
      const keyed = grouped.map((row) => {
        const id = row.subscriptionId.length > 0 ? row.subscriptionId : 'unnamed'
        const occurrence = (seen.get(id) ?? 0) + 1
        seen.set(id, occurrence)
        return { key: occurrence === 1 ? id : `${id}#${occurrence}`, row }
      })
      return { outcome, rows: keyed }
    })
    .sort((a, b) => {
      const byRank = outcomeRank(a.outcome) - outcomeRank(b.outcome)
      return byRank !== 0 ? byRank : a.outcome.localeCompare(b.outcome)
    })
}

/**
 * An outcome this build does not recognise renders its RAW wire value rather
 * than being hidden or lumped into "other" — a row nobody can name is a row
 * nobody can act on.
 */
function outcomeLabel(t: TFunction, outcome: string): string {
  if (isKnownOutcome(outcome)) return t(`panelLinkReconciliation.outcomes.${outcome}`)
  return outcome.length > 0 ? outcome : t('panelLinkReconciliation.fieldMissing')
}

/**
 * Which route named the profile — and, for one of them, what that implies.
 *
 * `storedIdentity` is not a third resolve: the panel was never asked, because
 * both rows ALREADY store the same well-formed identity. So its label says
 * "both live rows" outright rather than naming a lookup that never happened —
 * an operator reading it as just another resolve would go on believing one
 * half of the pair is the broken one, and there is no broken one.
 *
 * An unrecognised route still renders its raw wire value, for the same reason
 * `outcomeLabel` does: a row nobody can name is a row nobody can act on.
 */
function resolvedByLabel(t: TFunction, resolvedBy: string): string {
  if (resolvedBy === PANEL_LINK_RESOLVED_BY_SHORT_UUID) {
    return t('panelLinkReconciliation.resolvedByShortUuid')
  }
  if (resolvedBy === PANEL_LINK_RESOLVED_BY_USERNAME) {
    return t('panelLinkReconciliation.resolvedByUsername')
  }
  if (resolvedBy === PANEL_LINK_RESOLVED_BY_STORED_IDENTITY) {
    return t('panelLinkReconciliation.resolvedByStoredIdentity')
  }
  return resolvedBy.length > 0 ? resolvedBy : t('panelLinkReconciliation.fieldMissing')
}

/**
 * What to show for a failed run.
 *
 * `expectArray` rejects with a DICTIONARY KEY (`errors.unexpectedResponsePayload`)
 * rather than a sentence, and `translateApiError` looks its input up under an
 * `errors.` prefix — so handing it that key searches for
 * `errors.errors.unexpectedResponsePayload`, misses, and puts the raw key on
 * screen. Resolving an already-qualified key first is the whole fix; anything
 * else falls through to the shared translator unchanged.
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

export function PanelLinkReconciliationPanel(): JSX.Element | null {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const canRepair = useHasPermission('subscriptions', 'edit')

  const [limitInput, setLimitInput] = useState(String(PANEL_LINK_RECONCILIATION_DEFAULT_LIMIT))
  const [chunkInput, setChunkInput] = useState(String(PANEL_LINK_RECONCILIATION_DEFAULT_CHUNK))
  const [sweep, setSweep] = useState<Sweep | null>(null)

  const runMutation = useMutation({
    mutationFn: (request: PanelLinkReconciliationRequest) => runPanelLinkReconciliation(request),
    onSuccess: (report, request) => {
      setSweep((previous) => appendPage(previous, report, request.startAfterId))
      if (!report.dryRun) {
        // A real run rewrites `remnawave_id` on live rows, so the list and the
        // stat tiles above this panel are stale the moment it returns.
        queryClient.invalidateQueries({ queryKey: adminQueryKeys.subscriptions.all })
      }
      toast.success(
        report.dryRun
          ? t('panelLinkReconciliation.ranDry', {
              repairable: report.wouldLink,
              scanned: report.scanned,
            })
          : t('panelLinkReconciliation.ranReal', {
              linked: report.linked,
              scanned: report.scanned,
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

  const repairedGroups = useMemo(
    () => groupByOutcome(sweep?.repaired ?? []),
    [sweep?.repaired],
  )
  const unrepairedGroups = useMemo(
    () => groupByOutcome(sweep?.unrepaired ?? []),
    [sweep?.unrepaired],
  )

  // No `subscriptions:edit` → no panel at all, and therefore no way to reach
  // the endpoint the guard would refuse anyway.
  if (!canRepair) return null

  const busy = runMutation.isPending
  const effectiveLimit = parseBound(limitInput) ?? PANEL_LINK_RECONCILIATION_DEFAULT_LIMIT
  const previewRepairable = sweep !== null && sweep.dryRun ? sweep.wouldLink : null
  // Either signal is enough. The counter and the rows are produced by different
  // parts of the report, and a build that meets a backend carrying only one of
  // them must still shout.
  const hasDuplicatePair =
    (sweep?.duplicatePairs ?? 0) > 0 ||
    (sweep?.unrepaired ?? []).some((row) => row.outcome === 'duplicatePair')
  // ── THE TWO DUPLICATE POPULATIONS, WHICH NEED OPPOSITE ADVICE ────────────
  //
  // A resolve-route pair has exactly ONE bound half, and every sentence in
  // `duplicateDangerBody` rests on that: the wrong-looking row is the live one,
  // so find it before touching anything. The shared-identity arm produces pairs
  // where both rows already store the same well-formed identity, so BOTH halves
  // are bound and there is no unbound half to find. Against those rows that
  // paragraph is not incomplete, it is FALSE — and "look for the unbound one"
  // is an instruction that ends in a panel DELETE against a live profile.
  //
  // So each paragraph is gated on its own population being present. Either
  // signal counts, for the reason `hasDuplicatePair` takes either: the counter
  // and the rows come from different parts of the report, and a build that
  // meets a backend carrying only one of them must still shout.
  const allRows = [...(sweep?.unrepaired ?? []), ...(sweep?.repaired ?? [])]
  const hasSharedIdentityPair =
    (sweep?.sharedIdentityPairs ?? 0) > 0 ||
    allRows.some((row) => row.resolvedBy === PANEL_LINK_RESOLVED_BY_STORED_IDENTITY)
  // The resolve-route paragraph stays the DEFAULT and is suppressed only when
  // this build can see that every duplicate on screen came from the other arm.
  // A counter-only report — no rows, no `sharedIdentityPairs` — keeps the
  // historical wording rather than going silent about the danger entirely.
  const hasResolvedRouteDuplicate =
    !hasSharedIdentityPair ||
    allRows.some(
      (row) =>
        row.outcome === 'duplicatePair' &&
        row.resolvedBy !== PANEL_LINK_RESOLVED_BY_STORED_IDENTITY,
    )

  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="max-w-2xl">
            <p className="flex items-center gap-2 text-sm font-semibold">
              <Link2 className="h-4 w-4" aria-hidden="true" />
              {t('panelLinkReconciliation.title')}
            </p>
            <p className="text-xs text-muted-foreground">{t('panelLinkReconciliation.hint')}</p>
          </div>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="panel-link-limit" className="text-xs">
              {t('panelLinkReconciliation.limitLabel')}
            </Label>
            <Input
              id="panel-link-limit"
              type="number"
              min={1}
              max={PANEL_LINK_RECONCILIATION_MAX_LIMIT}
              className="h-9 w-32"
              value={limitInput}
              disabled={busy}
              onChange={(event) => setLimitInput(event.target.value)}
            />
            <p className="text-[11px] text-muted-foreground">
              {t('panelLinkReconciliation.limitHint', { max: PANEL_LINK_RECONCILIATION_MAX_LIMIT })}
            </p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="panel-link-chunk" className="text-xs">
              {t('panelLinkReconciliation.chunkLabel')}
            </Label>
            <Input
              id="panel-link-chunk"
              type="number"
              min={1}
              max={PANEL_LINK_RECONCILIATION_MAX_CHUNK}
              className="h-9 w-32"
              value={chunkInput}
              disabled={busy}
              onChange={(event) => setChunkInput(event.target.value)}
            />
            <p className="text-[11px] text-muted-foreground">
              {t('panelLinkReconciliation.chunkHint', { max: PANEL_LINK_RECONCILIATION_MAX_CHUNK })}
            </p>
          </div>

          <Button size="sm" className="h-9" disabled={busy} onClick={() => run(true)}>
            {busy ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <PlayCircle className="mr-2 h-4 w-4" aria-hidden="true" />
            )}
            {busy ? t('panelLinkReconciliation.running') : t('panelLinkReconciliation.runDryRun')}
          </Button>

          <RealRunConfirmation
            busy={busy}
            label={t('panelLinkReconciliation.runReal')}
            limit={effectiveLimit}
            startAfterId={undefined}
            previewRepairable={previewRepairable}
            onConfirm={() => run(false)}
          />
        </div>

        <p className="text-[11px] text-muted-foreground">
          {t('panelLinkReconciliation.dryRunNote')}
        </p>

        {sweep === null ? null : (
          <div className="space-y-4 border-t pt-4">
            <PanelEraNotice era={sweep.panelEra} />

            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-semibold">{t('panelLinkReconciliation.reportTitle')}</p>
              <Badge variant={sweep.dryRun ? 'secondary' : 'warning'}>
                {sweep.dryRun
                  ? t('panelLinkReconciliation.modeDry')
                  : t('panelLinkReconciliation.modeReal')}
              </Badge>
              <span className="text-xs text-muted-foreground">
                {t('panelLinkReconciliation.pagesRun', { pages: sweep.runs })}
              </span>
            </div>

            <div className="flex flex-wrap gap-x-6 gap-y-2">
              <Metric label={t('panelLinkReconciliation.metrics.scanned')} value={sweep.scanned} />
              <Metric label={t('panelLinkReconciliation.metrics.linked')} value={sweep.linked} />
              <Metric
                label={t('panelLinkReconciliation.metrics.wouldLink')}
                value={sweep.wouldLink}
              />
              <Metric
                label={t('panelLinkReconciliation.metrics.unrepaired')}
                value={sweep.unrepaired.length}
                emphasise={sweep.unrepaired.length > 0}
              />
              <Metric
                label={t('panelLinkReconciliation.metrics.staleIdentityScanned')}
                value={sweep.staleIdentityScanned}
              />
              <Metric
                label={t('panelLinkReconciliation.metrics.duplicatePairs')}
                value={sweep.duplicatePairs}
                emphasise={(sweep.duplicatePairs ?? 0) > 0}
              />
              {/* Which of those pairs have NO unbound half. Shown beside the
                  total so the two populations are told apart at a glance
                  rather than by opening rows — they take opposite advice, and
                  the advice for this one is the one that prevents a DELETE. */}
              <Metric
                label={t('panelLinkReconciliation.metrics.sharedIdentityPairs')}
                value={sweep.sharedIdentityPairs}
                emphasise={(sweep.sharedIdentityPairs ?? 0) > 0}
              />
            </div>

            {hasDuplicatePair ? (
              <DuplicatePairWarning
                oneHalfUnbound={hasResolvedRouteDuplicate}
                bothHalvesLive={hasSharedIdentityPair}
              />
            ) : null}

            <SweepProgress
              sweep={sweep}
              busy={busy}
              limit={effectiveLimit}
              previewRepairable={previewRepairable}
              onContinue={(dryRun, cursor) => run(dryRun, cursor)}
            />

            <RowSection
              title={
                sweep.dryRun
                  ? t('panelLinkReconciliation.repairedTitleDry')
                  : t('panelLinkReconciliation.repairedTitleReal')
              }
              emptyLabel={t('panelLinkReconciliation.emptyRepaired')}
              groups={repairedGroups}
            />
            <RowSection
              title={t('panelLinkReconciliation.unrepairedTitle')}
              emptyLabel={t('panelLinkReconciliation.emptyUnrepaired')}
              groups={unrepairedGroups}
            />
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/**
 * A counter the server may not have sent.
 *
 * `null` renders as "not reported", NEVER as `0`. Those two say opposite
 * things: `0` is a measurement, and printing one for a field that never
 * arrived would let a half-deployed backend look like a clean panel.
 */
function Metric({
  label,
  value,
  emphasise = false,
}: {
  readonly label: string
  readonly value: number | null
  readonly emphasise?: boolean
}): JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="min-w-[7rem]">
      {value === null ? (
        <p className="text-sm italic text-muted-foreground">
          {t('panelLinkReconciliation.metricUnavailable')}
        </p>
      ) : (
        <p
          className={
            emphasise
              ? 'text-lg font-semibold tabular-nums text-destructive'
              : 'text-lg font-semibold tabular-nums'
          }
        >
          {value}
        </p>
      )}
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  )
}

/**
 * Which era of the panel API answered — or the fact that nothing did.
 *
 * THREE MEANINGS, THREE SENTENCES, because "zero repairs" reads differently
 * under each and the difference is the whole point of reporting the era:
 *
 *   3.x   both populations were searched — the rows with no identity AND the
 *         rows holding a dead 2.x uuid. Zero repairs means nothing was broken.
 *   2.x   a uuid-shaped identity is CORRECT here, so the stale population does
 *         not exist on this panel and was never selected. Zero repairs means
 *         nothing was broken in the only population there is — it does NOT mean
 *         the stale rows were checked and found clean.
 *   null  the sweep refused to guess, and left the stale population out
 *         entirely. Zero repairs means the panel answered nothing.
 *
 * Only the third is an `Alert`: it is the one that reverses the meaning of
 * every number above it. The other two are statements of scope, and collapsing
 * them into one "the sweep knew the era" sentence would tell a 2.x operator
 * their stale rows came back clean when they were never looked at.
 */
function PanelEraNotice({ era }: { readonly era: string | null }): JSX.Element {
  const { t } = useTranslation()
  if (era === null) {
    return (
      <Alert variant="destructive">
        <ShieldAlert className="h-4 w-4" aria-hidden="true" />
        <AlertTitle>{t('panelLinkReconciliation.eraUnknownTitle')}</AlertTitle>
        <AlertDescription>{t('panelLinkReconciliation.eraUnknownBody')}</AlertDescription>
      </Alert>
    )
  }
  // An era string the service does not document falls to its own sentence
  // rather than borrowing 2.x's or 3.x's — either would be a claim about which
  // populations were searched, and this build has no basis for one.
  const scopeKey =
    era === PANEL_ERA_3X
      ? 'panelLinkReconciliation.eraScope3x'
      : era === PANEL_ERA_2X
        ? 'panelLinkReconciliation.eraScope2x'
        : 'panelLinkReconciliation.eraScopeOther'
  return (
    <div className="rounded-lg border p-3">
      <p className="text-sm font-medium">{t('panelLinkReconciliation.eraKnown', { era })}</p>
      <p className="text-xs text-muted-foreground">{t(scopeKey)}</p>
    </div>
  )
}

/**
 * The one thing on this screen an operator can do irreversible damage with.
 *
 * A `duplicatePair` is TWO live rows on ONE panel profile, and the polarity is
 * backwards from instinct: the older, legitimate-looking row holds a dead 2.x
 * uuid, and the newer, wrong-looking duplicate is the one bound to the profile
 * the customer is actually using. Deleting either half through the panel
 * destroys a paying customer's service, and the half an operator reaches for
 * first is the wrong one.
 *
 * So this is an alert above the tables, not a column an operator might scroll
 * past. The sweep DIAGNOSES pairs and deliberately does not merge them —
 * merging moves history, payments and referral links, and belongs behind its
 * own dry run rather than inside a link repair.
 *
 * TWO POPULATIONS, TWO PARAGRAPHS, EACH GATED ON ITS OWN ROWS. `oneHalfUnbound`
 * covers the pair described above — one dead half, one live half — and every
 * word of its advice rests on there BEING a wrong-looking half to identify.
 * `bothHalvesLive` covers the shared-identity arm, where both rows already
 * store the same well-formed identity: both are bound, neither looks wrong, and
 * only the creation date separates them. Against those rows the first paragraph
 * is a FALSE statement rather than a partial one — "find the unbound half" sends
 * the operator to delete a live profile — so it is suppressed when this build
 * can see that every duplicate on screen came from the other arm.
 *
 * The second paragraph also names the tie-breaker the operator is left with once
 * neither row is broken: the older row is the survivor, because it is the one
 * carrying the payments and the customer history.
 */
function DuplicatePairWarning({
  oneHalfUnbound,
  bothHalvesLive,
}: {
  readonly oneHalfUnbound: boolean
  readonly bothHalvesLive: boolean
}): JSX.Element {
  const { t } = useTranslation()
  return (
    <Alert variant="destructive">
      <ShieldAlert className="h-4 w-4" aria-hidden="true" />
      <AlertTitle>{t('panelLinkReconciliation.duplicateDangerTitle')}</AlertTitle>
      <AlertDescription className="space-y-1">
        {oneHalfUnbound ? <p>{t('panelLinkReconciliation.duplicateDangerBody')}</p> : null}
        {bothHalvesLive ? <p>{t('panelLinkReconciliation.duplicateDangerBothLive')}</p> : null}
        <p>{t('panelLinkReconciliation.duplicateDangerNext')}</p>
      </AlertDescription>
    </Alert>
  )
}

/**
 * Whether the sweep finished, and the way to carry on when it did not.
 *
 * `hasMore` gets a titled block rather than a caption: a run that stopped at
 * its cap has examined a PREFIX of the backlog, and an operator who reads the
 * counters as the whole picture stops early believing the job is done.
 */
function SweepProgress({
  sweep,
  busy,
  limit,
  previewRepairable,
  onContinue,
}: {
  readonly sweep: Sweep
  readonly busy: boolean
  readonly limit: number
  readonly previewRepairable: number | null
  readonly onContinue: (dryRun: boolean, cursor: string) => void
}): JSX.Element {
  const { t } = useTranslation()
  const cursor = sweep.nextCursor

  if (!sweep.hasMore) {
    return (
      <div className="rounded-lg border p-3">
        <p className="text-sm font-medium">{t('panelLinkReconciliation.finishedTitle')}</p>
        <p className="text-xs text-muted-foreground">
          {cursor === null
            ? t('panelLinkReconciliation.finishedBodyEmpty')
            : t('panelLinkReconciliation.finishedBody', { cursor })}
        </p>
      </div>
    )
  }

  return (
    <Alert>
      <Wrench className="h-4 w-4" aria-hidden="true" />
      <AlertTitle>{t('panelLinkReconciliation.hasMoreTitle')}</AlertTitle>
      <AlertDescription className="space-y-3">
        <p>
          {t('panelLinkReconciliation.hasMoreBody', {
            cursor: cursor ?? t('panelLinkReconciliation.fieldMissing'),
          })}
        </p>
        {cursor === null ? null : (
          <div className="flex flex-wrap gap-2">
            {sweep.dryRun ? (
              <Button
                size="sm"
                variant="outline"
                className="h-8"
                disabled={busy}
                onClick={() => onContinue(true, cursor)}
              >
                {t('panelLinkReconciliation.continueDry')}
              </Button>
            ) : (
              <RealRunConfirmation
                busy={busy}
                label={t('panelLinkReconciliation.continueReal')}
                limit={limit}
                startAfterId={cursor}
                previewRepairable={previewRepairable}
                onConfirm={() => onContinue(false, cursor)}
              />
            )}
          </div>
        )}
      </AlertDescription>
    </Alert>
  )
}

/**
 * The only way a write can be requested.
 *
 * Both entry points to a real run — the first page and every continuation —
 * go through this component, so "continuing" a sweep cannot become a second,
 * unconfirmed path to the same write.
 */
function RealRunConfirmation({
  busy,
  label,
  limit,
  startAfterId,
  previewRepairable,
  onConfirm,
}: {
  readonly busy: boolean
  readonly label: string
  readonly limit: number
  readonly startAfterId: string | undefined
  readonly previewRepairable: number | null
  readonly onConfirm: () => void
}): JSX.Element {
  const { t } = useTranslation()
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button size="sm" variant="destructive" className="h-9" disabled={busy}>
          <Wrench className="mr-2 h-4 w-4" aria-hidden="true" />
          {label}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('panelLinkReconciliation.confirmTitle')}</AlertDialogTitle>
          <AlertDialogDescription className="space-y-2">
            <span className="block">{t('panelLinkReconciliation.confirmBody')}</span>
            <span className="block">
              {previewRepairable === null
                ? t('panelLinkReconciliation.confirmNoPreview')
                : t('panelLinkReconciliation.confirmRepairable', { rows: previewRepairable })}
            </span>
            <span className="block">
              {t('panelLinkReconciliation.confirmScope', {
                limit,
                from:
                  startAfterId === undefined
                    ? t('panelLinkReconciliation.confirmFromStart')
                    : t('panelLinkReconciliation.confirmFromCursor', { id: startAfterId }),
              })}
            </span>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>
            {t('panelLinkReconciliation.confirmAction')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/**
 * Whether this row is the one actually bound to the live panel profile.
 *
 * Three states, not two. An absent flag reads as "not reported" rather than as
 * "not bound": the whole value of this column is that it points AWAY from the
 * destructive action, and a guessed  points straight at it.
 *
 * "Live" ON BOTH HALVES IS A REAL ANSWER, not a bug in the report. The
 * shared-identity arm finds pairs where both rows already store the same
 * well-formed identity, and both are bound to the same profile. That is why
 * this cell reports each row on its own terms instead of rendering a
 * one-of-two verdict across the pair: there is no rule that one of them is
 * unbound.
 */
function LiveIdentityCell({
  holdsLiveIdentity,
}: {
  readonly holdsLiveIdentity: boolean | null
}): JSX.Element {
  const { t } = useTranslation()
  if (holdsLiveIdentity === null) {
    return (
      <span className="italic text-muted-foreground">
        {t('panelLinkReconciliation.metricUnavailable')}
      </span>
    )
  }
  return holdsLiveIdentity ? (
    <Badge variant="warning">{t('panelLinkReconciliation.holdsLiveYes')}</Badge>
  ) : (
    <span className="text-muted-foreground">{t('panelLinkReconciliation.holdsLiveNo')}</span>
  )
}

/** One half of the report — repaired or not — grouped by outcome. */
function RowSection({
  title,
  emptyLabel,
  groups,
}: {
  readonly title: string
  readonly emptyLabel: string
  readonly groups: readonly OutcomeGroup[]
}): JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="space-y-3">
      <p className="text-sm font-semibold">{title}</p>
      {groups.length === 0 ? (
        <p className="text-sm text-muted-foreground">{emptyLabel}</p>
      ) : (
        groups.map((group) => (
          <div key={group.outcome} className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">
              {t('panelLinkReconciliation.groupHeading', {
                outcome: outcomeLabel(t, group.outcome),
                rows: group.rows.length,
              })}
            </p>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('panelLinkReconciliation.table.subscription')}</TableHead>
                  <TableHead>{t('panelLinkReconciliation.table.user')}</TableHead>
                  <TableHead>{t('panelLinkReconciliation.table.panelUsername')}</TableHead>
                  <TableHead>{t('panelLinkReconciliation.table.resolvedBy')}</TableHead>
                  <TableHead>{t('panelLinkReconciliation.table.storedId')}</TableHead>
                  <TableHead>{t('panelLinkReconciliation.table.resolvedId')}</TableHead>
                  <TableHead>{t('panelLinkReconciliation.table.panelId')}</TableHead>
                  <TableHead>{t('panelLinkReconciliation.table.duplicateOf')}</TableHead>
                  <TableHead>{t('panelLinkReconciliation.table.holdsLive')}</TableHead>
                  <TableHead>{t('panelLinkReconciliation.table.reason')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {group.rows.map(({ key, row }) => (
                  <TableRow key={key}>
                    <TableCell className="font-mono text-xs">
                      {row.subscriptionId.length > 0
                        ? row.subscriptionId
                        : t('panelLinkReconciliation.fieldMissing')}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {row.userId.length > 0
                        ? row.userId
                        : t('panelLinkReconciliation.fieldMissing')}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {row.panelUsername.length > 0
                        ? row.panelUsername
                        : t('panelLinkReconciliation.fieldMissing')}
                    </TableCell>
                    <TableCell className="text-xs">{resolvedByLabel(t, row.resolvedBy)}</TableCell>
                    {/* The dead identity, beside the live one. An operator who
                        cannot see what the row holds NOW cannot check the repair. */}
                    <TableCell className="font-mono text-xs">
                      {row.storedRemnawaveId ?? (
                        <span className="italic text-muted-foreground">
                          {t('panelLinkReconciliation.storedEmpty')}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {row.remnawaveId ?? t('panelLinkReconciliation.fieldMissing')}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {row.panelId === null
                        ? t('panelLinkReconciliation.fieldMissing')
                        : row.panelId}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {row.duplicateOfSubscriptionId ??
                        t('panelLinkReconciliation.fieldMissing')}
                    </TableCell>
                    {/* Stated outright, never inferred. On a resolve-route
                        pair the polarity is backwards from instinct — the
                        WRONG-looking duplicate is the row bound to the live
                        profile — and on a shared-identity pair BOTH halves say
                        "Live". Either way an operator who tidies up on a guess
                        issues a panel DELETE against a paying customer. */}
                    <TableCell className="text-xs">
                      <LiveIdentityCell holdsLiveIdentity={row.holdsLiveIdentity} />
                    </TableCell>
                    <TableCell className="max-w-md text-xs text-muted-foreground">
                      {row.reason ?? t('panelLinkReconciliation.fieldMissing')}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ))
      )}
    </div>
  )
}

export default PanelLinkReconciliationPanel
