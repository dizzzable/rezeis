/**
 * Nodes table — drop-in replacement for the legacy NodesTab.
 *
 * Visual upgrades vs. legacy:
 *   - First column shows a country flag SVG with a tooltip + ISO code.
 *   - Status column uses <StatusDot /> with the live pulse on online nodes.
 *   - Traffic column renders a coloured <MetricBar /> instead of a bare
 *     `usedBytes / limitBytes` string.
 *   - Per-row "Restart" / "Disable" / "Reset traffic" actions kept intact.
 */
import { Fragment, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, MoreVertical, Power, RotateCcw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

import { remnawaveApi, type RemnawaveNode } from '../remnawave-api'
import { NodeFlag } from '../remnawave-flags'
import { KEYS } from '../remnawave-query-keys'
import { formatBytes, formatUptime, stripCountryPrefix } from '../remnawave-utils'
import { MetricBar } from '../shared/metric-bar'
import { StatusDot } from '../shared/status-dot'

export function InfraNodesSection() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { data: nodes, isLoading } = useQuery({ queryKey: KEYS.nodes, queryFn: remnawaveApi.getAllNodes })

  const enableMutation = useMutation({
    mutationFn: remnawaveApi.enableNode,
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: KEYS.nodes }); toast.success(t('remnaWavePage.nodes.toasts.enabled')) },
    onError: () => toast.error(t('remnaWavePage.nodes.toasts.enableFailed')),
  })
  const disableMutation = useMutation({
    mutationFn: remnawaveApi.disableNode,
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: KEYS.nodes }); toast.success(t('remnaWavePage.nodes.toasts.disabled')) },
    onError: () => toast.error(t('remnaWavePage.nodes.toasts.disableFailed')),
  })
  const restartMutation = useMutation({
    mutationFn: remnawaveApi.restartNode,
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: KEYS.nodes }); toast.success(t('remnaWavePage.nodes.toasts.restarted')) },
    onError: () => toast.error(t('remnaWavePage.nodes.toasts.restartFailed')),
  })
  const resetTrafficMutation = useMutation({
    mutationFn: remnawaveApi.resetNodeTraffic,
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: KEYS.nodes }); toast.success(t('remnaWavePage.nodes.toasts.trafficReset')) },
    onError: () => toast.error(t('remnaWavePage.nodes.toasts.trafficResetFailed')),
  })

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex h-32 items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden />
        </CardContent>
      </Card>
    )
  }

  if (!nodes || nodes.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          {t('remnaWavePage.nodes.empty')}
        </CardContent>
      </Card>
    )
  }

  const sorted = [...nodes].sort((a, b) => a.viewPosition - b.viewPosition)

  return (
    <Card>
      <CardContent className="px-0 pb-0 pt-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('remnaWavePage.nodes.columns.node')}</TableHead>
              <TableHead>{t('remnaWavePage.nodes.columns.status')}</TableHead>
              <TableHead>{t('remnaWavePage.nodes.columns.address')}</TableHead>
              <TableHead className="min-w-[180px]">{t('remnaWavePage.nodes.columns.traffic')}</TableHead>
              <TableHead className="text-right">{t('remnaWavePage.nodes.columns.users')}</TableHead>
              <TableHead className="text-right">{t('remnaWavePage.nodes.columns.uptime')}</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((node) => (
              <NodeRow
                key={node.uuid}
                node={node}
                onEnable={() => enableMutation.mutate(node.uuid)}
                onDisable={() => disableMutation.mutate(node.uuid)}
                onRestart={() => restartMutation.mutate(node.uuid)}
                onResetTraffic={() => resetTrafficMutation.mutate(node.uuid)}
                pending={
                  (enableMutation.isPending || disableMutation.isPending || restartMutation.isPending || resetTrafficMutation.isPending) &&
                  // Pending state from any mutation that targeted this row — undici-style heuristic.
                  [enableMutation.variables, disableMutation.variables, restartMutation.variables, resetTrafficMutation.variables].includes(node.uuid)
                }
              />
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

interface NodeRowProps {
  readonly node: RemnawaveNode
  readonly pending: boolean
  readonly onEnable: () => void
  readonly onDisable: () => void
  readonly onRestart: () => void
  readonly onResetTraffic: () => void
}

function NodeRow({ node, pending, onEnable, onDisable, onRestart, onResetTraffic }: NodeRowProps) {
  const { t } = useTranslation()
  const [menuOpen, setMenuOpen] = useState(false)

  const status: 'online' | 'offline' | 'disabled' = node.isDisabled ? 'disabled' : node.isConnected ? 'online' : 'offline'
  const statusLabel =
    status === 'online'
      ? t('remnaWavePage.nodes.statusOnline')
      : status === 'offline'
        ? t('remnaWavePage.nodes.statusOffline')
        : t('remnaWavePage.nodes.statusDisabled')

  const usedBytes = node.trafficUsedBytes ?? 0
  const limitBytes = node.trafficLimitBytes ?? 0

  return (
    <TableRow className="text-sm">
      <TableCell>
        <div className="flex items-center gap-3">
          <NodeFlag code={node.countryCode} title={node.countryCode} />
          <div className="min-w-0">
            <p className="truncate font-medium">{stripCountryPrefix(node.name, node.countryCode)}</p>
            {node.tags.length > 0 ? (
              <div className="mt-0.5 flex flex-wrap gap-1">
                {node.tags.map((tag) => (
                  <Badge key={tag} variant="secondary" className="px-1.5 text-[10px] font-normal">
                    {tag}
                  </Badge>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </TableCell>
      <TableCell>
        <StatusDot status={status} label={statusLabel} />
      </TableCell>
      <TableCell className="font-mono text-xs text-muted-foreground">
        {node.address}{node.port ? `:${node.port}` : ''}
      </TableCell>
      <TableCell>
        {limitBytes > 0 ? (
          <MetricBar value={usedBytes} max={limitBytes} format={formatBytes} />
        ) : (
          <span className="text-xs tabular-nums text-muted-foreground">{formatBytes(usedBytes)}</span>
        )}
      </TableCell>
      <TableCell className="text-right tabular-nums">{node.usersOnline}</TableCell>
      <TableCell className="text-right text-xs text-muted-foreground">{formatUptime(node.xrayUptime)}</TableCell>
      <TableCell className="text-right">
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={t('remnaWavePage.nodes.rowActionsLabel')}>
              {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MoreVertical className="h-3.5 w-3.5" />}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {node.isDisabled ? (
              <DropdownMenuItem onClick={onEnable}>
                <Power className="mr-2 h-3.5 w-3.5" />{t('remnaActions.enable')}
              </DropdownMenuItem>
            ) : (
              <Fragment>
                <DropdownMenuItem onClick={onDisable}>
                  <Power className="mr-2 h-3.5 w-3.5" />{t('remnaActions.disable')}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={onRestart}>
                  <RotateCcw className="mr-2 h-3.5 w-3.5" />{t('remnaActions.restart')}
                </DropdownMenuItem>
              </Fragment>
            )}
            <DropdownMenuItem onClick={onResetTraffic}>
              <Trash2 className="mr-2 h-3.5 w-3.5" />{t('remnaActions.resetTraffic')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </TableCell>
    </TableRow>
  )
}
