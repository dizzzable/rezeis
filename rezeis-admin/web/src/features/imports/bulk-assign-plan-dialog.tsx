/**
 * BulkAssignPlanDialog
 * ──────────────────────────────────────────────────────────────────
 * Second-step modal that the operator opens from the success screen
 * of `ImportProgressDialog` (or directly from the page).
 *
 * Flow:
 *   1. Pick a plan from the list of currently active, non-archived plans.
 *   2. Optionally toggle "Apply limits immediately" — when off (default),
 *      the assignment only updates the local DB (planSnapshot, planId,
 *      cached limits). The Remnawave panel is NOT reshaped right now;
 *      the new limits land on the next renewal/upgrade through the
 *      customer flow. This is the "Variant 2" behaviour the operator
 *      and product agreed on, so we never silently shrink a paying
 *      customer's panel limits as a side-effect of an admin re-plan.
 *   3. Submit → `POST /admin/imports/assign-plan`. Returns `{ jobId }`
 *      because the work is enqueued, not synchronous. We toast on
 *      enqueue and let the operator track progress through the import
 *      history (queue jobs typically finish in <1 s for plain re-plan
 *      operations since no Remnawave roundtrip is involved when
 *      `applyImmediately === false`).
 */
import { useState, type JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import { api } from '@/lib/api'
import { adminQueryKeys } from '@/lib/admin-query-keys'
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
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { usePlans } from '@/features/plans/plans-api'

interface BulkAssignPlanDialogProps {
  readonly open: boolean
  readonly onClose: () => void
  /**
   * Either `importRecordId` (assign to all subscriptions created by
   * this import) or `userIds` (explicit list) — the page picks one
   * based on context. We do not allow both at once: backend rejects
   * that combination.
   */
  readonly importRecordId?: string
  readonly userIds?: ReadonlyArray<string>
}

interface BulkAssignResponse {
  readonly jobId: string
  readonly message: string
}

export function BulkAssignPlanDialog({
  open,
  onClose,
  importRecordId,
  userIds,
}: BulkAssignPlanDialogProps): JSX.Element {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const [selectedPlanId, setSelectedPlanId] = useState<string>('')
  const [applyImmediately, setApplyImmediately] = useState(false)

  const { data: plans } = usePlans({ active: true })
  const eligiblePlans = (plans ?? []).filter((p) => p.isActive && !p.isArchived)

  const assignMutation = useMutation({
    mutationFn: async () => {
      const response = await api.post<BulkAssignResponse>('/admin/imports/assign-plan', {
        planId: selectedPlanId,
        importRecordId,
        userIds: userIds && userIds.length > 0 ? [...userIds] : undefined,
        applyImmediately,
      })
      return response.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminQueryKeys.imports.all })
      toast.success(t('importsPage.assignPlan.success', {
        // Backend returns only jobId (work is async). The actual counters
        // land in import_records when the worker finishes — operator can
        // refresh the history table to see them.
        updated: '…',
        skipped: '…',
        synced: '…',
      }))
      handleReset()
      onClose()
    },
    onError: (err: unknown) => {
      const message = (err as { response?: { data?: { message?: string } } })
        ?.response?.data?.message
      toast.error(message ?? t('importsPage.errorGeneric'))
    },
  })

  function handleReset(): void {
    setSelectedPlanId('')
    setApplyImmediately(false)
  }

  const canSubmit = selectedPlanId !== '' && !assignMutation.isPending

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !assignMutation.isPending) {
          handleReset()
          onClose()
        }
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('importsPage.assignDialog.title')}</DialogTitle>
          <DialogDescription>{t('importsPage.assignDialog.description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label>{t('importsPage.assignDialog.planLabel')}</Label>
            {eligiblePlans.length === 0 ? (
              <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                {t('importsPage.assignDialog.noPlans')}
              </p>
            ) : (
              <Select value={selectedPlanId} onValueChange={setSelectedPlanId}>
                <SelectTrigger>
                  <SelectValue placeholder={t('importsPage.assignDialog.planPlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  {eligiblePlans.map((plan) => (
                    <SelectItem key={plan.id} value={plan.id}>
                      {plan.name}
                      {plan.trafficLimit !== null && plan.trafficLimit !== undefined
                        ? ` · ${plan.trafficLimit} GB`
                        : ''}
                      {plan.deviceLimit > 0 ? ` · ${plan.deviceLimit} dev` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          <div className="rounded-md border p-3">
            <label className="flex cursor-pointer items-start gap-3">
              <Checkbox
                checked={applyImmediately}
                onCheckedChange={(checked) => setApplyImmediately(checked === true)}
                className="mt-0.5"
              />
              <span className="space-y-1">
                <span className="block text-sm font-medium">
                  {t('importsPage.assignDialog.applyImmediately')}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {t('importsPage.assignDialog.applyImmediatelyHint')}
                </span>
              </span>
            </label>
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={onClose} disabled={assignMutation.isPending}>
            {t('importsPage.assignDialog.cancel')}
          </Button>
          <Button
            onClick={() => assignMutation.mutate()}
            disabled={!canSubmit || eligiblePlans.length === 0}
          >
            {assignMutation.isPending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {t('importsPage.assignDialog.submitting')}
              </>
            ) : (
              t('importsPage.assignDialog.submit')
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
