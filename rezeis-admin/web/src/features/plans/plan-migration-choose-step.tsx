/**
 * Step 3 of the plan delete dialog (spec §7): the subscriptions still on the
 * plan, and where each of them goes.
 *
 * The operator selects rows — or every subscription of the plan at once — picks
 * a target plan and assigns it; several groups with different targets are
 * allowed. «Далее» waits until every subscription has a target. «Удалить без
 * переноса» is today's delete, with today's consequences.
 */
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, ArrowRight, Loader2, Search } from 'lucide-react'

import {
  AlertDialogCancel,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn, formatDate } from '@/lib/utils'

import type { Plan } from './plans-api'
import type { PlanMigrationRequest, PlanSubscriptionItem } from './plan-migration-api'
import {
  assignAll,
  assignedTargetOf,
  assignSelected,
  buildMigrationRequest,
  canOfferSelectAll,
  describeSubscriber,
  EMPTY_MIGRATION_SELECTION,
  isRowSelected,
  planLabelOf,
  selectedCount,
  summariseAssignment,
  toggleRow,
  toggleVisible,
  visibleSelectionState,
  type MigrationAssignment,
  type MigrationSelection,
} from './plan-migration'
import { MigrationCheckbox, SubscriberName, ToneBadge } from './plan-migration-parts'

const STATUS_VARIANT: Readonly<Record<string, 'default' | 'secondary' | 'destructive' | 'outline'>> = {
  ACTIVE: 'default',
  LIMITED: 'outline',
  DISABLED: 'secondary',
  EXPIRED: 'destructive',
}

export interface PlanMigrationListState {
  /** Nothing to show yet for the current search. */
  readonly loading: boolean
  /** A new search is being asked while the previous rows stay on screen. */
  readonly searching: boolean
  /** The current search could not be loaded and there are no rows to show. */
  readonly failed: boolean
  readonly hasMore: boolean
  readonly loadingMore: boolean
  readonly loadMoreFailed: boolean
}

export interface PlanMigrationChooseStepProps {
  readonly title: string
  /** Every subscription on the plan, ignoring the search. */
  readonly total: number
  /** How many subscriptions landed on the plan while the last move ran; `null` for none. */
  readonly newSubscriptionsNotice: number | null
  readonly searchInput: string
  readonly onSearchInputChange: (value: string) => void
  readonly search: string
  readonly rows: readonly PlanSubscriptionItem[]
  readonly listState: PlanMigrationListState
  readonly onLoadMore: () => void
  readonly onRetryList: () => void
  readonly targets: readonly Plan[]
  readonly targetsState: 'loading' | 'failed' | 'ready'
  readonly plansById: ReadonlyMap<string, Plan>
  readonly assignment: MigrationAssignment
  readonly onAssignmentChange: (next: MigrationAssignment) => void
  readonly canEditSubscriptions: boolean
  readonly onDeleteWithoutMove: () => void
  readonly onNext: (request: PlanMigrationRequest) => void
}

export function PlanMigrationChooseStep({
  title,
  total,
  newSubscriptionsNotice,
  searchInput,
  onSearchInputChange,
  search,
  rows,
  listState,
  onLoadMore,
  onRetryList,
  targets,
  targetsState,
  plansById,
  assignment,
  onAssignmentChange,
  canEditSubscriptions,
  onDeleteWithoutMove,
  onNext,
}: PlanMigrationChooseStepProps) {
  const { t } = useTranslation()
  const [selection, setSelection] = useState<MigrationSelection>(EMPTY_MIGRATION_SELECTION)
  const [pickedTargetId, setPickedTargetId] = useState<string | null>(null)

  const eligibleTargetIds = useMemo(() => new Set(targets.map((plan) => plan.id)), [targets])
  // A picked plan that the refreshed catalogue no longer offers is no pick.
  const pickedTarget = pickedTargetId !== null && eligibleTargetIds.has(pickedTargetId) ? pickedTargetId : null
  const visibleIds = rows.map((row) => row.subscriptionId)
  const selectionSize = selectedCount(selection, total)
  const summary = summariseAssignment(assignment, total, eligibleTargetIds)
  const headerState = visibleSelectionState(selection, visibleIds)

  const assign = () => {
    if (pickedTarget === null || selectionSize === 0) return
    onAssignmentChange(
      selection.all ? assignAll(pickedTarget) : assignSelected(assignment, selection.ids, pickedTarget),
    )
    setSelection(EMPTY_MIGRATION_SELECTION)
  }

  const targetPlaceholder =
    targetsState === 'loading'
      ? t('plansPage.deleteDialog.migrate.choose.targetsLoading')
      : t('plansPage.deleteDialog.migrate.choose.targetPlaceholder')

  return (
    <>
      <AlertDialogHeader className="shrink-0">
        <AlertDialogTitle>{title}</AlertDialogTitle>
        <AlertDialogDescription>
          {t('plansPage.deleteDialog.migrate.choose.lead', { count: total })}
        </AlertDialogDescription>
      </AlertDialogHeader>

      {/* Seen here; HEARD through the dialog's own status region, which is
          mounted before this text exists — a live region inserted together
          with its text is not reliably announced. */}
      {newSubscriptionsNotice !== null && (
        <div
          data-notice=""
          className="flex shrink-0 items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-300"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>
            {t('plansPage.deleteDialog.migrate.choose.newSubscriptions', { count: newSubscriptionsNotice })}
          </span>
        </div>
      )}

      <div className="shrink-0 space-y-2">
        <div className="relative">
          <Search
            className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            value={searchInput}
            onChange={(event) => onSearchInputChange(event.target.value)}
            placeholder={t('plansPage.deleteDialog.migrate.choose.searchPlaceholder')}
            aria-label={t('plansPage.deleteDialog.migrate.choose.searchLabel')}
            className="h-9 pl-9 pr-9"
          />
          {listState.searching && (
            <Loader2
              className="absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 motion-safe:animate-spin text-muted-foreground"
              aria-hidden="true"
            />
          )}
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Select
            value={pickedTarget ?? ''}
            onValueChange={(value) => setPickedTargetId(value)}
            disabled={targetsState !== 'ready' || targets.length === 0}
          >
            <SelectTrigger className="h-9 sm:flex-1" aria-label={t('plansPage.deleteDialog.migrate.choose.targetLabel')}>
              <SelectValue placeholder={targetPlaceholder} />
            </SelectTrigger>
            <SelectContent>
              {targets.map((plan) => (
                <SelectItem key={plan.id} value={plan.id}>
                  {plan.name}
                  {plan.isArchived
                    ? ` · ${t('plansPage.deleteDialog.migrate.choose.archivedTag')}`
                    : !plan.isActive
                      ? ` · ${t('plansPage.deleteDialog.migrate.choose.inactiveTag')}`
                      : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            size="sm"
            className="h-9"
            disabled={pickedTarget === null || selectionSize === 0}
            onClick={assign}
          >
            {t('plansPage.deleteDialog.migrate.choose.assign')}
          </Button>
        </div>
        {targetsState === 'failed' && (
          <p className="text-xs text-destructive">{t('plansPage.deleteDialog.migrate.choose.targetsFailed')}</p>
        )}
        {targetsState === 'ready' && targets.length === 0 && (
          <p className="text-xs text-muted-foreground">{t('plansPage.deleteDialog.migrate.choose.targetsEmpty')}</p>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border">
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b bg-muted/40 px-3 py-2 text-xs">
          <MigrationCheckbox
            checked={headerState}
            onCheckedChange={() => setSelection(toggleVisible(selection, visibleIds))}
            disabled={visibleIds.length === 0}
            aria-label={t('plansPage.deleteDialog.migrate.choose.selectShown')}
          />
          {selection.all ? (
            <span className="font-medium">
              {t('plansPage.deleteDialog.migrate.choose.allSelected', { count: total })}
            </span>
          ) : (
            <span className="text-muted-foreground">
              {t('plansPage.deleteDialog.migrate.choose.selected', { count: selection.ids.size })}
            </span>
          )}
          {canOfferSelectAll(selection, visibleIds, total) && (
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto p-0 text-xs"
              onClick={() => setSelection({ all: true, ids: new Set<string>() })}
            >
              {t('plansPage.deleteDialog.migrate.choose.selectAll', { count: total })}
            </Button>
          )}
          {selectionSize > 0 && (
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto p-0 text-xs"
              onClick={() => setSelection(EMPTY_MIGRATION_SELECTION)}
            >
              {t('plansPage.deleteDialog.migrate.choose.clearSelection')}
            </Button>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {listState.loading ? (
            <p className="flex items-center gap-2 px-3 py-6 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden="true" />
              {t('plansPage.deleteDialog.migrate.choose.listLoading')}
            </p>
          ) : listState.failed ? (
            <div className="flex flex-wrap items-center gap-3 px-3 py-6 text-sm">
              <span className="text-destructive">{t('plansPage.deleteDialog.migrate.choose.listFailed')}</span>
              <Button type="button" variant="outline" size="sm" onClick={onRetryList}>
                {t('common.retry')}
              </Button>
            </div>
          ) : rows.length === 0 ? (
            search.length > 0 && (
              <p className="px-3 py-6 text-sm text-muted-foreground">
                {t('plansPage.deleteDialog.migrate.choose.searchEmpty')}
              </p>
            )
          ) : (
            <ul aria-label={t('plansPage.deleteDialog.migrate.choose.listLabel')} className="divide-y">
              {rows.map((row) => (
                <SubscriptionRow
                  key={row.subscriptionId}
                  row={row}
                  selected={isRowSelected(selection, row.subscriptionId)}
                  onToggle={() => setSelection(toggleRow(selection, row.subscriptionId, visibleIds))}
                  targetPlanId={assignedTargetOf(assignment, row.subscriptionId)}
                  eligibleTargetIds={eligibleTargetIds}
                  plansById={plansById}
                />
              ))}
            </ul>
          )}
          {listState.hasMore && !listState.loading && (
            <div className="space-y-1 border-t p-2">
              {listState.loadMoreFailed && (
                <p className="text-xs text-destructive">{t('plansPage.deleteDialog.migrate.choose.loadMoreFailed')}</p>
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full"
                disabled={listState.loadingMore}
                onClick={onLoadMore}
              >
                {listState.loadingMore && <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden="true" />}
                {t('plansPage.deleteDialog.migrate.choose.loadMore')}
              </Button>
            </div>
          )}
        </div>
      </div>

      <div className="shrink-0 space-y-1.5">
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="font-medium tabular-nums">
            {t('plansPage.deleteDialog.migrate.choose.assignedSummary', {
              assigned: summary.assigned,
              total,
            })}
          </span>
          {summary.groups.map((group) => (
            <Badge key={group.targetPlanId} variant="outline" className="px-1.5 py-0 text-[10px] font-normal">
              {t('plansPage.deleteDialog.migrate.choose.group', {
                plan: planLabelOf(plansById, group.targetPlanId),
                count: group.count,
              })}
            </Badge>
          ))}
          {summary.restTargetPlanId !== null && (
            <Badge variant="outline" className="px-1.5 py-0 text-[10px] font-normal">
              {t('plansPage.deleteDialog.migrate.choose.restGroup', {
                plan: planLabelOf(plansById, summary.restTargetPlanId),
              })}
            </Badge>
          )}
        </div>
        {summary.unassigned > 0 && (
          <p className="text-xs text-muted-foreground">
            {t('plansPage.deleteDialog.migrate.choose.unassignedHint', { count: summary.unassigned })}
          </p>
        )}
        {summary.ineligibleTargetIds.length > 0 && (
          <p className="text-xs text-amber-700 dark:text-amber-400">
            {t('plansPage.deleteDialog.migrate.choose.ineligibleHint')}
          </p>
        )}
        {!canEditSubscriptions && (
          <p className="text-xs text-muted-foreground">
            {t('plansPage.deleteDialog.migrate.choose.needsEditPermission')}
          </p>
        )}
      </div>

      <AlertDialogFooter className="shrink-0 gap-2 sm:space-x-0">
        <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
        <Button
          type="button"
          variant="outline"
          className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
          onClick={onDeleteWithoutMove}
        >
          {t('plansPage.deleteDialog.migrate.choose.deleteWithoutMove')}
        </Button>
        <Button
          type="button"
          disabled={!summary.complete}
          onClick={() => onNext(buildMigrationRequest(assignment, eligibleTargetIds))}
        >
          {t('plansPage.deleteDialog.migrate.choose.next')}
          <ArrowRight aria-hidden="true" />
        </Button>
      </AlertDialogFooter>
    </>
  )
}

function SubscriptionRow({
  row,
  selected,
  onToggle,
  targetPlanId,
  eligibleTargetIds,
  plansById,
}: {
  readonly row: PlanSubscriptionItem
  readonly selected: boolean
  readonly onToggle: () => void
  readonly targetPlanId: string | null
  readonly eligibleTargetIds: ReadonlySet<string>
  readonly plansById: ReadonlyMap<string, Plan>
}) {
  const { t } = useTranslation()
  const subscriberLabel = describeSubscriber(row.user, row.subscriptionId).primary
  return (
    <li className={cn('flex items-start gap-3 px-3 py-2.5', selected && 'bg-primary/5')}>
      <MigrationCheckbox
        className="mt-1"
        checked={selected}
        onCheckedChange={onToggle}
        aria-label={t('plansPage.deleteDialog.migrate.choose.selectRow', { name: subscriberLabel })}
      />
      <div className="min-w-0 flex-1 space-y-1">
        <SubscriberName user={row.user} subscriptionId={row.subscriptionId} />
        <div className="flex flex-wrap items-center gap-1">
          <Badge variant={STATUS_VARIANT[row.status] ?? 'outline'} className="px-1.5 py-0 text-[10px]">
            {t(`subscriptionsPage.statuses.${row.status}`, { defaultValue: row.status })}
          </Badge>
          {row.isTrial && <ToneBadge tone="info">{t('subscriptionsPage.trialBadge')}</ToneBadge>}
          <span className="text-[11px] text-muted-foreground">
            {row.expiresAt === null
              ? t('plansPage.deleteDialog.migrate.choose.noExpiry')
              : t('plansPage.deleteDialog.migrate.choose.expires', { date: formatDate(row.expiresAt) })}
          </span>
          {row.flags.pendingRenewalForPlan && (
            <ToneBadge tone="info" hint={t('plansPage.deleteDialog.migrate.flags.pendingRenewalHint')}>
              {t('plansPage.deleteDialog.migrate.flags.pendingRenewal')}
            </ToneBadge>
          )}
          {row.flags.scheduledTermOnPlan && (
            <ToneBadge tone="caution" hint={t('plansPage.deleteDialog.migrate.flags.scheduledTermHint')}>
              {t('plansPage.deleteDialog.migrate.flags.scheduledTerm')}
            </ToneBadge>
          )}
          {row.flags.sharedPanelProfile && (
            <ToneBadge tone="caution" hint={t('plansPage.deleteDialog.migrate.flags.sharedProfileHint')}>
              {t('plansPage.deleteDialog.migrate.flags.sharedProfile')}
            </ToneBadge>
          )}
        </div>
      </div>
      <div className="shrink-0 pt-0.5 text-right text-xs">
        {targetPlanId === null ? (
          <span className="text-muted-foreground">{t('plansPage.deleteDialog.migrate.choose.unassigned')}</span>
        ) : eligibleTargetIds.has(targetPlanId) ? (
          <span className="inline-flex items-center gap-1 font-medium">
            <ArrowRight className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
            {planLabelOf(plansById, targetPlanId)}
          </span>
        ) : (
          <ToneBadge tone="danger">{t('plansPage.deleteDialog.migrate.choose.targetUnavailable')}</ToneBadge>
        )}
      </div>
    </li>
  )
}
