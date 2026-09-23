/**
 * A trial's conversion withheld for refund, as the panel shows it.
 * ────────────────────────────────────────────────────────────────
 * Received after another payment had converted the same trial: the payment is
 * COMPLETED and stamped delivered — so it is settled and holds nothing up —
 * yet it changed nothing, and its money is due back to the payer. The server
 * tells the operator once (`payment.withheld`), and that card names the way
 * here: «Платежи» → «Транзакции» → the payment → «Отметить возврат».
 *
 * «Отметить возврат» records that the operator returned the money at the
 * provider, which most gateways never report. The server runs the reversal a
 * provider's refund notification runs and changes no subscription. Offered
 * only while the money is held, and only with `payments:refund`, the
 * permission a refund itself needs; the server checks both again.
 */
import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Undo2 } from 'lucide-react'

import { api } from '@/lib/api'
import { adminQueryKeys } from '@/lib/admin-query-keys'
import { getErrorMessage } from '@/lib/http-errors'
import { activeLocale } from '@/lib/utils'
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
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CopyableId } from '@/components/ui/copyable-id'
import { useHasPermission } from '@/features/rbac'
import { formatPaymentAmount, gatewayLabel, type TransactionRow, type WithheldConversion } from './payment-records'

/** The mark beside a withheld payment's status, wherever a payment is listed. */
export function WithheldBadge({ mark }: { readonly mark: WithheldConversion }) {
  const { t } = useTranslation()
  return (
    <Badge variant={mark.refundedAt ? 'secondary' : 'warning'} title={t('paymentsPage.withheld.hint')}>
      {mark.refundedAt ? t('paymentsPage.withheld.badgeRefunded') : t('paymentsPage.withheld.badge')}
    </Badge>
  )
}

/** `WithheldRefundRecordResultInterface`: what the server did. */
interface RecordResult {
  readonly recorded: boolean
  readonly refundedAt: string | null
}

/** The refusals the server answers «Отметить возврат» with, by their code. */
const REFUSALS = new Set(['PAYMENT_NOT_WITHHELD', 'PAYMENT_WITHHELD_REFUND_IN_PROGRESS'])

function refusalMessage(error: unknown, t: (key: string) => string): string {
  const message = (error as { response?: { data?: { message?: unknown } } } | null)?.response?.data?.message
  if (typeof message === 'string' && REFUSALS.has(message)) return t(`paymentsPage.withheld.errors.${message}`)
  return getErrorMessage(error, t('paymentsPage.withheld.failed'))
}

export function WithheldConversionSection({
  transaction,
  mark,
}: {
  readonly transaction: TransactionRow
  readonly mark: WithheldConversion
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const canRecord = useHasPermission('payments', 'refund')
  const [open, setOpen] = useState(false)
  // The server's answer, kept: the row this sheet shows can be the list's
  // cached copy, which the page does not read again by itself.
  const [recordedAt, setRecordedAt] = useState<string | null>(null)
  const refundedAt = mark.refundedAt ?? recordedAt

  const record = useMutation({
    mutationFn: async () =>
      (await api.post(`/admin/payments/transactions/${encodeURIComponent(transaction.id)}/withheld-refund`))
        .data as RecordResult,
    onSuccess: (result) => {
      setOpen(false)
      setRecordedAt(result.refundedAt ?? new Date().toISOString())
      void queryClient.invalidateQueries({ queryKey: adminQueryKeys.payments.all })
      void queryClient.invalidateQueries({ queryKey: ['admin', 'users'] })
      toast.success(result.recorded ? t('paymentsPage.withheld.recorded') : t('paymentsPage.withheld.alreadyRecorded'))
    },
    onError: (error) => toast.error(refusalMessage(error, t)),
  })

  return (
    <section aria-labelledby="payment-details-withheld" className="space-y-2 rounded-md border p-3">
      <h3 id="payment-details-withheld" className="flex flex-wrap items-center gap-2 font-semibold">
        {t('paymentsPage.withheld.title')}
        <WithheldBadge mark={{ ...mark, refundedAt }} />
      </h3>
      <p className="text-muted-foreground">{t('paymentsPage.withheld.description')}</p>
      {mark.convertedByPaymentId ? (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-muted-foreground">{t('paymentsPage.withheld.convertedBy')}</span>
          <CopyableId value={mark.convertedByPaymentId} label={t('paymentsPage.withheld.convertedBy')} />
        </div>
      ) : null}
      {refundedAt ? (
        <p className="text-xs">{t('paymentsPage.withheld.refundedAt', { time: formatInstant(refundedAt) })}</p>
      ) : canRecord ? (
        <div className="space-y-1.5">
          <AlertDialog open={open} onOpenChange={setOpen}>
            <AlertDialogTrigger asChild>
              <Button size="sm" variant="outline">
                <Undo2 className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                {t('paymentsPage.withheld.recordRefund')}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t('paymentsPage.withheld.confirmTitle')}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t('paymentsPage.withheld.confirmDescription', {
                    amount: formatPaymentAmount(transaction.amount, transaction.currency, activeLocale()),
                    gateway: gatewayLabel(transaction.gatewayType, t),
                  })}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t('common.cancel', { defaultValue: 'Отмена' })}</AlertDialogCancel>
                <AlertDialogAction
                  disabled={record.isPending}
                  onClick={(event) => {
                    // Kept open until the answer: a refusal is shown while the
                    // operator still sees what they were confirming.
                    event.preventDefault()
                    record.mutate()
                  }}
                >
                  {record.isPending ? t('paymentsPage.withheld.submitting') : t('paymentsPage.withheld.confirm')}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          <p className="text-xs text-muted-foreground">{t('paymentsPage.withheld.recordRefundHint')}</p>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{t('paymentsPage.withheld.noPermission')}</p>
      )}
    </section>
  )
}

function formatInstant(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(activeLocale())
}
