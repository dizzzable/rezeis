import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import {
  Area,
  AreaChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import {
  ArrowRight,
  BarChart3,
  Crown,
  PieChart as PieIcon,
  TrendingUp,
  Trophy,
} from 'lucide-react'

import { api } from '@/lib/api'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'

/** Granularity supported by the time-series endpoint. */
type Granularity = 'day' | 'week'

interface FunnelData {
  readonly invitesCreated: number
  readonly invitesConsumed: number
  readonly referralsQualified: number
  readonly rewardsIssued: number
  readonly conversion: {
    readonly invitesToConsumed: number
    readonly consumedToQualified: number
    readonly qualifiedToIssued: number
  }
  readonly from: string
  readonly to: string
}

interface TimeseriesPoint {
  readonly bucket: string
  readonly invitesCreated: number
  readonly referralsCreated: number
  readonly referralsQualified: number
  readonly rewardsIssued: number
  readonly pointsIssued: number
}

interface TimeseriesData {
  readonly granularity: Granularity
  readonly from: string
  readonly to: string
  readonly points: readonly TimeseriesPoint[]
}

interface TopReferrer {
  readonly userId: string
  readonly username: string | null
  readonly name: string | null
  readonly telegramId: string | null
  readonly totalReferrals: number
  readonly qualifiedReferrals: number
  readonly conversionRate: number
  readonly rewardsIssued: number
  readonly pointsEarned: number
}

interface TopReferrersData {
  readonly items: readonly TopReferrer[]
  readonly from: string
  readonly to: string
}

interface RewardDistributionData {
  readonly byType: Readonly<Record<string, { issued: number; pending: number; revoked: number }>>
  readonly totals: { readonly issued: number; readonly pending: number; readonly revoked: number }
}

interface SourceBreakdownData {
  readonly bySource: Readonly<Record<string, number>>
  readonly total: number
}

const RANGE_OPTIONS = [
  { id: '7d', days: 7 },
  { id: '30d', days: 30 },
  { id: '90d', days: 90 },
] as const

type RangeId = (typeof RANGE_OPTIONS)[number]['id']

const PIE_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4']

export default function ReferralsAnalyticsTab() {
  const { t } = useTranslation()
  const [rangeId, setRangeId] = useState<RangeId>('30d')

  const { from, to, granularity } = useMemo(() => {
    const days = RANGE_OPTIONS.find((r) => r.id === rangeId)?.days ?? 30
    const toDate = new Date()
    const fromDate = new Date(toDate.getTime() - days * 24 * 60 * 60 * 1000)
    return {
      from: fromDate.toISOString(),
      to: toDate.toISOString(),
      granularity: (days >= 60 ? 'week' : 'day') as Granularity,
    }
  }, [rangeId])

  return (
    <div className="space-y-6 mt-4">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <BarChart3 className="h-5 w-5" />
            {t('referralsAnalytics.title')}
          </h2>
          <p className="text-xs text-muted-foreground">{t('referralsAnalytics.subtitle')}</p>
        </div>
        <Tabs value={rangeId} onValueChange={(v) => setRangeId(v as RangeId)}>
          <TabsList>
            {RANGE_OPTIONS.map((r) => (
              <TabsTrigger key={r.id} value={r.id}>
                {t(`referralsAnalytics.ranges.${r.id}`)}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>

      <FunnelCard from={from} to={to} />

      <div className="grid gap-4 lg:grid-cols-2">
        <TimeseriesCard from={from} to={to} granularity={granularity} />
        <RewardDistributionCard />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <TopReferrersCard from={from} to={to} />
        <SourceBreakdownCard />
      </div>
    </div>
  )
}

// ── Funnel ───────────────────────────────────────────────────────────────────

function FunnelCard({ from, to }: { readonly from: string; readonly to: string }) {
  const { t } = useTranslation()
  const { data, isLoading } = useQuery<FunnelData>({
    queryKey: ['admin', 'referrals', 'analytics', 'funnel', from, to],
    queryFn: async () =>
      (await api.get('/admin/referrals/analytics/funnel', { params: { from, to } })).data,
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <TrendingUp className="h-4 w-4" />
          {t('referralsAnalytics.funnel.title')}
        </CardTitle>
        <CardDescription>{t('referralsAnalytics.funnel.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading || !data ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-7 items-stretch gap-2">
            <FunnelStep label={t('referralsAnalytics.funnel.steps.invitesCreated')} value={data.invitesCreated} />
            <FunnelArrow rate={data.conversion.invitesToConsumed} />
            <FunnelStep label={t('referralsAnalytics.funnel.steps.invitesConsumed')} value={data.invitesConsumed} />
            <FunnelArrow rate={data.conversion.consumedToQualified} />
            <FunnelStep label={t('referralsAnalytics.funnel.steps.referralsQualified')} value={data.referralsQualified} />
            <FunnelArrow rate={data.conversion.qualifiedToIssued} />
            <FunnelStep label={t('referralsAnalytics.funnel.steps.rewardsIssued')} value={data.rewardsIssued} />
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function FunnelStep({ label, value }: { readonly label: string; readonly value: number }) {
  return (
    <div className="rounded-lg border bg-card/50 px-4 py-3 text-center md:col-span-1">
      <p className="text-2xl font-bold tabular-nums">{value.toLocaleString('ru-RU')}</p>
      <p className="text-[11px] text-muted-foreground mt-1">{label}</p>
    </div>
  )
}

function FunnelArrow({ rate }: { readonly rate: number }) {
  const percent = (rate * 100).toFixed(1)
  return (
    <div className="flex items-center justify-center md:col-span-1">
      <div className="flex flex-col items-center text-muted-foreground">
        <ArrowRight className="h-5 w-5" />
        <span className="text-[11px] tabular-nums mt-1">{percent}%</span>
      </div>
    </div>
  )
}

// ── Timeseries ───────────────────────────────────────────────────────────────

function TimeseriesCard({
  from,
  to,
  granularity,
}: {
  readonly from: string
  readonly to: string
  readonly granularity: Granularity
}) {
  const { t } = useTranslation()
  const { data, isLoading } = useQuery<TimeseriesData>({
    queryKey: ['admin', 'referrals', 'analytics', 'timeseries', from, to, granularity],
    queryFn: async () =>
      (
        await api.get('/admin/referrals/analytics/timeseries', {
          params: { from, to, granularity },
        })
      ).data,
  })

  const formatted = useMemo(() => {
    if (!data) return []
    return data.points.map((p) => ({
      ...p,
      bucketLabel: new Date(p.bucket).toLocaleDateString('ru-RU', {
        month: 'short',
        day: 'numeric',
      }),
    }))
  }, [data])

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <TrendingUp className="h-4 w-4" />
          {t('referralsAnalytics.timeseries.title')}
        </CardTitle>
        <CardDescription>{t('referralsAnalytics.timeseries.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading || !data ? (
          <Skeleton className="h-64 w-full" />
        ) : (
          <ResponsiveContainer width="100%" height={260} minWidth={0}>
            <AreaChart data={formatted}>
              <CartesianGrid strokeDasharray="3 3" stroke="#27272a" opacity={0.3} />
              <XAxis dataKey="bucketLabel" stroke="#a1a1aa" fontSize={11} />
              <YAxis stroke="#a1a1aa" fontSize={11} />
              <Tooltip
                contentStyle={{
                  background: 'rgba(24, 24, 27, 0.9)',
                  border: '1px solid #3f3f46',
                  borderRadius: 6,
                }}
              />
              <Legend />
              <Area
                type="monotone"
                dataKey="invitesCreated"
                stackId="1"
                stroke="#3b82f6"
                fill="#3b82f6"
                fillOpacity={0.2}
                name={t('referralsAnalytics.timeseries.legend.invitesCreated')}
              />
              <Area
                type="monotone"
                dataKey="referralsCreated"
                stackId="1"
                stroke="#8b5cf6"
                fill="#8b5cf6"
                fillOpacity={0.2}
                name={t('referralsAnalytics.timeseries.legend.referralsCreated')}
              />
              <Area
                type="monotone"
                dataKey="referralsQualified"
                stackId="1"
                stroke="#10b981"
                fill="#10b981"
                fillOpacity={0.3}
                name={t('referralsAnalytics.timeseries.legend.referralsQualified')}
              />
              <Area
                type="monotone"
                dataKey="rewardsIssued"
                stackId="1"
                stroke="#f59e0b"
                fill="#f59e0b"
                fillOpacity={0.4}
                name={t('referralsAnalytics.timeseries.legend.rewardsIssued')}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  )
}

// ── Reward distribution ─────────────────────────────────────────────────────

function RewardDistributionCard() {
  const { t } = useTranslation()
  const { data, isLoading } = useQuery<RewardDistributionData>({
    queryKey: ['admin', 'referrals', 'analytics', 'reward-distribution'],
    queryFn: async () => (await api.get('/admin/referrals/analytics/reward-distribution')).data,
  })

  const pieData = useMemo(() => {
    if (!data) return []
    const result: Array<{ name: string; value: number }> = []
    for (const [type, counts] of Object.entries(data.byType)) {
      if (counts.issued > 0)
        result.push({ name: `${type} · ${t('referralsAnalytics.distribution.issued')}`, value: counts.issued })
      if (counts.pending > 0)
        result.push({ name: `${type} · ${t('referralsAnalytics.distribution.pending')}`, value: counts.pending })
    }
    if (data.totals.revoked > 0) {
      result.push({ name: t('referralsAnalytics.distribution.revoked'), value: data.totals.revoked })
    }
    return result
  }, [data, t])

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <PieIcon className="h-4 w-4" />
          {t('referralsAnalytics.distribution.title')}
        </CardTitle>
        <CardDescription>{t('referralsAnalytics.distribution.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading || !data ? (
          <Skeleton className="h-64 w-full" />
        ) : pieData.length === 0 ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            {t('referralsAnalytics.distribution.empty')}
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={260} minWidth={0}>
            <PieChart>
              <Pie
                data={pieData}
                cx="50%"
                cy="50%"
                innerRadius={50}
                outerRadius={90}
                paddingAngle={3}
                dataKey="value"
                label={(entry) => {
                  const e = entry as { name?: string; value?: number }
                  return `${e.name ?? ''}: ${e.value ?? 0}`
                }}
              >
                {pieData.map((_, idx) => (
                  <Cell key={idx} fill={PIE_COLORS[idx % PIE_COLORS.length]} />
                ))}
              </Pie>
              <Tooltip
                contentStyle={{
                  background: 'rgba(24, 24, 27, 0.9)',
                  border: '1px solid #3f3f46',
                  borderRadius: 6,
                }}
              />
            </PieChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  )
}

// ── Top referrers ───────────────────────────────────────────────────────────

function TopReferrersCard({ from, to }: { readonly from: string; readonly to: string }) {
  const { t } = useTranslation()
  const { data, isLoading } = useQuery<TopReferrersData>({
    queryKey: ['admin', 'referrals', 'analytics', 'top-referrers', from, to],
    queryFn: async () =>
      (
        await api.get('/admin/referrals/analytics/top-referrers', {
          params: { from, to, limit: 10 },
        })
      ).data,
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Trophy className="h-4 w-4" />
          {t('referralsAnalytics.topReferrers.title')}
        </CardTitle>
        <CardDescription>{t('referralsAnalytics.topReferrers.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading || !data ? (
          <Skeleton className="h-64 w-full" />
        ) : data.items.length === 0 ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            {t('referralsAnalytics.topReferrers.empty')}
          </div>
        ) : (
          <div className="space-y-2">
            {data.items.map((row, idx) => (
              <div
                key={row.userId}
                className="flex items-center gap-3 rounded-md border border-border/40 bg-card/30 px-3 py-2"
              >
                <div className="flex h-7 w-7 items-center justify-center rounded-full bg-muted text-xs font-bold tabular-nums">
                  {idx === 0 ? <Crown className="h-3.5 w-3.5 text-amber-500" /> : idx + 1}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{row.name ?? row.username ?? '—'}</p>
                  <p className="text-xs text-muted-foreground font-mono truncate">
                    {row.telegramId ?? row.userId.slice(0, 8)}
                  </p>
                </div>
                <div className="text-right">
                  <Badge variant="outline" className="text-[10px]">
                    {row.qualifiedReferrals}/{row.totalReferrals}
                  </Badge>
                  <p className="text-[10px] text-muted-foreground mt-1">
                    {(row.conversionRate * 100).toFixed(0)}% · {row.pointsEarned} pts
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

// ── Source breakdown ────────────────────────────────────────────────────────

function SourceBreakdownCard() {
  const { t } = useTranslation()
  const { data, isLoading } = useQuery<SourceBreakdownData>({
    queryKey: ['admin', 'referrals', 'analytics', 'source-breakdown'],
    queryFn: async () => (await api.get('/admin/referrals/analytics/source-breakdown')).data,
  })

  const chartData = useMemo(() => {
    if (!data) return [] as Array<{ name: string; value: number }>
    return Object.entries(data.bySource).map(([name, value]) => ({ name, value }))
  }, [data])

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <PieIcon className="h-4 w-4" />
          {t('referralsAnalytics.sources.title')}
        </CardTitle>
        <CardDescription>{t('referralsAnalytics.sources.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading || !data ? (
          <Skeleton className="h-64 w-full" />
        ) : chartData.length === 0 ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            {t('referralsAnalytics.sources.empty')}
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={260} minWidth={0}>
            <LineChart data={chartData} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke="#27272a" opacity={0.3} />
              <XAxis type="number" stroke="#a1a1aa" fontSize={11} />
              <YAxis dataKey="name" type="category" stroke="#a1a1aa" fontSize={11} width={90} />
              <Tooltip
                contentStyle={{
                  background: 'rgba(24, 24, 27, 0.9)',
                  border: '1px solid #3f3f46',
                  borderRadius: 6,
                }}
              />
              <Line dataKey="value" stroke="#3b82f6" strokeWidth={2} dot />
            </LineChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  )
}
