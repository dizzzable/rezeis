/**
 * Top-of-funnel "Dashboard" tab. Compact 3-column KPI grid + health card +
 * recap + bandwidth + status counters. Designed to fit one screen on a
 * 1440-wide laptop without scrolling beyond the fold.
 */
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { Activity, Cpu, MemoryStick, Server, Users } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

import { remnawaveApi } from '../remnawave-api'
import { KEYS } from '../remnawave-query-keys'
import { formatMemory, summarizeNodes } from '../remnawave-utils'
import { StatTile } from '../shared/stat-tile'
import { TabHeader } from '../shared/tab-header'

import { DashboardBandwidthCard, DashboardRecapCard } from './dashboard-recap-card'
import { DashboardHealthCard } from './dashboard-health-card'

export function DashboardTab() {
  const { t } = useTranslation()
  const { data: stats } = useQuery({ queryKey: KEYS.stats, queryFn: remnawaveApi.getSystemStats })
  const { data: nodes } = useQuery({ queryKey: KEYS.nodes, queryFn: remnawaveApi.getAllNodes })

  const nodeStats = summarizeNodes(nodes ?? [])
  const memTotal = stats?.memory?.total ?? 0
  const memUsed = stats?.memory?.used ?? 0

  return (
    <div className="space-y-4">
      <TabHeader
        title={t('remnaWavePage.dashboard.title')}
        subtitle={t('remnaWavePage.dashboard.subtitle')}
      />

      {/* Row 1: hero KPIs — 4 compact tiles */}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <DashboardHealthCard />
        <StatTile
          icon={Users}
          title={t('remnaWavePage.stats.totalUsers')}
          value={stats?.users?.totalUsers ?? 0}
          subtitle={t('remnaWavePage.stats.last24h', { count: stats?.users?.onlineStats?.lastDay ?? 0 })}
        />
        <StatTile
          icon={Activity}
          title={t('remnaWavePage.stats.onlineNow')}
          value={stats?.users?.onlineStats?.onlineNow ?? 0}
          tone="success"
        />
        <StatTile
          icon={Server}
          title={t('remnaWavePage.stats.nodesOnline')}
          value={nodeStats.online}
          subtitle={t('remnaWavePage.stats.nodesBreakdown', {
            total: nodeStats.total,
            offline: nodeStats.offline,
            disabled: nodeStats.disabled,
          })}
        />
      </div>

      {/* Row 2: machine vitals — CPU/memory in compact cards */}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatTile
          icon={Cpu}
          title={t('remnaWavePage.stats.cpuCores')}
          value={stats?.cpu?.cores ?? 0}
        />
        <StatTile
          icon={MemoryStick}
          title={t('remnaWavePage.dashboard.ram')}
          value={memTotal > 0 ? `${formatMemory(memUsed)} / ${formatMemory(memTotal)}` : '—'}
          subtitle={memTotal > 0 ? `${Math.round((memUsed / memTotal) * 100)}%` : undefined}
        />
        {/* Filler tiles re-using existing data so the row never collapses to 2-up on xl */}
        <DashboardRecapCard />
        <DashboardBandwidthCard />
      </div>

      {/* Row 3: per-status user breakdown */}
      {stats?.users?.statusCounts && Object.keys(stats.users.statusCounts).length > 0 ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">{t('remnaWavePage.userStatus')}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {Object.entries(stats.users.statusCounts).map(([status, count]) => (
                <Badge key={status} variant="outline" className="text-xs px-3 py-1 tabular-nums">
                  {status}: {count}
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  )
}
