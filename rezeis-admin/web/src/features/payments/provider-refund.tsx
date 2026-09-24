/**
 * «Отметить возврат» for any payment the panel does not refund itself.
 * ────────────────────────────────────────────────────────────────────
 * The panel gives money back by itself only through ЮKassa («Вернуть»). A
 * refund made in Platega's or RollyPay's own dashboard — or by hand, for any
 * other gateway — never reached it: the autopay went on, and the commission
 * and the cashback stayed (the panel files «Мой налог» receipts for ЮKassa
 * payments only, so there is none to cancel). This records it: the server
 * runs the reversal a provider's own refund notice runs
 * (`POST /admin/payments/transactions/:id/provider-refund`) and sends the
 * provider nothing.
 *
 * Offered on a COMPLETED payment of any gateway but ЮKassa and the partner
 * balance (which has no provider), that was not withheld — a withheld one has
 * its own section — and only with `payments:refund`. The server checks all of
 * it again and refuses in words this dialog shows.
 *
 * One dialog on two pages: the payment's details («Платежи» → «Транзакции»)
 * and the user card's «Операции» tab. Each page loads its own i18n bundle, so
 * the words live in both — `paymentsPage.providerRefund` and
 * `userDetailPanel.providerRefund` — and a test holds the two the same.
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
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { useHasPermission } from '@/features/rbac'
import { formatPaymentAmount, gatewayLabel, type TransactionRow } from './payment-records'
import { isProviderRefundCandidate, type ProviderRefundPayment } from './provider-refund-candidate'

/** Where the dialog's words are, by the page it is on. */
export type ProviderRefundTexts = 'paymentsPage.providerRefund' | 'userDetailPanel.providerRefund'

/** `ProviderRefundRecordResultInterface`: what the server did. */
interface RecordResult {
  readonly recorded: boolean
  readonly refundedAt: string | null
}

/** The refusals the server answers with, by their code. */
const REFUSALS = new Set([
  'PAYMENT_REFUND_RECORD_USE_REFUND',
  'PAYMENT_REFUND_RECORD_NO_PROVIDER',
  'PAYMENT_REFUND_RECORD_IMPORTED',
  'PAYMENT_REFUND_NOT_COMPLETED',
  'PAYMENT_REFUND_NOT_FULFILLED',
  'PAYMENT_REFUND_RECORD_NOTHING_PAID',
  'PAYMENT_REFUND_RECORD_IN_PROGRESS',
  'PAYMENT_WITHHELD_REFUND_IN_PROGRESS',
])

function refusalMessage(error: unknown, texts: ProviderRefundTexts, t: (key: string) => string): string {
  const message = (error as { response?: { data?: { message?: unknown } } } | null)?.response?.data?.message
  if (typeof message === 'string' && REFUSALS.has(message)) return t(`${texts}.errors.${message}`)
  return getErrorMessage(error, t(`${texts}.failed`))
}

/**
 * The button and its confirmation. Renders nothing without `payments:refund`
 * or for a payment that is not a candidate.
 */
export function ProviderRefundAction({
  payment,
  texts,
  size = 'inline',
  onRecorded,
}: {
  readonly payment: ProviderRefundPayment
  readonly texts: ProviderRefundTexts
  /** `inline` beside «Вернуть» in the «Операции» tab; `section` in the payment's details. */
  readonly size?: 'inline' | 'section'
  readonly onRecorded?: (refundedAt: string) => void
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const canRecord = useHasPermission('payments', 'refund')
  const [open, setOpen] = useState(false)

  const record = useMutation({
    mutationFn: async () =>
      (await api.post(`/admin/payments/transactions/${encodeURIComponent(payment.id)}/provider-refund`))
        .data as RecordResult,
    onSuccess: (result) => {
      setOpen(false)
      onRecorded?.(result.refundedAt ?? new Date().toISOString())
      void queryClient.invalidateQueries({ queryKey: adminQueryKeys.payments.all })
      void queryClient.invalidateQueries({ queryKey: ['admin', 'users'] })
      toast.success(result.recorded ? t(`${texts}.recorded`) : t(`${texts}.alreadyRecorded`))
    },
    onError: (error) => toast.error(refusalMessage(error, texts, t)),
  })

  if (!canRecord || !isProviderRefundCandidate(payment)) return null

  const amount = formatPaymentAmount(payment.amount, payment.currency, activeLocale())
  const gateway = gatewayLabel(payment.gatewayType ?? '', t)

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        {size === 'inline' ? (
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive">
            <Undo2 className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
            {t(`${texts}.action`)}
          </Button>
        ) : (
          <Button size="sm" variant="outline">
            <Undo2 className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            {t(`${texts}.action`)}
          </Button>
        )}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t(`${texts}.confirmTitle`)}</AlertDialogTitle>
          <AlertDialogDescription>{t(`${texts}.confirmIntro`, { amount, gateway })}</AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground" data-provider-refund-consequences="">
          <li>
            {payment.purchaseType === 'NEW' ? t(`${texts}.consequenceNew`) : t(`${texts}.consequenceOther`)}
          </li>
          <li>{t(`${texts}.consequenceAutopay`)}</li>
          <li>{t(`${texts}.consequenceMoney`)}</li>
        </ul>
        <p className="text-sm text-muted-foreground">{t(`${texts}.confirmAfter`)}</p>
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
            {record.isPending ? t(`${texts}.submitting`) : t(`${texts}.confirm`)}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/**
 * The section in the payment's details («Платежи» → «Транзакции» → the
 * payment): what the button is for, the button, and once pressed, when.
 */
export function ProviderRefundSection({ transaction }: { readonly transaction: TransactionRow }) {
  const { t } = useTranslation()
  const canRecord = useHasPermission('payments', 'refund')
  // The server's answer, kept: the row this sheet shows can be the list's
  // cached copy, which the page does not read again by itself.
  const [recordedAt, setRecordedAt] = useState<string | null>(null)
  const payment: ProviderRefundPayment = {
    id: transaction.id,
    paymentId: transaction.paymentId,
    status: transaction.status,
    gatewayType: transaction.gatewayType,
    purchaseType: transaction.purchaseType,
    amount: transaction.amount,
    currency: transaction.currency,
    conversionWithheld: transaction.conversionWithheld ?? null,
    fulfilledAt: transaction.fulfilledAt ?? null,
    planSnapshot: transaction.planSnapshot,
  }
  if (recordedAt === null && !isProviderRefundCandidate(payment)) return null

  return (
    <>
      <Separator />
      <section aria-labelledby="payment-details-provider-refund" className="space-y-2">
        <h3
          id="payment-details-provider-refund"
          className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
        >
          {t('paymentsPage.providerRefund.title')}
        </h3>
        {recordedAt !== null ? (
          <p className="text-xs">{t('paymentsPage.providerRefund.recordedAt', { time: formatInstant(recordedAt) })}</p>
        ) : (
          <>
            <p className="text-muted-foreground">
              {t('paymentsPage.providerRefund.hint', { gateway: gatewayLabel(transaction.gatewayType, t) })}
            </p>
            {canRecord ? (
              <ProviderRefundAction
                payment={payment}
                texts="paymentsPage.providerRefund"
                size="section"
                onRecorded={setRecordedAt}
              />
            ) : (
              <p className="text-xs text-muted-foreground">{t('paymentsPage.providerRefund.noPermission')}</p>
            )}
          </>
        )}
      </section>
    </>
  )
}

function formatInstant(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(activeLocale())
}
