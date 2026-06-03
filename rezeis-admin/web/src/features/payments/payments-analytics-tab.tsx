/**
 * Payments → Analytics tab.
 *
 * Two reports stacked into one tab:
 *   1. Provider performance — per-gateway GMV, conversion, time-to-pay,
 *      top failure reasons, channel mix, revenue trendline.
 *   2. Webhook health — delivery rate, latency percentiles, top errors,
 *      reconciliation gap.
 *
 * The window selector at the top drives both reports (they accept the
 * same `days` query). Recharts is used for spark/area charts to stay
 * consistent with the rest of the admin (same theme tokens, same
 * `ChartContainer` UI primitive).
 */

import { useState, type JSX } from 'react'
import { useTranslation } from 'react-i18next'
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
  Loader2,
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
import { adminQueryKeys } from '@/lib/admin-query-keys'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Progress } from '@/components/ui/progress'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'
import { FadeIn, StaggerItem, StaggerList } from '@/lib/motion'

import {
  type PaymentGatewayIconType,
  getPaymentGatewayIcon,
} from './payment-gateway-icons'

// ── Wire types (mirrors backend payment-analytics.types.ts) ──────────────────

interface ProviderDailyPoint {
  readonly day: string
  readonly revenue: number
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
  readonly transactions: number
  readonly completed: number
  readonly pending: number
  readonly failed: number
  readonly canceled: number
  readonly grossRevenue: number
  readonly avgTicket: number
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
  readonly generatedAt: string
  readonly totalGrossRevenue: number
  readonly totalTransactions: number
  readonly totalCompleted: number
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

export default function PaymentsAnalyticsTab(): JSX.Element {
  const { t } = useTranslation()
  const [days, setDays] = useState<number>(30)

  return (
    <div className="space-y-6 mt-4">
      <FadeIn>
        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="flex items-center gap-2 text-lg font-semibold">
              <Activity className="h-5 w-5" />
              {t('paymentsAnalytics.title')}
            </h2>
            <p className="text-sm text-muted-foreground">{t('paymentsAnalytics.subtitle')}</p>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{t('paymentsAnalytics.windowLabel')}</span>
            <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
              <SelectTrigger className="h-9 w-32"><SelectValue /></SelectTrigger>
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

// ── Providers Section ────────────────────────────────────────────────────────

function ProvidersSection({ days }: { readonly days: number }): JSX.Element {
  const { t } = useTranslation()
  const { data, isLoading, isError, isFetching } = useQuery({
    queryKey: adminQueryKeys.payments.analytics.providers(days),
    queryFn: async () => {
      const res = await api.get<ProvidersReport>(`/admin/analytics/payments/providers?days=${days}`)
      return res.data
    },
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  })

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

  return (
    <FadeIn
      key={`providers-${days}`}
      className={cn('space-y-4 transition-opacity', isFetching && 'opacity-70')}
    >
      {/* Aggregate summary cards */}
      <StaggerList className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StaggerItem>
          <SummaryCard
            icon={<CircleDollarSign className="h-4 w-4 text-emerald-500" />}
            title={t('paymentsAnalytics.summary.gmv')}
            value={formatMoney(data.totalGrossRevenue)}
            subtitle={t('paymentsAnalytics.summary.windowDays', { count: data.windowDays })}
          />
        </StaggerItem>
        <StaggerItem>
          <SummaryCard
            icon={<Activity className="h-4 w-4 text-sky-500" />}
            title={t('paymentsAnalytics.summary.transactions')}
            value={data.totalTransactions.toLocaleString()}
            subtitle={t('paymentsAnalytics.summary.completed', { count: data.totalCompleted })}
          />
        </StaggerItem>
        <StaggerItem>
          <SummaryCard
            icon={<PercentCircle className="h-4 w-4 text-violet-500" />}
            title={t('paymentsAnalytics.summary.successRate')}
            value={
              data.totalTransactions > 0
                ? `${((data.totalCompleted / data.totalTransactions) * 100).toFixed(1)}%`
                : '—'
            }
            subtitle={t('paymentsAnalytics.summary.checkoutToPaid')}
          />
        </StaggerItem>
        <StaggerItem>
          <SummaryCard
            icon={<Clock className="h-4 w-4 text-amber-500" />}
            title={t('paymentsAnalytics.summary.activeProviders')}
            value={String(data.providers.filter((p) => p.transactions > 0).length)}
            subtitle={t('paymentsAnalytics.summary.totalProviders', { count: data.providers.length })}
          />
        </StaggerItem>
      </StaggerList>

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
                  <ProviderRow provider={provider} />
                </StaggerItem>
              ))}
            </StaggerList>
          )}
        </CardContent>
      </Card>
    </FadeIn>
  )
}

function ProviderRow({ provider }: { readonly provider: ProviderDetail }): JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const Icon = getPaymentGatewayIcon(provider.gatewayType)

  const showsTrend = provider.daily.some((point) => point.revenue > 0 || point.transactions > 0)

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div
        className={cn(
          'rounded-lg border bg-background/40 transition-colors duration-200',
          open ? 'border-primary/40' : 'hover:border-primary/20',
        )}
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
                {!provider.isActive && (
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
                  <span className="text-foreground">{provider.transactions.toLocaleString()}</span>
                </span>
                <span>
                  {t('paymentsAnalytics.providers.completedLabel')}{' '}
                  <span className="text-foreground">{provider.completed.toLocaleString()}</span>
                </span>
                <span>
                  {t('paymentsAnalytics.providers.successRateLabel')}{' '}
                  <span className="text-foreground">{(provider.successRate * 100).toFixed(1)}%</span>
                </span>
              </div>
            </div>

            <div className="hidden text-right sm:block">
              <div className="text-sm font-semibold tabular-nums">{formatMoney(provider.grossRevenue)}</div>
              <DeltaBadge value={provider.delta.revenuePct} />
            </div>

            <div className="hidden h-12 w-32 shrink-0 lg:block" aria-hidden={!showsTrend}>
              {showsTrend && (
                <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
                  <AreaChart data={[...provider.daily]}>
                    <defs>
                      <linearGradient id={`grad-${provider.gatewayType}`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.4} />
                        <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <Area
                      type="monotone"
                      dataKey="revenue"
                      stroke="hsl(var(--primary))"
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
            <ProviderDetailPanel provider={provider} />
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}

function ProviderDetailPanel({ provider }: { readonly provider: ProviderDetail }): JSX.Element {
  const { t } = useTranslation()
  const completed = provider.completed
  const failed = provider.failed
  const canceled = provider.canceled
  const pending = provider.pending
  const total = provider.transactions

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      {/* Status breakdown */}
      <div className="space-y-3">
        <h4 className="text-xs font-medium uppercase text-muted-foreground">
          {t('paymentsAnalytics.providers.statusBreakdown')}
        </h4>
        <ProgressLine
          label={t('paymentsAnalytics.statuses.completed')}
          count={completed}
          total={total}
          tone="emerald"
        />
        <ProgressLine
          label={t('paymentsAnalytics.statuses.pending')}
          count={pending}
          total={total}
          tone="amber"
        />
        <ProgressLine
          label={t('paymentsAnalytics.statuses.failed')}
          count={failed}
          total={total}
          tone="rose"
        />
        <ProgressLine
          label={t('paymentsAnalytics.statuses.canceled')}
          count={canceled}
          total={total}
          tone="muted"
        />
      </div>

      {/* Conversion + ticket size + time-to-pay */}
      <div className="space-y-3">
        <h4 className="text-xs font-medium uppercase text-muted-foreground">
          {t('paymentsAnalytics.providers.conversion')}
        </h4>
        <Stat
          label={t('paymentsAnalytics.providers.avgTicket')}
          value={formatMoney(provider.avgTicket)}
          hint={provider.currency}
        />
        <Stat
          label={t('paymentsAnalytics.providers.successRate')}
          value={`${(provider.successRate * 100).toFixed(1)}%`}
          hint={
            provider.delta.successRateDelta === null
              ? '—'
              : `${provider.delta.successRateDelta >= 0 ? '+' : ''}${(provider.delta.successRateDelta * 100).toFixed(1)} pp`
          }
          hintTone={
            provider.delta.successRateDelta === null
              ? 'muted'
              : provider.delta.successRateDelta >= 0
                ? 'positive'
                : 'negative'
          }
        />
        <Stat
          label={t('paymentsAnalytics.providers.medianTimeToPay')}
          value={formatDuration(provider.medianTimeToPaySeconds)}
          hint={
            provider.p95TimeToPaySeconds
              ? `p95 ${formatDuration(provider.p95TimeToPaySeconds)}`
              : '—'
          }
        />
        <Stat
          label={t('paymentsAnalytics.providers.checkoutRate')}
          value={`${(provider.checkoutRate * 100).toFixed(1)}%`}
          hint={t('paymentsAnalytics.providers.checkoutRateHint')}
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
                    {reason.count} · {(reason.share * 100).toFixed(0)}%
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
            <ProgressLine
              label={t('paymentsAnalytics.providers.web')}
              count={Math.round(provider.channelMix.web * 100)}
              total={100}
              tone="sky"
              suffix="%"
            />
            <ProgressLine
              label={t('paymentsAnalytics.providers.telegram')}
              count={Math.round(provider.channelMix.telegram * 100)}
              total={100}
              tone="violet"
              suffix="%"
            />
          </div>
        </div>
      </div>

      {/* Trend chart full width below */}
      <div className="lg:col-span-3">
        <h4 className="pb-2 text-xs font-medium uppercase text-muted-foreground">
          {t('paymentsAnalytics.providers.trend')}
        </h4>
        <div className="h-40 w-full">
          <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
            <AreaChart data={[...provider.daily]} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id={`gradFull-${provider.gatewayType}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.5} />
                  <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0.05} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.15} />
              <XAxis dataKey="day" tick={{ fontSize: 10 }} stroke="currentColor" strokeOpacity={0.4} />
              <YAxis tick={{ fontSize: 10 }} stroke="currentColor" strokeOpacity={0.4} width={50} />
              <Tooltip
                contentStyle={{ background: 'hsl(var(--popover))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 12 }}
                labelStyle={{ color: 'hsl(var(--muted-foreground))' }}
                formatter={(value, key) => [formatMoney(Number(value ?? 0)), String(key)]}
              />
              <Area
                type="monotone"
                dataKey="revenue"
                name={t('paymentsAnalytics.providers.revenue')}
                stroke="hsl(var(--primary))"
                fill={`url(#gradFull-${provider.gatewayType})`}
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  )
}

// ── Webhook Health Section ───────────────────────────────────────────────────

function WebhookHealthSection({ days }: { readonly days: number }): JSX.Element {
  const { t } = useTranslation()
  const { data, isLoading, isError, isFetching } = useQuery({
    queryKey: adminQueryKeys.payments.analytics.webhooks(days),
    queryFn: async () => {
      const res = await api.get<WebhookHealthReport>(`/admin/analytics/payments/webhooks?days=${days}`)
      return res.data
    },
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  })

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
                value={data.totalReceived.toLocaleString()}
                subtitle={t('paymentsAnalytics.webhooks.processed', { count: data.totalProcessed })}
              />
            </StaggerItem>
            <StaggerItem>
              <SummaryCard
                icon={<CheckCircle2 className="h-4 w-4 text-emerald-500" />}
                title={t('paymentsAnalytics.webhooks.deliveryRate')}
                value={`${(overallRate * 100).toFixed(1)}%`}
                subtitle={t('paymentsAnalytics.webhooks.failedSubtitle', { count: data.totalFailed })}
              />
            </StaggerItem>
            <StaggerItem>
              <SummaryCard
                icon={<AlertTriangle className="h-4 w-4 text-amber-500" />}
                title={t('paymentsAnalytics.webhooks.txMissingWebhook')}
                value={data.reconciliation.transactionsMissingWebhook.toLocaleString()}
                subtitle={t('paymentsAnalytics.webhooks.txMissingWebhookHint')}
              />
            </StaggerItem>
            <StaggerItem>
              <SummaryCard
                icon={<RefreshCw className="h-4 w-4 text-rose-500" />}
                title={t('paymentsAnalytics.webhooks.webhookMissingTx')}
                value={data.reconciliation.webhooksMissingTransaction.toLocaleString()}
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
            <span className="text-foreground">{gateway.received.toLocaleString()}</span>
          </span>
          <span>
            {t('paymentsAnalytics.webhooks.deliveryRateLabel')}{' '}
            <span className="text-foreground">{(gateway.deliveryRate * 100).toFixed(1)}%</span>
          </span>
          {gateway.medianLatencyMs !== null && (
            <span>
              {t('paymentsAnalytics.webhooks.medianLatencyLabel')}{' '}
              <span className="text-foreground">{gateway.medianLatencyMs.toFixed(0)} ms</span>
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
  icon,
  title,
  value,
  subtitle,
}: {
  readonly icon: JSX.Element
  readonly title: string
  readonly value: string
  readonly subtitle: string
}): JSX.Element {
  return (
    <Card>
      <CardContent className="p-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {icon}
          <span className="uppercase tracking-wide">{title}</span>
        </div>
        <div className="pt-1.5 text-xl font-bold tabular-nums">{value}</div>
        <div className="text-[11px] text-muted-foreground">{subtitle}</div>
      </CardContent>
    </Card>
  )
}

function Stat({
  label,
  value,
  hint,
  hintTone = 'muted',
}: {
  readonly label: string
  readonly value: string
  readonly hint?: string
  readonly hintTone?: 'muted' | 'positive' | 'negative'
}): JSX.Element {
  return (
    <div>
      <div className="text-[11px] uppercase text-muted-foreground">{label}</div>
      <div className="text-sm font-semibold tabular-nums">{value}</div>
      {hint && (
        <div
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

function ProgressLine({
  label,
  count,
  total,
  tone,
  suffix,
}: {
  readonly label: string
  readonly count: number
  readonly total: number
  readonly tone: 'emerald' | 'amber' | 'rose' | 'muted' | 'sky' | 'violet'
  readonly suffix?: string
}): JSX.Element {
  const pct = total === 0 ? 0 : (count / total) * 100
  const barColor: Record<typeof tone, string> = {
    emerald: 'bg-emerald-500',
    amber: 'bg-amber-500',
    rose: 'bg-rose-500',
    muted: 'bg-muted-foreground/40',
    sky: 'bg-sky-500',
    violet: 'bg-violet-500',
  }
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span>{label}</span>
        <span className="tabular-nums text-muted-foreground">
          {count.toLocaleString()}
          {suffix ?? ''} {suffix ? '' : pct > 0 ? `· ${pct.toFixed(1)}%` : ''}
        </span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-muted/40">
        <div className={cn('h-full transition-all', barColor[tone])} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

function DeltaBadge({ value }: { readonly value: number | null }): JSX.Element {
  if (value === null || !Number.isFinite(value)) {
    return <span className="text-[11px] text-muted-foreground">—</span>
  }
  if (Math.abs(value) < 0.001) {
    return <span className="text-[11px] text-muted-foreground">±0%</span>
  }
  const positive = value > 0
  return (
    <span
      className={cn(
        'inline-flex items-center gap-0.5 text-[11px] font-medium tabular-nums',
        positive ? 'text-emerald-500' : 'text-rose-500',
      )}
    >
      {positive ? (
        <ArrowUpRight className="h-3 w-3" />
      ) : (
        <ArrowDownRight className="h-3 w-3" />
      )}
      {(value * 100).toFixed(1)}%
    </span>
  )
}

// ── Formatters ───────────────────────────────────────────────────────────────

function formatMoney(value: number): string {
  if (!Number.isFinite(value)) return '—'
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return value.toFixed(2)
}

function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '—'
  if (seconds < 60) return `${Math.round(seconds)}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  return `${(seconds / 3600).toFixed(1)}h`
}

// Avoid unused-import lint warnings for the Loader2 icon (kept for future
// per-section spinners if we add manual refresh buttons).
void Loader2
