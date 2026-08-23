import { lazy, Suspense, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { truncate } from '@/lib/utils'
import { expectArray } from '@/lib/api-utils'
import { adminQueryKeys } from '@/lib/admin-query-keys'
import { Card, CardContent } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Skeleton } from '@/components/ui/skeleton'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { DatePicker } from '@/components/ui/date-picker'
import { PermissionGate } from '@/features/rbac'
import { useTabSync } from '@/lib/use-tab-sync'
import { ReconciliationHealthCard } from './reconciliation-health-card'
import { WebhookReplayControl } from './webhook-replay-control'
import { PermissionRequiredNotice } from './permission-required-notice'
import { paymentsRoutePermissions, useRouteAccess } from './payments-route-permissions'

const PaymentsAnalyticsTab = lazy(() => import('./payments-analytics-tab'))

interface TransactionRow {
  readonly id: string
  readonly paymentId: string | null
  readonly userTelegramId?: string | number | bigint | null
  readonly userId?: string | null
  readonly userUsername?: string | null
  readonly userName?: string | null
  readonly status: string
  readonly gatewayType: string
  readonly amount: number | string | null
  readonly currency: string
  readonly planSnapshot?: { readonly name?: string | null } | null
  readonly purchaseType: string
  readonly createdAt: string
}

interface TransactionsList {
  readonly items: ReadonlyArray<TransactionRow>
  readonly total: number
}

interface WebhookEventRow {
  readonly id: string
  readonly gatewayType: string
  readonly providerEventId: string | null
  readonly status: string
  readonly receivedAt: string
  /** Why the last reconciliation attempt gave up; shown before a replay. */
  readonly lastError?: string | null
}

/**
 * Tab values addressable by `#hash`, and the fifth page to join the pattern
 * `useTabSync` already serves for `/admins`, `/audit`, `/partners` and
 * `/settings/panel`.
 *
 * Before this, `Tabs` was uncontrolled (`defaultValue="transactions"`) and
 * nothing read the URL — the same defect `hub-tab-anchors.test.tsx` was written
 * about, where "both hubs shipped with an uncontrolled `<Tabs defaultValue=…>`"
 * and every link into them was decorative. The one artefact that tried was
 * `features/payments/webhooks-page.tsx`, which redirected to
 * `/payments?tab=webhooks`: a query param this page never read, from a
 * component `router.tsx` never routed. It has been deleted rather than wired
 * up — a component whose whole job is to redirect to another spelling of the
 * same page is a second place for this list to go stale.
 *
 * PERMISSION-INDEPENDENT, deliberately. `webhooks` stays addressable for an
 * admin without `payment_webhooks:view`, so the deep link lands on the tab and
 * the tab says which token is missing. Dropping it from this list for such an
 * admin would silently land them on Transactions — "my link was wrong" and "I
 * am not allowed" rendering identically, which is the defect the refusal card
 * inside the tab exists to end.
 *
 * NOT yet in `HUB_TABS` (`components/layout/admin-nav-config.ts`), which is
 * where the other four pages keep their lists: that file is not this change's
 * to edit. Nothing breaks — `useTabSync` takes the array directly and
 * `HUB_TABS` only exists so `deepLinkNavItems` rows can be validated against
 * it, and Payments has no such row. Whoever owns the nav config should add:
 *
 *     '/payments': ['transactions', 'webhooks', 'analytics'],
 *
 * and then this constant becomes `HUB_TABS['/payments']`. Until then a Cmd+K
 * row pointing at `/payments#webhooks` would fail `admin-nav-config.test.ts`
 * with "no HUB_TABS entry for /payments" — a named failure that leads here.
 */
const ALLOWED_TABS = ['transactions', 'webhooks', 'analytics'] as const
type PaymentsTab = (typeof ALLOWED_TABS)[number]

export default function PaymentsPage() {
  const { t } = useTranslation()
  // An unknown or misspelt hash (`#wehbooks`) falls back to `transactions`
  // rather than rendering nothing, and `setTab` navigates with `replace`, so
  // Back leaves the page instead of walking the tabs the operator clicked.
  // Both are `useTabSync`'s behaviour, not this page's.
  const { activeTab, setTab } = useTabSync<PaymentsTab>(ALLOWED_TABS, 'transactions')

  return (
    <PermissionGate
      resource="payments"
      action="view"
      hideWhileLoading
      fallback={<PaymentsAccessDenied />}
    >
      <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t('paymentsPage.title')}</h1>
        <p className="text-muted-foreground">{t('paymentsPage.subtitle')}</p>
      </div>

      <Tabs value={activeTab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="transactions">{t('paymentsPage.tabs.transactions')}</TabsTrigger>
          <TabsTrigger value="webhooks">{t('paymentsPage.tabs.webhooks')}</TabsTrigger>
          <TabsTrigger value="analytics">{t('paymentsPage.tabs.analytics')}</TabsTrigger>
        </TabsList>

        <TabsContent value="transactions"><TransactionsTab /></TabsContent>
        <TabsContent value="webhooks"><WebhooksTab /></TabsContent>
        <TabsContent value="analytics">
          <Suspense fallback={<Skeleton className="h-96 w-full mt-4" />}>
            <PaymentsAnalyticsTab />
          </Suspense>
        </TabsContent>
      </Tabs>
      </div>
    </PermissionGate>
  )
}

function PaymentsAccessDenied() {
  const { t } = useTranslation()
  return (
    <Card>
      <CardContent className="space-y-2 py-8">
        <h1 className="text-2xl font-bold tracking-tight">{t('paymentsPage.accessDeniedTitle')}</h1>
        <p className="text-muted-foreground">{t('paymentsPage.accessDeniedDescription')}</p>
      </CardContent>
    </Card>
  )
}

function TransactionsTab() {
  const { t } = useTranslation()
  const [userSearch, setUserSearch] = useState('')
  const [status, setStatus] = useState('__all__')
  const [gateway, setGateway] = useState('__all__')
  const [purchaseType, setPurchaseType] = useState('__all__')
  const [dateFrom, setDateFrom] = useState<Date | undefined>(undefined)
  const [dateTo, setDateTo] = useState<Date | undefined>(undefined)
  const [page, setPage] = useState(0)
  const limit = 50

  const params = new URLSearchParams()
  params.set('limit', String(limit))
  params.set('offset', String(page * limit))
  if (userSearch.trim()) params.set('userSearch', userSearch.trim())
  if (status !== '__all__') params.set('status', status)
  if (gateway !== '__all__') params.set('gatewayType', gateway)
  if (purchaseType !== '__all__') params.set('purchaseType', purchaseType)
  if (dateFrom) params.set('dateFrom', dateFrom.toISOString())
  if (dateTo) params.set('dateTo', new Date(dateTo.getTime() + 86400000 - 1).toISOString())

  const { data, isLoading } = useQuery<TransactionsList>({
    queryKey: adminQueryKeys.payments.transactions.list(params.toString()),
    queryFn: async ({ signal }) =>
      (await api.get<TransactionsList>(`/admin/payments/transactions?${params.toString()}`, { signal })).data,
    placeholderData: keepPreviousData,
  })

  const statusColor = (
    s: string,
  ): 'success' | 'warning' | 'destructive' | 'secondary' | 'outline' => {
    switch (s) { case 'COMPLETED': return 'success'; case 'PENDING': return 'warning'; case 'FAILED': return 'destructive'; case 'CANCELED': return 'secondary'; default: return 'outline' }
  }

  const items = data?.items ?? []
  const total = data?.total ?? 0
  const totalPages = Math.ceil(total / limit)

  return (
    <div className="space-y-4 mt-4">
      {/* Filters */}
      <Card>
        <CardContent className="pt-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
            <div className="space-y-1">
              <Label htmlFor="payments-filter-user" className="text-xs">{t('paymentsPage.filters.user')}</Label>
              <Input
                id="payments-filter-user"
                placeholder={t('paymentsPage.filters.userPlaceholder')}
                value={userSearch}
                onChange={(e) => { setUserSearch(e.target.value); setPage(0) }}
                className="h-9"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t('paymentsPage.filters.status')}</Label>
              <Select value={status} onValueChange={(v) => { setStatus(v); setPage(0) }}>
                <SelectTrigger className="h-9" aria-label={t('paymentsPage.filters.status')}><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">{t('paymentsPage.filters.all')}</SelectItem>
                  <SelectItem value="COMPLETED">{t('paymentsPage.statuses.COMPLETED')}</SelectItem>
                  <SelectItem value="PENDING">{t('paymentsPage.statuses.PENDING')}</SelectItem>
                  <SelectItem value="FAILED">{t('paymentsPage.statuses.FAILED')}</SelectItem>
                  <SelectItem value="CANCELED">{t('paymentsPage.statuses.CANCELED')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t('paymentsPage.filters.gateway')}</Label>
              <Select value={gateway} onValueChange={(v) => { setGateway(v); setPage(0) }}>
                <SelectTrigger className="h-9" aria-label={t('paymentsPage.filters.gateway')}><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">{t('paymentsPage.filters.all')}</SelectItem>
                  <SelectItem value="TELEGRAM_STARS">Telegram Stars</SelectItem>
                  <SelectItem value="YOOKASSA">YooKassa</SelectItem>
                  <SelectItem value="PLATEGA">Platega</SelectItem>
                  <SelectItem value="HELEKET">Heleket</SelectItem>
                  <SelectItem value="CRYPTOMUS">Cryptomus</SelectItem>
                  <SelectItem value="MULENPAY">Mulenpay</SelectItem>
                  <SelectItem value="ANTILOPAY">Antilopay</SelectItem>
                  <SelectItem value="OVERPAY">Overpay</SelectItem>
                  <SelectItem value="PAYPALYCH">Paypalych</SelectItem>
                  <SelectItem value="RIOPAY">Riopay</SelectItem>
                  <SelectItem value="VALUTIX">Valutix</SelectItem>
                  <SelectItem value="CRYPTOPAY">CryptoPay</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t('paymentsPage.filters.type')}</Label>
              <Select value={purchaseType} onValueChange={(v) => { setPurchaseType(v); setPage(0) }}>
                <SelectTrigger className="h-9" aria-label={t('paymentsPage.filters.type')}><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">{t('paymentsPage.filters.all')}</SelectItem>
                  <SelectItem value="NEW">{t('paymentsPage.purchaseTypes.NEW')}</SelectItem>
                  <SelectItem value="RENEW">{t('paymentsPage.purchaseTypes.RENEW')}</SelectItem>
                  <SelectItem value="UPGRADE">{t('paymentsPage.purchaseTypes.UPGRADE')}</SelectItem>
                  <SelectItem value="ADDITIONAL">{t('paymentsPage.purchaseTypes.ADDITIONAL')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t('paymentsPage.filters.dateFrom')}</Label>
              <DatePicker
                value={dateFrom}
                onChange={(d) => { setDateFrom(d); setPage(0) }}
                placeholder={t('paymentsPage.filters.dateFrom')}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t('paymentsPage.filters.dateTo')}</Label>
              <DatePicker
                value={dateTo}
                onChange={(d) => { setDateTo(d); setPage(0) }}
                placeholder={t('paymentsPage.filters.dateTo')}
              />
            </div>
          </div>
          <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
            <span>{t('paymentsPage.filters.totalResults', { count: total })}</span>
            {(userSearch || status !== '__all__' || gateway !== '__all__' || purchaseType !== '__all__' || dateFrom || dateTo) && (
              <button
                type="button"
                className="text-primary hover:underline"
                onClick={() => { setUserSearch(''); setStatus('__all__'); setGateway('__all__'); setPurchaseType('__all__'); setDateFrom(undefined); setDateTo(undefined); setPage(0) }}
              >
                {t('paymentsPage.filters.reset')}
              </button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Table */}
      {isLoading ? <Skeleton className="h-64 w-full" /> : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('paymentsPage.transactions.paymentId')}</TableHead>
                  <TableHead>{t('paymentsPage.transactions.user')}</TableHead>
                  <TableHead>{t('paymentsPage.transactions.status')}</TableHead>
                  <TableHead>{t('paymentsPage.transactions.gateway')}</TableHead>
                  <TableHead>{t('paymentsPage.transactions.amount')}</TableHead>
                  <TableHead>{t('paymentsPage.transactions.plan')}</TableHead>
                  <TableHead>{t('paymentsPage.transactions.type')}</TableHead>
                  <TableHead>{t('paymentsPage.transactions.date')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                      {t('paymentsPage.transactions.empty')}
                    </TableCell>
                  </TableRow>
                ) : items.map((tx) => (
                  <TableRow key={tx.id}>
                    <TableCell className="font-mono text-xs">{truncate(tx.paymentId, 8)}</TableCell>
                    <TableCell className="text-xs">
                      <div>{tx.userUsername ? `@${tx.userUsername}` : tx.userName ?? '—'}</div>
                      {/* A transaction can carry neither identity (a gateway
                          row imported before the customer was linked), and the
                          bare optional chain rendered that as a blank cell —
                          indistinguishable from a rendering bug. */}
                      <div className="text-muted-foreground">{tx.userTelegramId ?? truncate(tx.userId, 8)}</div>
                    </TableCell>
                    <TableCell><Badge variant={statusColor(tx.status)}>{String(t(`paymentsPage.statuses.${tx.status}`, tx.status))}</Badge></TableCell>
                    <TableCell className="text-xs uppercase">{tx.gatewayType}</TableCell>
                    <TableCell className="font-mono text-sm">{tx.amount ?? '—'} {tx.currency}</TableCell>
                    <TableCell className="text-xs">{tx.planSnapshot?.name ?? '—'}</TableCell>
                    <TableCell><Badge variant="outline" className="text-xs">{tx.purchaseType}</Badge></TableCell>
                    <TableCell className="text-xs text-muted-foreground">{new Date(tx.createdAt).toLocaleString()}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between border-t px-4 py-3">
              <button
                type="button"
                disabled={page === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                className="text-sm text-primary disabled:opacity-40"
              >
                ← {t('paymentsPage.pagination.prev')}
              </button>
              <span className="text-xs text-muted-foreground">
                {t('paymentsPage.pagination.page', { current: page + 1, total: totalPages })}
              </span>
              <button
                type="button"
                disabled={page >= totalPages - 1}
                onClick={() => setPage((p) => p + 1)}
                className="text-sm text-primary disabled:opacity-40"
              >
                {t('paymentsPage.pagination.next')} →
              </button>
            </div>
          )}
        </Card>
      )}
    </div>
  )
}

function WebhooksTab() {
  const { t } = useTranslation()
  // The tab renders behind the page's `payments:view` gate, but the list route
  // is guarded by `payment_webhooks:view`
  // (admin-payment-webhooks.controller.ts:30). Holding only the first got the
  // operator through to a table whose body was empty because the request 403'd
  // — indistinguishable from an inbox with nothing in it.
  const canListEvents = useRouteAccess(paymentsRoutePermissions.webhookEvents)

  const { data, isLoading, isError } = useQuery<ReadonlyArray<WebhookEventRow>>({
    queryKey: adminQueryKeys.payments.webhooks.all,
    queryFn: async ({ signal }) =>
      expectArray<WebhookEventRow>(
        (await api.get('/admin/payments/webhooks/events?limit=30', { signal })).data,
      ),
    enabled: canListEvents,
  })

  const events = data ?? []
  // Three outcomes, three sentences. The permission refusal is handled above;
  // down here a request that WENT OUT either came back with rows, came back
  // empty, or did not come back. Collapsing the last two is the convention
  // `array-endpoint-unavailable.test.tsx` exists to enforce, and the
  // empty-state row added below would otherwise have made it worse: before it,
  // a failed load drew a bare header; with it, a failed load would state
  // outright that no webhooks arrived.
  const unavailable = isError || data === undefined

  return (
    <div className="mt-4 space-y-4">
      {/* Aggregate health of the very rows listed below: what came in, and
          whether any of it is stuck unapplied. Served by
          `/admin/payments/reconciliation/health`, which needs `payments:view`
          — so it survives when the per-event list below does not, and the
          refusal below explains that split rather than leaving the operator to
          reconcile a populated card with an absent table. */}
      <ReconciliationHealthCard />
      {!canListEvents ? (
        <PermissionRequiredNotice
          permission={paymentsRoutePermissions.webhookEvents}
          title={t('paymentsAccess.webhookEvents.title')}
          description={t('paymentsAccess.webhookEvents.description')}
        />
      ) : isLoading ? (
        <Skeleton className="h-48 w-full" />
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('paymentsPage.webhooks.gateway')}</TableHead>
                  <TableHead>{t('paymentsPage.webhooks.providerEvent')}</TableHead>
                  <TableHead>{t('paymentsPage.webhooks.status')}</TableHead>
                  <TableHead>{t('paymentsPage.webhooks.date')}</TableHead>
                  <TableHead className="text-right">
                    {t('paymentsReconciliation.replay.columnActions')}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {unavailable ? (
                  <TableRow>
                    <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                      {t('paymentsReconciliation.events.unavailable')}
                    </TableCell>
                  </TableRow>
                ) : events.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                      {t('paymentsReconciliation.events.empty')}
                    </TableCell>
                  </TableRow>
                ) : events.map((ev) => (
                  <TableRow key={ev.id}>
                    <TableCell className="text-xs uppercase">{ev.gatewayType}</TableCell>
                    <TableCell className="font-mono text-xs">{truncate(ev.providerEventId, 16)}</TableCell>
                    <TableCell><Badge variant="outline">{ev.status}</Badge></TableCell>
                    <TableCell className="text-xs text-muted-foreground">{new Date(ev.receivedAt).toLocaleString()}</TableCell>
                    <TableCell className="text-right">
                      <WebhookReplayControl event={ev} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
