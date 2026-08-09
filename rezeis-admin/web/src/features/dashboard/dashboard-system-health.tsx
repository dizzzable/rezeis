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
import { RezeisLogo } from '@/components/branding/rezeis-logo'
import { ReiwaMark } from '@/features/branding/reiwa-mark'

import type { SystemHealthResponse } from './dashboard-api'

export function DashboardSystemHealth({
  health,
  loading,
  reiwaHealth,
  reiwaLoading,
}: {
  readonly health: SystemHealthResponse | null
  readonly loading: boolean
  readonly reiwaHealth: SystemHealthResponse | null
  readonly reiwaLoading: boolean
}): JSX.Element {
  const { t } = useTranslation()

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
        {/* Outer tabs = the two services (Rezeis panel + Reiwa cabinet),
            each branded with its own logo. Works whether they share a VPS or
            run on separate hosts (Reiwa metrics are pulled over REIWA_URL). */}
        <Tabs defaultValue="rezeis">
          <TabsList className="mb-4">
            <TabsTrigger value="rezeis" className="gap-1.5">
              <RezeisLogo className="h-3.5 w-3.5" />
              {t('dashboardPage.systemHealth.rezeisTab')}
            </TabsTrigger>
            <TabsTrigger value="reiwa" className="gap-1.5">
              <ReiwaMark className="h-3.5 w-3.5 text-current" />
              {t('dashboardPage.systemHealth.reiwaTab')}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="rezeis" className="mt-0">
            <ServerHealth health={health} loading={loading} />
          </TabsContent>

          <TabsContent value="reiwa" className="mt-0">
            <ServerHealth
              health={reiwaHealth}
              loading={reiwaLoading}
              unavailableMessage={t('dashboardPage.systemHealth.reiwaUnavailable')}
            />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  )
}

/**
 * One server's health: a skeleton while loading, an "unavailable" note when
 * there's no data (e.g. Reiwa unreachable/unconfigured), otherwise the
 * existing VPS / process inner tabs.
 */
function ServerHealth({
  health,
  loading,
  unavailableMessage,
}: {
  readonly health: SystemHealthResponse | null
  readonly loading: boolean
  readonly unavailableMessage?: string
}): JSX.Element {
  const { t } = useTranslation()

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-6 w-full" />
        <Skeleton className="h-6 w-full" />
        <Skeleton className="h-6 w-full" />
        <Skeleton className="h-6 w-full" />
      </div>
    )
  }

  if (!health) {
    return (
      <p className="py-6 text-center text-sm text-muted-foreground">
        {unavailableMessage ?? t('dashboardPage.systemHealth.reiwaUnavailable')}
      </p>
    )
  }

  return (
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
  )
}

/**
 * One absent metrics block must not take the dashboard down.
 *
 * `SystemHealthResponse` types `vps` and `process` as required, but nothing
 * enforces that at runtime: `dashboard-api.ts` reads the response with a bare
 * `api.get<SystemHealthResponse>` cast and no schema parse, so the type is a
 * promise about the contract rather than a fact about the payload. The panel
 * renders this same component for its OWN health and for reiwa's, fetched from
 * a separate service over the network (`getReiwaSystemHealth`), where a version
 * skew or a partial reply is an ordinary event rather than a bug.
 *
 * Dereferencing a missing block threw inside render with no error boundary
 * above it, so React unmounted the whole DashboardPage — the operator lost
 * every widget on the page because one metrics section was unavailable.
 */
function MetricsUnavailable(): JSX.Element {
  const { t } = useTranslation()
  return (
    <p className="py-6 text-center text-sm text-muted-foreground">
      {t('dashboardPage.systemHealth.sectionUnavailable')}
    </p>
  )
}

function VpsMetrics({ health }: { readonly health: SystemHealthResponse }): JSX.Element {
  const { t } = useTranslation()
  const { vps } = health

  if (!vps) return <MetricsUnavailable />

  // `loadAverage` and `network` are arrays in the contract; a partial payload
  // can still carry the block without them, and `[0]` on undefined throws just
  // as hard as the missing block did.
  const load = vps.loadAverage ?? []
  const network = vps.network ?? []

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
          {load[0] ?? '—'} / {load[1] ?? '—'} / {load[2] ?? '—'}
        </span>
      </div>
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">
          {t('dashboardPage.systemHealth.uptime')}
        </span>
        <span className="font-mono text-xs">{formatUptime(vps.uptimeSeconds)}</span>
      </div>
      {network.length > 0 && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">
            {t('dashboardPage.systemHealth.network')}
          </span>
          <span className="font-mono text-xs">
            ↓{formatBytes(network[0]!.rxBytes)} ↑{formatBytes(network[0]!.txBytes)}
          </span>
        </div>
      )}
    </>
  )
}

function ProcessMetrics({ health }: { readonly health: SystemHealthResponse }): JSX.Element {
  const { t } = useTranslation()
  const { process: proc } = health

  if (!proc) return <MetricsUnavailable />

  // This tab reads the VPS block too, for "share of total RAM". A payload
  // carrying `process` without `vps` is exactly the partial reply the guard
  // above exists for, so the share degrades to the bare figure rather than
  // taking a second tab down with the first.
  const ramTotalBytes = health.vps?.ramTotalBytes

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
        percent={ramTotalBytes ? (proc.rssBytes / ramTotalBytes) * 100 : undefined}
        sublabel={
          ramTotalBytes
            ? t('dashboardPage.systemHealth.ofTotal', { total: formatBytes(ramTotalBytes) })
            : undefined
        }
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
  /** Omitted when the share is not derivable — the bar is then left out
   *  rather than drawn at zero, which would read as "idle" instead of
   *  "unknown". Happens when a partial payload carries this metric but not
   *  the VPS total it is a share of. */
  readonly percent?: number
  readonly sublabel?: string
}): JSX.Element {
  const colorClass = percent === undefined
    ? '[&>div]:bg-emerald-500'
    : percent > 90
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
      {percent !== undefined && (
        <Progress value={Math.min(percent, 100)} className={`h-2 ${colorClass}`} />
      )}
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
