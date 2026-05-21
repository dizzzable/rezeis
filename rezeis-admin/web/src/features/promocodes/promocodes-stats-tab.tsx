/* eslint-disable @typescript-eslint/no-explicit-any -- TODO: type API responses */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { Tag, Users, Activity } from 'lucide-react'

import { api } from '@/lib/api'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import {
  StatsPeriodFilter,
  type StatsPeriod,
} from '@/features/shared/stats-period-filter'

interface PromocodesStatsResponse {
  totals: { activations: number; uniqueUsers: number }
  byCode: Array<{
    promocodeId: string
    promocodeCode: string
    rewardType: string
    activations: number
    uniqueUsers: number
  }>
  byReward: Array<{
    rewardType: string
    activations: number
    totalRewardValue: number
  }>
  topUsers: Array<{
    userId: string
    displayName: string
    username: string | null
    telegramId: string | null
    activations: number
  }>
  timeline: Array<{ bucket: string; activations: number }>
}

function buildQuery(period: StatsPeriod): string {
  const parts: string[] = []
  if (period.from) parts.push(`from=${period.from.toISOString()}`)
  if (period.to) parts.push(`to=${period.to.toISOString()}`)
  return parts.length > 0 ? `?${parts.join('&')}` : ''
}

export function PromocodesStatsTab() {
  const { t } = useTranslation()
  const [period, setPeriod] = useState<StatsPeriod>({})

  const { data, isLoading } = useQuery({
    queryKey: [
      'admin',
      'promocodes',
      'stats',
      period.from?.toISOString(),
      period.to?.toISOString(),
    ],
    queryFn: async () =>
      (
        await api.get<PromocodesStatsResponse>(`/admin/promocodes/stats${buildQuery(period)}`)
      ).data,
  })

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-20 w-full" />
        <div className="grid gap-3 grid-cols-2">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  const stats = data ?? {
    totals: { activations: 0, uniqueUsers: 0 },
    byCode: [],
    byReward: [],
    topUsers: [],
    timeline: [],
  }

  return (
    <div className="space-y-4">
      <StatsPeriodFilter value={period} onChange={setPeriod} />

      {/* Totals */}
      <div className="grid gap-3 grid-cols-1 sm:grid-cols-2">
        <SummaryTile
          label={t('promocodesIndex.stats.totals.activations')}
          value={stats.totals.activations.toString()}
          icon={<Activity className="h-4 w-4 text-blue-500" />}
        />
        <SummaryTile
          label={t('promocodesIndex.stats.totals.uniqueUsers')}
          value={stats.totals.uniqueUsers.toString()}
          icon={<Users className="h-4 w-4 text-purple-500" />}
        />
      </div>

      {/* By code */}
      <Card>
        <CardContent className="p-0">
          <div className="px-4 py-3 border-b">
            <p className="text-sm font-semibold">
              {t('promocodesIndex.stats.byCode.title')}
            </p>
            <p className="text-xs text-muted-foreground">
              {t('promocodesIndex.stats.byCode.subtitle')}
            </p>
          </div>
          {stats.byCode.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              {t('promocodesIndex.stats.empty')}
            </div>
          ) : (
            <div className="divide-y">
              {stats.byCode.map((row, idx) => (
                <div
                  key={row.promocodeId}
                  className="px-4 py-2.5 flex items-center justify-between gap-3"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-xs font-mono text-muted-foreground w-6">
                      #{idx + 1}
                    </span>
                    <Tag className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="font-mono font-bold text-sm truncate">
                      {row.promocodeCode}
                    </span>
                    <Badge variant="outline" className="text-[10px]">
                      {row.rewardType.replace(/_/g, ' ')}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-3 text-xs whitespace-nowrap">
                    <Badge variant="secondary" className="font-mono">
                      {t('promocodesIndex.stats.byCode.activations', {
                        count: row.activations,
                      })}
                    </Badge>
                    <span className="text-muted-foreground">
                      {t('promocodesIndex.stats.byCode.uniqueUsers', {
                        count: row.uniqueUsers,
                      })}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* By reward type */}
      <Card>
        <CardContent className="p-0">
          <div className="px-4 py-3 border-b">
            <p className="text-sm font-semibold">
              {t('promocodesIndex.stats.byReward.title')}
            </p>
            <p className="text-xs text-muted-foreground">
              {t('promocodesIndex.stats.byReward.subtitle')}
            </p>
          </div>
          {stats.byReward.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              {t('promocodesIndex.stats.empty')}
            </div>
          ) : (
            <div className="divide-y">
              {stats.byReward.map((row) => (
                <div
                  key={row.rewardType}
                  className="px-4 py-2.5 flex items-center justify-between gap-3"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <Badge variant="outline">{row.rewardType.replace(/_/g, ' ')}</Badge>
                  </div>
                  <div className="flex items-center gap-3 text-xs whitespace-nowrap">
                    <Badge variant="secondary" className="font-mono">
                      {t('promocodesIndex.stats.byReward.activations', {
                        count: row.activations,
                      })}
                    </Badge>
                    <span className="text-muted-foreground font-mono">
                      {t('promocodesIndex.stats.byReward.totalReward', {
                        value: row.totalRewardValue,
                      })}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Top users */}
      <Card>
        <CardContent className="p-0">
          <div className="px-4 py-3 border-b">
            <p className="text-sm font-semibold">
              {t('promocodesIndex.stats.topUsers.title')}
            </p>
            <p className="text-xs text-muted-foreground">
              {t('promocodesIndex.stats.topUsers.subtitle')}
            </p>
          </div>
          {stats.topUsers.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              {t('promocodesIndex.stats.empty')}
            </div>
          ) : (
            <div className="divide-y">
              {stats.topUsers.map((row, idx) => (
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
                  <Badge variant="secondary" className="font-mono">
                    {t('promocodesIndex.stats.topUsers.activations', {
                      count: row.activations,
                    })}
                  </Badge>
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
