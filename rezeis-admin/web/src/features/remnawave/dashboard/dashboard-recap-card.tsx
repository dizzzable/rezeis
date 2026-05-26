/**
 * Compact "system recap" panel — one-card summary of `recap` + `bandwidth`
 * endpoints. Falls back to a polite degradation notice when either endpoint
 * is missing on the current Remnawave version.
 */
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { CalendarClock, TrendingUp } from 'lucide-react'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

import { remnawaveApi } from '../remnawave-api'
import { KEYS } from '../remnawave-query-keys'
import { formatBytes, formatUptime, getBandwidthDelta } from '../remnawave-utils'
import { EndpointDegraded } from '../shared/endpoint-degraded'

export function DashboardRecapCard() {
  const { t } = useTranslation()
  const { data: recap } = useQuery({ queryKey: KEYS.recap, queryFn: remnawaveApi.getSystemRecap })
  const { data: stats } = useQuery({ queryKey: KEYS.stats, queryFn: remnawaveApi.getSystemStats })

  if (!recap) {
    return (
      <EndpointDegraded
        title={t('remnaWavePage.dashboard.recap.title')}
        description={t('remnaWavePage.recap.unavailable')}
        compact
      />
    )
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <CalendarClock className="h-4 w-4 text-muted-foreground" aria-hidden />
          {t('remnaWavePage.dashboard.recap.title')}
        </CardTitle>
        <CardDescription className="text-xs">
          {t('remnaWavePage.recap.version', { version: recap.version ?? '—' })}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <Row label={t('remnaWavePage.recap.totalUsers')} value={(recap.total?.users ?? 0).toLocaleString()} />
        <Row label={t('remnaWavePage.recap.totalNodes')} value={(recap.total?.nodes ?? 0).toLocaleString()} />
        <Row label={t('remnaWavePage.recap.countries')} value={(recap.total?.distinctCountries ?? 0).toLocaleString()} />
        <Row label={t('remnaWavePage.recap.totalTraffic')} value={formatBytes(Number(recap.total?.traffic ?? 0))} />
        <Row label={t('remnaWavePage.recap.thisMonthUsers')} value={(recap.thisMonth?.users ?? 0).toLocaleString()} />
        <Row label={t('remnaWavePage.recap.thisMonthTraffic')} value={formatBytes(Number(recap.thisMonth?.traffic ?? 0))} />
        <Row label={t('remnaWavePage.recap.uptime')} value={formatUptime(stats?.uptime ?? 0)} />
      </CardContent>
    </Card>
  )
}

export function DashboardBandwidthCard() {
  const { t } = useTranslation()
  const { data: bandwidth } = useQuery({ queryKey: KEYS.bandwidth, queryFn: remnawaveApi.getBandwidthStats })

  if (!bandwidth) {
    return (
      <EndpointDegraded
        title={t('remnaWavePage.dashboard.bandwidth.title')}
        description={t('remnaWavePage.bandwidth.unavailable')}
        compact
      />
    )
  }

  const windows = [
    { label: t('remnaWavePage.bandwidth.last2Days'), data: bandwidth.bandwidthLastTwoDays },
    { label: t('remnaWavePage.bandwidth.last7Days'), data: bandwidth.bandwidthLastSevenDays },
    { label: t('remnaWavePage.bandwidth.last30Days'), data: bandwidth.bandwidthLast30Days },
    { label: t('remnaWavePage.bandwidth.calendarMonth'), data: bandwidth.bandwidthCalendarMonth },
    { label: t('remnaWavePage.bandwidth.currentYear'), data: bandwidth.bandwidthCurrentYear },
  ] as const

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <TrendingUp className="h-4 w-4 text-muted-foreground" aria-hidden />
          {t('remnaWavePage.dashboard.bandwidth.title')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {windows.map(({ label, data }) => {
          if (!data) return null
          const delta = getBandwidthDelta(data.current ?? 0, data.previous ?? 0)
          return (
            <div key={label} className="flex items-center justify-between">
              <span className="text-muted-foreground">{label}</span>
              <div className="flex items-center gap-2 text-xs">
                <span className="font-medium tabular-nums text-foreground">{formatBytes(data.current ?? 0)}</span>
                <span className={delta.positive ? 'text-emerald-600' : 'text-red-500'}>{delta.label}</span>
              </div>
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  )
}
