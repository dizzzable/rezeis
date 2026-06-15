import { lazy, Suspense, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
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
}

export default function PaymentsPage() {
  const { t } = useTranslation()
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

      <Tabs defaultValue="transactions">
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
                    <TableCell className="font-mono text-xs">{tx.paymentId?.slice(0, 8)}…</TableCell>
                    <TableCell className="text-xs">
                      <div>{tx.userUsername ? `@${tx.userUsername}` : tx.userName ?? '—'}</div>
                      <div className="text-muted-foreground">{tx.userTelegramId ?? tx.userId?.slice(0, 8)}</div>
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
  const { data, isLoading } = useQuery<ReadonlyArray<WebhookEventRow>>({
    queryKey: adminQueryKeys.payments.webhooks.all,
    queryFn: async ({ signal }) =>
      (await api.get<ReadonlyArray<WebhookEventRow>>('/admin/payments/webhooks/events?limit=30', { signal })).data,
  })

  if (isLoading) return <Skeleton className="h-48 w-full mt-4" />

  return (
    <Card className="mt-4">
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('paymentsPage.webhooks.gateway')}</TableHead>
              <TableHead>{t('paymentsPage.webhooks.providerEvent')}</TableHead>
              <TableHead>{t('paymentsPage.webhooks.status')}</TableHead>
              <TableHead>{t('paymentsPage.webhooks.date')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(data ?? []).map((ev) => (
              <TableRow key={ev.id}>
                <TableCell className="text-xs uppercase">{ev.gatewayType}</TableCell>
                <TableCell className="font-mono text-xs">{ev.providerEventId?.slice(0, 16)}…</TableCell>
                <TableCell><Badge variant="outline">{ev.status}</Badge></TableCell>
                <TableCell className="text-xs text-muted-foreground">{new Date(ev.receivedAt).toLocaleString()}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}
