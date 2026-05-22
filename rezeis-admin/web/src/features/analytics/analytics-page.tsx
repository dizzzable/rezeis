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
  ArrowRightLeft,
  PieChart as PieChartIcon,
} from 'lucide-react'
import {
  Area,
  AreaChart,
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  Pie,
  PieChart,
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

import {
  getAnalyticsCohorts,
  getAnalyticsOverview,
  getLtvDistribution,
  getRevenueByCurrency,
  getSubscriptionsByPlan,
  getTopPayers,
  getTrialConversion,
  type AdvancedAnalyticsReport,
} from './analytics-api'

const WINDOW_OPTIONS: ReadonlyArray<{ label: string; days: number }> = [
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
  { label: '1y', days: 365 },
]

const DONUT_COLORS = [
  'hsl(142, 71%, 45%)', 'hsl(217, 91%, 60%)', 'hsl(48, 96%, 53%)',
  'hsl(0, 84%, 60%)', 'hsl(262, 83%, 58%)', 'hsl(25, 95%, 53%)',
  'hsl(180, 70%, 45%)', 'hsl(330, 80%, 55%)',
]

export default function AnalyticsPage() {
  const { t } = useTranslation()
  const [days, setDays] = useState(30)
  const [activeTab, setActiveTab] = useState('overview')

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

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="overview">{t('analyticsPage.tabs.overview')}</TabsTrigger>
          <TabsTrigger value="revenue">{t('analyticsPage.tabs.revenue')}</TabsTrigger>
          <TabsTrigger value="conversion">{t('analyticsPage.tabs.conversion')}</TabsTrigger>
          <TabsTrigger value="retention">{t('analyticsPage.tabs.retention')}</TabsTrigger>
          <TabsTrigger value="leaderboard">{t('analyticsPage.tabs.leaderboard')}</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-6 mt-4">
          <OverviewTab report={overview.data} loading={overview.isLoading} />
        </TabsContent>
        <TabsContent value="revenue" className="space-y-6 mt-4">
          <RevenueTab days={days} />
        </TabsContent>
        <TabsContent value="conversion" className="space-y-6 mt-4">
          <ConversionTab days={days} />
        </TabsContent>
        <TabsContent value="retention" className="space-y-6 mt-4">
          <RetentionTab />
        </TabsContent>
        <TabsContent value="leaderboard" className="space-y-6 mt-4">
          <LeaderboardTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}

// ── Overview Tab ─────────────────────────────────────────────────────────────

function OverviewTab({ report, loading }: { report: AdvancedAnalyticsReport | undefined; loading: boolean }) {
  const { t } = useTranslation()
  if (loading || !report) {
    return (
      <div className="grid gap-4 md:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-28" />)}
      </div>
    )
  }
  const { kpis, churn } = report
  return (
    <>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <KpiCard icon={DollarSign} title={t('analyticsPage.kpi.revenue')} value={formatCurrency(kpis.totalRevenue)} subtitle={t('analyticsPage.kpi.revenueSubtitle', { count: kpis.paidCount.toLocaleString() })} />
        <KpiCard icon={Users} title={t('analyticsPage.kpi.payingUsers')} value={kpis.payingUsers.toLocaleString()} subtitle={t('analyticsPage.kpi.payingUsersSubtitle', { arppu: formatCurrency(kpis.arppu), arpu: formatCurrency(kpis.arpu) })} />
        <KpiCard icon={CreditCard} title={t('analyticsPage.kpi.activeSubs')} value={kpis.activeSubscriptions.toLocaleString()} subtitle={t('analyticsPage.kpi.activeSubsSubtitle', { trial: kpis.trialSubscriptions.toLocaleString(), users: kpis.totalUsers.toLocaleString() })} />
        <KpiCard icon={churn.churnRate > 0.1 ? TrendingDown : TrendingUp} title={t('analyticsPage.kpi.retention')} value={`${(churn.retentionRate * 100).toFixed(1)}%`} subtitle={t('analyticsPage.kpi.retentionSubtitle', { churned: churn.churned, total: churn.prevActive })} negative={churn.churnRate > 0.2} />
      </div>
      <DailyChart daily={report.daily} />
      <div className="grid gap-4 lg:grid-cols-2">
        <FunnelCard funnel={report.funnel} />
        <ProvidersCard providers={report.providers} />
      </div>
    </>
  )
}

// ── Revenue Tab ──────────────────────────────────────────────────────────────

function RevenueTab({ days }: { days: number }) {
  const { t } = useTranslation()
  const { data: currencies, isLoading: currLoading } = useQuery({
    queryKey: ['analytics', 'revenue-by-currency', days],
    queryFn: () => getRevenueByCurrency(days),
    staleTime: 60_000,
  })
  const { data: plans, isLoading: plansLoading } = useQuery({
    queryKey: ['analytics', 'subscriptions-by-plan'],
    queryFn: getSubscriptionsByPlan,
    staleTime: 60_000,
  })

  if (currLoading || plansLoading) {
    return <div className="grid gap-4 lg:grid-cols-2"><Skeleton className="h-72" /><Skeleton className="h-72" /></div>
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {/* Revenue by Currency Donut */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <PieChartIcon className="h-4 w-4" />
            {t('analyticsPage.revenue.byCurrencyTitle')}
          </CardTitle>
          <CardDescription>{t('analyticsPage.revenue.byCurrencyDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          {!currencies || currencies.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">{t('analyticsPage.revenue.empty')}</p>
          ) : (
            <div className="flex items-center gap-6">
              <div className="h-52 w-52 shrink-0">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={[...currencies]} cx="50%" cy="50%" innerRadius={45} outerRadius={75} paddingAngle={2} dataKey="revenue">
                      {currencies.map((_, i) => <Cell key={i} fill={DONUT_COLORS[i % DONUT_COLORS.length]} />)}
                    </Pie>
                    <Tooltip formatter={(v: number) => [formatCurrency(v), '']} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="flex flex-col gap-2">
                {currencies.map((item, i) => (
                  <div key={item.currency} className="flex items-center gap-2 text-sm">
                    <div className="h-3 w-3 rounded-full" style={{ backgroundColor: DONUT_COLORS[i % DONUT_COLORS.length] }} />
                    <span className="text-muted-foreground">{item.currency}</span>
                    <span className="font-medium ml-auto">{formatCurrency(item.revenue)}</span>
                    <span className="text-xs text-muted-foreground">({(item.percentage * 100).toFixed(0)}%)</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Subscriptions by Plan Donut */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Layers className="h-4 w-4" />
            {t('analyticsPage.revenue.byPlanTitle')}
          </CardTitle>
          <CardDescription>{t('analyticsPage.revenue.byPlanDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          {!plans || plans.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">{t('analyticsPage.revenue.noPlans')}</p>
          ) : (
            <div className="flex items-center gap-6">
              <div className="h-52 w-52 shrink-0">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={[...plans]} cx="50%" cy="50%" innerRadius={45} outerRadius={75} paddingAngle={2} dataKey="total">
                      {plans.map((_, i) => <Cell key={i} fill={DONUT_COLORS[i % DONUT_COLORS.length]} />)}
                    </Pie>
                    <Tooltip />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="flex flex-col gap-2">
                {plans.map((item, i) => (
                  <div key={item.plan} className="flex items-center gap-2 text-sm">
                    <div className="h-3 w-3 rounded-full" style={{ backgroundColor: DONUT_COLORS[i % DONUT_COLORS.length] }} />
                    <span className="text-muted-foreground truncate max-w-32">{item.plan}</span>
                    <span className="font-medium ml-auto">{item.total}</span>
                    <span className="text-xs text-muted-foreground">({(item.percentage * 100).toFixed(0)}%)</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

// ── Conversion Tab ───────────────────────────────────────────────────────────

function ConversionTab({ days }: { days: number }) {
  const { t } = useTranslation()
  const { data: conversion, isLoading } = useQuery({
    queryKey: ['analytics', 'trial-conversion', days],
    queryFn: () => getTrialConversion(days),
    staleTime: 60_000,
  })

  if (isLoading) {
    return <div className="grid gap-4 md:grid-cols-3"><Skeleton className="h-28" /><Skeleton className="h-28" /><Skeleton className="h-28" /></div>
  }

  if (!conversion) return null

  return (
    <>
      {/* KPI Cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <KpiCard icon={ArrowRightLeft} title={t('analyticsPage.conversion.rate')} value={`${(conversion.conversionRate * 100).toFixed(1)}%`} subtitle={t('analyticsPage.conversion.rateSubtitle', { converted: conversion.convertedUsers, total: conversion.totalTrialUsers })} />
        <KpiCard icon={Users} title={t('analyticsPage.conversion.trialUsers')} value={conversion.totalTrialUsers.toLocaleString()} subtitle={t('analyticsPage.conversion.trialUsersSubtitle', { days })} />
        <KpiCard icon={DollarSign} title={t('analyticsPage.conversion.revenueFromConverted')} value={formatCurrency(conversion.revenueFromConverted)} subtitle={t('analyticsPage.conversion.revenueSubtitle')} />
        <KpiCard icon={TrendingUp} title={t('analyticsPage.conversion.avgDays')} value={`${conversion.avgDaysToConvert}d`} subtitle={t('analyticsPage.conversion.avgDaysSubtitle')} />
      </div>

      {/* Top Converted Plans */}
      {conversion.topConvertedPlans.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('analyticsPage.conversion.topPlansTitle')}</CardTitle>
            <CardDescription>{t('analyticsPage.conversion.topPlansDescription')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {conversion.topConvertedPlans.map((plan) => (
              <div key={plan.plan} className="space-y-1">
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium">{plan.plan}</span>
                  <span className="tabular-nums text-muted-foreground">
                    {plan.count} ({(plan.percentage * 100).toFixed(0)}%)
                  </span>
                </div>
                <Progress value={plan.percentage * 100} className="h-2" />
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </>
  )
}

// ── Retention Tab ────────────────────────────────────────────────────────────

function RetentionTab() {
  const { t } = useTranslation()
  const [cohortOpen, setCohortOpen] = useState(false)
  const cohorts = useQuery({
    queryKey: ['analytics', 'cohorts'],
    queryFn: getAnalyticsCohorts,
    enabled: cohortOpen,
    staleTime: 5 * 60_000,
  })
  const ltv = useQuery({
    queryKey: ['analytics', 'ltv'],
    queryFn: getLtvDistribution,
    staleTime: 5 * 60_000,
  })

  const ltvData = (ltv.data ?? []).map((b) => ({ bound: `≥ ${b.bound}`, users: b.users }))
  const totalLtvUsers = ltvData.reduce((acc, b) => acc + b.users, 0)

  return (
    <>
      {/* Cohort Matrix */}
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle className="text-base">{t('analyticsPage.cohorts.title')}</CardTitle>
              <CardDescription>{t('analyticsPage.cohorts.description')}</CardDescription>
            </div>
            <Button variant="outline" size="sm" onClick={() => setCohortOpen((v) => !v)}>
              {cohortOpen ? t('analyticsPage.cohorts.hide') : t('analyticsPage.cohorts.show')}
            </Button>
          </div>
        </CardHeader>
        {cohortOpen && (
          <CardContent>
            {cohorts.isLoading ? <Skeleton className="h-48 w-full" /> : !cohorts.data || cohorts.data.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('analyticsPage.cohorts.empty')}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="border-b text-muted-foreground">
                    <tr>
                      <th className="px-2 py-2 text-left">{t('analyticsPage.cohorts.cohortColumn')}</th>
                      <th className="px-2 py-2 text-right">{t('analyticsPage.cohorts.sizeColumn')}</th>
                      {Array.from({ length: 12 }).map((_, idx) => <th key={idx} className="px-2 py-2 text-center">M{idx}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {cohorts.data.map((row) => (
                      <tr key={row.cohort} className="border-b last:border-0">
                        <td className="px-2 py-2 font-mono">{row.cohort}</td>
                        <td className="px-2 py-2 text-right tabular-nums">{row.cohortSize}</td>
                        {Array.from({ length: 12 }).map((_, idx) => {
                          const value = row.retentionByMonth[idx]
                          if (value === undefined) return <td key={idx} className="px-2 py-2 text-center text-muted-foreground">—</td>
                          const pct = value * 100
                          const intensity = Math.min(0.85, value)
                          return <td key={idx} className="px-2 py-2 text-center tabular-nums" style={{ background: `rgba(59, 130, 246, ${intensity})`, color: intensity > 0.4 ? 'white' : undefined }}>{pct < 1 ? pct.toFixed(1) : pct.toFixed(0)}%</td>
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

      {/* LTV Distribution */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Layers className="h-4 w-4" />
            <CardTitle className="text-base">{t('analyticsPage.ltv.title')}</CardTitle>
          </div>
          <CardDescription>{t('analyticsPage.ltv.description', { count: totalLtvUsers.toLocaleString() })}</CardDescription>
        </CardHeader>
        <CardContent>
          {ltv.isLoading ? <Skeleton className="h-48 w-full" /> : totalLtvUsers === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">{t('analyticsPage.ltv.empty')}</p>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={ltvData}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="bound" className="text-xs" />
                <YAxis className="text-xs" allowDecimals={false} />
                <Tooltip contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))' }} />
                <Area type="monotone" dataKey="users" stroke="#10b981" fill="#10b981" fillOpacity={0.3} />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>
    </>
  )
}

// ── Leaderboard Tab ──────────────────────────────────────────────────────────

function LeaderboardTab() {
  const { t } = useTranslation()
  const top = useQuery({ queryKey: ['analytics', 'top-payers'], queryFn: () => getTopPayers(20), staleTime: 60_000 })

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
        {top.isLoading ? <Skeleton className="h-32 w-full" /> : !top.data || top.data.length === 0 ? (
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
                  <td className="px-3 py-2">{row.name || row.username || <span className="text-muted-foreground">{t('analyticsPage.topPayers.unknownUser')}</span>}</td>
                  <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{row.telegramId ?? '—'}</td>
                  <td className="px-3 py-2 text-right font-mono">{formatCurrency(row.totalSpent)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{row.transactionCount}</td>
                  <td className="px-3 py-2 text-right text-xs text-muted-foreground">{row.lastPaymentAt ? new Date(row.lastPaymentAt).toLocaleDateString() : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  )
}

// ── Shared Components ────────────────────────────────────────────────────────

function KpiCard({ icon: Icon, title, value, subtitle, negative }: { icon: React.ElementType; title: string; value: string | number; subtitle: string; negative?: boolean }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        <Icon className={`h-4 w-4 ${negative ? 'text-destructive' : 'text-muted-foreground'}`} />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
        <p className="mt-1 text-xs text-muted-foreground">{subtitle}</p>
      </CardContent>
    </Card>
  )
}

function DailyChart({ daily }: { daily: readonly { date: string; revenue: number; newUsers: number; newSubscriptions: number }[] }) {
  const { t } = useTranslation()
  if (!daily || daily.length === 0) return null
  const formatted = daily.map((point) => ({ ...point, label: point.date.slice(5) }))
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
            <Tooltip contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))' }} />
            <Bar yAxisId="left" dataKey="revenue" fill="#3b82f6" radius={[4, 4, 0, 0]} />
            <Line yAxisId="right" type="monotone" dataKey="newUsers" stroke="#10b981" strokeWidth={2} dot={false} />
            <Line yAxisId="right" type="monotone" dataKey="newSubscriptions" stroke="#f59e0b" strokeWidth={2} dot={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  )
}

function FunnelCard({ funnel }: { funnel: readonly { key: string; label: string; count: number; pctOfStart: number; pctOfPrev: number }[] }) {
  const { t } = useTranslation()
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('analyticsPage.funnel.title')}</CardTitle>
        <CardDescription>{t('analyticsPage.funnel.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {funnel.length === 0 ? <p className="text-sm text-muted-foreground">{t('analyticsPage.funnel.empty')}</p> : funnel.map((step) => (
          <div key={step.key} className="space-y-1">
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium">{step.label}</span>
              <span className="tabular-nums text-muted-foreground">{step.count.toLocaleString()} <span className="text-xs">({(step.pctOfStart * 100).toFixed(1)}%)</span></span>
            </div>
            <Progress value={step.pctOfStart * 100} className="h-2" />
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

function ProvidersCard({ providers }: { providers: readonly { gatewayType: string; total: number; completed: number; failed: number; successRate: number; revenue: number }[] }) {
  const { t } = useTranslation()
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('analyticsPage.providers.title')}</CardTitle>
        <CardDescription>{t('analyticsPage.providers.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {providers.length === 0 ? <p className="py-6 text-center text-sm text-muted-foreground">{t('analyticsPage.providers.empty')}</p> : providers.map((p) => (
          <div key={p.gatewayType} className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">{p.gatewayType}</p>
              <p className="text-xs text-muted-foreground">{t('analyticsPage.providers.successCount', { completed: p.completed, total: p.total, failed: p.failed })}</p>
            </div>
            <div className="text-right">
              <p className="font-mono text-sm">{formatCurrency(p.revenue)}</p>
              <Badge variant={p.successRate > 0.8 ? 'success' : p.successRate > 0.5 ? 'warning' : 'destructive'} className="text-xs">{(p.successRate * 100).toFixed(0)}%</Badge>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatCurrency(amount: number): string {
  if (Math.abs(amount) >= 1_000_000) return `${(amount / 1_000_000).toFixed(2)}M`
  if (Math.abs(amount) >= 1_000) return `${(amount / 1_000).toFixed(1)}K`
  return amount.toFixed(0)
}
