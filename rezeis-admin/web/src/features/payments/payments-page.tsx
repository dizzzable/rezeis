import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { useLocation, useNavigate } from 'react-router'
import { PanelRightOpen, X } from 'lucide-react'
import { api } from '@/lib/api'
import { activeLocale, truncate } from '@/lib/utils'
import { expectArray } from '@/lib/api-utils'
import { adminQueryKeys } from '@/lib/admin-query-keys'
import { getErrorMessage } from '@/lib/http-errors'
import { Card, CardContent } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CopyableId } from '@/components/ui/copyable-id'
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
import { PaymentDetailsSheet } from './payment-details-sheet'
import {
  GATEWAY_LABELS,
  PARTNER_BALANCE_GATEWAY,
  formatPaymentAmount,
  gatewayLabel,
  readTransactionsList,
  statusVariant,
  type TransactionsList,
  type WebhookEventRow,
} from './payment-records'
import {
  EMPTY_PAYMENTS_FILTERS,
  OPEN_PAYMENT_PARAM,
  PAYMENT_STATUSES,
  PURCHASE_TYPES,
  dateToDay,
  dayToDate,
  filtersFromSearchParams,
  filtersToApiParams,
  hasActiveFilters,
  pageIndex,
  withFilters,
  type PaymentsFilters,
} from './payments-filters'
import { lazyWithChunkRecovery as lazy } from '@/lib/lazy-chunk'

const PaymentsAnalyticsTab = lazy(() => import('./payments-analytics-tab'))

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

const PAGE_SIZE = 50
/** How long the search boxes wait for typing to stop before they search. */
const SEARCH_DEBOUNCE_MS = 350

/**
 * Every gateway a payment can carry. The picker used to list twelve of the
 * eighteen: a WATA, AuraPay, RollyPay, SeverPay, Lava.top or partner-balance
 * payment could not be filtered to at all.
 */
const GATEWAY_FILTER_VALUES: readonly string[] = [...Object.keys(GATEWAY_LABELS), PARTNER_BALANCE_GATEWAY]

/** Characters an id keeps in a table cell; the rest is behind its reveal. */
const ID_CELL_LENGTH = 14

/**
 * Whether the operator has text selected. A click that ends a drag-to-select
 * inside a row is someone copying a value by hand, not asking to open it.
 */
function hasTextSelection(): boolean {
  const selection = window.getSelection()
  return selection !== null && !selection.isCollapsed && selection.toString().trim() !== ''
}

/** The select's stand-in for "no filter": Radix refuses an empty item value. */
const ALL = '__all__'

/**
 * The address bar as this page's state.
 *
 * Writes keep the path and the `#tab` hash — `setSearchParams` would drop the
 * hash and throw the operator off the Webhooks tab — and replace the entry, so
 * Back leaves the page instead of replaying every keystroke. Each write starts
 * from the NEWEST address, not the one the caller rendered with: a debounced
 * search that lands after a status change must not put the old status back.
 */
function usePaymentsAddress() {
  const location = useLocation()
  const navigate = useNavigate()
  const searchParams = useMemo(() => new URLSearchParams(location.search), [location.search])
  const latest = useRef(location)
  useEffect(() => {
    latest.current = location
  }, [location])

  const update = useCallback(
    (mutate: (current: URLSearchParams) => URLSearchParams) => {
      const current = latest.current
      const next = mutate(new URLSearchParams(current.search)).toString()
      const search = next === '' ? '' : `?${next}`
      // Two writes in one tick must compose, not race.
      latest.current = { ...current, search }
      navigate({ pathname: current.pathname, search, hash: current.hash }, { replace: true })
    },
    [navigate],
  )

  return { searchParams, update }
}

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

      <PaymentsWorkspace activeTab={activeTab} setTab={setTab} />
      </div>
    </PermissionGate>
  )
}

/**
 * Everything behind the `payments:view` gate. Split out of the page so that
 * nothing here — the list, the details lookup — runs for an operator the gate
 * turned away.
 */
function PaymentsWorkspace({
  activeTab,
  setTab,
}: {
  readonly activeTab: PaymentsTab
  readonly setTab: (value: string) => void
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { searchParams, update } = usePaymentsAddress()
  const filters = useMemo(() => filtersFromSearchParams(searchParams), [searchParams])
  const openReference = searchParams.get(OPEN_PAYMENT_PARAM)

  const setFilters = useCallback(
    (patch: Partial<PaymentsFilters>) =>
      update((current) => withFilters(current, { ...filtersFromSearchParams(current), ...patch })),
    [update],
  )
  const openPayment = useCallback(
    (reference: string) =>
      update((current) => {
        current.set(OPEN_PAYMENT_PARAM, reference)
        return current
      }),
    [update],
  )
  const closePayment = useCallback(
    () =>
      update((current) => {
        current.delete(OPEN_PAYMENT_PARAM)
        return current
      }),
    [update],
  )
  const showMatches = useCallback(
    (reference: string) =>
      update(() => withFilters(new URLSearchParams(), { ...EMPTY_PAYMENTS_FILTERS, q: reference })),
    [update],
  )

  // The row the operator clicked is already in the cache of the list they
  // clicked it in; the sheet starts from it instead of asking again.
  const listKey = adminQueryKeys.payments.transactions.list(
    filtersToApiParams(filters, PAGE_SIZE).toString(),
  )
  const seed =
    openReference === null
      ? undefined
      : queryClient
          .getQueryData<TransactionsList>(listKey)
          ?.items.find((item) => item.paymentId === openReference || item.id === openReference)

  return (
    <>
      <Tabs value={activeTab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="transactions">{t('paymentsPage.tabs.transactions')}</TabsTrigger>
          <TabsTrigger value="webhooks">{t('paymentsPage.tabs.webhooks')}</TabsTrigger>
          <TabsTrigger value="analytics">{t('paymentsPage.tabs.analytics')}</TabsTrigger>
        </TabsList>

        <TabsContent value="transactions">
          <TransactionsTab filters={filters} setFilters={setFilters} onOpenPayment={openPayment} />
        </TabsContent>
        <TabsContent value="webhooks">
          <WebhooksTab onOpenPayment={openPayment} />
        </TabsContent>
        <TabsContent value="analytics">
          <Suspense fallback={<Skeleton className="h-96 w-full mt-4" />}>
            <PaymentsAnalyticsTab />
          </Suspense>
        </TabsContent>
      </Tabs>

      <PaymentDetailsSheet
        reference={openReference}
        seed={seed}
        onClose={closePayment}
        onShowMatches={showMatches}
      />
    </>
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

/**
 * A search box whose value lives in the address bar.
 *
 * Typing is local; it reaches the URL once the operator pauses (or presses
 * Enter). When the URL changes under it — a Cmd+K jump, a link, "reset" — the
 * box follows, so what it shows is always what the list is filtered by.
 */
function AddressSearchInput({
  id,
  value,
  placeholder,
  onCommit,
}: {
  readonly id: string
  readonly value: string
  readonly placeholder: string
  readonly onCommit: (value: string) => void
}) {
  const [draft, setDraft] = useState(value)
  const [committed, setCommitted] = useState(value)
  if (value !== committed) {
    setCommitted(value)
    setDraft(value)
  }

  useEffect(() => {
    if (draft.trim() === value) return
    const handle = window.setTimeout(() => onCommit(draft.trim()), SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(handle)
  }, [draft, value, onCommit])

  return (
    <Input
      id={id}
      value={draft}
      placeholder={placeholder}
      className="h-9"
      autoComplete="off"
      spellCheck={false}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') onCommit(draft.trim())
      }}
    />
  )
}

function TransactionsTab({
  filters,
  setFilters,
  onOpenPayment,
}: {
  readonly filters: PaymentsFilters
  readonly setFilters: (patch: Partial<PaymentsFilters>) => void
  readonly onOpenPayment: (reference: string) => void
}) {
  const { t } = useTranslation()
  const apiParams = filtersToApiParams(filters, PAGE_SIZE)

  const { data, isLoading, isError, error } = useQuery<TransactionsList>({
    queryKey: adminQueryKeys.payments.transactions.list(apiParams.toString()),
    queryFn: async ({ signal }) =>
      readTransactionsList(
        (await api.get(`/admin/payments/transactions?${apiParams.toString()}`, { signal })).data,
      ),
    placeholderData: keepPreviousData,
  })

  const commitSearch = useCallback((q: string) => setFilters({ q, page: '' }), [setFilters])
  const commitUserSearch = useCallback(
    (userSearch: string) => setFilters({ userSearch, page: '' }),
    [setFilters],
  )

  const items = isError ? [] : (data?.items ?? [])
  const total = isError ? 0 : (data?.total ?? 0)
  const page = pageIndex(filters)
  const currentPage = Number.isNaN(page) ? 0 : page
  const totalPages = Math.ceil(total / PAGE_SIZE)

  return (
    <div className="space-y-4 mt-4">
      {/* Filters */}
      <Card>
        <CardContent className="pt-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
            <div className="space-y-1 lg:col-span-2 xl:col-span-1">
              <Label htmlFor="payments-filter-reference" className="text-xs">{t('paymentsPage.filters.search')}</Label>
              <AddressSearchInput
                id="payments-filter-reference"
                value={filters.q}
                placeholder={t('paymentsPage.filters.searchPlaceholder')}
                onCommit={commitSearch}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="payments-filter-user" className="text-xs">{t('paymentsPage.filters.user')}</Label>
              <AddressSearchInput
                id="payments-filter-user"
                value={filters.userSearch}
                placeholder={t('paymentsPage.filters.userPlaceholder')}
                onCommit={commitUserSearch}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t('paymentsPage.filters.status')}</Label>
              <Select value={filters.status || ALL} onValueChange={(v) => setFilters({ status: v === ALL ? '' : v, page: '' })}>
                <SelectTrigger className="h-9" aria-label={t('paymentsPage.filters.status')}><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>{t('paymentsPage.filters.all')}</SelectItem>
                  {PAYMENT_STATUSES.map((status) => (
                    <SelectItem key={status} value={status}>{t(`paymentsPage.statuses.${status}`)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t('paymentsPage.filters.gateway')}</Label>
              <Select value={filters.gatewayType || ALL} onValueChange={(v) => setFilters({ gatewayType: v === ALL ? '' : v, page: '' })}>
                <SelectTrigger className="h-9" aria-label={t('paymentsPage.filters.gateway')}><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>{t('paymentsPage.filters.all')}</SelectItem>
                  {GATEWAY_FILTER_VALUES.map((gateway) => (
                    <SelectItem key={gateway} value={gateway}>{gatewayLabel(gateway, t)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t('paymentsPage.filters.type')}</Label>
              <Select value={filters.purchaseType || ALL} onValueChange={(v) => setFilters({ purchaseType: v === ALL ? '' : v, page: '' })}>
                <SelectTrigger className="h-9" aria-label={t('paymentsPage.filters.type')}><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>{t('paymentsPage.filters.all')}</SelectItem>
                  {PURCHASE_TYPES.map((type) => (
                    <SelectItem key={type} value={type}>{t(`paymentsPage.purchaseTypes.${type}`)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t('paymentsPage.filters.dateFrom')}</Label>
              <DatePicker
                value={dayToDate(filters.dateFrom)}
                onChange={(d) => setFilters({ dateFrom: d ? dateToDay(d) : '', page: '' })}
                placeholder={t('paymentsPage.filters.dateFrom')}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t('paymentsPage.filters.dateTo')}</Label>
              <DatePicker
                value={dayToDate(filters.dateTo)}
                onChange={(d) => setFilters({ dateTo: d ? dateToDay(d) : '', page: '' })}
                placeholder={t('paymentsPage.filters.dateTo')}
              />
            </div>
          </div>
          {(filters.userId !== '' || filters.subscriptionId !== '') && (
            // The two filters a LINK sets and no control on this page can: the
            // user card's «Все платежи клиента», a subscription's payments.
            // Shown so the operator can see why the list is narrow, and undo it.
            <div className="mt-3 flex flex-wrap gap-2">
              {filters.userId !== '' && (
                <LinkedFilterChip
                  label={t('paymentsPage.filters.client')}
                  value={filters.userId}
                  removeLabel={t('paymentsPage.filters.removeClient')}
                  onRemove={() => setFilters({ userId: '', page: '' })}
                />
              )}
              {filters.subscriptionId !== '' && (
                <LinkedFilterChip
                  label={t('paymentsPage.filters.subscription')}
                  value={filters.subscriptionId}
                  removeLabel={t('paymentsPage.filters.removeSubscription')}
                  onRemove={() => setFilters({ subscriptionId: '', page: '' })}
                />
              )}
            </div>
          )}
          <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
            <span>{isError ? '' : t('paymentsPage.filters.totalResults', { count: total })}</span>
            {hasActiveFilters(filters) && (
              <button
                type="button"
                className="text-primary hover:underline"
                onClick={() => setFilters(EMPTY_PAYMENTS_FILTERS)}
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
                  <TableHead className="w-10"><span className="sr-only">{t('paymentsPage.transactions.details')}</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isError ? (
                  // Not the empty-state sentence: a refused or failed request is
                  // not "no transactions", and a malformed link must say which
                  // part of it the server refused.
                  <TableRow>
                    <TableCell colSpan={9} className="py-8 text-center">
                      <div role="alert" className="space-y-1">
                        <p className="font-medium">{t('paymentsPage.transactions.loadFailed')}</p>
                        <p className="break-words text-xs text-muted-foreground">
                          {getErrorMessage(error, t('paymentsPage.transactions.loadFailed'))}
                        </p>
                      </div>
                    </TableCell>
                  </TableRow>
                ) : items.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={9} className="text-center py-8 text-muted-foreground">
                      {t('paymentsPage.transactions.empty')}
                    </TableCell>
                  </TableRow>
                ) : items.map((tx) => (
                  <TableRow
                    key={tx.id}
                    className="cursor-pointer hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    // The row opens from the mouse and, focused, from Enter or
                    // Space. The button in the last cell stays the named control
                    // for a screen reader.
                    tabIndex={0}
                    onClick={() => {
                      if (!hasTextSelection()) onOpenPayment(tx.paymentId)
                    }}
                    onKeyDown={(event) => {
                      // The row's own keys only: Enter on the copy button inside
                      // it copies, it does not also open the payment.
                      if (event.target !== event.currentTarget) return
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        onOpenPayment(tx.paymentId)
                      }
                    }}
                  >
                    <TableCell className="text-xs">
                      <CopyableId
                        value={tx.paymentId}
                        label={t('paymentsPage.transactions.paymentId')}
                        maxLength={ID_CELL_LENGTH}
                        ellipsis="middle"
                      />
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-1 text-[11px] text-muted-foreground">
                        <span>{t('paymentsPage.transactions.gatewayId')}</span>
                        <CopyableId
                          value={tx.gatewayId}
                          label={t('paymentsPage.transactions.gatewayId')}
                          maxLength={ID_CELL_LENGTH}
                          ellipsis="middle"
                        />
                      </div>
                    </TableCell>
                    <TableCell className="text-xs">
                      <div>{tx.userUsername ? `@${tx.userUsername}` : tx.userName ?? '—'}</div>
                      {/* A transaction can carry neither identity (a gateway
                          row imported before the customer was linked), and the
                          bare optional chain rendered that as a blank cell —
                          indistinguishable from a rendering bug. */}
                      <div className="text-muted-foreground">{tx.userTelegramId ?? truncate(tx.userId, 8)}</div>
                    </TableCell>
                    <TableCell><Badge variant={statusVariant(tx.status)}>{String(t(`paymentsPage.statuses.${tx.status}`, tx.status))}</Badge></TableCell>
                    <TableCell className="text-xs">{gatewayLabel(tx.gatewayType, t)}</TableCell>
                    <TableCell className="whitespace-nowrap text-sm tabular-nums">
                      {formatPaymentAmount(tx.amount, tx.currency, activeLocale())}
                    </TableCell>
                    <TableCell className="text-xs">{readPlanName(tx.planSnapshot) ?? '—'}</TableCell>
                    <TableCell><Badge variant="outline" className="text-xs">{t(`paymentsPage.purchaseTypes.${tx.purchaseType}`, { defaultValue: tx.purchaseType })}</Badge></TableCell>
                    <TableCell className="text-xs text-muted-foreground">{new Date(tx.createdAt).toLocaleString(activeLocale())}</TableCell>
                    <TableCell>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7"
                        aria-label={t('paymentsPage.transactions.open', { id: tx.paymentId })}
                        onClick={(event) => {
                          event.stopPropagation()
                          onOpenPayment(tx.paymentId)
                        }}
                      >
                        <PanelRightOpen className="h-3.5 w-3.5" aria-hidden="true" />
                      </Button>
                    </TableCell>
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
                disabled={currentPage === 0}
                onClick={() => setFilters({ page: String(Math.max(1, currentPage)) })}
                className="text-sm text-primary disabled:opacity-40"
              >
                ← {t('paymentsPage.pagination.prev')}
              </button>
              <span className="text-xs text-muted-foreground">
                {t('paymentsPage.pagination.page', { current: currentPage + 1, total: totalPages })}
              </span>
              <button
                type="button"
                disabled={currentPage >= totalPages - 1}
                onClick={() => setFilters({ page: String(currentPage + 2) })}
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

function LinkedFilterChip({
  label,
  value,
  removeLabel,
  onRemove,
}: {
  readonly label: string
  readonly value: string
  readonly removeLabel: string
  readonly onRemove: () => void
}) {
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-md border bg-muted/40 py-0.5 pl-2 pr-0.5 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <CopyableId value={value} label={label} maxLength={ID_CELL_LENGTH} ellipsis="middle" />
      <button
        type="button"
        aria-label={removeLabel}
        title={removeLabel}
        onClick={onRemove}
        className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <X className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </span>
  )
}

function readPlanName(snapshot: unknown): string | null {
  if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) return null
  const name = (snapshot as Record<string, unknown>)['name']
  return typeof name === 'string' && name.length > 0 ? name : null
}

function WebhooksTab({ onOpenPayment }: { readonly onOpenPayment: (reference: string) => void }) {
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
                  <TableHead>{t('paymentsPage.webhooks.payment')}</TableHead>
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
                    <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                      {t('paymentsReconciliation.events.unavailable')}
                    </TableCell>
                  </TableRow>
                ) : events.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                      {t('paymentsReconciliation.events.empty')}
                    </TableCell>
                  </TableRow>
                ) : events.map((ev) => (
                  <TableRow key={ev.id}>
                    <TableCell className="text-xs">{gatewayLabel(ev.gatewayType, t)}</TableCell>
                    <TableCell className="text-xs">
                      <span className="inline-flex items-center gap-0.5">
                        <CopyableId
                          value={ev.paymentId}
                          label={t('paymentsPage.webhooks.payment')}
                          maxLength={ID_CELL_LENGTH}
                          ellipsis="middle"
                        />
                        {ev.paymentId ? (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-6 w-6"
                            aria-label={t('paymentsPage.webhooks.openPayment', { id: ev.paymentId })}
                            title={t('paymentsPage.webhooks.openPayment', { id: ev.paymentId })}
                            onClick={() => onOpenPayment(ev.paymentId)}
                          >
                            <PanelRightOpen className="h-3.5 w-3.5" aria-hidden="true" />
                          </Button>
                        ) : null}
                      </span>
                    </TableCell>
                    <TableCell className="text-xs">
                      <CopyableId
                        value={ev.providerEventId}
                        label={t('paymentsPage.webhooks.providerEvent')}
                        maxLength={16}
                      />
                    </TableCell>
                    <TableCell><Badge variant="outline">{ev.status}</Badge></TableCell>
                    <TableCell className="text-xs text-muted-foreground">{new Date(ev.receivedAt).toLocaleString(activeLocale())}</TableCell>
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
