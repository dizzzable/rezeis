/**
 * «Автосписание» on the user card's «Подписки» tab: how the customer's
 * subscriptions renew without them, and the operator's «Отменить
 * автосписание» — without a refund.
 * ─────────────────────────────────────────────────────────────────────────
 * Two kinds. A Platega or RollyPay subscription is charged by the provider on
 * its own schedule: cancelling it asks the provider, after the answer
 * (`POST …/provider-subscriptions/:id/cancel`), and the panel keeps asking
 * every 10 minutes if the provider does not take it. The ЮKassa autopay is
 * the panel's own renewal charging a saved method: «Выключить автосписание
 * ЮKassa» turns it off on every method (`POST …/yookassa/disable`) — the same
 * switch the customer has in the cabinet, theirs to turn back on.
 *
 * Neither gives money back. The customer is told nothing, and the dialogs say
 * what they see in the cabinet, in «Способы оплаты». Reading is
 * `payments:view`; the buttons are `payments:edit`, and the server checks
 * both. The operator's card comes to Telegram once the provider answered
 * (`payment.autopay_stopped_by_operator`).
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { CircleStop, Loader2 } from 'lucide-react'

import { api } from '@/lib/api'
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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { useHasPermission } from '@/features/rbac'
import { formatPaymentAmount, gatewayLabel } from '@/features/payments/payment-records'
import {
  type AutopayProviderSubscription,
  type AutopayYookassaMethod,
  readUserAutopay,
  type UserAutopay,
  userAutopayPath as base,
  userAutopayQueryKey,
} from './user-autopay-api'

export function UserAutopaySection({ userId }: { readonly userId: string }) {
  const { t } = useTranslation()
  const canView = useHasPermission('payments', 'view')
  const canEdit = useHasPermission('payments', 'edit')
  const autopay = useQuery({
    queryKey: userAutopayQueryKey(userId),
    queryFn: async () => readUserAutopay((await api.get(base(userId))).data),
    enabled: canView,
  })

  if (!canView) return null

  return (
    <Card data-user-autopay="">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{t('userDetailPanel.autopay.title')}</CardTitle>
        <CardDescription>{t('userDetailPanel.autopay.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {autopay.isLoading ? (
          <Skeleton className="h-12 w-full" />
        ) : autopay.isError || autopay.data === undefined ? (
          <p className="text-muted-foreground">{t('userDetailPanel.autopay.loadFailed')}</p>
        ) : (
          <AutopayBody userId={userId} autopay={autopay.data} canEdit={canEdit} />
        )}
      </CardContent>
    </Card>
  )
}

function AutopayBody({
  userId,
  autopay,
  canEdit,
}: {
  readonly userId: string
  readonly autopay: UserAutopay
  readonly canEdit: boolean
}) {
  const { t } = useTranslation()
  const withAutopay = autopay.yookassaMethods.filter((method) => method.autopayEnabled)
  const nothing = autopay.providerSubscriptions.length === 0 && autopay.yookassaMethods.length === 0
  if (nothing) {
    return <p className="text-muted-foreground">{t('userDetailPanel.autopay.none')}</p>
  }
  return (
    <>
      {autopay.providerSubscriptions.map((subscription) => (
        <ProviderAutopayRow key={subscription.id} userId={userId} subscription={subscription} canEdit={canEdit} />
      ))}
      {autopay.yookassaMethods.length > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3" data-autopay-yookassa="">
          <div className="min-w-0 space-y-0.5">
            <p className="font-medium">{t('userDetailPanel.autopay.yookassaTitle')}</p>
            <p className="text-xs text-muted-foreground">
              {withAutopay.length > 0
                ? t('userDetailPanel.autopay.yookassaOn', { methods: withAutopay.map((method) => method.title).join(', ') })
                : t('userDetailPanel.autopay.yookassaOff')}
            </p>
          </div>
          {canEdit && withAutopay.length > 0 ? <YookassaDisableAction userId={userId} methods={withAutopay} /> : null}
        </div>
      ) : null}
      {!canEdit ? <p className="text-xs text-muted-foreground">{t('userDetailPanel.autopay.noPermission')}</p> : null}
    </>
  )
}

function ProviderAutopayRow({
  userId,
  subscription,
  canEdit,
}: {
  readonly userId: string
  readonly subscription: AutopayProviderSubscription
  readonly canEdit: boolean
}) {
  const { t } = useTranslation()
  const provider = gatewayLabel(subscription.gatewayType, t)
  const amount = formatPaymentAmount(subscription.amount, subscription.currency, activeLocale())
  const plan = subscription.planName ?? t('userDetailPanel.autopay.planUnnamed')
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3" data-autopay-provider={subscription.id}>
      <div className="min-w-0 space-y-0.5">
        <p className="flex flex-wrap items-center gap-1.5 font-medium">
          {t('userDetailPanel.autopay.providerTitle', { provider, plan })}
          {subscription.status === 'PAST_DUE' ? (
            <Badge variant="warning">{t('userDetailPanel.autopay.pastDue')}</Badge>
          ) : null}
          {subscription.cancelRequestedBy !== null ? (
            <Badge variant="secondary">
              {subscription.cancelRequestedBy === 'REFUND'
                ? t('userDetailPanel.autopay.cancellingByRefund')
                : t('userDetailPanel.autopay.cancelling')}
            </Badge>
          ) : null}
        </p>
        <p className="text-xs text-muted-foreground">
          {subscription.nextChargeAt
            ? t('userDetailPanel.autopay.providerCharge', { amount, date: formatDate(subscription.nextChargeAt) })
            : t('userDetailPanel.autopay.providerAmount', { amount })}
        </p>
      </div>
      {canEdit && subscription.cancelRequestedBy === null ? (
        <ProviderCancelAction userId={userId} subscription={subscription} provider={provider} amount={amount} plan={plan} />
      ) : null}
    </div>
  )
}

function ProviderCancelAction({
  userId,
  subscription,
  provider,
  amount,
  plan,
}: {
  readonly userId: string
  readonly subscription: AutopayProviderSubscription
  readonly provider: string
  readonly amount: string
  readonly plan: string
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const cancel = useMutation({
    mutationFn: async () =>
      (
        await api.post(
          `${base(userId)}/provider-subscriptions/${encodeURIComponent(subscription.id)}/cancel`,
        )
      ).data as { readonly state: 'CANCELLING' | 'ENDED' | 'REFUND_ENDING' },
    onSuccess: (result) => {
      setOpen(false)
      void queryClient.invalidateQueries({ queryKey: userAutopayQueryKey(userId) })
      toast.success(t(`userDetailPanel.autopay.cancelResult.${result.state}`))
    },
    onError: (error) => toast.error(getErrorMessage(error, t('userDetailPanel.autopay.cancelFailed'))),
  })
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button size="sm" variant="outline">
          <CircleStop className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
          {t('userDetailPanel.autopay.cancel')}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('userDetailPanel.autopay.cancelTitle')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('userDetailPanel.autopay.cancelDescription', { provider, amount, plan })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <p className="text-sm text-muted-foreground">{t('userDetailPanel.autopay.cancelCustomer', { provider })}</p>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('common.cancel', { defaultValue: 'Отмена' })}</AlertDialogCancel>
          <AlertDialogAction
            disabled={cancel.isPending}
            onClick={(event) => {
              event.preventDefault()
              cancel.mutate()
            }}
          >
            {cancel.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
            {t('userDetailPanel.autopay.cancelConfirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function YookassaDisableAction({
  userId,
  methods,
}: {
  readonly userId: string
  readonly methods: ReadonlyArray<AutopayYookassaMethod>
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const disable = useMutation({
    mutationFn: async () =>
      (await api.post(`${base(userId)}/yookassa/disable`)).data as { readonly switched: number; readonly pending: number },
    onSuccess: (result) => {
      setOpen(false)
      void queryClient.invalidateQueries({ queryKey: userAutopayQueryKey(userId) })
      toast.success(
        result.pending > 0
          ? t('userDetailPanel.autopay.yookassaDisabledPending')
          : result.switched > 0
            ? t('userDetailPanel.autopay.yookassaDisabled')
            : t('userDetailPanel.autopay.yookassaAlreadyOff'),
      )
    },
    onError: (error) => toast.error(getErrorMessage(error, t('userDetailPanel.autopay.yookassaFailed'))),
  })
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button size="sm" variant="outline">
          <CircleStop className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
          {t('userDetailPanel.autopay.yookassaDisable')}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('userDetailPanel.autopay.yookassaTitleConfirm')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('userDetailPanel.autopay.yookassaDescription', { methods: methods.map((method) => method.title).join(', ') })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <p className="text-sm text-muted-foreground">{t('userDetailPanel.autopay.yookassaCustomer')}</p>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('common.cancel', { defaultValue: 'Отмена' })}</AlertDialogCancel>
          <AlertDialogAction
            disabled={disable.isPending}
            onClick={(event) => {
              event.preventDefault()
              disable.mutate()
            }}
          >
            {disable.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
            {t('userDetailPanel.autopay.yookassaConfirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function formatDate(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString(activeLocale())
}
