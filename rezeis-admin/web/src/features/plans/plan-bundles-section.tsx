import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Layers, Check, Pencil, Plus, Trash2, Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ButtonTip } from '@/components/ui/button-tip'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { getErrorMessage } from '@/lib/http-errors'
import { cn } from '@/lib/utils'
import type { Plan } from './plans-api'
import {
  createPlanBundle,
  deletePlanBundle,
  planBundlesQueryKeys,
  updatePlanBundle,
  usePlanBundles,
  type PlanBundle,
} from './plan-bundles-api'

/**
 * A merge links EXACTLY two plans — the two halves of one merged link (the
 * owner, 14.11.2026). One would be the plan's own subscription URL; a third
 * would need a traffic row and a caption nobody designed, which is why the
 * server refuses it too.
 */
const MIN_BUNDLE_PLANS = 2
const MAX_BUNDLE_PLANS = 2

/**
 * What the operator's groupings look like on the plans page: one block per
 * bundle, its member plans as chips, and the two things an operator does with a
 * grouping — edit it and remove it.
 *
 * Renders nothing while there is nothing to show. The entry point is the header's
 * «Объединить тарифы», and an empty card under the plan grid would be furniture
 * on every install that does not use the feature.
 */
export function PlanBundlesSection({
  plans,
  onEdit,
}: {
  readonly plans: readonly Plan[]
  readonly onEdit: (bundle: PlanBundle) => void
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { data: bundles } = usePlanBundles()
  const [pendingDelete, setPendingDelete] = useState<PlanBundle | null>(null)

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deletePlanBundle(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: planBundlesQueryKeys.all })
      setPendingDelete(null)
      toast.success(t('plansPage.bundles.deleted'))
    },
    onError: (err) => toast.error(getErrorMessage(err, t('plansPage.bundles.deleteFailed'))),
  })

  const planNameById = new Map(plans.map((plan) => [plan.id, plan.name]))
  if (!bundles?.length) return null

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Layers className="h-4 w-4" /> {t('plansPage.bundles.title')}
        </CardTitle>
        <CardDescription>{t('plansPage.bundles.subtitle')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {bundles.map((bundle) => (
          <div key={bundle.id} className="rounded-lg border bg-card p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{bundle.name}</span>
                  <Badge variant={bundle.isActive ? 'success' : 'secondary'}>
                    {bundle.isActive
                      ? t('plansPage.bundles.active')
                      : t('plansPage.bundles.inactive')}
                  </Badge>
                </div>
                {bundle.description ? (
                  <p className="text-xs text-muted-foreground">{bundle.description}</p>
                ) : null}
                {bundle.planId !== null && bundle.planId !== undefined ? (
                  <p className="text-xs text-muted-foreground">
                    {t('plansPage.bundles.issuedAs', {
                      plan: planNameById.get(bundle.planId) ?? bundle.planId,
                    })}
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {t('plansPage.bundles.noPlanYet')}
                  </p>
                )}
                {/* The card is where the merged subscription's device limit is
                    set, so the card is where it is read back. `0` is unlimited
                    by the panel's own rule (`hwidDeviceLimit: 0`) — printed as
                    words, never as a zero that reads like "no devices". */}
                <p className="text-xs text-muted-foreground">
                  {t('plansPage.bundles.devices')}:{' '}
                  {bundle.deviceLimit === null
                    ? t('plansPage.bundles.devicesAsPlan')
                    : bundle.deviceLimit > 0
                      ? t('plansPage.bundles.devicesUpTo', { count: bundle.deviceLimit })
                      : t('plansPage.bundles.devicesUnlimited')}
                </p>
                <div className="flex flex-wrap gap-1">
                  {bundle.planIds.map((planId) => {
                    const isVisible = planId === bundle.visiblePlanId
                    return (
                      <Badge key={planId} variant="outline">
                        {planNameById.get(planId) ?? planId}
                        {isVisible ? ` · ${t('plansPage.bundles.visibleBadge')}` : ''}
                      </Badge>
                    )
                  })}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t('plansPage.bundles.aria.edit')}
                  onClick={() => onEdit(bundle)}
                >
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t('plansPage.bundles.aria.delete')}
                  onClick={() => setPendingDelete(bundle)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>
        ))}
      </CardContent>

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('plansPage.bundles.deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('plansPage.bundles.deleteHint', { name: pendingDelete?.name ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('plansPage.bundles.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                // The dialog stays open while the request runs, so a failure
                // leaves the operator a second try instead of a vanished card.
                event.preventDefault()
                if (pendingDelete !== null) deleteMutation.mutate(pendingDelete.id)
              }}
            >
              {deleteMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              {t('plansPage.bundles.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}

/**
 * Create or edit one grouping: a name and exactly two plans.
 *
 * Two kinds of plan cannot be picked, and both are disabled chips with the
 * reason in their `title` rather than a refusal after saving:
 *
 * - a plan that already belongs to another bundle — one plan in two groupings
 *   would ask one card to offer two different merged links (the server keeps
 *   the unique index and answers 409);
 * - a plan that is itself a bundle's tariff («объединённый») — it carries no
 *   config of its own (its squads and limits belong to that other bundle), so
 *   merging it into a third one would produce an empty profile. The server
 *   refuses it as well.
 *
 * Once two are picked every other chip is disabled: the bundle is two halves,
 * not a list.
 */
export function PlanBundleDialog({
  open,
  onOpenChange,
  bundle,
  plans,
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  /** `null` = create. */
  readonly bundle: PlanBundle | null
  readonly plans: readonly Plan[]
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { data: bundles } = usePlanBundles()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [isActive, setIsActive] = useState(true)
  const [selectedPlanIds, setSelectedPlanIds] = useState<string[]>([])
  const [visiblePlanId, setVisiblePlanId] = useState<string | null>(null)
  /**
   * Device limit of the merged subscription, as the input holds it. Empty means
   * "as the visible plan" — the server falls back to that plan's own limit.
   */
  const [deviceLimit, setDeviceLimit] = useState('')

  // Populate/reset when the dialog opens, the same mirroring the add-on dialog
  // does — the state has to survive the close animation, so it cannot be keyed.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!open) return
    setName(bundle?.name ?? '')
    setDescription(bundle?.description ?? '')
    setIsActive(bundle?.isActive ?? true)
    setSelectedPlanIds(bundle === null ? [] : [...bundle.planIds])
    setVisiblePlanId(bundle?.visiblePlanId ?? null)
    setDeviceLimit(bundle?.deviceLimit == null ? '' : String(bundle.deviceLimit))
  }, [open, bundle])
  /* eslint-enable react-hooks/set-state-in-effect */

  const groupedElsewhere = new Set(
    (bundles ?? [])
      .filter((candidate) => candidate.id !== bundle?.id)
      .flatMap((candidate) => candidate.planIds),
  )
  // Archived plans stay pickable only when the bundle already holds them — an
  // edit that silently dropped one would re-write the grouping on save.
  const pickablePlans = plans.filter(
    (plan) => !plan.isArchived || selectedPlanIds.includes(plan.id),
  )
  // In the plans' own display order, so the radio list reads like the grid.
  const selectedPlans = plans.filter((plan) => selectedPlanIds.includes(plan.id))
  /** Two halves are a merge; a third chip has nothing to become. */
  const atPlanLimit = selectedPlanIds.length >= MAX_BUNDLE_PLANS
  /**
   * What the server will store: the operator's pick while it is still a member,
   * otherwise the bundle's default — its first LIMITED plan, because an app that
   * read «unlimited» would hide the limit the customer has to watch, and only
   * then the first plan at all. Mirrors `PlanBundlesService`'s own rule, and the
   * radio below shows it selected so the default is never a surprise.
   */
  const effectiveVisiblePlanId =
    visiblePlanId !== null && selectedPlanIds.includes(visiblePlanId)
      ? visiblePlanId
      : (selectedPlans.find((plan) => plan.trafficLimit !== null)?.id ??
        selectedPlans[0]?.id ??
        null)

  const createMutation = useMutation({
    mutationFn: () =>
      createPlanBundle({
        name: name.trim(),
        description,
        isActive,
        planIds: selectedPlanIds,
        visiblePlanId: effectiveVisiblePlanId,
        ...(deviceLimit.trim() === '' ? {} : { deviceLimit: Number(deviceLimit) }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: planBundlesQueryKeys.all })
      // The save also creates the tariff, so the plans list is stale too.
      queryClient.invalidateQueries({ queryKey: ['admin', 'plans'] })
      onOpenChange(false)
      toast.success(t('plansPage.bundles.created'))
    },
    onError: (err) => toast.error(getErrorMessage(err, t('plansPage.bundles.createFailed'))),
  })

  const updateMutation = useMutation({
    mutationFn: () =>
      updatePlanBundle(bundle?.id ?? '', {
        name: name.trim(),
        description,
        isActive,
        planIds: selectedPlanIds,
        visiblePlanId: effectiveVisiblePlanId,
        ...(deviceLimit.trim() === '' ? {} : { deviceLimit: Number(deviceLimit) }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: planBundlesQueryKeys.all })
      queryClient.invalidateQueries({ queryKey: ['admin', 'plans'] })
      onOpenChange(false)
      toast.success(t('plansPage.bundles.updated'))
    },
    onError: (err) => toast.error(getErrorMessage(err, t('plansPage.bundles.updateFailed'))),
  })

  const mutation = bundle === null ? createMutation : updateMutation
  const canSave =
    name.trim().length > 0 &&
    selectedPlanIds.length >= MIN_BUNDLE_PLANS &&
    selectedPlanIds.length <= MAX_BUNDLE_PLANS

  const togglePlan = (planId: string) => {
    setSelectedPlanIds((current) => {
      if (current.includes(planId)) return current.filter((id) => id !== planId)
      // The two-halves rule also holds for a programmatic pick: the chips are
      // disabled at the limit, and this keeps the state from ever holding three.
      if (current.length >= MAX_BUNDLE_PLANS) return current
      return [...current, planId]
    })
    // Dropping the plan the app shows sends the choice back to the default
    // rather than leaving a dangling id the server would refuse.
    if (visiblePlanId === planId) setVisiblePlanId(null)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {bundle === null ? t('plansPage.bundles.createTitle') : t('plansPage.bundles.editTitle')}
          </DialogTitle>
          <DialogDescription>{t('plansPage.bundles.formHint')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="plan-bundle-name">{t('plansPage.bundles.name')}</Label>
            <Input
              id="plan-bundle-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={80}
              placeholder={t('plansPage.bundles.namePlaceholder')}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="plan-bundle-description">{t('plansPage.bundles.description')}</Label>
            <Input
              id="plan-bundle-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              maxLength={500}
            />
          </div>

          <div className="space-y-2">
            <Label>{t('plansPage.bundles.plans')}</Label>
            <p className="text-xs text-muted-foreground">{t('plansPage.bundles.plansHint')}</p>
            <div className="flex max-h-32 flex-wrap gap-2 overflow-y-auto">
              {pickablePlans.map((plan) => {
                const selected = selectedPlanIds.includes(plan.id)
                const takenByAnotherBundle = !selected && groupedElsewhere.has(plan.id)
                // A bundle's own tariff («объединённый») is not a plan a merge
                // can take: its squads and limits are the other bundle's, so a
                // merge built on it would mint an empty profile. The server
                // refuses it too — here the reason is visible before saving.
                const alreadyMerged = !selected && plan.bundle != null
                const blockedByLimit = !selected && !takenByAnotherBundle && !alreadyMerged && atPlanLimit
                const disabled = takenByAnotherBundle || alreadyMerged || blockedByLimit
                return (
                  <button
                    key={plan.id}
                    type="button"
                    className={cn(
                      'rounded-full border px-3 py-1 text-xs transition-colors',
                      selected
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-input hover:bg-accent',
                      disabled && 'cursor-not-allowed opacity-50',
                    )}
                    aria-pressed={selected}
                    disabled={disabled}
                    title={
                      takenByAnotherBundle
                        ? t('plansPage.bundles.planGroupedElsewhere')
                        : alreadyMerged
                          ? t('plansPage.bundles.planAlreadyMerged', { name: plan.bundle?.name ?? '' })
                          : blockedByLimit
                            ? t('plansPage.bundles.planLimitReached')
                            : undefined
                    }
                    onClick={() => togglePlan(plan.id)}
                  >
                    {plan.name}
                  </button>
                )
              })}
            </div>
            {atPlanLimit ? (
              <p className="text-xs text-muted-foreground">
                {t('plansPage.bundles.planLimitReached')}
              </p>
            ) : null}
          </div>

          {selectedPlans.length > 0 && (
            <div className="space-y-2">
              <div>
                <Label>{t('plansPage.bundles.visiblePlan')}</Label>
                <p className="text-xs text-muted-foreground">
                  {t('plansPage.bundles.visibleHint')}
                </p>
              </div>
              {/* A card per member with an explicit check, not a browser radio
                  dot: the choice decides what the customer's VPN app reports
                  as their plan, and it has to be readable at a glance. An
                  unlimited plan is offered but cannot be picked — the merged
                  link would report «unlimited» and hide the limited plan's
                  remaining traffic. */}
              <div className="space-y-1.5">
                {selectedPlans.map((plan) => {
                  const unlimited = plan.trafficLimit === null
                  const checked = !unlimited && plan.id === effectiveVisiblePlanId
                  return (
                    <button
                      key={plan.id}
                      type="button"
                      disabled={unlimited}
                      aria-pressed={checked}
                      title={unlimited ? t('plansPage.bundles.visibleUnlimited') : undefined}
                      onClick={() => setVisiblePlanId(plan.id)}
                      className={cn(
                        'flex w-full items-center gap-2.5 rounded-md border px-3 py-2 text-left text-xs transition-colors',
                        checked
                          ? 'border-primary bg-primary/5 ring-1 ring-primary'
                          : 'border-input hover:bg-accent',
                        unlimited && 'cursor-not-allowed opacity-60',
                      )}
                    >
                      <span
                        className={cn(
                          'flex h-4 w-4 shrink-0 items-center justify-center rounded-full border',
                          checked
                            ? 'border-primary bg-primary text-primary-foreground'
                            : 'border-muted-foreground/40',
                        )}
                      >
                        {checked ? <Check className="h-3 w-3" /> : null}
                      </span>
                      <span className="font-medium">{plan.name}</span>
                      <span className="text-muted-foreground">
                        {plan.trafficLimit === null
                          ? t('plansPage.unlimited')
                          : `${plan.trafficLimit} GB`}
                      </span>
                      {unlimited ? (
                        <span className="ml-auto text-[10px] text-muted-foreground">
                          {t('plansPage.bundles.visibleUnlimitedShort')}
                        </span>
                      ) : null}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="plan-bundle-device-limit">
              {t('plansPage.bundles.deviceLimit')}
            </Label>
            <Input
              id="plan-bundle-device-limit"
              type="number"
              min="0"
              className="w-40"
              value={deviceLimit}
              onChange={(event) => setDeviceLimit(event.target.value)}
              placeholder={t('plansPage.bundles.deviceLimitPlaceholder')}
            />
            <p className="text-xs text-muted-foreground">
              {t('plansPage.bundles.deviceLimitHint')}
            </p>
          </div>

          <div className="flex items-center justify-between rounded-lg border p-3">
            <div>
              <Label htmlFor="plan-bundle-active">{t('plansPage.bundles.activeLabel')}</Label>
              <p className="text-xs text-muted-foreground">{t('plansPage.bundles.activeHint')}</p>
            </div>
            <Switch
              id="plan-bundle-active"
              checked={isActive}
              onCheckedChange={setIsActive}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('plansPage.bundles.cancel')}
          </Button>
          <ButtonTip
            disabled={!canSave || mutation.isPending}
            tip={
              selectedPlanIds.length < MIN_BUNDLE_PLANS
                ? t('plansPage.bundles.needTwoPlans')
                : name.trim().length === 0
                  ? t('plansPage.bundles.needName')
                  : t('plansPage.bundles.save')
            }
          >
            <Button
              onClick={() => mutation.mutate()}
              disabled={!canSave || mutation.isPending}
            >
              {mutation.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : bundle === null ? (
                <Plus className="mr-2 h-4 w-4" />
              ) : null}
              {bundle === null ? t('plansPage.bundles.create') : t('plansPage.bundles.save')}
            </Button>
          </ButtonTip>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
