import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, Pencil, Archive, ArchiveRestore, Package, BarChart3, List, GripVertical, AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  arrayMove,
  rectSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { FadeIn } from '@/lib/motion'
import { PlanForm, type PlanFormData } from './plan-form'
import {
  plansQueryKeys,
  reorderPlans,
  usePlanSquadPropagation,
  usePlans,
  type Plan,
  type PlanUpdateResult,
} from './plans-api'
import { resolvePlanWriteRefusal } from './plan-write-refusals'
import { PlansStatsTab } from './plans-stats-tab'

export default function PlansPage() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  /**
   * What a refused plan write says to the operator.
   *
   * THREE OUTCOMES, AND THE MIDDLE ONE IS THE POINT.
   *
   *   • A code this build knows → its translated sentence, which names the
   *     field to fix. The panel used to print the server's English diagnostic
   *     verbatim, so an operator running the panel in Russian was told
   *     "Replacement and upgrade plans must be active non-trial public plans:
   *     cmsxo98e8006r01jgn33gtpbe" — the wrong language, naming a cuid that
   *     appears on no screen.
   *   • A code this build does NOT know → the server's own `message`, in
   *     English. A rolling deploy WILL put a newer backend behind this panel,
   *     and folding its new code into the generic sentence below would throw
   *     away the one line that says which of seventeen refusals happened.
   *     English prose the operator has to puzzle over beats a confident lie.
   *   • No message at all — a dead host, a refused connection → the
   *     per-mutation fallback, which is at least translated.
   *
   * Replaces `getErrorMessage`, which is not the same three-way split: it
   * falls through to `error.message`, and on a network failure that is axios'
   * own untranslated "Network Error" rather than "Failed to archive plan".
   */
  const refusalMessage = (error: unknown, fallback: string): string => {
    const resolution = resolvePlanWriteRefusal(error)
    if (resolution.recognised) return t(resolution.i18nKey)
    return resolution.serverMessage ?? fallback
  }

  const [showCreate, setShowCreate] = useState(false)
  const [editingPlan, setEditingPlan] = useState<Plan | null>(null)
  // Set when a save reports it queued a squad push, so the banner below can
  // follow it to completion. Editing a plan's squads rewrites every existing
  // subscriber in the background; without this the operator is told "saved" and
  // has no way to know whether the panel ever heard about it.
  const [watchedPropagationPlanId, setWatchedPropagationPlanId] = useState<string | null>(null)

  const { data: plans, isLoading } = usePlans()

  const createMutation = useMutation({
    mutationFn: (data: PlanFormData) => api.post('/admin/plans', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: plansQueryKeys.all })
      setShowCreate(false)
      toast.success(t('plansPage.created'))
    },
    onError: (err) => toast.error(refusalMessage(err, t('plansPage.createFailed'))),
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: PlanFormData }) =>
      api.patch<PlanUpdateResult>(`/admin/plans/${id}`, data),
    onSuccess: (response, variables) => {
      queryClient.invalidateQueries({ queryKey: plansQueryKeys.all })
      setEditingPlan(null)
      toast.success(t('plansPage.updated'))
      const propagation = response.data?.squadPropagation
      if (propagation && propagation.syncJobsCreated > 0) {
        toast.info(
          t('plansPage.squadPropagation.queued', { count: propagation.syncJobsCreated }),
        )
        setWatchedPropagationPlanId(variables.id)
      }
      // Said out loud, and as a WARNING rather than an info line. These
      // customers keep the plan's OLD squads — deliberately, because they had
      // diverged — but nothing else in the panel would ever mention them. If
      // the old squads were deleted or recreated in Remnawave, their renewals
      // now fail with the panel's catch-all `A039`, and the operator's only
      // clue would have been a plan edit that reported success.
      if (propagation && propagation.subscriptionsSkippedDiverged > 0) {
        toast.warning(
          t('plansPage.squadPropagation.skippedDiverged', {
            count: propagation.subscriptionsSkippedDiverged,
          }),
          { duration: 12_000 },
        )
      }
    },
    onError: (err) => toast.error(refusalMessage(err, t('plansPage.updateFailed'))),
  })

  const archiveMutation = useMutation({
    mutationFn: (id: string) => api.post(`/admin/plans/${id}/archive`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: plansQueryKeys.all })
      toast.success(t('plansPage.archived'))
    },
    onError: (err) => toast.error(refusalMessage(err, t('plansPage.archiveFailed'))),
  })

  const unarchiveMutation = useMutation({
    mutationFn: (id: string) => api.post(`/admin/plans/${id}/unarchive`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: plansQueryKeys.all })
      toast.success(t('plansPage.unarchived'))
    },
    onError: (err) => toast.error(refusalMessage(err, t('plansPage.unarchiveFailed'))),
  })

  const toggleActiveMutation = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      api.patch(`/admin/plans/${id}`, { isActive }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: plansQueryKeys.all }),
    onError: (err) => toast.error(refusalMessage(err, t('plansPage.toggleActiveFailed'))),
  })

  const moveMutation = useMutation({
    mutationFn: (orderedIds: string[]) => reorderPlans(orderedIds),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: plansQueryKeys.all }),
    onError: (err) => toast.error(refusalMessage(err, t('plansPage.reorderFailed'))),
    onSettled: () => setLocalOrder(null),
  })

  // Optimistic drag order — holds the reordered list while the reorder request
  // is in flight, so cards don't snap back before the refetch lands. Cleared
  // in `onSettled` so the server order becomes authoritative again.
  const [localOrder, setLocalOrder] = useState<Plan[] | null>(null)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const displayedPlans = useMemo<readonly Plan[]>(
    () => localOrder ?? plans ?? [],
    [localOrder, plans],
  )

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const current = [...displayedPlans]
    const from = current.findIndex((p) => p.id === active.id)
    const to = current.findIndex((p) => p.id === over.id)
    if (from === -1 || to === -1) return
    const next = arrayMove(current, from, to)
    setLocalOrder(next)
    moveMutation.mutate(next.map((p) => p.id))
  }

  /**
   * A plan's traffic cap, as the OPERATOR has to read it.
   *
   * `null` is the server's UNLIMITED, and it is not a rare edge:
   * `plans-admin.normalizers` writes it for every DEVICES and every
   * UNLIMITED plan. The old test was `gb === 0`, which `null` never
   * satisfies, so the unlimited branch was unreachable for exactly the two
   * plan types that ARE unlimited and their cards printed the literal text
   * `null GB`.
   *
   * `0` deliberately does NOT come back here as unlimited. It is a cap of
   * ZERO gigabytes — no traffic at all — the opposite product fact, and
   * folding the two together is a defect this codebase has already paid
   * for: see `plan-picker-traffic-cap.test.tsx`, where a legacy zero
   * rendered exactly like an uncapped plan and an operator handed a
   * customer a subscription carrying nothing. Rows authored before the DTO
   * was raised to `@Min(1)` still hold that zero, and this list is where an
   * operator would go looking for one. `0 GB` says what it is.
   *
   * The customer-facing card previews (`branding-preview`,
   * `plan-card-styles-section`) answer differently on purpose: they mirror
   * the cabinet's `tariff-card`, which folds both spellings into unlimited.
   * Showing the operator what the customer sees is their job; showing the
   * operator what the row actually holds is this one's.
   */
  const formatTraffic = (gb: number | null) =>
    gb === null ? t('plansPage.unlimited') : `${gb} GB`

  return (
    <div className="space-y-6">
      <FadeIn>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <Package className="h-6 w-6" /> {t('plansPage.title')}
            </h1>
            <p className="text-muted-foreground">{t('plansPage.subtitle')}</p>
          </div>
          <Button onClick={() => setShowCreate(true)}>
            <Plus className="h-4 w-4 mr-2" /> {t('plansPage.createPlan')}
          </Button>
        </div>
      </FadeIn>

      <SquadPropagationBanner
        planId={watchedPropagationPlanId}
        onDismiss={() => setWatchedPropagationPlanId(null)}
      />

      <Tabs defaultValue="list" className="space-y-4">
        <TabsList>
          <TabsTrigger value="list" className="gap-2">
            <List className="h-4 w-4" /> {t('plansPage.tabs.list')}
          </TabsTrigger>
          <TabsTrigger value="stats" className="gap-2">
            <BarChart3 className="h-4 w-4" /> {t('plansPage.tabs.stats')}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="list" className="space-y-4">
          {isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-28 w-full rounded-lg" />
          ))}
        </div>
      ) : !plans?.length ? (
        <Card>
          <CardContent className="py-16 text-center">
            <p className="text-muted-foreground mb-4">{t('plansPage.empty')}</p>
            <Button onClick={() => setShowCreate(true)}>
              <Plus className="h-4 w-4 mr-2" /> {t('plansPage.createFirst')}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Summary cards */}
          <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
            <div className="rounded-lg border bg-card p-3 text-center">
              <p className="text-2xl font-bold">{plans.length}</p>
              <p className="text-xs text-muted-foreground">{t('plansPage.summary.total')}</p>
            </div>
            <div className="rounded-lg border bg-card p-3 text-center">
              <p className="text-2xl font-bold text-emerald-500">
                {plans.filter((p) => p.isActive && !p.isArchived).length}
              </p>
              <p className="text-xs text-muted-foreground">{t('plansPage.summary.active')}</p>
            </div>
            <div className="rounded-lg border bg-card p-3 text-center">
              <p className="text-2xl font-bold text-amber-500">
                {plans.filter((p) => p.isArchived).length}
              </p>
              <p className="text-xs text-muted-foreground">{t('plansPage.summary.archived')}</p>
            </div>
            <div className="rounded-lg border bg-card p-3 text-center">
              <p className="text-2xl font-bold text-blue-500">
                {plans.filter((p) => p.availability === 'TRIAL').length}
              </p>
              <p className="text-xs text-muted-foreground">{t('plansPage.summary.trial')}</p>
            </div>
          </div>

          {/* Plan grid — free drag-and-drop reorder (sets the cabinet order) */}
          <p className="text-xs text-muted-foreground">{t('plansPage.orderHint')}</p>
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={displayedPlans.map((p) => p.id)} strategy={rectSortingStrategy}>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 items-start">
                {displayedPlans.map((plan) => (
                  <SortablePlanCard
                    key={plan.id}
                    plan={plan}
                    formatTraffic={formatTraffic}
                    onEdit={() => setEditingPlan(plan)}
                    onToggleActive={(v) => toggleActiveMutation.mutate({ id: plan.id, isActive: v })}
                    onArchive={() => archiveMutation.mutate(plan.id)}
                    onUnarchive={() => unarchiveMutation.mutate(plan.id)}
                    archivePending={archiveMutation.isPending}
                    unarchivePending={unarchiveMutation.isPending}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        </>
      )}
        </TabsContent>

        <TabsContent value="stats">
          <PlansStatsTab />
        </TabsContent>
      </Tabs>

      {/* Create Dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('plansPage.createTitle')}</DialogTitle>
          </DialogHeader>
          <PlanForm
            onSubmit={(data) => createMutation.mutate(data)}
            isLoading={createMutation.isPending}
          />
        </DialogContent>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={!!editingPlan} onOpenChange={() => setEditingPlan(null)}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {t('plansPage.editTitle')}: {editingPlan?.name}
            </DialogTitle>
          </DialogHeader>
          {editingPlan && (
            <PlanForm
              plan={editingPlan}
              onSubmit={(data) => updateMutation.mutate({ id: editingPlan.id, data })}
              isLoading={updateMutation.isPending}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

interface SortablePlanCardProps {
  readonly plan: Plan
  readonly formatTraffic: (gb: number | null) => string
  readonly onEdit: () => void
  readonly onToggleActive: (isActive: boolean) => void
  readonly onArchive: () => void
  readonly onUnarchive: () => void
  readonly archivePending: boolean
  readonly unarchivePending: boolean
}

/**
 * One draggable plan card. The grip handle carries the dnd-kit drag listeners
 * so the action controls (switch/edit/archive) stay independently clickable.
 */
function SortablePlanCard({
  plan,
  formatTraffic,
  onEdit,
  onToggleActive,
  onArchive,
  onUnarchive,
  archivePending,
  unarchivePending,
}: SortablePlanCardProps) {
  const { t } = useTranslation()
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: plan.id,
  })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 10 : undefined,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'rounded-lg border bg-card transition-all hover:shadow-md',
        plan.isArchived && 'opacity-60',
        isDragging && 'opacity-80 shadow-lg',
      )}
    >
      <div className="px-3 py-2.5 space-y-2">
        {/* Title row */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <button
              type="button"
              className="shrink-0 cursor-grab touch-none text-muted-foreground hover:text-foreground active:cursor-grabbing focus:outline-none"
              aria-label={t('plansPage.aria.dragHandle')}
              {...attributes}
              {...listeners}
            >
              <GripVertical className="h-4 w-4" aria-hidden="true" />
            </button>
            <span className="truncate text-sm font-semibold" title={plan.name}>
              {plan.name}
            </span>
          </div>
          <div className="flex items-center gap-0.5 shrink-0">
            <Switch
              checked={plan.isActive}
              onCheckedChange={onToggleActive}
              disabled={plan.isArchived}
              className="scale-75"
              aria-label={t('plansPage.aria.toggleActive')}
            />
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              onClick={onEdit}
              aria-label={t('plansPage.aria.edit')}
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            {plan.isArchived ? (
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7 text-emerald-500 hover:text-emerald-600"
                onClick={onUnarchive}
                disabled={unarchivePending}
                aria-label={t('plansPage.aria.unarchive')}
              >
                <ArchiveRestore className="h-3.5 w-3.5" />
              </Button>
            ) : (
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7 text-muted-foreground"
                onClick={onArchive}
                disabled={archivePending}
                aria-label={t('plansPage.aria.archive')}
              >
                <Archive className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </div>

        {/* Badges row */}
        <div className="flex items-center gap-1 flex-wrap">
          {plan.tag && (
            <Badge variant="outline" className="text-[10px] px-1.5 py-0">
              {plan.tag}
            </Badge>
          )}
          <Badge
            variant={plan.isActive ? 'default' : 'secondary'}
            className="text-[10px] px-1.5 py-0"
          >
            {plan.isActive ? t('plansPage.status.active') : t('plansPage.status.inactive')}
          </Badge>
          <Badge variant="outline" className="text-[10px] px-1.5 py-0">
            {plan.type}
          </Badge>
          <Badge variant="outline" className="text-[10px] px-1.5 py-0">
            {plan.availability}
          </Badge>
          {plan.isArchived && (
            <Badge variant="destructive" className="text-[10px] px-1.5 py-0">
              {t('plansPage.status.archived')}
            </Badge>
          )}
        </div>

        {/* Stats row */}
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground pt-1 border-t">
          <span>
            {t('plansPage.labels.traffic')}:{' '}
            <span className="text-foreground font-medium">{formatTraffic(plan.trafficLimit)}</span>
          </span>
          <span>
            {t('plansPage.labels.devices')}:{' '}
            <span className="text-foreground font-medium">
              {plan.deviceLimit <= 0 ? '∞' : plan.deviceLimit}
            </span>
          </span>
          <span>
            {t('plansPage.labels.durations')}:{' '}
            <span className="text-foreground font-medium">{plan.durations.length}</span>
          </span>
        </div>
      </div>
    </div>
  )
}

/**
 * Follows a squad propagation started by the last plan save.
 *
 * A squad edit does not land the moment the operator clicks Save: every
 * existing subscriber is rewritten and a Remnawave push is queued for each,
 * drained by the profile-sync worker. Before this banner existed the operator
 * saw "Plan updated" and nothing else — an edit that took an hour looked
 * exactly like one that never happened. Polling stops by itself once the server
 * reports the propagation complete.
 */
function SquadPropagationBanner({
  planId,
  onDismiss,
}: {
  readonly planId: string | null
  readonly onDismiss: () => void
}) {
  const { t } = useTranslation()
  const { data } = usePlanSquadPropagation(planId)

  if (planId === null || !data || data.total === 0) return null

  const remaining = data.pending + data.running
  const hasFailures = data.failed > 0
  const done = data.isComplete

  return (
    <FadeIn>
      <Card className={cn(hasFailures && 'border-destructive/50')}>
        <CardContent className="flex items-center gap-3 py-3 text-sm">
          {done && !hasFailures ? (
            <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
          ) : hasFailures ? (
            <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" />
          ) : (
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
          )}
          <div className="flex-1">
            <p className="font-medium">
              {done
                ? hasFailures
                  ? t('plansPage.squadPropagation.finishedWithFailures', { count: data.failed })
                  : t('plansPage.squadPropagation.finished', { count: data.completed })
                : t('plansPage.squadPropagation.running', {
                    done: data.completed,
                    total: data.total,
                  })}
            </p>
            {!done && (
              <p className="text-xs text-muted-foreground">
                {t('plansPage.squadPropagation.remaining', { count: remaining })}
              </p>
            )}
          </div>
          <Button variant="ghost" size="sm" onClick={onDismiss}>
            {t('plansPage.squadPropagation.dismiss')}
          </Button>
        </CardContent>
      </Card>
    </FadeIn>
  )
}
