/* eslint-disable @typescript-eslint/no-explicit-any -- TODO: type API responses */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import {
  TrendingUp,
  TrendingDown,
  Users,
  DollarSign,
  CreditCard,
  Trophy,
  Layers,
  BarChart3,
} from 'lucide-react'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'

import {
  getAnalyticsCohorts,
  getAnalyticsOverview,
  getLtvDistribution,
  getTopPayers,
  type ChurnSnapshot,
} from './analytics-api'

const WINDOW_OPTIONS: ReadonlyArray<{ label: string; days: number }> = [
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
  { label: '1y', days: 365 },
]

/**
 * Phase 7 — Business analytics dashboard.
 *
 * Layout
 *   1. Window switcher + KPI cards (revenue, ARPU/ARPPU, paying users, retention).
 *   2. Daily timeseries (revenue + new users + new subs) — composed chart.
 *   3. Conversion funnel + provider health side-by-side.
 *   4. Cohort retention matrix (collapsible — heavy query, hidden by default).
 *   5. LTV distribution histogram.
 *   6. Top payers leaderboard.
 */
export default function AnalyticsPage() {
  const { t } = useTranslation()
  const [days, setDays] = useState(30)

  const overview = useQuery({
    queryKey: ['analytics', 'overview', days],
    queryFn: () => getAnalyticsOverview(days),
    staleTime: 30_000,
  })

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <BarChart3 className="h-6 w-6" />
            {t('analyticsPage.title')}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t('analyticsPage.subtitle')}
          </p>
        </div>
        <div className="flex gap-1">
          {WINDOW_OPTIONS.map((opt) => (
            <Button
              key={opt.days}
              size="sm"
              variant={opt.days === days ? 'default' : 'outline'}
              onClick={() => setDays(opt.days)}
            >
              {opt.label}
            </Button>
          ))}
        </div>
      </div>

      {overview.isLoading || !overview.data ? (
        <div className="grid gap-4 md:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      ) : (
        <>
          <KpiGrid report={overview.data} />
          <DailyChart daily={overview.data.daily} />
          <div className="grid gap-4 lg:grid-cols-2">
            <FunnelCard funnel={overview.data.funnel} />
            <ProvidersCard providers={overview.data.providers} />
          </div>
        </>
      )}

      <CohortMatrixCard />
      <LtvDistributionCard />
      <TopPayersCard />
    </div>
  )
}

// ── KPI Grid ─────────────────────────────────────────────────────────────────

function KpiGrid({
  report,
}: {
  report: { kpis: ReturnType<typeof useQuery<{ kpis: any }>>['data'] extends never ? never : any; churn: ChurnSnapshot }
}) {
  const { t } = useTranslation()
  const { kpis, churn } = report
  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
      <KpiCard
        icon={DollarSign}
        title={t('analyticsPage.kpi.revenue')}
        value={formatCurrency(kpis.totalRevenue)}
        subtitle={t('analyticsPage.kpi.revenueSubtitle', { count: kpis.paidCount.toLocaleString() })}
      />
      <KpiCard
        icon={Users}
        title={t('analyticsPage.kpi.payingUsers')}
        value={kpis.payingUsers.toLocaleString()}
        subtitle={t('analyticsPage.kpi.payingUsersSubtitle', { arppu: formatCurrency(kpis.arppu), arpu: formatCurrency(kpis.arpu) })}
      />
      <KpiCard
        icon={CreditCard}
        title={t('analyticsPage.kpi.activeSubs')}
        value={kpis.activeSubscriptions.toLocaleString()}
        subtitle={t('analyticsPage.kpi.activeSubsSubtitle', { trial: kpis.trialSubscriptions.toLocaleString(), users: kpis.totalUsers.toLocaleString() })}
      />
      <KpiCard
        icon={churn.churnRate > 0.1 ? TrendingDown : TrendingUp}
        title={t('analyticsPage.kpi.retention')}
        value={`${(churn.retentionRate * 100).toFixed(1)}%`}
        subtitle={t('analyticsPage.kpi.retentionSubtitle', { churned: churn.churned, total: churn.prevActive })}
        negative={churn.churnRate > 0.2}
      />
    </div>
  )
}

function KpiCard({
  icon: Icon,
  title,
  value,
  subtitle,
  negative,
}: {
  icon: any
  title: string
  value: string | number
  subtitle: string
  negative?: boolean
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        <Icon
          className={`h-4 w-4 ${negative ? 'text-destructive' : 'text-muted-foreground'}`}
        />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
        <p className="mt-1 text-xs text-muted-foreground">{subtitle}</p>
      </CardContent>
    </Card>
  )
}

// ── Daily timeseries ─────────────────────────────────────────────────────────

function DailyChart({ daily }: { daily: ReturnType<typeof useQuery<any>>['data'] | any }) {
  const { t } = useTranslation()
  if (!daily || daily.length === 0) return null
  const formatted = daily.map((point: any) => ({
    ...point,
    label: point.date.slice(5),
  }))
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('analyticsPage.daily.title')}</CardTitle>
        <CardDescription>{t('analyticsPage.daily.description', { count: daily.length })}</CardDescription>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={280}>
          <ComposedChart data={formatted}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
            <XAxis dataKey="label" className="text-xs" />
            <YAxis yAxisId="left" className="text-xs" />
            <YAxis yAxisId="right" orientation="right" className="text-xs" />
            <Tooltip
              contentStyle={{
                background: 'hsl(var(--card))',
                border: '1px solid hsl(var(--border))',
              }}
            />
            <Bar yAxisId="left" dataKey="revenue" fill="#3b82f6" radius={[4, 4, 0, 0]} />
            <Line
              yAxisId="right"
              type="monotone"
              dataKey="newUsers"
              stroke="#10b981"
              strokeWidth={2}
              dot={false}
            />
            <Line
              yAxisId="right"
              type="monotone"
              dataKey="newSubscriptions"
              stroke="#f59e0b"
              strokeWidth={2}
              dot={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  )
}

// ── Funnel ───────────────────────────────────────────────────────────────────

function FunnelCard({
  funnel,
}: {
  funnel: ReadonlyArray<{
    key: string
    label: string
    count: number
    pctOfStart: number
    pctOfPrev: number
  }>
}) {
  const { t } = useTranslation()
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('analyticsPage.funnel.title')}</CardTitle>
        <CardDescription>
          {t('analyticsPage.funnel.description')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {funnel.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('analyticsPage.funnel.empty')}</p>
        ) : (
          funnel.map((step) => (
            <div key={step.key} className="space-y-1">
              <div className="flex items-center justify-between text-sm">
                <span className="font-medium">{step.label}</span>
                <span className="tabular-nums text-muted-foreground">
                  {step.count.toLocaleString()}{' '}
                  <span className="text-xs">
                    ({(step.pctOfStart * 100).toFixed(1)}% · {t('analyticsPage.funnel.prev')}{' '}
                    {(step.pctOfPrev * 100).toFixed(0)}%)
                  </span>
                </span>
              </div>
              <Progress value={step.pctOfStart * 100} className="h-2" />
            </div>
          ))
        )}
      </CardContent>
    </Card>
  )
}

// ── Providers ────────────────────────────────────────────────────────────────

function ProvidersCard({
  providers,
}: {
  providers: ReadonlyArray<{
    gatewayType: string
    total: number
    completed: number
    failed: number
    canceled: number
    successRate: number
    revenue: number
  }>
}) {
  const { t } = useTranslation()
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('analyticsPage.providers.title')}</CardTitle>
        <CardDescription>{t('analyticsPage.providers.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {providers.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{t('analyticsPage.providers.empty')}</p>
        ) : (
          <>
            {providers.map((provider) => (
              <div key={provider.gatewayType} className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium">{provider.gatewayType}</p>
                  <p className="text-xs text-muted-foreground">
                    {t('analyticsPage.providers.successCount', { completed: provider.completed, total: provider.total, failed: provider.failed })}
                  </p>
                </div>
                <div className="text-right">
                  <p className="font-mono text-sm">{formatCurrency(provider.revenue)}</p>
                  <Badge
                    variant={
                      provider.successRate > 0.8
                        ? 'success'
                        : provider.successRate > 0.5
                          ? 'warning'
                          : 'destructive'
                    }
                    className="text-xs"
                  >
                    {(provider.successRate * 100).toFixed(0)}%
                  </Badge>
                </div>
              </div>
            ))}
            <div className="pt-3">
              <ResponsiveContainer width="100%" height={140}>
                <BarChart data={[...providers]}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis dataKey="gatewayType" className="text-xs" />
                  <YAxis className="text-xs" />
                  <Tooltip
                    contentStyle={{
                      background: 'hsl(var(--card))',
                      border: '1px solid hsl(var(--border))',
                    }}
                  />
                  <Bar dataKey="revenue" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}

// ── Cohort Matrix ────────────────────────────────────────────────────────────

function CohortMatrixCard() {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const cohorts = useQuery({
    queryKey: ['analytics', 'cohorts'],
    queryFn: getAnalyticsCohorts,
    enabled: open,
    staleTime: 5 * 60 * 1_000,
  })
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">{t('analyticsPage.cohorts.title')}</CardTitle>
            <CardDescription>
              {t('analyticsPage.cohorts.description')}
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => setOpen((v) => !v)}>
            {open ? t('analyticsPage.cohorts.hide') : t('analyticsPage.cohorts.show')}
          </Button>
        </div>
      </CardHeader>
      {open && (
        <CardContent>
          {cohorts.isLoading ? (
            <Skeleton className="h-48 w-full" />
          ) : cohorts.data === undefined || cohorts.data.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('analyticsPage.cohorts.empty')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="border-b text-muted-foreground">
                  <tr>
                    <th className="px-2 py-2 text-left">{t('analyticsPage.cohorts.cohortColumn')}</th>
                    <th className="px-2 py-2 text-right">{t('analyticsPage.cohorts.sizeColumn')}</th>
                    {Array.from({ length: 12 }).map((_, idx) => (
                      <th key={idx} className="px-2 py-2 text-center">
                        M{idx}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {cohorts.data.map((row) => (
                    <tr key={row.cohort} className="border-b last:border-0">
                      <td className="px-2 py-2 font-mono">{row.cohort}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{row.cohortSize}</td>
                      {Array.from({ length: 12 }).map((_, idx) => {
                        const value = row.retentionByMonth[idx]
                        if (value === undefined) {
                          return (
                            <td key={idx} className="px-2 py-2 text-center text-muted-foreground">
                              —
                            </td>
                          )
                        }
                        const pct = value * 100
                        const intensity = Math.min(0.85, value)
                        return (
                          <td
                            key={idx}
                            className="px-2 py-2 text-center tabular-nums"
                            style={{
                              background: `rgba(59, 130, 246, ${intensity})`,
                              color: intensity > 0.4 ? 'white' : undefined,
                            }}
                          >
                            {pct < 1 ? pct.toFixed(1) : pct.toFixed(0)}%
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      )}
    </Card>
  )
}

// ── LTV Distribution ─────────────────────────────────────────────────────────

function LtvDistributionCard() {
  const { t } = useTranslation()
  const ltv = useQuery({
    queryKey: ['analytics', 'ltv'],
    queryFn: getLtvDistribution,
    staleTime: 5 * 60 * 1_000,
  })
  if (ltv.isLoading) return <Skeleton className="h-48" />
  const data = (ltv.data ?? []).map((bucket) => ({
    bound: `≥ ${bucket.bound}`,
    users: bucket.users,
  }))
  const totalUsers = data.reduce((acc, b) => acc + b.users, 0)
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Layers className="h-4 w-4" />
          <CardTitle className="text-base">{t('analyticsPage.ltv.title')}</CardTitle>
        </div>
        <CardDescription>
          {t('analyticsPage.ltv.description', { count: totalUsers.toLocaleString() })}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {totalUsers === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {t('analyticsPage.ltv.empty')}
          </p>
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={data}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis dataKey="bound" className="text-xs" />
              <YAxis className="text-xs" allowDecimals={false} />
              <Tooltip
                contentStyle={{
                  background: 'hsl(var(--card))',
                  border: '1px solid hsl(var(--border))',
                }}
              />
              <Area
                type="monotone"
                dataKey="users"
                stroke="#10b981"
                fill="#10b981"
                fillOpacity={0.3}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  )
}

// ── Top Payers ───────────────────────────────────────────────────────────────

function TopPayersCard() {
  const { t } = useTranslation()
  const top = useQuery({
    queryKey: ['analytics', 'top-payers'],
    queryFn: () => getTopPayers(20),
    staleTime: 60_000,
  })
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Trophy className="h-4 w-4" />
          <CardTitle className="text-base">{t('analyticsPage.topPayers.title')}</CardTitle>
        </div>
        <CardDescription>{t('analyticsPage.topPayers.description')}</CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {top.isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : top.data === undefined || top.data.length === 0 ? (
          <p className="px-6 py-4 text-sm text-muted-foreground">{t('analyticsPage.topPayers.empty')}</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/30 text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-3 py-2 w-10">#</th>
                <th className="px-3 py-2">{t('analyticsPage.topPayers.userColumn')}</th>
                <th className="px-3 py-2">{t('analyticsPage.topPayers.telegramColumn')}</th>
                <th className="px-3 py-2 text-right">{t('analyticsPage.topPayers.spentColumn')}</th>
                <th className="px-3 py-2 text-right">{t('analyticsPage.topPayers.txCountColumn')}</th>
                <th className="px-3 py-2 text-right">{t('analyticsPage.topPayers.lastPaymentColumn')}</th>
              </tr>
            </thead>
            <tbody>
              {top.data.map((row, idx) => (
                <tr key={row.userId} className="border-b last:border-0">
                  <td className="px-3 py-2 font-mono text-xs">{idx + 1}</td>
                  <td className="px-3 py-2">
                    {row.name || row.username || (
                      <span className="text-muted-foreground">{t('analyticsPage.topPayers.unknownUser')}</span>
                    )}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                    {row.telegramId ?? '—'}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">
                    {formatCurrency(row.totalSpent)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{row.transactionCount}</td>
                  <td className="px-3 py-2 text-right text-xs text-muted-foreground">
                    {row.lastPaymentAt
                      ? new Date(row.lastPaymentAt).toLocaleDateString()
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  )
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatCurrency(amount: number): string {
  if (Math.abs(amount) >= 1_000_000) {
    return `${(amount / 1_000_000).toFixed(2)}M`
  }
  if (Math.abs(amount) >= 1_000) {
    return `${(amount / 1_000).toFixed(1)}K`
  }
  return amount.toFixed(0)
}
