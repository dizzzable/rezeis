/**
 * ClonePlansDialog
 * ──────────────────────────────────────────────────────────────────
 * Optional second step the operator can take after a successful
 * altshop / remnashop import: restore the source-side plan catalog
 * (Plan + PlanDuration + PlanPrice) so imported subscriptions land on
 * real plans with real prices instead of `planSnapshot.planId === null`.
 *
 * Flow:
 *   1. The dialog opens with a `GET /admin/imports/:id/plan-preview`
 *      call that returns a per-plan summary (name, status, subscription
 *      count, suggested final name with conflict suffix, etc.).
 *   2. The operator unticks plans they don't want cloned. By default
 *      we also auto-untick the synthetic "IMPORTED" placeholder.
 *   3. Submit triggers `POST /admin/imports/:id/clone-plans` with the
 *      selected source ids and a `linkSubscriptions` flag.
 *   4. We toast on success with counters and close.
 *
 * Cloning is fully idempotent on the backend, so the operator can
 * cancel and re-open this dialog without consequences.
 */
import { useEffect, useMemo, useState, type JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, AlertCircle } from 'lucide-react'
import { toast } from 'sonner'

import { api } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
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
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

interface PlanPreviewRow {
  readonly sourcePlanId: number
  readonly name: string
  readonly tag: string | null
  readonly type: string
  readonly availability: string
  readonly trafficLimit: number
  readonly deviceLimit: number
  readonly isActive: boolean
  readonly isArchived: boolean
  readonly subscriptionsCount: number
  readonly finalName: string
  readonly willReuseExisting: boolean
  readonly recommendDeselect: boolean
}

interface PlanCatalogPreview {
  readonly plans: ReadonlyArray<PlanPreviewRow>
}

interface CloneResult {
  readonly plansCreated: number
  readonly plansReused: number
  readonly subscriptionsLinked: number
  readonly errors: ReadonlyArray<string>
}

interface ClonePlansDialogProps {
  readonly open: boolean
  readonly onClose: () => void
  /** ImportRecord whose catalog we'll clone from. */
  readonly importRecordId: string
}

export function ClonePlansDialog({
  open,
  onClose,
  importRecordId,
}: ClonePlansDialogProps): JSX.Element {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const previewQuery = useQuery<PlanCatalogPreview>({
    queryKey: ['admin', 'imports', importRecordId, 'plan-preview'],
    queryFn: async () => {
      const res = await api.get<PlanCatalogPreview>(`/admin/imports/${importRecordId}/plan-preview`)
      return res.data
    },
    enabled: open,
    // Preview is read-only and the source data does not change during
    // the operator's session — cache aggressively.
    staleTime: 60_000,
  })

  // Keep an explicit selection map so the operator's manual ticks
  // override the recommendation defaults that only fire on first load.
  const [selected, setSelected] = useState<Record<number, boolean>>({})
  const [linkSubscriptions, setLinkSubscriptions] = useState(true)

  // Initialise selection when the preview arrives — auto-deselect the
  // synthetic "IMPORTED" placeholder, tick everything else.
  useEffect(() => {
    if (!previewQuery.data) return
    setSelected((prev) => {
      // Already initialised by the operator? respect the existing map.
      if (Object.keys(prev).length > 0) return prev
      const next: Record<number, boolean> = {}
      for (const plan of previewQuery.data.plans) {
        next[plan.sourcePlanId] = !plan.recommendDeselect
      }
      return next
    })
  }, [previewQuery.data])

  // Reset state on close so reopening starts fresh.
  useEffect(() => {
    if (!open) {
      setSelected({})
      setLinkSubscriptions(true)
    }
  }, [open])

  const cloneMutation = useMutation({
    mutationFn: async (): Promise<CloneResult> => {
      const selectedSourcePlanIds = Object.entries(selected)
        .filter(([, on]) => on)
        .map(([id]) => Number(id))
      const res = await api.post<CloneResult>(`/admin/imports/${importRecordId}/clone-plans`, {
        selectedSourcePlanIds,
        linkSubscriptions,
      })
      return res.data
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'plans'] })
      queryClient.invalidateQueries({ queryKey: ['admin', 'imports'] })
      toast.success(t('importsPage.clonePlans.success', {
        created: result.plansCreated,
        reused: result.plansReused,
        linked: result.subscriptionsLinked,
      }))
      if (result.errors.length > 0) {
        toast.warning(t('importsPage.clonePlans.partialErrors', { count: result.errors.length }))
      }
      onClose()
    },
    onError: (err: unknown) => {
      const message = (err as { response?: { data?: { message?: string } } })
        ?.response?.data?.message
      toast.error(message ?? t('importsPage.errorGeneric'))
    },
  })

  const selectedCount = useMemo(
    () => Object.values(selected).filter(Boolean).length,
    [selected],
  )

  const handleToggle = (sourcePlanId: number): void => {
    setSelected((prev) => ({ ...prev, [sourcePlanId]: !prev[sourcePlanId] }))
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !cloneMutation.isPending) onClose()
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('importsPage.clonePlans.title')}</DialogTitle>
          <DialogDescription>{t('importsPage.clonePlans.description')}</DialogDescription>
        </DialogHeader>

        {previewQuery.isLoading ? (
          <div className="space-y-2 py-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </div>
        ) : previewQuery.isError || !previewQuery.data ? (
          <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm">
            <AlertCircle className="h-4 w-4 shrink-0 text-destructive" />
            <p>{t('importsPage.clonePlans.previewError')}</p>
          </div>
        ) : previewQuery.data.plans.length === 0 ? (
          <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
            {t('importsPage.clonePlans.emptyCatalog')}
          </div>
        ) : (
          <>
            <ScrollArea className="max-h-80 rounded-md border">
              <ul className="divide-y">
                {previewQuery.data.plans.map((plan) => (
                  <PlanRow
                    key={plan.sourcePlanId}
                    plan={plan}
                    checked={selected[plan.sourcePlanId] === true}
                    onToggle={() => handleToggle(plan.sourcePlanId)}
                  />
                ))}
              </ul>
            </ScrollArea>

            <Separator />

            <label className="flex cursor-pointer items-start gap-3 rounded-md border p-3">
              <Checkbox
                checked={linkSubscriptions}
                onCheckedChange={(c) => setLinkSubscriptions(c === true)}
                className="mt-0.5"
              />
              <span className="space-y-1">
                <span className="block text-sm font-medium">
                  {t('importsPage.clonePlans.linkSubscriptions')}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {t('importsPage.clonePlans.linkSubscriptionsHint')}
                </span>
              </span>
            </label>
          </>
        )}

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={onClose} disabled={cloneMutation.isPending}>
            {t('importsPage.clonePlans.cancel')}
          </Button>
          <Button
            onClick={() => cloneMutation.mutate()}
            disabled={
              cloneMutation.isPending ||
              previewQuery.isLoading ||
              previewQuery.isError ||
              selectedCount === 0
            }
          >
            {cloneMutation.isPending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {t('importsPage.clonePlans.cloning')}
              </>
            ) : (
              t('importsPage.clonePlans.submit', { count: selectedCount })
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function PlanRow({
  plan,
  checked,
  onToggle,
}: {
  readonly plan: PlanPreviewRow
  readonly checked: boolean
  readonly onToggle: () => void
}): JSX.Element {
  const { t } = useTranslation()
  const trafficLabel =
    plan.trafficLimit > 0
      ? t('importsPage.clonePlans.row.traffic', { gb: plan.trafficLimit })
      : t('importsPage.clonePlans.row.unlimited')
  const deviceLabel = plan.deviceLimit > 0
    ? t('importsPage.clonePlans.row.devices', { count: plan.deviceLimit })
    : t('importsPage.clonePlans.row.unlimitedDevices')

  return (
    <li
      className={cn(
        'flex items-start gap-3 px-3 py-2.5 text-sm transition-colors',
        checked ? 'bg-card' : 'bg-muted/30 text-muted-foreground',
      )}
    >
      <Checkbox checked={checked} onCheckedChange={onToggle} className="mt-1" />
      <button
        type="button"
        onClick={onToggle}
        className="flex flex-1 cursor-pointer flex-col gap-1 text-left"
      >
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium">{plan.name}</span>
          {plan.finalName !== plan.name ? (
            <Badge variant="outline" className="text-[10px]">
              {t('importsPage.clonePlans.row.willBeNamed', { name: plan.finalName })}
            </Badge>
          ) : null}
          {plan.willReuseExisting ? (
            <Badge variant="secondary" className="text-[10px]">
              {t('importsPage.clonePlans.row.willReuse')}
            </Badge>
          ) : null}
          {plan.tag ? (
            <Badge variant="secondary" className="text-[10px]">{plan.tag}</Badge>
          ) : null}
          {plan.isArchived ? (
            <Badge variant="outline" className="text-[10px]">
              {t('importsPage.clonePlans.row.archived')}
            </Badge>
          ) : !plan.isActive ? (
            <Badge variant="outline" className="text-[10px]">
              {t('importsPage.clonePlans.row.inactive')}
            </Badge>
          ) : (
            <Badge variant="default" className="text-[10px]">
              {t('importsPage.clonePlans.row.active')}
            </Badge>
          )}
        </div>
        <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
          <span>{trafficLabel}</span>
          <span>{deviceLabel}</span>
          <span>
            {t('importsPage.clonePlans.row.subscriptions', { count: plan.subscriptionsCount })}
          </span>
          {plan.recommendDeselect ? (
            <span className="text-amber-600 dark:text-amber-400">
              {t('importsPage.clonePlans.row.placeholderHint')}
            </span>
          ) : null}
        </div>
      </button>
    </li>
  )
}

// Re-export type so the page can pick CloneResult type without hand-rolling.
export type { CloneResult, PlanPreviewRow, PlanCatalogPreview }
