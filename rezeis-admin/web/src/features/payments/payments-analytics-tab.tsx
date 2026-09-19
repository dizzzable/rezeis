/**
 * Payments → Analytics tab.
 *
 * Two reports stacked into one tab:
 *   1. Provider performance — per-gateway revenue, conversion, time-to-pay,
 *      top failure reasons, channel mix, revenue trendline.
 *   2. Webhook health — delivery rate, latency percentiles, top errors,
 *      reconciliation gap.
 *
 * The window selector at the top drives both reports (they accept the
 * same `days` query). Recharts is used for spark/area charts to stay
 * consistent with the rest of the admin (same theme tokens, same
 * `ChartContainer` UI primitive).
 *
 * MONEY IS «Бизнес-аналитика»'s. The report counts money received —
 * completed, above zero, net of refunds, not paid from a partner's balance —
 * by the day its checkout started, in the operator's time zone, and states it
 * in ONE currency: natively when there is one, else the panel's base with the
 * other currencies converted at its rates and any currency without a rate
 * named. So every amount here is printed WITH that currency, through the
 * analytics page's own formatter («9,7 тыс. ₽», never «RUB 9.7K» or «9.7K»),
 * and a partner's balance is a row for its health and a line of its own,
 * never revenue. Until 2026-09 the tab added 1 000 ₽ to 10 USDT and read
 * «1010», dated by the last write of a row.
 */

import { useState, type JSX } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  CheckCircle2,
  ChevronDown,
  CircleDollarSign,
  Clock,
  Info,
  PercentCircle,
  RefreshCw,
  Webhook,
} from 'lucide-react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

import { api } from '@/lib/api'
import { isRecord, unwrapPayload } from '@/lib/api-utils'
import { adminQueryKeys } from '@/lib/admin-query-keys'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { InfoTip } from '@/components/ui/info-tip'
import { Skeleton } from '@/components/ui/skeleton'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Progress } from '@/components/ui/progress'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { activeLocale, cn } from '@/lib/utils'
import { FadeIn, StaggerItem, StaggerList } from '@/lib/motion'
import type { CurrencyAmount, MoneyFigure, MoneyView, PartnerBalanceSpend } from '@/features/analytics/analytics-api'
import { approx } from '@/features/analytics/analytics-chart-support'
import { formatAmounts, formatDay, formatMoney, formatPercent, formatShortDate } from '@/features/analytics/analytics-format'

import {
  type PaymentGatewayIconType,
  getPaymentGatewayIcon,
} from './payment-gateway-icons'
import { PermissionRequiredNotice } from './permission-required-notice'
import { paymentsRoutePermissions, useRouteAccess } from './payments-route-permissions'

// ── Wire types (mirrors backend payment-analytics.types.ts) ──────────────────

interface ProviderDailyPoint {
  /** A local calendar day of the report's zone, `YYYY-MM-DD`. */
  readonly day: string
  /** Money received that day, in `money.currency`. */
  readonly revenueValue: number
  readonly transactions: number
  readonly successful: number
}

interface ProviderFailureReason {
  readonly reason: string
  readonly count: number
  readonly share: number
}

interface ProviderDetail {
  readonly gatewayType: string
  readonly isActive: boolean
  readonly currency: string
  /** `false` for a partner's balance: its row is there for its health, its money is never revenue. */
  readonly countsAsRevenue: boolean
  readonly transactions: number
  readonly completed: number
  readonly refunded: number
  readonly pending: number
  readonly failed: number
  readonly canceled: number
  readonly revenue: MoneyFigure
  readonly payments: number
  readonly averagePayment: CurrencyAmount | null
  readonly successRate: number
  readonly checkoutRate: number
  readonly medianTimeToPaySeconds: number | null
  readonly p95TimeToPaySeconds: number | null
  readonly stuckPending: number
  readonly delta: {
    readonly revenuePct: number | null
    readonly transactionsPct: number | null
    readonly successRateDelta: number | null
  }
  readonly daily: readonly ProviderDailyPoint[]
  readonly topFailureReasons: readonly ProviderFailureReason[]
  readonly channelMix: { readonly web: number; readonly telegram: number }
}

interface ProvidersReport {
  readonly windowDays: number
  readonly windowStart: string
  readonly previousWindowStart: string
  readonly previousWindowEnd: string
  readonly generatedAt: string
  readonly timeZone: string
  readonly timeZoneFallback: boolean
  readonly money: MoneyView
  readonly revenue: MoneyFigure
  readonly payments: number
  readonly partnerBalance: PartnerBalanceSpend
  readonly totalTransactions: number
  readonly totalCompleted: number
  readonly totalPaid: number
  readonly providers: readonly ProviderDetail[]
}

interface WebhookGatewayHealth {
  readonly gatewayType: string
  readonly received: number
  readonly processed: number
  readonly failed: number
  readonly retrying: number
  readonly replayed: number
  readonly deliveryRate: number
  readonly medianLatencyMs: number | null
  readonly p95LatencyMs: number | null
  readonly topErrors: readonly { readonly error: string; readonly count: number }[]
}

interface WebhookHealthReport {
  readonly windowDays: number
  readonly windowStart: string
  readonly generatedAt: string
  readonly totalReceived: number
  readonly totalProcessed: number
  readonly totalFailed: number
  readonly reconciliation: {
    readonly transactionsMissingWebhook: number
    readonly webhooksMissingTransaction: number
  }
  readonly perGateway: readonly WebhookGatewayHealth[]
}

const WINDOW_OPTIONS: readonly number[] = [7, 14, 30, 60, 90] as const

/**
 * The providers report as this tab may read it, or a throw. A panel a release
 * behind — one that still sums money across currencies and names no currency
 * — answers without `money`; the section then says it could not load rather
 * than print its numbers under a currency they are not in.
 */
function readProvidersReport(body: unknown): ProvidersReport {
  const report = unwrapPayload(body)
  const money = report['money']
  const revenue = report['revenue']
  if (
    !isRecord(money) ||
    typeof money['currency'] !== 'string' ||
    !isRecord(revenue) ||
    typeof revenue['value'] !== 'number' ||
    !isRecord(report['partnerBalance']) ||
    !Array.isArray(report['providers'])
  ) {
    throw new Error('errors.unexpectedResponsePayload')
  }
  return report as unknown as ProvidersReport
}

export default function PaymentsAnalyticsTab(): JSX.Element {
  const { t } = useTranslation()
  const [days, setDays] = useState<number>(30)
  // Both reports are served by the payment-ANALYTICS module, which is guarded
  // by `analytics:view` (admin-payment-analytics.controller.ts:27 and :40) —
  // not by the `payments:view` this tab renders behind. The 403 used to land
  // in each section's `isError` branch, which says "could not load the
  // report": a transient-failure message for a permanent refusal, so the
  // operator retries forever instead of asking for the token.
  const canViewAnalytics = useRouteAccess(paymentsRoutePermissions.paymentAnalytics)

  const heading = (
    <div>
      <h2 className="flex items-center gap-2 text-lg font-semibold">
        <Activity className="h-5 w-5" />
        {t('paymentsAnalytics.title')}
      </h2>
      <p className="text-sm text-muted-foreground">{t('paymentsAnalytics.subtitle')}</p>
    </div>
  )

  if (!canViewAnalytics) {
    // The window selector goes with the reports: a control that changes the
    // parameters of a request that will never be made is furniture.
    return (
      <div className="space-y-6 mt-4">
        <FadeIn>{heading}</FadeIn>
        <PermissionRequiredNotice
          permission={paymentsRoutePermissions.paymentAnalytics}
          title={t('paymentsAccess.paymentAnalytics.title')}
          description={t('paymentsAccess.paymentAnalytics.description')}
        />
      </div>
    )
  }

  return (
    <div className="space-y-6 mt-4">
      <FadeIn>
        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
          {heading}
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{t('paymentsAnalytics.windowLabel')}</span>
            <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
              <SelectTrigger className="h-9 w-32" aria-label={t('paymentsAnalytics.windowAria')}><SelectValue /></SelectTrigger>
              <SelectContent>
                {WINDOW_OPTIONS.map((option) => (
                  <SelectItem key={option} value={String(option)}>
                    {t('paymentsAnalytics.windowDays', { count: option })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </FadeIn>

      <ProvidersSection days={days} />
      <WebhookHealthSection days={days} />
    </div>
  )
}

// ── Money ────────────────────────────────────────────────────────────────────

/**
 * A money figure of the report as one string: its value in the view currency
 * («≈ » when part of it was converted), and beside it whatever has no rate, in
 * its own currency — «1 000 ₽ + 500 XTR». Stars alone read «500 XTR», not «0 ₽».
 */
function figureText(figure: MoneyFigure, money: MoneyView, compact = true): string {
  const unconverted = figure.byCurrency.filter((slice) => money.unconverted.includes(slice.currency))
  const converts = figure.byCurrency.some((slice) => !money.unconverted.includes(slice.currency))
  const parts: string[] = []
  if (converts || unconverted.length === 0) {
    parts.push(`${approx(money, figure.byCurrency.map((slice) => slice.currency))}${formatMoney(figure.value, money.currency, { compact })}`)
  }
  for (const slice of unconverted) parts.push(formatMoney(slice.amount, slice.currency, { compact }))
  return parts.join(' + ')
}

/** The report's money in a sentence or two: which rates converted what, and what had none. */
function MoneyNotes({ report }: { readonly report: ProvidersReport }): JSX.Element | null {
  const { t } = useTranslation()
  const { money } = report
  const lines: string[] = []
  if (report.timeZoneFallback) lines.push(t('paymentsAnalytics.notes.zoneFallback'))
  if (money.converted) {
    const oldest = money.rates.reduce<string | null>(
      (earliest, rate) => (earliest === null || rate.fetchedAt < earliest ? rate.fetchedAt : earliest),
      null,
    )
    lines.push(
      t('paymentsAnalytics.notes.converted', {
        currency: money.currency,
        date: oldest === null ? '—' : formatShortDate(oldest),
        rates: money.rates.map((rate) => `1\xa0${rate.currency} = ${formatMoney(rate.rate, money.currency)}`).join(' · '),
      }),
    )
  }
  if (money.unconverted.length > 0) {
    lines.push(
      `${t('paymentsAnalytics.notes.unconverted', { count: money.unconverted.length, currencies: money.unconverted.join(', ') })} ${t('paymentsAnalytics.notes.whereToSetRate')}`,
    )
  }
  if (report.partnerBalance.payments > 0) {
    lines.push(
      t('paymentsAnalytics.notes.partnerBalance', {
        amount: formatAmounts(report.partnerBalance.figure.byCurrency),
        payments: t('paymentsAnalytics.notes.partnerBalancePayments', { count: report.partnerBalance.payments }),
      }),
    )
  }
  if (lines.length === 0) return null
  return (
    <div className="space-y-1" data-payments-money-notes="">
      {lines.map((line) => (
        <p key={line} className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span>{line}</span>
        </p>
      ))}
    </div>
  )
}

// ── Providers Section ────────────────────────────────────────────────────────

function ProvidersSection({ days }: { readonly days: number }): JSX.Element {
  const { t } = useTranslation()
  const canViewAnalytics = useRouteAccess(paymentsRoutePermissions.paymentAnalytics)
  const { data, isLoading, isError, isFetching } = useQuery({
    queryKey: adminQueryKeys.payments.analytics.providers(days),
    queryFn: async () => {
      const res = await api.get<unknown>(`/admin/analytics/payments/providers?days=${days}`)
      return readProvidersReport(res.data)
    },
    staleTime: 60_000,
    placeholderData: keepPreviousData,
    // Repeated below the tab's own gate on purpose, the way
    // `ReconciliationHealthCard` repeats its check: the section must not fire
    // a request it knows will 403 from some future mount point that forgets.
    // Without it the `isError` branch would report a permission refusal as a
    // failed report.
    enabled: canViewAnalytics,
  })

  // Unreachable from the tab, which refuses above before mounting either
  // section — so exactly one notice ever renders. It is here because the
  // branch below it is the one that used to lie: `enabled: false` leaves
  // `data` undefined, and `isError || !data` would call a refusal a failed
  // report all over again.
  if (!canViewAnalytics) {
    return (
      <PermissionRequiredNotice
        permission={paymentsRoutePermissions.paymentAnalytics}
        title={t('paymentsAccess.paymentAnalytics.title')}
        description={t('paymentsAccess.paymentAnalytics.description')}
      />
    )
  }

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    )
  }

  if (isError || !data) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 py-6 text-sm text-rose-500">
          <AlertTriangle className="h-4 w-4" />
          {t('paymentsAnalytics.loadError')}
        </CardContent>
      </Card>
    )
  }

  const unconverted = data.revenue.byCurrency.filter((slice) => data.money.unconverted.includes(slice.currency))

  return (
    <FadeIn
      key={`providers-${days}`}
      className={cn('space-y-4 transition-opacity', isFetching && 'opacity-70')}
    >
      {/* Aggregate summary cards */}
      <StaggerList className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StaggerItem>
          <SummaryCard
            id="revenue"
            icon={<CircleDollarSign className="h-4 w-4 text-emerald-500" />}
            title={t('paymentsAnalytics.summary.revenue')}
            info={t('paymentsAnalytics.summary.revenueInfo')}
            value={`${approx(data.money, data.revenue.byCurrency.map((slice) => slice.currency))}${formatMoney(data.revenue.value, data.money.currency, { compact: true })}`}
            subtitle={[
              t('paymentsAnalytics.summary.windowDays', { count: data.windowDays }),
              t('paymentsAnalytics.summary.payments', { count: data.payments }),
              ...(unconverted.length > 0
                ? [t('paymentsAnalytics.summary.unconverted', { amount: unconverted.map((slice) => formatMoney(slice.amount, slice.currency, { compact: true })).join(', ') })]
                : []),
            ].join(' · ')}
          />
        </StaggerItem>
        <StaggerItem>
          <SummaryCard
            id="transactions"
            icon={<Activity className="h-4 w-4 text-sky-500" />}
            title={t('paymentsAnalytics.summary.transactions')}
            value={data.totalTransactions.toLocaleString(activeLocale())}
            subtitle={t('paymentsAnalytics.summary.completed', { count: data.totalPaid })}
          />
        </StaggerItem>
        <StaggerItem>
          <SummaryCard
            id="conversion"
            icon={<PercentCircle className="h-4 w-4 text-violet-500" />}
            title={t('paymentsAnalytics.summary.successRate')}
            value={
              data.totalTransactions > 0
                ? percent(data.totalPaid / data.totalTransactions)
                : '—'
            }
            subtitle={t('paymentsAnalytics.summary.checkoutToPaid')}
          />
        </StaggerItem>
        <StaggerItem>
          <SummaryCard
            id="providers"
            icon={<Clock className="h-4 w-4 text-amber-500" />}
            title={t('paymentsAnalytics.summary.activeProviders')}
            // Payment systems only: a partner's balance is a row of its own, not a gateway.
            value={String(data.providers.filter((p) => p.countsAsRevenue && p.transactions > 0).length)}
            subtitle={t('paymentsAnalytics.summary.totalProviders', { count: data.providers.filter((p) => p.countsAsRevenue).length })}
          />
        </StaggerItem>
      </StaggerList>

      <MoneyNotes report={data} />

      {/* Per-provider rows */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('paymentsAnalytics.providers.title')}</CardTitle>
          <CardDescription>{t('paymentsAnalytics.providers.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {data.providers.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {t('paymentsAnalytics.providers.empty')}
            </p>
          ) : (
            <StaggerList className="space-y-2">
              {data.providers.map((provider) => (
                <StaggerItem key={provider.gatewayType}>
                  <ProviderRow provider={provider} money={data.money} />
                </StaggerItem>
              ))}
            </StaggerList>
          )}
        </CardContent>
      </Card>
    </FadeIn>
  )
}

function ProviderRow({ provider, money }: { readonly provider: ProviderDetail; readonly money: MoneyView }): JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const Icon = getPaymentGatewayIcon(provider.gatewayType)
  const paid = provider.completed + provider.refunded

  const showsTrend = provider.countsAsRevenue && provider.daily.some((point) => point.revenueValue > 0 || point.transactions > 0)

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div
        className={cn(
          'rounded-lg border bg-background/40 transition-colors duration-200',
          open ? 'border-primary/40' : 'hover:border-primary/20',
        )}
        data-provider={provider.gatewayType}
      >
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center gap-4 px-4 py-3 text-left"
            aria-expanded={open}
          >
            <ChevronDown
              className={cn(
                'h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 ease-out',
                open ? 'rotate-0' : '-rotate-90',
              )}
              aria-hidden
            />
            <div className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted/40">
              {/* eslint-disable-next-line react-hooks/static-components */}
              {Icon ? <Icon className="h-5 w-5 object-contain" /> : (
                <CircleDollarSign className="h-4 w-4 text-muted-foreground" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{provider.gatewayType}</span>
                {/* A partner's balance has no catalog row, so it is never "active" — and never switched off either. */}
                {!provider.isActive && provider.countsAsRevenue && (
                  <Badge variant="outline" className="text-[10px]">
                    {t('paymentsAnalytics.providers.inactive')}
                  </Badge>
                )}
                {provider.stuckPending > 0 && (
                  <Badge variant="outline" className="border-amber-500/40 text-[10px] text-amber-600">
                    <AlertTriangle className="mr-0.5 h-3 w-3" />
                    {t('paymentsAnalytics.providers.stuckPending', { count: provider.stuckPending })}
                  </Badge>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-0.5 pt-0.5 text-[11px] text-muted-foreground">
                <span>
                  {t('paymentsAnalytics.providers.transactionsLabel')}{' '}
                  <span className="text-foreground">{provider.transactions.toLocaleString(activeLocale())}</span>
                </span>
                <span>
                  {t('paymentsAnalytics.providers.completedLabel')}{' '}
                  <span className="text-foreground">{paid.toLocaleString(activeLocale())}</span>
                </span>
                <span>
                  {t('paymentsAnalytics.providers.successRateLabel')}{' '}
                  <span className="text-foreground">{percent(provider.successRate)}</span>
                </span>
              </div>
            </div>

            <div className="hidden text-right sm:block">
              {provider.countsAsRevenue ? (
                <>
                  <div className="text-sm font-semibold tabular-nums" data-provider-revenue="">
                    {figureText(provider.revenue, money)}
                  </div>
                  <DeltaBadge value={provider.delta.revenuePct} />
                </>
              ) : (
                <div className="text-xs text-muted-foreground" data-provider-revenue="">
                  {t('paymentsAnalytics.providers.notRevenue')}
                </div>
              )}
            </div>

            <div className="hidden h-12 w-32 shrink-0 lg:block" aria-hidden={!showsTrend}>
              {showsTrend && (
                <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
                  <AreaChart data={[...provider.daily]}>
                    <defs>
                      <linearGradient id={`grad-${provider.gatewayType}`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="var(--primary)" stopOpacity={0.4} />
                        <stop offset="100%" stopColor="var(--primary)" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <Area
                      type="monotone"
                      dataKey="revenueValue"
                      stroke="var(--primary)"
                      strokeWidth={1.5}
                      fill={`url(#grad-${provider.gatewayType})`}
                      isAnimationActive={false}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </div>
          </button>
        </CollapsibleTrigger>

        <CollapsibleContent className="collapsible-animate overflow-hidden">
          <div className="border-t px-4 py-3">
            <ProviderDetailPanel provider={provider} money={money} />
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}

function ProviderDetailPanel({ provider, money }: { readonly provider: ProviderDetail; readonly money: MoneyView }): JSX.Element {
  const { t } = useTranslation()
  const total = provider.transactions
  const average = provider.averagePayment

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      {/* Status breakdown */}
      <div className="space-y-3">
        <h4 className="text-xs font-medium uppercase text-muted-foreground">
          {t('paymentsAnalytics.providers.statusBreakdown')}
        </h4>
        <ProgressLine
          label={t('paymentsAnalytics.statuses.completed')}
          count={provider.completed}
          total={total}
          tone="emerald"
        />
        {provider.refunded > 0 && (
          <ProgressLine
            label={t('paymentsAnalytics.statuses.refunded')}
            count={provider.refunded}
            total={total}
            tone="sky"
          />
        )}
        <ProgressLine
          label={t('paymentsAnalytics.statuses.pending')}
          count={provider.pending}
          total={total}
          tone="amber"
        />
        <ProgressLine
          label={t('paymentsAnalytics.statuses.failed')}
          count={provider.failed}
          total={total}
          tone="rose"
        />
        <ProgressLine
          label={t('paymentsAnalytics.statuses.canceled')}
          count={provider.canceled}
          total={total}
          tone="muted"
        />
        <Stat
          label={t('paymentsAnalytics.providers.stuckLabel')}
          info={t('paymentsAnalytics.providers.stuckInfo')}
          value={provider.stuckPending.toLocaleString(activeLocale())}
          testId="stuck"
        />
      </div>

      {/* Conversion + ticket size + time-to-pay */}
      <div className="space-y-3">
        <h4 className="text-xs font-medium uppercase text-muted-foreground">
          {t('paymentsAnalytics.providers.conversion')}
        </h4>
        <Stat
          label={t('paymentsAnalytics.providers.avgTicket')}
          value={
            average === null
              ? '—'
              : `${average.currency === money.currency ? approx(money, provider.revenue.byCurrency.map((slice) => slice.currency)) : ''}${formatMoney(average.amount, average.currency)}`
          }
          hint={
            provider.countsAsRevenue
              ? t('paymentsAnalytics.providers.avgTicketHint', { count: provider.payments })
              : t('paymentsAnalytics.providers.notRevenueHint')
          }
          testId="average-payment"
        />
        <Stat
          label={t('paymentsAnalytics.providers.successRate')}
          value={percent(provider.successRate)}
          hint={provider.delta.successRateDelta === null ? '—' : points(t, provider.delta.successRateDelta)}
          hintTone={
            provider.delta.successRateDelta === null
              ? 'muted'
              : provider.delta.successRateDelta >= 0
                ? 'positive'
                : 'negative'
          }
          testId="success-rate"
        />
        <Stat
          label={t('paymentsAnalytics.providers.medianTimeToPay')}
          info={t('paymentsAnalytics.providers.medianTimeToPayInfo')}
          value={formatDuration(t, provider.medianTimeToPaySeconds)}
          hint={
            provider.p95TimeToPaySeconds === null
              ? '—'
              : t('paymentsAnalytics.providers.p95', {
                  share: percent(0.95, 0),
                  value: formatDuration(t, provider.p95TimeToPaySeconds),
                })
          }
          testId="time-to-pay"
        />
        <Stat
          label={t('paymentsAnalytics.providers.checkoutRate')}
          value={percent(provider.checkoutRate)}
          hint={t('paymentsAnalytics.providers.checkoutRateHint')}
          testId="checkout-rate"
        />
      </div>

      {/* Top failure reasons + channel mix */}
      <div className="space-y-3">
        <h4 className="text-xs font-medium uppercase text-muted-foreground">
          {t('paymentsAnalytics.providers.topFailures')}
        </h4>
        {provider.topFailureReasons.length === 0 ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
            {t('paymentsAnalytics.providers.noFailures')}
          </div>
        ) : (
          <div className="space-y-2">
            {provider.topFailureReasons.map((reason) => (
              <div key={reason.reason} className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="truncate font-mono">{reason.reason}</span>
                  <span className="tabular-nums text-muted-foreground">
                    {reason.count.toLocaleString(activeLocale())} · {percent(reason.share, 0)}
                  </span>
                </div>
                <Progress value={reason.share * 100} className="h-1" />
              </div>
            ))}
          </div>
        )}

        <div className="border-t pt-3">
          <h4 className="pb-2 text-xs font-medium uppercase text-muted-foreground">
            {t('paymentsAnalytics.providers.channelMix')}
          </h4>
          <div className="space-y-2">
            <ShareLine label={t('paymentsAnalytics.providers.web')} share={provider.channelMix.web} tone="sky" />
            <ShareLine label={t('paymentsAnalytics.providers.telegram')} share={provider.channelMix.telegram} tone="violet" />
          </div>
        </div>
      </div>

      {/* Trend chart full width below — money, so not for a partner's balance */}
      {provider.countsAsRevenue && (
        <div className="lg:col-span-3">
          <h4 className="pb-2 text-xs font-medium uppercase text-muted-foreground">
            {t('paymentsAnalytics.providers.trend', { currency: money.currency })}
          </h4>
          <div className="h-40 w-full">
            <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
              <AreaChart data={[...provider.daily]} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id={`gradFull-${provider.gatewayType}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--primary)" stopOpacity={0.5} />
                    <stop offset="100%" stopColor="var(--primary)" stopOpacity={0.05} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.15} />
                <XAxis
                  dataKey="day"
                  tick={{ fontSize: 10 }}
                  stroke="currentColor"
                  strokeOpacity={0.4}
                  tickFormatter={(day: string) => formatDay(day, 'axis')}
                />
                <YAxis
                  tick={{ fontSize: 10 }}
                  stroke="currentColor"
                  strokeOpacity={0.4}
                  width={68}
                  tickFormatter={(value: number) => formatMoney(value, money.currency, { compact: true })}
                />
                <Tooltip
                  contentStyle={{ background: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }}
                  labelStyle={{ color: 'var(--muted-foreground)' }}
                  labelFormatter={(day) => formatDay(String(day), 'full')}
                  formatter={(value, key) => [formatMoney(Number(value ?? 0), money.currency), String(key)]}
                />
                <Area
                  type="monotone"
                  dataKey="revenueValue"
                  name={t('paymentsAnalytics.providers.revenue')}
                  stroke="var(--primary)"
                  fill={`url(#gradFull-${provider.gatewayType})`}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Webhook Health Section ───────────────────────────────────────────────────

function WebhookHealthSection({ days }: { readonly days: number }): JSX.Element {
  const { t } = useTranslation()
  const canViewAnalytics = useRouteAccess(paymentsRoutePermissions.paymentAnalytics)
  const { data, isLoading, isError, isFetching } = useQuery({
    queryKey: adminQueryKeys.payments.analytics.webhooks(days),
    queryFn: async () => {
      const res = await api.get<WebhookHealthReport>(`/admin/analytics/payments/webhooks?days=${days}`)
      return res.data
    },
    staleTime: 60_000,
    placeholderData: keepPreviousData,
    // See `ProvidersSection`: same route permission, same reason.
    enabled: canViewAnalytics,
  })

  // See `ProvidersSection`: unreachable from the tab, kept so the branch below
  // cannot report a refusal as a failed report.
  if (!canViewAnalytics) {
    return (
      <PermissionRequiredNotice
        permission={paymentsRoutePermissions.paymentAnalytics}
        title={t('paymentsAccess.paymentAnalytics.title')}
        description={t('paymentsAccess.paymentAnalytics.description')}
      />
    )
  }

  if (isLoading) {
    return <Skeleton className="h-48 w-full" />
  }

  if (isError || !data) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 py-6 text-sm text-rose-500">
          <AlertTriangle className="h-4 w-4" />
          {t('paymentsAnalytics.loadError')}
        </CardContent>
      </Card>
    )
  }

  const overallRate =
    data.totalReceived === 0 ? 0 : data.totalProcessed / data.totalReceived

  return (
    <FadeIn
      key={`webhooks-${days}`}
      className={cn('transition-opacity', isFetching && 'opacity-70')}
    >
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Webhook className="h-5 w-5" />
            {t('paymentsAnalytics.webhooks.title')}
          </CardTitle>
          <CardDescription>{t('paymentsAnalytics.webhooks.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <StaggerList className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StaggerItem>
              <SummaryCard
                icon={<Webhook className="h-4 w-4 text-sky-500" />}
                title={t('paymentsAnalytics.webhooks.received')}
                value={data.totalReceived.toLocaleString(activeLocale())}
                subtitle={t('paymentsAnalytics.webhooks.processed', { count: data.totalProcessed })}
              />
            </StaggerItem>
            <StaggerItem>
              <SummaryCard
                icon={<CheckCircle2 className="h-4 w-4 text-emerald-500" />}
                title={t('paymentsAnalytics.webhooks.deliveryRate')}
                value={percent(overallRate)}
                subtitle={t('paymentsAnalytics.webhooks.failedSubtitle', { count: data.totalFailed })}
              />
            </StaggerItem>
            <StaggerItem>
              <SummaryCard
                icon={<AlertTriangle className="h-4 w-4 text-amber-500" />}
                title={t('paymentsAnalytics.webhooks.txMissingWebhook')}
                value={data.reconciliation.transactionsMissingWebhook.toLocaleString(activeLocale())}
                subtitle={t('paymentsAnalytics.webhooks.txMissingWebhookHint')}
              />
            </StaggerItem>
            <StaggerItem>
              <SummaryCard
                icon={<RefreshCw className="h-4 w-4 text-rose-500" />}
                title={t('paymentsAnalytics.webhooks.webhookMissingTx')}
                value={data.reconciliation.webhooksMissingTransaction.toLocaleString(activeLocale())}
                subtitle={t('paymentsAnalytics.webhooks.webhookMissingTxHint')}
              />
            </StaggerItem>
          </StaggerList>

          {data.perGateway.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {t('paymentsAnalytics.webhooks.empty')}
            </p>
          ) : (
            <StaggerList className="space-y-2">
              {data.perGateway.map((gateway) => (
                <StaggerItem key={gateway.gatewayType}>
                  <WebhookGatewayRow gateway={gateway} />
                </StaggerItem>
              ))}
            </StaggerList>
          )}
        </CardContent>
      </Card>
    </FadeIn>
  )
}

function WebhookGatewayRow({ gateway }: { readonly gateway: WebhookGatewayHealth }): JSX.Element {
  const { t } = useTranslation()
  const Icon = getPaymentGatewayIcon(gateway.gatewayType as PaymentGatewayIconType)

  return (
    <div className="flex flex-col gap-2 rounded-md border bg-background/40 px-3 py-2 sm:flex-row sm:items-center sm:gap-4">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded bg-muted/40">
        {/* eslint-disable-next-line react-hooks/static-components */}
        {Icon ? <Icon className="h-4 w-4 object-contain" /> : (
          <Webhook className="h-3.5 w-3.5 text-muted-foreground" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{gateway.gatewayType}</span>
          {gateway.replayed > 0 && (
            <Badge variant="outline" className="text-[10px]">
              <RefreshCw className="mr-0.5 h-3 w-3" />
              {t('paymentsAnalytics.webhooks.replayedBadge', { count: gateway.replayed })}
            </Badge>
          )}
          {gateway.failed > 0 && (
            <Badge variant="outline" className="border-rose-500/40 text-[10px] text-rose-500">
              <AlertTriangle className="mr-0.5 h-3 w-3" />
              {t('paymentsAnalytics.webhooks.failedBadge', { count: gateway.failed })}
            </Badge>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-0.5 pt-0.5 text-[11px] text-muted-foreground">
          <span>
            {t('paymentsAnalytics.webhooks.receivedLabel')}{' '}
            <span className="text-foreground">{gateway.received.toLocaleString(activeLocale())}</span>
          </span>
          <span>
            {t('paymentsAnalytics.webhooks.deliveryRateLabel')}{' '}
            <span className="text-foreground">{percent(gateway.deliveryRate)}</span>
          </span>
          {gateway.medianLatencyMs !== null && (
            <span>
              {t('paymentsAnalytics.webhooks.medianLatencyLabel')}{' '}
              <span className="text-foreground" data-webhook-latency="">{milliseconds(t, gateway.medianLatencyMs)}</span>
            </span>
          )}
        </div>
        {gateway.topErrors.length > 0 && (
          <div className="pt-1.5 space-y-0.5">
            {gateway.topErrors.slice(0, 3).map((err) => (
              <div key={err.error} className="flex items-center gap-2 text-[11px]">
                <span className="truncate font-mono text-rose-500">{err.error}</span>
                <span className="text-muted-foreground">×{err.count}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Reusable atoms ───────────────────────────────────────────────────────────

function SummaryCard({
  id,
  icon,
  title,
  info,
  value,
  subtitle,
}: {
  readonly id?: string
  readonly icon: JSX.Element
  readonly title: string
  /** What the figure is — an (i) beside the title. */
  readonly info?: string
  readonly value: string
  readonly subtitle: string
}): JSX.Element {
  const { t } = useTranslation()
  return (
    <Card data-summary={id}>
      <CardContent className="p-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {icon}
          <span className="uppercase tracking-wide">{title}</span>
          {info !== undefined && (
            <InfoTip label={t('paymentsAnalytics.summary.aboutLabel', { title })}>{info}</InfoTip>
          )}
        </div>
        <div className="pt-1.5 text-xl font-bold tabular-nums" data-summary-value="">{value}</div>
        <div className="text-[11px] text-muted-foreground" data-summary-subtitle="">{subtitle}</div>
      </CardContent>
    </Card>
  )
}

function Stat({
  label,
  info,
  value,
  hint,
  hintTone = 'muted',
  testId,
}: {
  readonly label: string
  /** What the figure is — an (i) beside the label. */
  readonly info?: string
  readonly value: string
  readonly hint?: string
  readonly hintTone?: 'muted' | 'positive' | 'negative'
  readonly testId?: string
}): JSX.Element {
  const { t } = useTranslation()
  return (
    <div data-stat={testId}>
      <div className="flex items-center gap-1 text-[11px] uppercase text-muted-foreground">
        <span>{label}</span>
        {info !== undefined && <InfoTip label={t('paymentsAnalytics.summary.aboutLabel', { title: label })}>{info}</InfoTip>}
      </div>
      <div className="text-sm font-semibold tabular-nums" data-stat-value="">{value}</div>
      {hint && (
        <div
          data-stat-hint=""
          className={cn(
            'text-[11px]',
            hintTone === 'positive' && 'text-emerald-500',
            hintTone === 'negative' && 'text-rose-500',
            hintTone === 'muted' && 'text-muted-foreground',
          )}
        >
          {hint}
        </div>
      )}
    </div>
  )
}

type LineTone = 'emerald' | 'amber' | 'rose' | 'muted' | 'sky' | 'violet'

const BAR_COLOR: Readonly<Record<LineTone, string>> = {
  emerald: 'bg-emerald-500',
  amber: 'bg-amber-500',
  rose: 'bg-rose-500',
  muted: 'bg-muted-foreground/40',
  sky: 'bg-sky-500',
  violet: 'bg-violet-500',
}

function Line({ label, text, share, tone }: { readonly label: string; readonly text: string; readonly share: number; readonly tone: LineTone }): JSX.Element {
  return (
    <div className="space-y-1" data-line={label}>
      <div className="flex items-center justify-between text-xs">
        <span>{label}</span>
        <span className="tabular-nums text-muted-foreground" data-line-value="">{text}</span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-muted/40">
        <div className={cn('h-full transition-all', BAR_COLOR[tone])} style={{ width: `${share * 100}%` }} />
      </div>
    </div>
  )
}

/** A count, and its share of `total` when it has one: «3 · 37,5 %». */
function ProgressLine({
  label,
  count,
  total,
  tone,
}: {
  readonly label: string
  readonly count: number
  readonly total: number
  readonly tone: LineTone
}): JSX.Element {
  const share = total === 0 ? 0 : count / total
  const text = share > 0 ? `${count.toLocaleString(activeLocale())} · ${percent(share)}` : count.toLocaleString(activeLocale())
  return <Line label={label} text={text} share={share} tone={tone} />
}

/** A bare share: «25 %». */
function ShareLine({ label, share, tone }: { readonly label: string; readonly share: number; readonly tone: LineTone }): JSX.Element {
  return <Line label={label} text={percent(share, 0)} share={share} tone={tone} />
}

function DeltaBadge({ value }: { readonly value: number | null }): JSX.Element {
  if (value === null || !Number.isFinite(value)) {
    return <span className="text-[11px] text-muted-foreground">—</span>
  }
  if (Math.abs(value) < 0.001) {
    return <span className="text-[11px] text-muted-foreground" data-delta="">±{percent(0, 0)}</span>
  }
  const positive = value > 0
  return (
    <span
      className={cn(
        'inline-flex items-center gap-0.5 text-[11px] font-medium tabular-nums',
        positive ? 'text-emerald-500' : 'text-rose-500',
      )}
      data-delta=""
    >
      {positive ? (
        <ArrowUpRight className="h-3 w-3" />
      ) : (
        <ArrowDownRight className="h-3 w-3" />
      )}
      {signedPercent(value)}
    </span>
  )
}

// ── Formatters ───────────────────────────────────────────────────────────────

//
// Numbers go through `Intl` in the panel's language (`activeLocale()`, never the
// browser's), and every unit comes from the dictionary: «12,5 %», «+1,5 п. п.»,
// «6 мин», «120 мс» for a Russian operator — the tab used to write `12.5%`,
// `+1.5 pp`, `6m` and `120 ms` by hand, in English, for everyone.

/** A share (0–1): «12,5 %», "12.5%". */
function percent(ratio: number, digits = 1): string {
  return formatPercent(ratio, { digits })
}

/** A change of a quantity, with its sign: «+25 %», "-12.5%". */
function signedPercent(ratio: number): string {
  return new Intl.NumberFormat(activeLocale(), { style: 'percent', maximumFractionDigits: 1, signDisplay: 'exceptZero' }).format(ratio)
}

function number(value: number, digits: number): string {
  return new Intl.NumberFormat(activeLocale(), { maximumFractionDigits: digits }).format(value)
}

/** A change of a rate in percentage points: «+1,5 п. п.», "+1.5 pp". */
function points(t: TFunction, delta: number): string {
  const value = new Intl.NumberFormat(activeLocale(), { maximumFractionDigits: 1, signDisplay: 'exceptZero' }).format(delta * 100)
  return t('paymentsAnalytics.units.points', { value })
}

/** «120 мс», "120 ms". */
function milliseconds(t: TFunction, ms: number): string {
  return t('paymentsAnalytics.units.milliseconds', { value: number(ms, 0) })
}

/** «45 с», «6 мин», «1,5 ч» — "45 s", "6 min", "1.5 h". */
function formatDuration(t: TFunction, seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '—'
  if (seconds < 60) return t('paymentsAnalytics.units.seconds', { value: number(seconds, 0) })
  if (seconds < 3600) return t('paymentsAnalytics.units.minutes', { value: number(seconds / 60, 0) })
  return t('paymentsAnalytics.units.hours', { value: number(seconds / 3600, 1) })
}
