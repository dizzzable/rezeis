/**
 * One payment, everything an operator is asked about it.
 * ───────────────────────────────────────────────────────
 * Opened from a row of the Payments list, from a webhook event, from Cmd+K and
 * from the user card — all of them through the `?payment=` key of the address
 * bar, so every one of those is also a link that can be pasted.
 *
 * ── Three ids, and which is which ─────────────────────────────────────────
 *
 * `paymentId` is OURS: the reference sent to the gateway as the order number.
 * `gatewayId` is the PAYMENT SYSTEM'S own id — the one its support asks for,
 * and until this sheet the one id the panel received and showed nowhere.
 * `id` is the database row. Each is shown in full, labelled, and copyable.
 *
 * ── Finding the payment a link names ───────────────────────────────────────
 *
 * A reference is looked up through the list endpoint's `q`, which matches all
 * three ids exactly. Our `paymentId` and the row `id` are unique; a gateway id
 * is unique only within its gateway, so two payment systems can in principle
 * hand out the same one. That case is said out loud and handed to the list,
 * rather than resolved by picking whichever row came back first.
 */
import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { Receipt, User } from 'lucide-react'

import { api } from '@/lib/api'
import { expectArray } from '@/lib/api-utils'
import { adminQueryKeys } from '@/lib/admin-query-keys'
import { getErrorMessage } from '@/lib/http-errors'
import { activeLocale } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CopyableId } from '@/components/ui/copyable-id'
import { Separator } from '@/components/ui/separator'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { useHasPermission } from '@/features/rbac'
import { PermissionRequiredNotice } from './permission-required-notice'
import { paymentsRoutePermissions, useRouteAccess } from './payments-route-permissions'
import { WebhookReplayControl } from './webhook-replay-control'
import { clientPaymentsHref, subscriptionPaymentsHref } from './payments-filters'
import {
  describeDelivery,
  gatewayLabel,
  formatPaymentAmount,
  importSourceName,
  mergeEvents,
  readTransactionsList,
  resolvePayment,
  statusVariant,
  type PaymentResolution,
  type TransactionRow,
  type TransactionsList,
  type WebhookEventRow,
} from './payment-records'

const LOOKUP_LIMIT = '10'

export interface PaymentDetailsSheetProps {
  /** The payment to show — a paymentId, gatewayId or record id — or `null` for closed. */
  readonly reference: string | null
  /** The row, when the list on screen already holds it; saves a round trip. */
  readonly seed?: TransactionRow
  readonly onClose: () => void
  /** Narrows the list to every payment carrying `reference` (the ambiguous case). */
  readonly onShowMatches: (reference: string) => void
}

export function PaymentDetailsSheet({ reference, seed, onClose, onShowMatches }: PaymentDetailsSheetProps) {
  const { t } = useTranslation()
  const open = reference !== null
  const lookupParams = new URLSearchParams({ q: reference ?? '', limit: LOOKUP_LIMIT }).toString()

  const lookup = useQuery<TransactionsList>({
    queryKey: adminQueryKeys.payments.transactions.list(lookupParams),
    queryFn: async ({ signal }) =>
      readTransactionsList((await api.get(`/admin/payments/transactions?${lookupParams}`, { signal })).data),
    enabled: open && seed === undefined,
  })

  const resolution: PaymentResolution | undefined =
    reference === null
      ? undefined
      : seed !== undefined
        ? { kind: 'found', transaction: seed }
        : lookup.data !== undefined
          ? resolvePayment(lookup.data.items, reference)
          : undefined
  const transaction = resolution?.kind === 'found' ? resolution.transaction : undefined

  return (
    <Sheet open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-lg md:max-w-xl">
        <SheetHeader className="border-b px-6 py-4 text-left">
          <SheetTitle className="flex flex-wrap items-center gap-2 pr-6">
            {t('paymentsPage.details.title')}
            {transaction !== undefined && (
              <Badge variant={statusVariant(transaction.status)}>
                {String(t(`paymentsPage.statuses.${transaction.status}`, transaction.status))}
              </Badge>
            )}
          </SheetTitle>
          <SheetDescription className="break-all font-mono text-xs">
            {transaction !== undefined ? formatAmount(transaction) : (reference ?? '')}
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          {reference === null ? null : transaction !== undefined ? (
            <PaymentDetailsBody transaction={transaction} />
          ) : lookup.isError ? (
            <div role="alert" className="space-y-1 text-sm">
              <p className="font-medium">{t('paymentsPage.details.loadFailed')}</p>
              <p className="break-words text-muted-foreground">
                {getErrorMessage(lookup.error, t('paymentsPage.details.loadFailed'))}
              </p>
            </div>
          ) : resolution === undefined ? (
            <div className="space-y-3" aria-busy="true" aria-label={t('paymentsPage.details.loading')}>
              <Skeleton className="h-6 w-2/3" />
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          ) : resolution.kind === 'ambiguous' ? (
            <div className="space-y-3 text-sm">
              <p className="font-medium">{t('paymentsPage.details.ambiguous', { count: resolution.count })}</p>
              <p className="text-muted-foreground">{t('paymentsPage.details.ambiguousHint')}</p>
              <Button size="sm" variant="outline" onClick={() => onShowMatches(reference)}>
                {t('paymentsPage.details.showMatches')}
              </Button>
            </div>
          ) : (
            <div className="space-y-2 text-sm">
              <p className="font-medium">{t('paymentsPage.details.notFound')}</p>
              <p className="text-muted-foreground">{t('paymentsPage.details.notFoundHint')}</p>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function PaymentDetailsBody({ transaction }: { readonly transaction: TransactionRow }) {
  const { t } = useTranslation()
  const canOpenClient = useHasPermission('users', 'view')
  const plan = readPlanSnapshot(transaction.planSnapshot)
  const lineItems = transaction.lineItemSubscriptionIds ?? []
  const clientName =
    [transaction.userName, transaction.userUsername ? `@${transaction.userUsername}` : null]
      .filter((part): part is string => typeof part === 'string' && part.length > 0)
      .join(' · ') || t('paymentsPage.details.clientUnnamed')

  return (
    <div className="space-y-5 text-sm">
      <section aria-labelledby="payment-details-ids" className="space-y-3">
        <h3 id="payment-details-ids" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t('paymentsPage.details.idsTitle')}
        </h3>
        <IdLine
          label={t('paymentsPage.details.paymentId')}
          hint={t('paymentsPage.details.paymentIdHint')}
          value={transaction.paymentId}
        />
        <IdLine
          label={t('paymentsPage.details.gatewayId')}
          hint={t('paymentsPage.details.gatewayIdHint')}
          value={transaction.gatewayId}
          empty={t('paymentsPage.details.gatewayIdMissing')}
        />
        <IdLine
          label={t('paymentsPage.details.recordId')}
          hint={t('paymentsPage.details.recordIdHint')}
          value={transaction.id}
        />
      </section>

      <Separator />

      <section aria-labelledby="payment-details-summary" className="space-y-2">
        <h3 id="payment-details-summary" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t('paymentsPage.details.summaryTitle')}
        </h3>
        <dl className="grid grid-cols-[minmax(0,10rem)_1fr] gap-x-3 gap-y-1.5">
          <Fact term={t('paymentsPage.details.amount')}>{formatAmount(transaction)}</Fact>
          <Fact term={t('paymentsPage.details.gateway')}>{gatewayLabel(transaction.gatewayType, t)}</Fact>
          <Fact term={t('paymentsPage.details.purchaseType')}>
            {t(`paymentsPage.purchaseTypes.${transaction.purchaseType}`, { defaultValue: transaction.purchaseType })}
          </Fact>
          {transaction.channel ? (
            <Fact term={t('paymentsPage.details.channel')}>
              {t(`paymentsPage.details.channels.${transaction.channel}`, { defaultValue: transaction.channel })}
            </Fact>
          ) : null}
          <Fact term={t('paymentsPage.details.createdAt')}>{formatInstant(transaction.createdAt)}</Fact>
          {transaction.updatedAt ? (
            <Fact term={t('paymentsPage.details.updatedAt')}>{formatInstant(transaction.updatedAt)}</Fact>
          ) : null}
          <Fact term={t('paymentsPage.details.fulfilledAt')}>
            <DeliveryText transaction={transaction} />
          </Fact>
        </dl>
      </section>

      <Separator />

      <section aria-labelledby="payment-details-plan" className="space-y-2">
        <h3 id="payment-details-plan" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t('paymentsPage.details.planTitle')}
        </h3>
        {plan === null ? (
          <p className="text-muted-foreground">{t('paymentsPage.details.planEmpty')}</p>
        ) : (
          <>
            <dl className="grid grid-cols-[minmax(0,10rem)_1fr] gap-x-3 gap-y-1.5">
              <Fact term={t('paymentsPage.details.planName')}>{plan.name ?? '—'}</Fact>
              {plan.days !== null ? (
                <Fact term={t('paymentsPage.details.planTerm')}>
                  {t('paymentsPage.details.planDays', { count: plan.days })}
                </Fact>
              ) : null}
            </dl>
            <details className="rounded-md border px-3 py-2">
              <summary className="cursor-pointer text-xs text-muted-foreground">
                {t('paymentsPage.details.planRaw')}
              </summary>
              <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px]">
                {JSON.stringify(transaction.planSnapshot, null, 2)}
              </pre>
            </details>
          </>
        )}
      </section>

      <Separator />

      <section aria-labelledby="payment-details-client" className="space-y-2">
        <h3 id="payment-details-client" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t('paymentsPage.details.clientTitle')}
        </h3>
        <p className="font-medium">{clientName}</p>
        <dl className="grid grid-cols-[minmax(0,10rem)_1fr] gap-x-3 gap-y-1.5">
          <Fact term={t('paymentsPage.details.clientId')}>
            <CopyableId value={transaction.userId} label={t('paymentsPage.details.clientId')} />
          </Fact>
          {transaction.userTelegramId ? (
            <Fact term={t('paymentsPage.details.clientTelegram')}>
              <CopyableId value={transaction.userTelegramId} label={t('paymentsPage.details.clientTelegram')} />
            </Fact>
          ) : null}
          {transaction.userEmail ? (
            <Fact term={t('paymentsPage.details.clientEmail')}>
              <span className="break-all">{transaction.userEmail}</span>
            </Fact>
          ) : null}
        </dl>
        <div className="flex flex-wrap gap-2 pt-1">
          {canOpenClient ? (
            <Button asChild size="sm" variant="outline">
              <Link to={`/users/${encodeURIComponent(transaction.userId)}`}>
                <User className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                {t('paymentsPage.details.openClient')}
              </Link>
            </Button>
          ) : null}
          <Button asChild size="sm" variant="outline">
            <Link to={clientPaymentsHref(transaction.userId)}>
              <Receipt className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              {t('paymentsPage.details.clientPayments')}
            </Link>
          </Button>
        </div>
      </section>

      <Separator />

      <section aria-labelledby="payment-details-subscription" className="space-y-2">
        <h3
          id="payment-details-subscription"
          className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
        >
          {t('paymentsPage.details.subscriptionTitle')}
        </h3>
        {transaction.subscriptionId ? (
          <SubscriptionLine subscriptionId={transaction.subscriptionId} />
        ) : lineItems.length > 0 ? (
          <>
            <p className="text-muted-foreground">
              {t('paymentsPage.details.combinedRenewal', { count: lineItems.length })}
            </p>
            {lineItems.map((subscriptionId) => (
              <SubscriptionLine key={subscriptionId} subscriptionId={subscriptionId} />
            ))}
          </>
        ) : (
          <p className="text-muted-foreground">{t('paymentsPage.details.subscriptionNone')}</p>
        )}
        {canOpenClient && (transaction.subscriptionId || lineItems.length > 0) ? (
          <p className="text-xs text-muted-foreground">{t('paymentsPage.details.subscriptionInCard')}</p>
        ) : null}
      </section>

      <Separator />

      <PaymentWebhookEvents transaction={transaction} />
    </div>
  )
}

function IdLine({
  label,
  hint,
  value,
  empty,
}: {
  readonly label: string
  readonly hint: string
  readonly value: string | null | undefined
  readonly empty?: string
}) {
  return (
    <div className="space-y-0.5">
      <p className="text-xs font-medium">{label}</p>
      <CopyableId value={value} label={label} empty={empty} className="text-xs" />
      <p className="text-[11px] text-muted-foreground">{hint}</p>
    </div>
  )
}

function Fact({ term, children }: { readonly term: string; readonly children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{term}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  )
}

function SubscriptionLine({ subscriptionId }: { readonly subscriptionId: string }) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <CopyableId value={subscriptionId} label={t('paymentsPage.details.subscriptionId')} className="text-xs" />
      <Button asChild size="sm" variant="ghost" className="h-7 px-2 text-xs">
        <Link to={subscriptionPaymentsHref(subscriptionId)}>
          <Receipt className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
          {t('paymentsPage.details.subscriptionPayments')}
        </Link>
      </Button>
    </div>
  )
}

/**
 * The webhooks this payment received.
 *
 * Asked for by BOTH references a notification can carry: nearly every gateway
 * names our `paymentId`, but a YooKassa refund notice names the gateway's own
 * payment id (`payment-webhook-normalizer.service.ts`, `isYookassaRefundEvent`).
 * A gateway id is unique only within its gateway, so what that second query
 * returns is kept only for this payment's gateway.
 *
 * Guarded by `payment_webhooks:view`, which the list route demands and
 * `payments:view` does not include: without it nothing is requested and the
 * refusal says so, the rule the Webhooks tab already follows.
 */
function PaymentWebhookEvents({ transaction }: { readonly transaction: TransactionRow }) {
  const { t } = useTranslation()
  const canList = useRouteAccess(paymentsRoutePermissions.webhookEvents)
  const gatewayId = transaction.gatewayId ?? null

  const events = useQuery<ReadonlyArray<WebhookEventRow>>({
    queryKey: [...adminQueryKeys.payments.webhooks.all, 'payment', transaction.paymentId, gatewayId],
    queryFn: async ({ signal }) => {
      const fetchFor = async (paymentReference: string): Promise<WebhookEventRow[]> => {
        const params = new URLSearchParams({ paymentId: paymentReference, limit: '50' })
        return expectArray<WebhookEventRow>(
          (await api.get(`/admin/payments/webhooks/events?${params.toString()}`, { signal })).data,
        )
      }
      const [byPaymentId, byGatewayId] = await Promise.all([
        fetchFor(transaction.paymentId),
        gatewayId !== null && gatewayId !== transaction.paymentId ? fetchFor(gatewayId) : Promise.resolve([]),
      ])
      return mergeEvents(
        byPaymentId,
        byGatewayId.filter((event) => event.gatewayType === transaction.gatewayType),
      )
    },
    enabled: canList,
  })

  return (
    <section aria-labelledby="payment-details-webhooks" className="space-y-2">
      <h3 id="payment-details-webhooks" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {t('paymentsPage.details.webhooksTitle')}
      </h3>
      {!canList ? (
        <PermissionRequiredNotice
          permission={paymentsRoutePermissions.webhookEvents}
          title={t('paymentsAccess.webhookEvents.title')}
          description={t('paymentsPage.details.webhooksRestricted')}
        />
      ) : events.isLoading ? (
        <Skeleton className="h-16 w-full" />
      ) : events.isError || events.data === undefined ? (
        <p className="text-muted-foreground">{t('paymentsPage.details.webhooksFailed')}</p>
      ) : events.data.length === 0 ? (
        <p className="text-muted-foreground">{t('paymentsPage.details.webhooksEmpty')}</p>
      ) : (
        <ul className="space-y-2">
          {events.data.map((event) => (
            <li key={event.id} className="space-y-1 rounded-md border p-2.5 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge variant={event.status === 'FAILED' ? 'destructive' : 'outline'}>
                    {t(`paymentsReconciliation.events.${event.status}`, { defaultValue: event.status })}
                  </Badge>
                  {event.eventStatus ? <span className="font-mono">{event.eventStatus}</span> : null}
                  {event.gatewayType !== transaction.gatewayType ? (
                    <span className="text-muted-foreground">{gatewayLabel(event.gatewayType, t)}</span>
                  ) : null}
                </div>
                <WebhookReplayControl event={event} />
              </div>
              <p className="text-muted-foreground">
                {t('paymentsPage.details.webhookReceived', { time: formatInstant(event.receivedAt) })}
                {event.processedAt
                  ? ` · ${t('paymentsPage.details.webhookProcessed', { time: formatInstant(event.processedAt) })}`
                  : ''}
              </p>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-muted-foreground">{t('paymentsPage.details.webhookProviderEvent')}</span>
                <CopyableId
                  value={event.providerEventId}
                  label={t('paymentsPage.details.webhookProviderEvent')}
                  maxLength={24}
                />
              </div>
              {event.lastError ? (
                <p className="break-words text-destructive">
                  {t('paymentsPage.details.webhookLastError', { message: event.lastError })}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function formatAmount(transaction: TransactionRow): string {
  const amount = formatPaymentAmount(transaction.amount, transaction.currency, activeLocale())
  return transaction.paymentAsset ? `${amount} (${transaction.paymentAsset})` : amount
}

function DeliveryText({ transaction }: { readonly transaction: TransactionRow }) {
  const { t } = useTranslation()
  const delivery = describeDelivery(transaction)
  switch (delivery.kind) {
    case 'delivered':
      return <>{formatInstant(delivery.at)}</>
    case 'notDelivered':
      return <span className="text-muted-foreground">{t('paymentsPage.details.delivery.notDelivered')}</span>
    case 'noStampImported':
      return (
        <span className="text-muted-foreground">
          {t('paymentsPage.details.delivery.noStampImported', { source: importSourceName(delivery.source) })}
        </span>
      )
    case 'awaitingPayment':
      return <span className="text-muted-foreground">{t('paymentsPage.details.delivery.awaitingPayment')}</span>
    case 'noStamp':
      return <span className="text-muted-foreground">{t('paymentsPage.details.delivery.noStamp')}</span>
  }
}

function formatInstant(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(activeLocale())
}

interface PlanFacts {
  readonly name: string | null
  readonly days: number | null
}

/**
 * The two facts worth a line of their own from a plan snapshot. The snapshot
 * is whatever the checkout that wrote it recorded — a plan purchase, an add-on
 * receipt — so it is read defensively and shown in full underneath.
 */
function readPlanSnapshot(snapshot: unknown): PlanFacts | null {
  if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) return null
  const record = snapshot as Record<string, unknown>
  if (Object.keys(record).length === 0) return null
  const name = [record['name'], record['receiptName']].find(
    (value): value is string => typeof value === 'string' && value.length > 0,
  )
  const days = [record['selectedDurationDays'], record['durationDays']].find(
    (value): value is number => typeof value === 'number' && Number.isFinite(value),
  )
  return { name: name ?? null, days: days ?? null }
}
