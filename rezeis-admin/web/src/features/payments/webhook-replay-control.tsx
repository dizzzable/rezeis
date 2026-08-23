/**
 * Replay one payment webhook event.
 * ---------------------------------
 * Reader for `POST admin/payments/webhooks/events/:eventId/replay`
 * (`AdminPaymentWebhooksController.replayEvent:58-60`, `payment_webhooks:run`),
 * which had no caller in the SPA - so the reconciliation-health card could
 * report stuck events and the operator had no way to act on them.
 *
 * What a replay actually does (`PaymentWebhookOpsService.replayEvent` ->
 * `PaymentReconciliationService.reconcileWebhookEvent`): it re-enqueues the
 * reconciliation job for the event and re-applies the payload the panel
 * ALREADY STORED. It does not call the gateway again. The job id is
 * `reconcile:webhook:<eventId>`, so a second request while one is still queued
 * comes back `alreadyQueued: true` and enqueues nothing - the copy says so
 * rather than claiming a second replay happened.
 *
 * `force` is deliberately NOT exposed.
 *   `validateReplayPolicy` (payment-webhook-ops.service.ts:360-376) refuses
 *   exactly one status without it: `PROCESSED` -> 400
 *   `PAYMENT_WEBHOOK_REPLAY_FORCE_REQUIRED`. Every other lifecycle status
 *   (RECEIVED / ENQUEUED / PROCESSING / FAILED) replays without force, and
 *   those are exactly the ones the health card flags. So `force` buys nothing
 *   for the stuck-event workflow and costs a control whose only meaning is
 *   "re-apply a payment webhook the inbox already applied" - a money-affecting
 *   escalation whose safety depends on per-gateway handler idempotency.
 *   Omitting the key entirely also means the panel never depends on how the
 *   server coerces `force`.
 *   A PROCESSED row therefore gets a disabled button that says why, rather
 *   than an enabled one that 400s.
 *
 * `reason` is REQUIRED by the DTO (`@IsString() @MinLength(3) @MaxLength(512)`)
 * and is written to `adminAuditLog` alongside the admin id, so the
 * confirmation collects it rather than inventing one.
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Loader2, RotateCw } from 'lucide-react'
import { toast } from 'sonner'

import { api } from '@/lib/api'
import { adminQueryKeys } from '@/lib/admin-query-keys'
import { getErrorMessage } from '@/lib/http-errors'
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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { PermissionGate } from '@/features/rbac'
import { reconciliationHealthQueryKey } from './payments-ops-keys'

/** Mirrors `AdminReplayPaymentWebhookEventResultInterface`. */
interface ReplayResult {
  readonly alreadyQueued: boolean
}

export interface ReplayableWebhookEvent {
  readonly id: string
  readonly gatewayType: string
  readonly providerEventId: string | null
  readonly status: string
  readonly lastError?: string | null
}

/** Server-authored codes this control can explain in the operator's language. */
const KNOWN_REPLAY_ERRORS: Readonly<Record<string, string>> = {
  PAYMENT_WEBHOOK_REPLAY_FORCE_REQUIRED: 'paymentsReconciliation.replay.forceRequired',
  PAYMENT_WEBHOOK_REPLAY_NOT_ALLOWED: 'paymentsReconciliation.replay.notAllowed',
}

const MIN_REASON_LENGTH = 3
const MAX_REASON_LENGTH = 512

export function WebhookReplayControl({ event }: { readonly event: ReplayableWebhookEvent }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')

  const replayMutation = useMutation({
    // The reason travels as the mutation VARIABLE, not read from state inside
    // the mutationFn. Confirming closes the dialog, which clears `reason`, and
    // React Query calls the latest render's `mutationFn` — so a state read here
    // runs after that clear and puts `reason: ''` on the wire, which the DTO's
    // `@MinLength(3)` then rejects. `mutate(value)` captures it at click time.
    mutationFn: async (reasonText: string) => {
      // No `force` key: see the module docblock. The panel only ever replays
      // statuses the backend allows without it.
      const response = await api.post<ReplayResult>(
        `/admin/payments/webhooks/events/${encodeURIComponent(event.id)}/replay`,
        { reason: reasonText },
      )
      return response.data
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: adminQueryKeys.payments.webhooks.all })
      queryClient.invalidateQueries({ queryKey: reconciliationHealthQueryKey })
      toast.success(
        result?.alreadyQueued === true
          ? t('paymentsReconciliation.replay.alreadyQueued')
          : t('paymentsReconciliation.replay.queued'),
      )
    },
    onError: (err) => {
      const knownKey = KNOWN_REPLAY_ERRORS[getErrorMessage(err, '')]
      toast.error(
        knownKey !== undefined
          ? t(knownKey)
          : getErrorMessage(err, t('paymentsReconciliation.replay.failed')),
      )
    },
  })

  // PROCESSED is the one status the route refuses without `force`, which this
  // panel does not send. Saying so beats letting the operator find out via 400.
  const isProcessed = event.status === 'PROCESSED'
  const trimmedLength = reason.trim().length
  const reasonValid = trimmedLength >= MIN_REASON_LENGTH && trimmedLength <= MAX_REASON_LENGTH

  return (
    <PermissionGate resource="payment_webhooks" action="run">
      <AlertDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (!next) setReason('')
        }}
      >
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          disabled={isProcessed || replayMutation.isPending}
          title={isProcessed ? t('paymentsReconciliation.replay.processedHint') : undefined}
          onClick={() => setOpen(true)}
        >
          {replayMutation.isPending ? (
            <Loader2 className="h-3 w-3 mr-1 animate-spin" />
          ) : (
            <RotateCw className="h-3 w-3 mr-1" />
          )}
          {t('paymentsReconciliation.replay.action')}
        </Button>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('paymentsReconciliation.replay.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('paymentsReconciliation.replay.body')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-3">
            <p className="font-mono text-xs text-muted-foreground">
              {t('paymentsReconciliation.replay.event', {
                gateway: event.gatewayType,
                providerEventId: event.providerEventId ?? '-',
                status: event.status,
              })}
            </p>
            {event.lastError ? (
              <p className="text-xs text-destructive">
                {t('paymentsReconciliation.replay.lastError', { message: event.lastError })}
              </p>
            ) : null}
            <div className="space-y-1.5">
              <Label htmlFor={`replay-reason-${event.id}`} className="text-xs">
                {t('paymentsReconciliation.replay.reasonLabel')}
              </Label>
              <Input
                id={`replay-reason-${event.id}`}
                value={reason}
                maxLength={MAX_REASON_LENGTH}
                onChange={(e) => setReason(e.target.value)}
                placeholder={t('paymentsReconciliation.replay.reasonPlaceholder')}
              />
              <p className="text-xs text-muted-foreground">
                {t('paymentsReconciliation.replay.reasonHint')}
              </p>
            </div>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              disabled={!reasonValid || replayMutation.isPending}
              onClick={() => replayMutation.mutate(reason.trim())}
            >
              <RotateCw className="h-4 w-4 mr-2" />
              {t('paymentsReconciliation.replay.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PermissionGate>
  )
}

export default WebhookReplayControl
