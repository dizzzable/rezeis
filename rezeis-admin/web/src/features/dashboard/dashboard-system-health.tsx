import { type JSX } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Cpu,
  HardDrive,
  MemoryStick,
  Activity,
  Server,
  Bot,
} from 'lucide-react'

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
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

import type { SystemHealthResponse } from './dashboard-api'

export function DashboardSystemHealth({
  health,
  loading,
}: {
  readonly health: SystemHealthResponse | null
  readonly loading: boolean
}): JSX.Element {
  const { t } = useTranslation()

  if (loading || !health) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Server className="h-4 w-4" />
            {t('dashboardPage.systemHealth.title')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-full" />
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2">
          <Server className="h-4 w-4" />
          {t('dashboardPage.systemHealth.title')}
        </CardTitle>
        <CardDescription>
          {t('dashboardPage.systemHealth.description')}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="vps">
          <TabsList className="mb-4">
            <TabsTrigger value="vps" className="gap-1.5">
              <Server className="h-3.5 w-3.5" />
              {t('dashboardPage.systemHealth.vpsTab')}
            </TabsTrigger>
            <TabsTrigger value="process" className="gap-1.5">
              <Bot className="h-3.5 w-3.5" />
              {t('dashboardPage.systemHealth.processTab')}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="vps" className="space-y-4 mt-0">
            <VpsMetrics health={health} />
          </TabsContent>

          <TabsContent value="process" className="space-y-4 mt-0">
            <ProcessMetrics health={health} />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  )
}

function VpsMetrics({ health }: { readonly health: SystemHealthResponse }): JSX.Element {
  const { t } = useTranslation()
  const { vps } = health

  return (
    <>
      <MetricRow
        icon={Cpu}
        label={t('dashboardPage.systemHealth.cpu')}
        value={`${vps.cpuUsagePercent}%`}
        percent={vps.cpuUsagePercent}
        sublabel={`${vps.cpuCoreCount} ${t('dashboardPage.systemHealth.cores')} · ${truncateModel(vps.cpuModel)}`}
      />
      <MetricRow
        icon={MemoryStick}
        label={t('dashboardPage.systemHealth.ram')}
        value={`${formatBytes(vps.ramUsedBytes)} / ${formatBytes(vps.ramTotalBytes)}`}
        percent={vps.ramUsagePercent}
      />
      <MetricRow
        icon={HardDrive}
        label={t('dashboardPage.systemHealth.disk')}
        value={`${formatBytes(vps.diskUsedBytes)} / ${formatBytes(vps.diskTotalBytes)}`}
        percent={vps.diskUsagePercent}
      />
      <div className="flex items-center justify-between text-sm">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Activity className="h-4 w-4" />
          <span>{t('dashboardPage.systemHealth.loadAverage')}</span>
        </div>
        <span className="font-mono text-xs">
          {vps.loadAverage[0]} / {vps.loadAverage[1]} / {vps.loadAverage[2]}
        </span>
      </div>
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">
          {t('dashboardPage.systemHealth.uptime')}
        </span>
        <span className="font-mono text-xs">{formatUptime(vps.uptimeSeconds)}</span>
      </div>
      {vps.network.length > 0 && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">
            {t('dashboardPage.systemHealth.network')}
          </span>
          <span className="font-mono text-xs">
            ↓{formatBytes(vps.network[0].rxBytes)} ↑{formatBytes(vps.network[0].txBytes)}
          </span>
        </div>
      )}
    </>
  )
}

function ProcessMetrics({ health }: { readonly health: SystemHealthResponse }): JSX.Element {
  const { t } = useTranslation()
  const { process: proc } = health

  return (
    <>
      <MetricRow
        icon={Cpu}
        label={t('dashboardPage.systemHealth.processCpu')}
        value={`${proc.cpuUsagePercent}%`}
        percent={Math.min(proc.cpuUsagePercent, 100)}
      />
      <MetricRow
        icon={MemoryStick}
        label={t('dashboardPage.systemHealth.rss')}
        value={formatBytes(proc.rssBytes)}
        percent={(proc.rssBytes / health.vps.ramTotalBytes) * 100}
        sublabel={t('dashboardPage.systemHealth.ofTotal', { total: formatBytes(health.vps.ramTotalBytes) })}
      />
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">
          {t('dashboardPage.systemHealth.heap')}
        </span>
        <span className="font-mono text-xs">
          {formatBytes(proc.heapUsedBytes)} / {formatBytes(proc.heapTotalBytes)}
        </span>
      </div>
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">
          {t('dashboardPage.systemHealth.eventLoopLag')}
        </span>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className={`font-mono text-xs ${proc.eventLoopLagMs > 50 ? 'text-red-500' : proc.eventLoopLagMs > 10 ? 'text-yellow-500' : 'text-emerald-500'}`}>
                {proc.eventLoopLagMs}ms
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {t('dashboardPage.systemHealth.eventLoopLagTooltip')}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">
          {t('dashboardPage.systemHealth.processUptime')}
        </span>
        <span className="font-mono text-xs">{formatUptime(proc.uptimeSeconds)}</span>
      </div>
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">
          {t('dashboardPage.systemHealth.nodeVersion')}
        </span>
        <span className="font-mono text-xs">{proc.nodeVersion}</span>
      </div>
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">PID</span>
        <span className="font-mono text-xs">{proc.pid}</span>
      </div>
    </>
  )
}

function MetricRow({
  icon: Icon,
  label,
  value,
  percent,
  sublabel,
}: {
  readonly icon: React.ComponentType<{ className?: string }>
  readonly label: string
  readonly value: string
  readonly percent: number
  readonly sublabel?: string
}): JSX.Element {
  const colorClass = percent > 90
    ? '[&>div]:bg-red-500'
    : percent > 75
      ? '[&>div]:bg-yellow-500'
      : '[&>div]:bg-emerald-500'

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-sm">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Icon className="h-4 w-4" />
          <span>{label}</span>
        </div>
        <span className="font-mono text-xs font-medium">{value}</span>
      </div>
      <Progress value={Math.min(percent, 100)} className={`h-2 ${colorClass}`} />
      {sublabel && (
        <p className="text-xs text-muted-foreground">{sublabel}</p>
      )}
    </div>
  )
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  const value = bytes / Math.pow(1024, i)
  return `${value.toFixed(i > 1 ? 1 : 0)} ${units[i]}`
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

function truncateModel(model: string): string {
  // Shorten long CPU model names
  return model.length > 30 ? model.slice(0, 27) + '…' : model
}
