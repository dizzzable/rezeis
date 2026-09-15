/**
 * Step 4 of the plan delete dialog (spec §7): "было → станет" before anything is
 * written — per target a count with its warnings, and per subscription its
 * traffic, devices and squads before and after, with the fields kept because
 * the operator set them by hand marked «вручную».
 *
 * The preview is the server's dry run of the very function the move uses, so
 * this step computes nothing about limits: it draws what it was told, in the
 * encodings the columns use (traffic `null` and devices `<= 0` are unlimited).
 */
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, ArrowRight, Loader2 } from 'lucide-react'

import {
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { cn, truncate } from '@/lib/utils'

import type { PlanDeleteImpact } from './plan-delete'
import { PlanUsageDetails } from './plan-delete-usage'
import type { Plan } from './plans-api'
import type { PlanMigrationPreviewRow, PlanMigrationPreviewSummary, PlanMigrationSnapshot } from './plan-migration-api'
import {
  compareDeviceLimits,
  compareTrafficLimits,
  describeMigrationReason,
  describeMigrationWarnings,
  describeWarningCounts,
  diffSquads,
  planLabelOf,
  readDeviceLimit,
  readTrafficLimit,
  type LimitDirection,
} from './plan-migration'
import { SubscriberName, ToneBadge } from './plan-migration-parts'

export interface PlanMigrationPreviewState {
  readonly loading: boolean
  /** Why the preview could not be shown, already in the operator's words; `null` when it is shown. */
  readonly failedMessage: string | null
  readonly hasMore: boolean
  readonly loadingMore: boolean
  readonly loadMoreFailed: boolean
}

export interface PlanMigrationPreviewStepProps {
  readonly title: string
  readonly summary: readonly PlanMigrationPreviewSummary[]
  readonly rows: readonly PlanMigrationPreviewRow[]
  readonly state: PlanMigrationPreviewState
  readonly onLoadMore: () => void
  /** `null` when retrying cannot help — the server refused the request itself. */
  readonly onRetry: (() => void) | null
  readonly plansById: ReadonlyMap<string, Plan>
  readonly squadNames: ReadonlyMap<string, string>
  /**
   * What else uses the plan, said before «Перенести и удалить» — the delete comes
   * on its own once the move is done. `impact` leaves the moved subscriptions
   * out; `failed` is a references check that could not be made.
   */
  readonly usage: { readonly failed: boolean; readonly impact: PlanDeleteImpact | null }
  readonly canEditSubscriptions: boolean
  readonly starting: boolean
  readonly startError: string | null
  readonly onBack: () => void
  readonly onStart: () => void
}

export function PlanMigrationPreviewStep({
  title,
  summary,
  rows,
  state,
  onLoadMore,
  onRetry,
  plansById,
  squadNames,
  usage,
  canEditSubscriptions,
  starting,
  startError,
  onBack,
  onStart,
}: PlanMigrationPreviewStepProps) {
  const { t } = useTranslation()
  const ready = !state.loading && state.failedMessage === null

  return (
    <>
      <AlertDialogHeader className="shrink-0">
        <AlertDialogTitle>{title}</AlertDialogTitle>
        <AlertDialogDescription>{t('plansPage.deleteDialog.migrate.preview.lead')}</AlertDialogDescription>
      </AlertDialogHeader>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
        {state.loading ? (
          <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden="true" />
            {t('plansPage.deleteDialog.migrate.preview.loading')}
          </p>
        ) : state.failedMessage !== null ? (
          <div className="flex flex-wrap items-start gap-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="flex-1">{state.failedMessage}</span>
            {onRetry !== null && (
              <Button type="button" variant="outline" size="sm" onClick={onRetry}>
                {t('common.retry')}
              </Button>
            )}
          </div>
        ) : (
          <>
            <section className="space-y-2">
              <h3 className="text-sm font-medium">{t('plansPage.deleteDialog.migrate.preview.summaryLabel')}</h3>
              <ul
                aria-label={t('plansPage.deleteDialog.migrate.preview.summaryLabel')}
                className="grid gap-2 sm:grid-cols-2"
              >
                {summary.map((entry) => (
                  <li key={entry.targetPlanId} className="rounded-md border bg-card px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex min-w-0 items-center gap-1 truncate text-sm font-medium">
                        <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                        {planLabelOf(plansById, entry.targetPlanId)}
                      </span>
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                        {t('plansPage.deleteDialog.migrate.preview.count', { count: entry.count })}
                      </span>
                    </div>
                    {/* `count` includes them; the warnings below count only the rows that move. */}
                    {entry.skipped > 0 && (
                      <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
                        {t('plansPage.deleteDialog.migrate.preview.skippedCount', { count: entry.skipped })}
                      </p>
                    )}
                    {Object.values(entry.warnings).some((count) => count > 0) && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {describeWarningCounts(entry.warnings).map((warning) => (
                          <ToneBadge key={warning.code} tone={warning.tone} hint={t(warning.hintKey)}>
                            {t('plansPage.deleteDialog.migrate.warnings.count', {
                              label: t(warning.labelKey, { code: warning.code }),
                              count: warning.count,
                            })}
                          </ToneBadge>
                        ))}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </section>

            {usage.failed ? (
              <section className="space-y-1 text-sm">
                <p className="flex items-start gap-1.5 text-amber-600 dark:text-amber-500">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  {t('plansPage.deleteDialog.checkFailed')}
                </p>
                <p className="text-muted-foreground">{t('plansPage.deleteDialog.checkFailedHint')}</p>
              </section>
            ) : (
              usage.impact !== null && <PlanUsageDetails impact={usage.impact} />
            )}

            <section className="space-y-2">
              <h3 className="text-sm font-medium">{t('plansPage.deleteDialog.migrate.preview.rowsLabel')}</h3>
              <ul
                aria-label={t('plansPage.deleteDialog.migrate.preview.rowsLabel')}
                className="divide-y rounded-md border"
              >
                {rows.map((row) => (
                  <PreviewRow
                    key={row.subscriptionId}
                    row={row}
                    plansById={plansById}
                    squadNames={squadNames}
                  />
                ))}
              </ul>
              {state.hasMore && (
                <div className="space-y-1">
                  {state.loadMoreFailed && (
                    <p className="text-xs text-destructive">
                      {t('plansPage.deleteDialog.migrate.preview.loadMoreFailed')}
                    </p>
                  )}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="w-full"
                    disabled={state.loadingMore}
                    onClick={onLoadMore}
                  >
                    {state.loadingMore && <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden="true" />}
                    {t('plansPage.deleteDialog.migrate.preview.loadMore')}
                  </Button>
                </div>
              )}
            </section>
          </>
        )}
      </div>

      {(startError !== null || !canEditSubscriptions) && (
        <div className="shrink-0 space-y-1.5">
          {startError !== null && (
            <p className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              {startError}
            </p>
          )}
          {!canEditSubscriptions && (
            <p className="text-xs text-muted-foreground">
              {t('plansPage.deleteDialog.migrate.preview.needsEditPermission')}
            </p>
          )}
        </div>
      )}

      <AlertDialogFooter className="shrink-0 gap-2 sm:space-x-0">
        <Button type="button" variant="outline" onClick={onBack} disabled={starting}>
          {t('plansPage.deleteDialog.migrate.preview.back')}
        </Button>
        <Button
          type="button"
          variant="destructive"
          disabled={!canEditSubscriptions || !ready || starting}
          onClick={onStart}
        >
          {starting && <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden="true" />}
          {t('plansPage.deleteDialog.migrate.preview.confirm')}
        </Button>
      </AlertDialogFooter>
    </>
  )
}

function PreviewRow({
  row,
  plansById,
  squadNames,
}: {
  readonly row: PlanMigrationPreviewRow
  readonly plansById: ReadonlyMap<string, Plan>
  readonly squadNames: ReadonlyMap<string, string>
}) {
  const { t } = useTranslation()
  const kept = new Set(row.kept)
  const warnings = describeMigrationWarnings(row.warnings)
  const header = (
    <div className="flex flex-wrap items-start justify-between gap-2">
      <SubscriberName user={row.user} subscriptionId={row.subscriptionId} className="flex-1" />
      <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium">
        <ArrowRight className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
        {planLabelOf(plansById, row.targetPlanId)}
      </span>
    </div>
  )

  // A skipped row moves nowhere: the server sends `after` equal to `before`
  // (neutral values for an id that does not exist), so there is no diff to draw.
  if (row.willSkip !== null) {
    const skip = describeMigrationReason(row.willSkip)
    return (
      <li className="space-y-2 px-3 py-2.5" data-subscription-id={row.subscriptionId}>
        {header}
        <p className="text-xs text-amber-700 dark:text-amber-400">
          {t('plansPage.deleteDialog.migrate.preview.willSkip', { reason: t(skip.i18nKey) })}
          {!skip.recognised && (
            <span className="ml-1.5 font-mono text-[10px] text-muted-foreground">{skip.code}</span>
          )}
        </p>
      </li>
    )
  }

  return (
    <li className="space-y-2 px-3 py-2.5" data-subscription-id={row.subscriptionId}>
      {header}

      <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-1 text-xs">
        <LimitChange
          label={t('plansPage.deleteDialog.migrate.preview.traffic')}
          before={<TrafficText value={row.before.trafficLimit} />}
          after={<TrafficText value={row.after.trafficLimit} />}
          direction={compareTrafficLimits(row.before.trafficLimit, row.after.trafficLimit)}
          kept={kept.has('trafficLimit')}
        />
        <LimitChange
          label={t('plansPage.deleteDialog.migrate.preview.devices')}
          before={<DevicesText value={row.before.deviceLimit} />}
          after={<DevicesText value={row.after.deviceLimit} />}
          direction={compareDeviceLimits(row.before.deviceLimit, row.after.deviceLimit)}
          kept={kept.has('deviceLimit')}
        />
        <SquadsChange before={row.before} after={row.after} names={squadNames} kept={kept.has('squads')} />
        {row.before.isTrial !== row.after.isTrial && (
          <>
            <dt className="text-muted-foreground">{t('plansPage.deleteDialog.migrate.preview.type')}</dt>
            <dd>
              <BeforeAfter
                before={
                  row.before.isTrial
                    ? t('plansPage.deleteDialog.migrate.preview.trial')
                    : t('plansPage.deleteDialog.migrate.preview.regular')
                }
                after={
                  <span className="font-medium">
                    {row.after.isTrial
                      ? t('plansPage.deleteDialog.migrate.preview.trial')
                      : t('plansPage.deleteDialog.migrate.preview.regular')}
                  </span>
                }
              />
            </dd>
          </>
        )}
      </dl>

      {warnings.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {warnings.map((warning) => (
            <ToneBadge key={warning.code} tone={warning.tone} hint={t(warning.hintKey)}>
              {t(warning.labelKey, { code: warning.code })}
            </ToneBadge>
          ))}
        </div>
      )}
    </li>
  )
}

function TrafficText({ value }: { readonly value: number | null }) {
  const { t } = useTranslation()
  const traffic = readTrafficLimit(value)
  return (
    <>
      {traffic.kind === 'unlimited'
        ? t('plansPage.deleteDialog.migrate.preview.unlimited')
        : t('plansPage.deleteDialog.migrate.preview.gigabytes', { value: traffic.value })}
    </>
  )
}

function DevicesText({ value }: { readonly value: number }) {
  const { t } = useTranslation()
  const devices = readDeviceLimit(value)
  return <>{devices.kind === 'unlimited' ? t('plansPage.deleteDialog.migrate.preview.unlimited') : devices.value}</>
}

/**
 * "was X → becomes Y". The arrow is decoration and hidden from screen readers,
 * so the two words it stands for are read instead (§9 A6.4) — without them a
 * reader hears "50 GB 10 GB" and cannot tell which is which.
 */
function BeforeAfter({ before, after }: { readonly before: ReactNode; readonly after: ReactNode }) {
  const { t } = useTranslation()
  return (
    <>
      <span className="sr-only">{t('plansPage.deleteDialog.migrate.preview.srBefore')} </span>
      <span className="text-muted-foreground">{before}</span> <span aria-hidden="true">→</span>{' '}
      <span className="sr-only">{t('plansPage.deleteDialog.migrate.preview.srAfter')} </span>
      {after}
    </>
  )
}

function LimitChange({
  label,
  before,
  after,
  direction,
  kept,
}: {
  readonly label: string
  readonly before: ReactNode
  readonly after: ReactNode
  readonly direction: LimitDirection
  readonly kept: boolean
}) {
  const { t } = useTranslation()
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="flex flex-wrap items-center gap-x-1.5 gap-y-1" data-direction={direction}>
        {direction === 'same' ? (
          <span>{after}</span>
        ) : (
          <BeforeAfter
            before={before}
            after={
              <span className={cn('font-medium', direction === 'less' && 'text-amber-700 dark:text-amber-400')}>
                {after}
              </span>
            }
          />
        )}
        {kept && (
          <ToneBadge tone="info" hint={t('plansPage.deleteDialog.migrate.preview.keptHint')}>
            {t('plansPage.deleteDialog.migrate.preview.kept')}
          </ToneBadge>
        )}
      </dd>
    </>
  )
}

function SquadsChange({
  before,
  after,
  names,
  kept,
}: {
  readonly before: PlanMigrationSnapshot
  readonly after: PlanMigrationSnapshot
  readonly names: ReadonlyMap<string, string>
  readonly kept: boolean
}) {
  const { t } = useTranslation()
  const nameOf = (uuid: string): string => names.get(uuid) ?? truncate(uuid, 8)
  const internal = diffSquads(before.internalSquads, after.internalSquads)
  const internalChanged = internal.removed.length > 0 || internal.added.length > 0
  const externalChanged = before.externalSquad !== after.externalSquad
  const none = t('plansPage.deleteDialog.migrate.preview.none')
  // `kept` names the internal squads and the external squad as one field, and
  // the server sends it when EITHER is set by hand. The one it kept is the one
  // the move leaves unchanged, so the marker goes there, never on a field that
  // changes.
  const keptMarker = (
    <ToneBadge tone="info" hint={t('plansPage.deleteDialog.migrate.preview.keptHint')}>
      {t('plansPage.deleteDialog.migrate.preview.kept')}
    </ToneBadge>
  )

  return (
    <>
      <dt className="text-muted-foreground">{t('plansPage.deleteDialog.migrate.preview.squads')}</dt>
      <dd className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
        {internal.kept.length + internal.removed.length + internal.added.length === 0 ? (
          <span>{none}</span>
        ) : (
          <>
            {internal.kept.map((uuid) => (
              <span key={`kept:${uuid}`}>{nameOf(uuid)}</span>
            ))}
            {/* Struck through and marked with a plus is how they LOOK; a screen
                reader is told in words, since most do not announce del and ins. */}
            {internal.removed.map((uuid) => (
              <del key={`removed:${uuid}`} className="text-amber-700 dark:text-amber-400">
                <span className="sr-only">{t('plansPage.deleteDialog.migrate.preview.srRemoved')} </span>
                {nameOf(uuid)}
              </del>
            ))}
            {internal.added.map((uuid) => (
              <ins key={`added:${uuid}`} className="font-medium text-emerald-700 no-underline dark:text-emerald-400">
                <span className="sr-only">{t('plansPage.deleteDialog.migrate.preview.srAdded')} </span>
                <span aria-hidden="true">+</span>
                {nameOf(uuid)}
              </ins>
            ))}
          </>
        )}
        {kept && !internalChanged && keptMarker}
      </dd>
      <dt className="text-muted-foreground">{t('plansPage.deleteDialog.migrate.preview.externalSquad')}</dt>
      <dd className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
        {externalChanged ? (
          <BeforeAfter
            before={before.externalSquad === null ? none : nameOf(before.externalSquad)}
            after={
              // Removing or replacing a squad takes access away; adding one does not.
              <span
                className={cn(
                  'font-medium',
                  before.externalSquad === null
                    ? 'text-emerald-700 dark:text-emerald-400'
                    : 'text-amber-700 dark:text-amber-400',
                )}
              >
                {after.externalSquad === null ? none : nameOf(after.externalSquad)}
              </span>
            }
          />
        ) : (
          <span>{after.externalSquad === null ? none : nameOf(after.externalSquad)}</span>
        )}
        {kept && !externalChanged && keptMarker}
      </dd>
    </>
  )
}
