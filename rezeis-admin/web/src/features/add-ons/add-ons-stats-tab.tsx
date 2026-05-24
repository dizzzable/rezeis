import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { TrendingUp, ShoppingBag, Users } from 'lucide-react'

import { api } from '@/lib/api'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import {
  StatsPeriodFilter,
  type StatsPeriod,
} from '@/features/shared/stats-period-filter'

interface AddOnsStatsResponse {
  totals: {
    purchases: number
    uniqueBuyers: number
    revenueByCurrency: Record<string, string>
  }
  topBuyers: Array<{
    userId: string
    displayName: string
    username: string | null
    telegramId: string | null
    purchases: number
    revenueByCurrency: Record<string, string>
  }>
  timeline: Array<{
    bucket: string
    purchases: number
    revenueByCurrency: Record<string, string>
  }>
}

function buildQuery(period: StatsPeriod): string {
  const parts: string[] = []
  if (period.from) parts.push(`from=${period.from.toISOString()}`)
  if (period.to) parts.push(`to=${period.to.toISOString()}`)
  return parts.length > 0 ? `?${parts.join('&')}` : ''
}

function formatRevenue(map: Record<string, string>): string {
  const entries = Object.entries(map)
  if (entries.length === 0) return '0'
  return entries.map(([currency, amount]) => `${amount} ${currency}`).join(' · ')
}

export function AddOnsStatsTab() {
  const { t } = useTranslation()
  const [period, setPeriod] = useState<StatsPeriod>({})

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'add-ons', 'stats', period.from?.toISOString(), period.to?.toISOString()],
    queryFn: async () =>
      (await api.get<AddOnsStatsResponse>(`/admin/add-ons/stats${buildQuery(period)}`)).data,
  })

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-20 w-full" />
        <div className="grid gap-3 grid-cols-2 sm:grid-cols-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  const stats = data ?? {
    totals: { purchases: 0, uniqueBuyers: 0, revenueByCurrency: {} },
    topBuyers: [],
    timeline: [],
  }

  return (
    <div className="space-y-4">
      <StatsPeriodFilter value={period} onChange={setPeriod} />

      <div className="grid gap-3 grid-cols-1 sm:grid-cols-3">
        <SummaryTile
          label={t('addOnsPage.stats.totals.purchases')}
          value={stats.totals.purchases.toString()}
          icon={<ShoppingBag className="h-4 w-4 text-blue-500" />}
        />
        <SummaryTile
          label={t('addOnsPage.stats.totals.revenue')}
          value={formatRevenue(stats.totals.revenueByCurrency)}
          icon={<TrendingUp className="h-4 w-4 text-emerald-500" />}
        />
        <SummaryTile
          label={t('addOnsPage.stats.totals.uniqueBuyers')}
          value={stats.totals.uniqueBuyers.toString()}
          icon={<Users className="h-4 w-4 text-purple-500" />}
        />
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="px-4 py-3 border-b">
            <p className="text-sm font-semibold">{t('addOnsPage.stats.topBuyers.title')}</p>
            <p className="text-xs text-muted-foreground">
              {t('addOnsPage.stats.topBuyers.subtitle')}
            </p>
          </div>
          {stats.topBuyers.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              {t('addOnsPage.stats.empty')}
            </div>
          ) : (
            <div className="divide-y">
              {stats.topBuyers.map((row, idx) => (
                <div
                  key={row.userId}
                  className="px-4 py-2.5 flex items-center justify-between gap-3"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-xs font-mono text-muted-foreground w-6">
                      #{idx + 1}
                    </span>
                    <div className="min-w-0">
                      <p className="font-medium text-sm truncate">{row.displayName}</p>
                      <p className="text-xs text-muted-foreground truncate">
                        {row.username && `@${row.username}`}
                        {row.username && row.telegramId && ' · '}
                        {row.telegramId && `tg:${row.telegramId}`}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 text-xs whitespace-nowrap">
                    <Badge variant="secondary" className="font-mono">
                      {t('addOnsPage.stats.topBuyers.purchases', { count: row.purchases })}
                    </Badge>
                    <span className="font-mono text-foreground">
                      {formatRevenue(row.revenueByCurrency)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function SummaryTile({
  label,
  value,
  icon,
}: {
  label: string
  value: string
  icon: React.ReactNode
}) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {icon}
        {label}
      </div>
      <p className="mt-1 text-xl font-bold font-mono">{value}</p>
    </div>
  )
}
