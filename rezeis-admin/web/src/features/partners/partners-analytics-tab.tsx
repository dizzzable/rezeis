import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Activity,
  BarChart3,
  CircleDollarSign,
  Clock4,
  Coins,
  Download,
  Layers,
  Repeat,
  Target,
  Trophy,
  Users,
  Wallet,
} from 'lucide-react'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { FadeIn, StaggerList } from '@/lib/motion'

import { AnalyticsRangePicker, AnalyticsRangeValue, buildDefaultRange } from './analytics-range-picker'
import { AnimatedCounter } from './animated-counter'
import { CohortHeatmap } from './cohort-heatmap'
import { downloadCsv } from './csv-download'
import {
  formatDuration,
  formatKopecks,
  formatKopecksCompact,
  formatNumber,
  formatPercent,
  shortBucketLabel,
} from './partner-formatters'
import {
  useFunnel,
  useGatewayDistribution,
  useKpis,
  useLevelDistribution,
  useTimeseries,
  useTopPartners,
  useWithdrawalThroughput,
} from './partners-queries'

const LEVEL_COLORS = ['#10b981', '#3b82f6', '#a855f7'] as const
const PIE_PALETTE = [
  '#10b981',
  '#3b82f6',
  '#a855f7',
  '#f59e0b',
  '#ef4444',
  '#06b6d4',
  '#8b5cf6',
  '#84cc16',
  '#ec4899',
  '#f97316',
] as const

export default function PartnersAnalyticsTab() {
  const { t } = useTranslation()
  const [range, setRange] = useState<AnalyticsRangeValue>(buildDefaultRange)
  const { from, to, granularity } = range

  return (
    <div className="space-y-4 mt-4">
      <FadeIn>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <BarChart3 className="h-5 w-5" />
              {t('partnersAnalytics.title')}
            </h2>
            <p className="text-xs text-muted-foreground">{t('partnersAnalytics.subtitle')}</p>
          </div>
          <AnalyticsRangePicker value={range} onChange={setRange} />
        </div>
      </FadeIn>

      <KpiHeroCards from={from} to={to} />
      <FunnelCard from={from} to={to} />

      <div className="grid gap-4 lg:grid-cols-2">
        <TimeseriesCard from={from} to={to} granularity={granularity} />
        <LevelDistributionCard from={from} to={to} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <TopPartnersCard from={from} to={to} />
        <GatewayDistributionCard from={from} to={to} />
      </div>

      <CohortHeatmap from={from} to={to} />

      <ThroughputCard from={from} to={to} />
    </div>
  )
}

// ── KPI hero ─────────────────────────────────────────────────────────────────

function KpiHeroCards({ from, to }: { readonly from: string; readonly to: string }) {
  const { t } = useTranslation()
  const { data, isLoading } = useKpis({ from, to })

  if (isLoading || !data) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
    )
  }

  return (
    <StaggerList className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <KpiCard
        icon={<Coins className="h-4 w-4 text-emerald-500" />}
        label={t('partnersAnalytics.kpis.aov')}
        valueComponent={
          <AnimatedCounter
            value={data.aov / 100}
            format={(v) =>
              `${v.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽`
            }
            className="text-2xl font-bold tabular-nums"
          />
        }
        hint={t('partnersAnalytics.kpis.aovHint', { count: data.totalQualifyingPayments })}
      />
      <KpiCard
        icon={<Users className="h-4 w-4 text-blue-500" />}
        label={t('partnersAnalytics.kpis.epap')}
        valueComponent={
          <AnimatedCounter
            value={data.epap / 100}
            format={(v) =>
              `${v.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽`
            }
            className="text-2xl font-bold tabular-nums"
          />
        }
        hint={t('partnersAnalytics.kpis.epapHint', { count: data.partnersActiveInWindow })}
      />
      <KpiCard
        icon={<Target className="h-4 w-4 text-amber-500" />}
        label={t('partnersAnalytics.kpis.activationRate')}
        valueComponent={
          <AnimatedCounter
            value={data.activationRate * 100}
            format={(v) => `${v.toFixed(0)}%`}
            className="text-2xl font-bold tabular-nums"
          />
        }
        hint={t('partnersAnalytics.kpis.activationHint', {
          activated: data.newPartnersActivated,
          total: data.newPartners,
        })}
      />
      <KpiCard
        icon={<Repeat className="h-4 w-4 text-purple-500" />}
        label={t('partnersAnalytics.kpis.repeatShare')}
        valueComponent={
          <AnimatedCounter
            value={data.repeatPurchaseContribution * 100}
            format={(v) => `${v.toFixed(0)}%`}
            className="text-2xl font-bold tabular-nums"
          />
        }
        hint={t('partnersAnalytics.kpis.repeatHint')}
      />
    </StaggerList>
  )
}

function KpiCard({
  icon,
  label,
  valueComponent,
  hint,
}: {
  readonly icon: React.ReactNode
  readonly label: string
  readonly valueComponent: React.ReactNode
  readonly hint: string
}) {
  return (
    <Card>
      <CardContent className="pt-4">
        <div className="flex items-center gap-2 text-muted-foreground">
          {icon}
          <p className="text-[10px] uppercase tracking-wide">{label}</p>
        </div>
        <div className="mt-1">{valueComponent}</div>
        <p className="text-[10px] text-muted-foreground mt-1">{hint}</p>
      </CardContent>
    </Card>
  )
}

// ── Funnel ────────────────────────────────────────────────────────────────────

function FunnelCard({ from, to }: { readonly from: string; readonly to: string }) {
  const { t } = useTranslation()
  const { data, isLoading } = useFunnel({ from, to })

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Activity className="h-4 w-4" />
          {t('partnersAnalytics.funnel.title')}
        </CardTitle>
        <CardDescription>{t('partnersAnalytics.funnel.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading || !data ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-7 items-stretch gap-2">
            <FunnelStep value={data.newPartners} label={t('partnersAnalytics.funnel.new')} />
            <FunnelArrow rate={data.conversion.activationRate} />
            <FunnelStep value={data.activePartners} label={t('partnersAnalytics.funnel.active')} />
            <FunnelArrow rate={data.conversion.earningRate} />
            <FunnelStep
              value={data.partnersWithEarnings}
              label={t('partnersAnalytics.funnel.earning')}
            />
            <FunnelArrow rate={data.conversion.withdrawalRate} />
            <FunnelStep
              value={data.partnersWithWithdrawals}
              label={t('partnersAnalytics.funnel.withdrawal')}
            />
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function FunnelStep({ value, label }: { readonly value: number; readonly label: string }) {
  return (
    <div className="rounded-lg border bg-card/50 px-4 py-3 text-center md:col-span-1">
      <p className="text-2xl font-bold tabular-nums">
        <AnimatedCounter value={value} format={formatNumber} />
      </p>
      <p className="text-[11px] text-muted-foreground mt-1">{label}</p>
    </div>
  )
}

function FunnelArrow({ rate }: { readonly rate: number }) {
  return (
    <div className="flex items-center justify-center md:col-span-1">
      <Badge variant="secondary" className="text-[10px]">
        {formatPercent(rate, 0)}
      </Badge>
    </div>
  )
}

// ── Timeseries ────────────────────────────────────────────────────────────────

function TimeseriesCard({
  from,
  to,
  granularity,
}: {
  readonly from: string
  readonly to: string
  readonly granularity: 'day' | 'week'
}) {
  const { t } = useTranslation()
  const { data, isLoading } = useTimeseries({ from, to, granularity })

  const formatted = useMemo(() => {
    if (!data) return []
    return data.points.map((p) => ({
      ...p,
      bucketLabel: shortBucketLabel(p.bucket),
      earningsRub: p.earnings / 100,
    }))
  }, [data])

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <BarChart3 className="h-4 w-4" />
          {t('partnersAnalytics.timeseries.title')}
        </CardTitle>
        <CardDescription>{t('partnersAnalytics.timeseries.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading || !data ? (
          <Skeleton className="h-64 w-full" />
        ) : (
          <ResponsiveContainer width="100%" height={260}>
            <AreaChart data={formatted}>
              <defs>
                <linearGradient id="earningsGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#10b981" stopOpacity={0.5} />
                  <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="withdrawGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.4} />
                  <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#27272a" opacity={0.3} />
              <XAxis dataKey="bucketLabel" stroke="#a1a1aa" fontSize={11} />
              <YAxis
                stroke="#a1a1aa"
                fontSize={11}
                tickFormatter={(v) =>
                  typeof v === 'number' && v > 1000 ? `${(v / 1000).toFixed(1)}k` : `${v}`
                }
              />
              <Tooltip
                contentStyle={{
                  background: 'hsl(var(--popover))',
                  border: '1px solid hsl(var(--border))',
                  borderRadius: 8,
                  fontSize: 12,
                }}
                formatter={(value: number | string, key: string) => {
                  if (key === 'earningsRub')
                    return [`${Number(value).toFixed(2)} ₽`, t('partnersAnalytics.timeseries.legend.earnings')]
                  return [String(value), key]
                }}
              />
              <Legend />
              <Area
                yAxisId={0}
                type="monotone"
                dataKey="earningsRub"
                stroke="#10b981"
                fill="url(#earningsGradient)"
                strokeWidth={2}
                name={t('partnersAnalytics.timeseries.legend.earnings')}
              />
              <Area
                yAxisId={0}
                type="monotone"
                dataKey="withdrawalsApproved"
                stroke="#3b82f6"
                fill="url(#withdrawGradient)"
                strokeWidth={2}
                name={t('partnersAnalytics.timeseries.legend.approved')}
              />
              <Area
                yAxisId={0}
                type="monotone"
                dataKey="newPartners"
                stroke="#a855f7"
                fill="transparent"
                strokeWidth={2}
                name={t('partnersAnalytics.timeseries.legend.newPartners')}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  )
}

// ── Level distribution ────────────────────────────────────────────────────────

function LevelDistributionCard({ from, to }: { readonly from: string; readonly to: string }) {
  const { t } = useTranslation()
  const { data, isLoading } = useLevelDistribution({ from, to })

  const chartData = useMemo(() => {
    if (!data) return []
    return ['1', '2', '3'].map((level, idx) => ({
      level: `L${level}`,
      earnings: (data.byLevel[level] ?? 0) / 100,
      transactions: data.transactionsByLevel[level] ?? 0,
      color: LEVEL_COLORS[idx],
    }))
  }, [data])

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Layers className="h-4 w-4" />
          {t('partnersAnalytics.levelDistribution.title')}
        </CardTitle>
        <CardDescription>
          {t('partnersAnalytics.levelDistribution.description')}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading || !data ? (
          <Skeleton className="h-64 w-full" />
        ) : data.totalEarnings === 0 ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            {t('partnersAnalytics.empty')}
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#27272a" opacity={0.3} />
              <XAxis dataKey="level" stroke="#a1a1aa" fontSize={11} />
              <YAxis
                stroke="#a1a1aa"
                fontSize={11}
                tickFormatter={(v) =>
                  typeof v === 'number' && v > 1000 ? `${(v / 1000).toFixed(1)}k` : `${v}`
                }
              />
              <Tooltip
                contentStyle={{
                  background: 'hsl(var(--popover))',
                  border: '1px solid hsl(var(--border))',
                  borderRadius: 8,
                  fontSize: 12,
                }}
                formatter={(value: number | string, key: string) => {
                  if (key === 'earnings')
                    return [
                      `${Number(value).toFixed(2)} ₽`,
                      t('partnersAnalytics.levelDistribution.earnings'),
                    ]
                  return [String(value), t('partnersAnalytics.levelDistribution.transactions')]
                }}
              />
              <Bar dataKey="earnings" radius={[6, 6, 0, 0]}>
                {chartData.map((entry, idx) => (
                  <Cell key={entry.level} fill={LEVEL_COLORS[idx]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  )
}

// ── Gateway distribution ──────────────────────────────────────────────────────

function GatewayDistributionCard({ from, to }: { readonly from: string; readonly to: string }) {
  const { t } = useTranslation()
  const { data, isLoading } = useGatewayDistribution({ from, to })

  const pieData = useMemo(() => {
    if (!data) return []
    return Object.entries(data.byGateway)
      .map(([gateway, info]) => ({
        name: gateway,
        value: info.earnings,
      }))
      .filter((item) => item.value > 0)
      .sort((a, b) => b.value - a.value)
  }, [data])

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <CircleDollarSign className="h-4 w-4" />
          {t('partnersAnalytics.gatewayDistribution.title')}
        </CardTitle>
        <CardDescription>
          {t('partnersAnalytics.gatewayDistribution.description')}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading || !data ? (
          <Skeleton className="h-64 w-full" />
        ) : pieData.length === 0 ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            {t('partnersAnalytics.empty')}
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={260}>
            <PieChart>
              <Pie data={pieData} dataKey="value" nameKey="name" innerRadius={48} outerRadius={88}>
                {pieData.map((entry, index) => (
                  <Cell key={entry.name} fill={PIE_PALETTE[index % PIE_PALETTE.length]} />
                ))}
              </Pie>
              <Tooltip
                contentStyle={{
                  background: 'hsl(var(--popover))',
                  border: '1px solid hsl(var(--border))',
                  borderRadius: 8,
                  fontSize: 12,
                }}
                formatter={(value: number | string) => [formatKopecks(Number(value)), '']}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
            </PieChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  )
}

// ── Top partners ──────────────────────────────────────────────────────────────

function TopPartnersCard({ from, to }: { readonly from: string; readonly to: string }) {
  const { t } = useTranslation()
  const { data, isLoading } = useTopPartners({ from, to, limit: 10 })

  async function exportCsv() {
    try {
      await downloadCsv({
        path: '/admin/partners/export/top-partners.csv',
        filename: `top-partners-${new Date().toISOString().slice(0, 10)}.csv`,
        params: { from, to },
      })
      toast.success(t('partnersAnalytics.export.success'))
    } catch {
      toast.error(t('partnersAnalytics.export.failed'))
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Trophy className="h-4 w-4" />
              {t('partnersAnalytics.topPartners.title')}
            </CardTitle>
            <CardDescription>{t('partnersAnalytics.topPartners.description')}</CardDescription>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={exportCsv}
            aria-label={t('partnersAnalytics.export.csvAria')}
          >
            <Download className="h-3.5 w-3.5 mr-1.5" />
            CSV
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading || !data ? (
          <Skeleton className="h-64 w-full" />
        ) : data.items.length === 0 ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            {t('partnersAnalytics.empty')}
          </div>
        ) : (
          <div className="space-y-2">
            {data.items.map((row, idx) => (
              <div
                key={row.partnerId}
                className="flex items-center justify-between rounded-lg border bg-card/50 px-3 py-2"
              >
                <div className="flex items-center gap-3">
                  <Badge variant="outline" className="w-7 justify-center font-mono text-[10px]">
                    {idx + 1}
                  </Badge>
                  <div>
                    <p className="text-sm font-medium leading-tight">
                      {row.name ?? row.username ?? '—'}
                    </p>
                    <p className="text-[11px] text-muted-foreground font-mono">
                      @{row.username ?? row.telegramId ?? '—'}
                    </p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-sm font-semibold tabular-nums">
                    {formatKopecksCompact(row.earnings)}
                  </p>
                  <p className="text-[10px] text-muted-foreground">
                    {row.transactions} {t('partnersAnalytics.topPartners.transactions')} ·{' '}
                    {row.referrals} {t('partnersAnalytics.topPartners.referrals')}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ── Throughput ───────────────────────────────────────────────────────────────

function ThroughputCard({ from, to }: { readonly from: string; readonly to: string }) {
  const { t } = useTranslation()
  const { data, isLoading } = useWithdrawalThroughput({ from, to })

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Wallet className="h-4 w-4" />
          {t('partnersAnalytics.throughput.title')}
        </CardTitle>
        <CardDescription>{t('partnersAnalytics.throughput.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading || !data ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <ThroughputStat
              icon={<Wallet className="h-4 w-4 text-muted-foreground" />}
              label={t('partnersAnalytics.throughput.requested')}
              value={formatNumber(data.requested)}
            />
            <ThroughputStat
              icon={<Wallet className="h-4 w-4 text-emerald-500" />}
              label={t('partnersAnalytics.throughput.approved')}
              value={formatNumber(data.approved)}
            />
            <ThroughputStat
              icon={<Wallet className="h-4 w-4 text-destructive" />}
              label={t('partnersAnalytics.throughput.rejected')}
              value={formatNumber(data.rejected)}
            />
            <ThroughputStat
              icon={<Activity className="h-4 w-4 text-blue-500" />}
              label={t('partnersAnalytics.throughput.approvalRate')}
              value={formatPercent(data.approvalRate, 0)}
            />
            <ThroughputStat
              icon={<Clock4 className="h-4 w-4 text-amber-500" />}
              label={t('partnersAnalytics.throughput.medianDecision')}
              value={formatDuration(data.medianDecisionSeconds)}
              hint={
                data.p95DecisionSeconds !== null
                  ? `p95 ${formatDuration(data.p95DecisionSeconds)}`
                  : undefined
              }
            />
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function ThroughputStat({
  icon,
  label,
  value,
  hint,
}: {
  readonly icon: React.ReactNode
  readonly label: string
  readonly value: string
  readonly hint?: string
}) {
  return (
    <div className="rounded-lg border bg-card/50 px-3 py-3">
      <div className="flex items-center gap-2">
        {icon}
        <p className="text-[11px] text-muted-foreground">{label}</p>
      </div>
      <p className="text-xl font-bold tabular-nums mt-1">{value}</p>
      {hint && <p className="text-[10px] text-muted-foreground">{hint}</p>}
    </div>
  )
}
