import { useState } from 'react'
import type { ComponentType, SVGProps } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  Server,
  Activity,
  Globe,
  Shield,
  Cpu,
  HardDrive,
  Users,
  Smartphone,
  Power,
  PowerOff,
  RotateCcw,
  Trash2,
  AlertCircle,
  Loader2,
} from 'lucide-react'
import { toast } from 'sonner'

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Progress } from '@/components/ui/progress'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'

import { remnawaveApi, type RemnawaveNode } from './remnawave-api'
import { formatBytes, formatUptime, formatMemory, getCountryEmoji, getBandwidthDelta } from './remnawave-utils'

// ── Query keys ───────────────────────────────────────────────────────────────

const KEYS = {
  status: ['remnawave', 'status'],
  stats: ['remnawave', 'stats'],
  recap: ['remnawave', 'recap'],
  bandwidth: ['remnawave', 'bandwidth'],
  nodes: ['remnawave', 'nodes'],
  hosts: ['remnawave', 'hosts'],
  internalSquads: ['remnawave', 'internal-squads'],
  externalSquads: ['remnawave', 'external-squads'],
  configProfiles: ['remnawave', 'config-profiles'],
  hwidStats: ['remnawave', 'hwid-stats'],
} as const

// ── Main Page ────────────────────────────────────────────────────────────────

export default function RemnaWavePage() {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState('overview')

  const { data: status, isLoading: statusLoading, error: statusError } = useQuery({
    queryKey: KEYS.status,
    queryFn: remnawaveApi.getStatus,
    retry: 1,
  })

  if (statusError) {
    return (
      <div className="space-y-6">
        <PageHeader />
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>{t('remnaWavePage.connectionError')}</AlertTitle>
          <AlertDescription>{t('remnaWavePage.connectionErrorDescription')}</AlertDescription>
        </Alert>
      </div>
    )
  }

  if (statusLoading) {
    return (
      <div className="space-y-6">
        <PageHeader />
        <div className="grid gap-4 md:grid-cols-3">
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <PageHeader />

      {/* Status badges */}
      <div className="flex items-center gap-3">
        <Badge variant={status?.isReachable ? 'success' : 'destructive'}>
          {status?.isReachable ? t('remnaWavePage.connected') : t('remnaWavePage.unreachable')}
        </Badge>
        {status?.branding?.title && (
          <span className="text-sm text-muted-foreground">{status.branding.title}</span>
        )}
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="grid w-full grid-cols-7">
          <TabsTrigger value="overview">{t('remnaWavePage.tabs.overview')}</TabsTrigger>
          <TabsTrigger value="nodes">{t('remnaWavePage.tabs.nodes')}</TabsTrigger>
          <TabsTrigger value="hosts">{t('remnaWavePage.tabs.hosts')}</TabsTrigger>
          <TabsTrigger value="squads">{t('remnaWavePage.tabs.squads')}</TabsTrigger>
          <TabsTrigger value="profiles">{t('remnaWavePage.tabs.profiles')}</TabsTrigger>
          <TabsTrigger value="geo">{t('remnaWavePage.tabs.geo')}</TabsTrigger>
          <TabsTrigger value="hwid">{t('remnaWavePage.tabs.hwid')}</TabsTrigger>
        </TabsList>

        <TabsContent value="overview"><OverviewTab /></TabsContent>
        <TabsContent value="nodes"><NodesTab /></TabsContent>
        <TabsContent value="hosts"><HostsTab /></TabsContent>
        <TabsContent value="squads"><SquadsTab /></TabsContent>
        <TabsContent value="profiles"><ProfilesTab /></TabsContent>
        <TabsContent value="geo"><GeoTab /></TabsContent>
        <TabsContent value="hwid"><HwidTab /></TabsContent>
      </Tabs>
    </div>
  )
}

function PageHeader() {
  const { t } = useTranslation()
  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
        <Server className="h-6 w-6" />
        {t('remnaWavePage.title')}
      </h1>
      <p className="text-muted-foreground">{t('remnaWavePage.subtitle')}</p>
    </div>
  )
}

// ── Overview Tab ─────────────────────────────────────────────────────────────

function OverviewTab() {
  const { t } = useTranslation()
  const { data: stats, isLoading: statsLoading } = useQuery({ queryKey: KEYS.stats, queryFn: remnawaveApi.getSystemStats })
  const { data: recap, isLoading: recapLoading } = useQuery({ queryKey: KEYS.recap, queryFn: remnawaveApi.getSystemRecap })
  const { data: bandwidth, isLoading: bwLoading } = useQuery({ queryKey: KEYS.bandwidth, queryFn: remnawaveApi.getBandwidthStats })

  const isLoading = statsLoading || recapLoading || bwLoading

  if (isLoading) {
    return (
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4 mt-4">
        {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-28" />)}
      </div>
    )
  }

  return (
    <div className="space-y-6 mt-4">
      {/* Stats cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={Users} title={t('remnaWavePage.stats.totalUsers')} value={stats?.users.totalUsers ?? 0} />
        <StatCard icon={Activity} title={t('remnaWavePage.stats.onlineNow')} value={stats?.users.onlineStats.onlineNow ?? 0} subtitle={t('remnaWavePage.stats.last24h', { count: stats?.users.onlineStats.lastDay ?? 0 })} />
        <StatCard icon={Server} title={t('remnaWavePage.stats.nodesOnline')} value={stats?.nodes.totalOnline ?? 0} />
        <StatCard icon={Cpu} title={t('remnaWavePage.stats.cpuCores')} value={stats?.cpu.cores ?? 0} subtitle={stats ? `${formatMemory(stats.memory.used)} / ${formatMemory(stats.memory.total)}` : ''} />
      </div>

      {/* Recap + Bandwidth */}
      <div className="grid gap-4 md:grid-cols-2">
        {/* Recap */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('remnaWavePage.recap.title')}</CardTitle>
            <CardDescription>{t('remnaWavePage.recap.version', { version: recap?.version ?? '—' })}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <RecapRow label={t('remnaWavePage.recap.totalUsers')} value={recap?.total.users ?? 0} />
            <RecapRow label={t('remnaWavePage.recap.totalNodes')} value={recap?.total.nodes ?? 0} />
            <RecapRow label={t('remnaWavePage.recap.countries')} value={recap?.total.distinctCountries ?? 0} />
            <RecapRow label={t('remnaWavePage.recap.totalTraffic')} value={formatBytes(Number(recap?.total.traffic ?? 0))} />
            <RecapRow label={t('remnaWavePage.recap.thisMonthUsers')} value={recap?.thisMonth.users ?? 0} />
            <RecapRow label={t('remnaWavePage.recap.thisMonthTraffic')} value={formatBytes(Number(recap?.thisMonth.traffic ?? 0))} />
            <RecapRow label={t('remnaWavePage.recap.uptime')} value={formatUptime(stats?.uptime ?? 0)} />
          </CardContent>
        </Card>

        {/* Bandwidth */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('remnaWavePage.bandwidth.title')}</CardTitle>
            <CardDescription>{t('remnaWavePage.bandwidth.description')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {bandwidth && (
              <>
                <BandwidthRow label={t('remnaWavePage.bandwidth.last2Days')} current={bandwidth.bandwidthLastTwoDays.current} previous={bandwidth.bandwidthLastTwoDays.previous} />
                <BandwidthRow label={t('remnaWavePage.bandwidth.last7Days')} current={bandwidth.bandwidthLastSevenDays.current} previous={bandwidth.bandwidthLastSevenDays.previous} />
                <BandwidthRow label={t('remnaWavePage.bandwidth.last30Days')} current={bandwidth.bandwidthLast30Days.current} previous={bandwidth.bandwidthLast30Days.previous} />
                <BandwidthRow label={t('remnaWavePage.bandwidth.calendarMonth')} current={bandwidth.bandwidthCalendarMonth.current} previous={bandwidth.bandwidthCalendarMonth.previous} />
                <BandwidthRow label={t('remnaWavePage.bandwidth.currentYear')} current={bandwidth.bandwidthCurrentYear.current} previous={bandwidth.bandwidthCurrentYear.previous} />
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* User status breakdown */}
      {stats && Object.keys(stats.users.statusCounts).length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('remnaWavePage.userStatus')}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-3">
              {Object.entries(stats.users.statusCounts).map(([status, count]) => (
                <Badge key={status} variant="outline" className="text-sm px-3 py-1">
                  {status}: {count}
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function StatCard({ icon: Icon, title, value, subtitle }: { icon: ComponentType<SVGProps<SVGSVGElement>>; title: string; value: number | string; subtitle?: string }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{typeof value === 'number' ? value.toLocaleString() : value}</div>
        {subtitle && <p className="text-xs text-muted-foreground mt-1">{subtitle}</p>}
      </CardContent>
    </Card>
  )
}

function RecapRow({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums">{typeof value === 'number' ? value.toLocaleString() : value}</span>
    </div>
  )
}

function BandwidthRow({ label, current, previous }: { label: string; current: number; previous: number }) {
  const delta = getBandwidthDelta(current, previous)
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2">
        <span className="font-medium tabular-nums">{formatBytes(current)}</span>
        <span className={`text-xs ${delta.positive ? 'text-emerald-600' : 'text-red-500'}`}>{delta.label}</span>
      </div>
    </div>
  )
}

// ── Nodes Tab ────────────────────────────────────────────────────────────────

function NodesTab() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { data: nodes, isLoading } = useQuery({ queryKey: KEYS.nodes, queryFn: remnawaveApi.getAllNodes })

  const enableMutation = useMutation({
    mutationFn: remnawaveApi.enableNode,
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: KEYS.nodes }); toast.success(t('remnaWavePage.nodes.toasts.enabled')) },
    onError: () => toast.error(t('remnaWavePage.nodes.toasts.enableFailed')),
  })
  const disableMutation = useMutation({
    mutationFn: remnawaveApi.disableNode,
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: KEYS.nodes }); toast.success(t('remnaWavePage.nodes.toasts.disabled')) },
    onError: () => toast.error(t('remnaWavePage.nodes.toasts.disableFailed')),
  })
  const restartMutation = useMutation({
    mutationFn: remnawaveApi.restartNode,
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: KEYS.nodes }); toast.success(t('remnaWavePage.nodes.toasts.restarted')) },
    onError: () => toast.error(t('remnaWavePage.nodes.toasts.restartFailed')),
  })
  const resetTrafficMutation = useMutation({
    mutationFn: remnawaveApi.resetNodeTraffic,
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: KEYS.nodes }); toast.success(t('remnaWavePage.nodes.toasts.trafficReset')) },
    onError: () => toast.error(t('remnaWavePage.nodes.toasts.trafficResetFailed')),
  })

  if (isLoading) return <TableSkeleton rows={6} />

  if (!nodes || nodes.length === 0) {
    return <EmptyState icon={Server} message={t('remnaWavePage.nodes.empty')} />
  }

  const sortedNodes = [...nodes].sort((a, b) => a.viewPosition - b.viewPosition)

  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle>{t('remnaWavePage.nodes.title')}</CardTitle>
        <CardDescription>{t('remnaWavePage.nodes.count', { count: nodes.length })}</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('remnaWavePage.nodes.columns.node')}</TableHead>
              <TableHead>{t('remnaWavePage.nodes.columns.status')}</TableHead>
              <TableHead>{t('remnaWavePage.nodes.columns.address')}</TableHead>
              <TableHead>{t('remnaWavePage.nodes.columns.traffic')}</TableHead>
              <TableHead>{t('remnaWavePage.nodes.columns.users')}</TableHead>
              <TableHead>{t('remnaWavePage.nodes.columns.uptime')}</TableHead>
              <TableHead className="text-right">{t('remnaWavePage.nodes.columns.actions')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortedNodes.map((node) => (
              <TableRow key={node.uuid}>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <span>{getCountryEmoji(node.countryCode)}</span>
                    <div>
                      <p className="font-medium">{node.name}</p>
                      {node.tags.length > 0 && (
                        <div className="flex gap-1 mt-0.5">
                          {node.tags.slice(0, 3).map((tag) => (
                            <Badge key={tag} variant="outline" className="text-[10px] px-1 py-0">{tag}</Badge>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </TableCell>
                <TableCell>
                  <NodeStatusBadge node={node} />
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {node.address}{node.port ? `:${node.port}` : ''}
                </TableCell>
                <TableCell>
                  {node.trafficLimitBytes ? (
                    <div className="space-y-1 min-w-24">
                      <Progress value={node.trafficUsedBytes && node.trafficLimitBytes ? (node.trafficUsedBytes / node.trafficLimitBytes) * 100 : 0} className="h-1.5" />
                      <p className="text-[10px] text-muted-foreground">
                        {formatBytes(node.trafficUsedBytes)} / {formatBytes(node.trafficLimitBytes)}
                      </p>
                    </div>
                  ) : (
                    <span className="text-xs text-muted-foreground">{t('remnaWavePage.nodes.unlimited')}</span>
                  )}
                </TableCell>
                <TableCell className="tabular-nums">{node.usersOnline}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{formatUptime(node.xrayUptime)}</TableCell>
                <TableCell className="text-right">
                  <div className="flex items-center justify-end gap-1">
                    {node.isDisabled ? (
                      <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => enableMutation.mutate(node.uuid)} disabled={enableMutation.isPending} title={t('remnaActions.enable')} aria-label={t('remnaActions.enable')}>
                        <Power className="h-3.5 w-3.5 text-emerald-600" />
                      </Button>
                    ) : (
                      <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => disableMutation.mutate(node.uuid)} disabled={disableMutation.isPending} title={t('remnaActions.disable')} aria-label={t('remnaActions.disable')}>
                        <PowerOff className="h-3.5 w-3.5 text-destructive" />
                      </Button>
                    )}
                    <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => restartMutation.mutate(node.uuid)} disabled={restartMutation.isPending} title={t('remnaActions.restart')} aria-label={t('remnaActions.restart')}>
                      <RotateCcw className="h-3.5 w-3.5" />
                    </Button>
                    <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => resetTrafficMutation.mutate(node.uuid)} disabled={resetTrafficMutation.isPending} title={t('remnaActions.resetTraffic')} aria-label={t('remnaActions.resetTraffic')}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

function NodeStatusBadge({ node }: { node: RemnawaveNode }) {
  const { t } = useTranslation()
  if (node.isDisabled) return <Badge variant="secondary">{t('remnaWavePage.nodes.statusDisabled')}</Badge>
  if (node.isConnecting) return <Badge variant="warning"><Loader2 className="h-3 w-3 mr-1 animate-spin" />{t('remnaWavePage.nodes.statusConnecting')}</Badge>
  if (node.isConnected) return <Badge variant="success">{t('remnaWavePage.nodes.statusOnline')}</Badge>
  return <Badge variant="destructive">{t('remnaWavePage.nodes.statusOffline')}</Badge>
}

// ── Hosts Tab ────────────────────────────────────────────────────────────────

function HostsTab() {
  const { t } = useTranslation()
  const { data: hosts, isLoading } = useQuery({ queryKey: KEYS.hosts, queryFn: remnawaveApi.getAllHosts })

  if (isLoading) return <TableSkeleton rows={5} />
  if (!hosts || hosts.length === 0) return <EmptyState icon={Globe} message={t('remnaWavePage.hosts.empty')} />

  const sortedHosts = [...hosts].sort((a, b) => a.viewPosition - b.viewPosition)

  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle>{t('remnaWavePage.hosts.title')}</CardTitle>
        <CardDescription>{t('remnaWavePage.hosts.count', { count: hosts.length })}</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('remnaWavePage.hosts.columns.remark')}</TableHead>
              <TableHead>{t('remnaWavePage.hosts.columns.address')}</TableHead>
              <TableHead>{t('remnaWavePage.hosts.columns.port')}</TableHead>
              <TableHead>{t('remnaWavePage.hosts.columns.security')}</TableHead>
              <TableHead>{t('remnaWavePage.hosts.columns.status')}</TableHead>
              <TableHead>{t('remnaWavePage.hosts.columns.nodes')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortedHosts.map((host) => (
              <TableRow key={host.uuid}>
                <TableCell className="font-medium">{host.remark}</TableCell>
                <TableCell className="font-mono text-xs">{host.address}</TableCell>
                <TableCell className="tabular-nums">{host.port}</TableCell>
                <TableCell>
                  <Badge variant="outline" className="text-xs">{host.securityLayer}</Badge>
                </TableCell>
                <TableCell>
                  {host.isDisabled ? (
                    <Badge variant="secondary">{t('remnaWavePage.hosts.statusDisabled')}</Badge>
                  ) : host.isHidden ? (
                    <Badge variant="outline">{t('remnaWavePage.hosts.statusHidden')}</Badge>
                  ) : (
                    <Badge variant="success">{t('remnaWavePage.hosts.statusActive')}</Badge>
                  )}
                </TableCell>
                <TableCell className="tabular-nums">{host.nodes.length}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

// ── Squads Tab ───────────────────────────────────────────────────────────────

function SquadsTab() {
  const { t } = useTranslation()
  const { data: internal, isLoading: iLoading } = useQuery({ queryKey: KEYS.internalSquads, queryFn: remnawaveApi.getInternalSquads })
  const { data: external, isLoading: eLoading } = useQuery({ queryKey: KEYS.externalSquads, queryFn: remnawaveApi.getExternalSquads })

  const isLoading = iLoading || eLoading

  if (isLoading) return <TableSkeleton rows={4} />

  return (
    <div className="space-y-6 mt-4">
      {/* Internal Squads */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('remnaWavePage.squads.internal')}</CardTitle>
          <CardDescription>{internal?.length ?? 0} squads</CardDescription>
        </CardHeader>
        <CardContent>
          {!internal || internal.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">{t('remnaWavePage.squads.noInternal')}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('remnaWavePage.squads.columns.name')}</TableHead>
                  <TableHead>{t('remnaWavePage.squads.columns.members')}</TableHead>
                  <TableHead>{t('remnaWavePage.squads.columns.inbounds')}</TableHead>
                  <TableHead>{t('remnaWavePage.squads.columns.uuid')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {internal.map((squad) => (
                  <TableRow key={squad.uuid}>
                    <TableCell className="font-medium">{squad.name}</TableCell>
                    <TableCell className="tabular-nums">{squad.info.membersCount}</TableCell>
                    <TableCell className="tabular-nums">{squad.info.inboundsCount}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{squad.uuid.slice(0, 8)}…</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* External Squads */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('remnaWavePage.squads.external')}</CardTitle>
          <CardDescription>{external?.length ?? 0} squads</CardDescription>
        </CardHeader>
        <CardContent>
          {!external || external.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">{t('remnaWavePage.squads.noExternal')}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('remnaWavePage.squads.columns.name')}</TableHead>
                  <TableHead>{t('remnaWavePage.squads.columns.members')}</TableHead>
                  <TableHead>{t('remnaWavePage.squads.columns.uuid')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {external.map((squad) => (
                  <TableRow key={squad.uuid}>
                    <TableCell className="font-medium">{squad.name}</TableCell>
                    <TableCell className="tabular-nums">{squad.info.membersCount}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{squad.uuid.slice(0, 8)}…</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

// ── Profiles Tab ─────────────────────────────────────────────────────────────

function ProfilesTab() {
  const { t } = useTranslation()
  const { data: profiles, isLoading } = useQuery({ queryKey: KEYS.configProfiles, queryFn: remnawaveApi.getConfigProfiles })

  if (isLoading) return <TableSkeleton rows={3} />
  if (!profiles || profiles.length === 0) return <EmptyState icon={Shield} message={t('remnaWavePage.profiles.empty')} />

  const sortedProfiles = [...profiles].sort((a, b) => a.viewPosition - b.viewPosition)

  return (
    <div className="space-y-4 mt-4">
      {sortedProfiles.map((profile) => (
        <Card key={profile.uuid}>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">{profile.name}</CardTitle>
              <Badge variant="outline" className="font-mono text-xs">{profile.uuid.slice(0, 8)}…</Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Inbounds */}
            {profile.inbounds.length > 0 && (
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-2">{t('remnaWavePage.profiles.inbounds', { count: profile.inbounds.length })}</p>
                <div className="flex flex-wrap gap-2">
                  {profile.inbounds.map((ib) => (
                    <Badge key={ib.uuid} variant="secondary" className="text-xs">
                      {ib.tag} • {ib.type}{ib.network ? `/${ib.network}` : ''}{ib.port ? `:${ib.port}` : ''}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {/* Nodes */}
            {profile.nodes.length > 0 && (
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-2">{t('remnaWavePage.profiles.nodes', { count: profile.nodes.length })}</p>
                <div className="flex flex-wrap gap-2">
                  {profile.nodes.map((n) => (
                    <Badge key={n.uuid} variant="outline" className="text-xs">
                      {getCountryEmoji(n.countryCode)} {n.name}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

// ── HWID Tab ─────────────────────────────────────────────────────────────────

function HwidTab() {
  const { t } = useTranslation()
  const { data: hwidStats, isLoading } = useQuery({ queryKey: KEYS.hwidStats, queryFn: remnawaveApi.getHwidStats })

  if (isLoading) return <TableSkeleton rows={4} />

  return (
    <div className="space-y-6 mt-4">
      {/* Stats cards */}
      <div className="grid gap-4 md:grid-cols-3">
        <StatCard icon={Smartphone} title={t('remnaWavePage.hwid.totalDevices')} value={hwidStats?.stats.totalHwidDevices ?? 0} />
        <StatCard icon={HardDrive} title={t('remnaWavePage.hwid.uniqueDevices')} value={hwidStats?.stats.totalUniqueDevices ?? 0} />
        <StatCard icon={Users} title={t('remnaWavePage.hwid.avgPerUser')} value={(hwidStats?.stats.averageHwidDevicesPerUser ?? 0).toFixed(1)} />
      </div>

      {/* Platform breakdown */}
      {hwidStats && hwidStats.byPlatform.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('remnaWavePage.hwid.byPlatform')}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {hwidStats.byPlatform
                .sort((a, b) => b.count - a.count)
                .map((item) => {
                  const pct = hwidStats.stats.totalHwidDevices > 0
                    ? (item.count / hwidStats.stats.totalHwidDevices) * 100
                    : 0
                  return (
                    <div key={item.platform} className="space-y-1">
                      <div className="flex items-center justify-between text-sm">
                        <span className="font-medium capitalize">{item.platform || t('remnaActions.unknown')}</span>
                        <span className="tabular-nums text-muted-foreground">{item.count} ({pct.toFixed(0)}%)</span>
                      </div>
                      <Progress value={pct} className="h-2" />
                    </div>
                  )
                })}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

// ── Geo Tab ──────────────────────────────────────────────────────────────────

function GeoTab() {
  const { t } = useTranslation()
  const { data: geo, isLoading } = useQuery({
    queryKey: ['remnawave', 'geo-distribution'],
    queryFn: remnawaveApi.getGeoDistribution,
  })

  if (isLoading) return <TableSkeleton rows={5} />

  if (!geo || geo.length === 0) {
    return <EmptyState icon={Globe} message={t('remnaWavePage.geo.empty')} />
  }

  const totalOnline = geo.reduce((sum, g) => sum + g.usersOnline, 0)

  return (
    <div className="space-y-6 mt-4">
      <div className="grid gap-4 md:grid-cols-3">
        <StatCard icon={Globe} title={t('remnaWavePage.geo.countries')} value={geo.length} />
        <StatCard icon={Users} title={t('remnaWavePage.geo.totalOnline')} value={totalOnline} />
        <StatCard icon={Server} title={t('remnaWavePage.geo.totalNodes')} value={geo.reduce((sum, g) => sum + g.nodesCount, 0)} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('remnaWavePage.geo.distributionTitle')}</CardTitle>
          <CardDescription>{t('remnaWavePage.geo.distributionDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {geo.map((item) => {
              const pct = totalOnline > 0 ? (item.usersOnline / totalOnline) * 100 : 0
              return (
                <div key={item.country} className="space-y-1">
                  <div className="flex items-center justify-between text-sm">
                    <div className="flex items-center gap-2">
                      <span>{getCountryEmoji(item.country)}</span>
                      <span className="font-medium">{item.country}</span>
                      <Badge variant="outline" className="text-[10px]">
                        {item.nodesCount} {item.nodesCount === 1 ? 'node' : 'nodes'}
                      </Badge>
                    </div>
                    <span className="tabular-nums text-muted-foreground">
                      {item.usersOnline} ({pct.toFixed(1)}%)
                    </span>
                  </div>
                  <Progress value={pct} className="h-2" />
                </div>
              )
            })}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

// ── Shared Components ────────────────────────────────────────────────────────

function TableSkeleton({ rows }: { rows: number }) {
  return (
    <div className="space-y-2 mt-4">
      {Array.from({ length: rows }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
    </div>
  )
}

function EmptyState({ icon: Icon, message }: { icon: ComponentType<SVGProps<SVGSVGElement>>; message: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-muted-foreground mt-4">
      <Icon className="h-12 w-12 opacity-30" />
      <p className="text-sm">{message}</p>
    </div>
  )
}
