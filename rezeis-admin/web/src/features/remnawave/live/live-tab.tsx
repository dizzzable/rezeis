/**
 * Live tab — active sessions / source IPs per node.
 *
 * The operator picks a node; we ask the panel for the online users + their
 * source IPs (an async job the backend starts and polls) and render them.
 * Which endpoint family that job runs on is the backend's problem and changes
 * with the panel — `ip-control/*` once it matured on 2.8, `connections/*` on
 * 3.x — so nothing here names one, and the tab is shown or hidden by the
 * `liveIpControl` capability rather than by a version comparison. Read-only
 * inspection: the drop-connections enforcement lives in the anti-fraud module.
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { Loader2, RadioTower, RefreshCw, Wifi } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

import { remnawaveApi } from '../remnawave-api'
import { KEYS } from '../remnawave-query-keys'
import { stripCountryPrefix } from '../remnawave-utils'
import { TabHeader } from '../shared/tab-header'

export function LiveTab() {
  const { t } = useTranslation()
  const [nodeUuid, setNodeUuid] = useState<string | null>(null)

  const { data: nodes, isLoading: nodesLoading } = useQuery({
    queryKey: KEYS.nodes,
    queryFn: remnawaveApi.getAllNodes,
  })

  const {
    data: sessions,
    isFetching,
    refetch,
  } = useQuery({
    queryKey: nodeUuid ? KEYS.liveNode(nodeUuid) : ['remnawave', 'live-node', 'none'],
    queryFn: () => remnawaveApi.getNodeLiveSessions(nodeUuid as string),
    enabled: nodeUuid !== null,
    staleTime: 10_000,
  })

  const totalIps = (sessions ?? []).reduce((acc, s) => acc + s.ips.length, 0)

  return (
    <div className="space-y-4">
      <TabHeader title={t('remnaWavePage.tabs.live')} subtitle={t('remnaWavePage.live.subtitle')} />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <RadioTower className="h-4 w-4 text-muted-foreground" aria-hidden />
            {t('remnaWavePage.live.pickNode')}
          </CardTitle>
          <CardDescription className="text-xs">{t('remnaWavePage.live.pickNodeHint')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          <Select value={nodeUuid ?? undefined} onValueChange={(v) => setNodeUuid(v)}>
            <SelectTrigger className="w-72" aria-label={t('remnaWavePage.live.pickNode')}>
              <SelectValue placeholder={nodesLoading ? t('remnaWavePage.live.loadingNodes') : t('remnaWavePage.live.pickNodePlaceholder')} />
            </SelectTrigger>
            <SelectContent>
              {(nodes ?? []).map((n) => (
                <SelectItem key={n.uuid} value={n.uuid}>
                  {stripCountryPrefix(n.name, n.countryCode)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="sm"
            disabled={nodeUuid === null || isFetching}
            onClick={() => refetch()}
          >
            {isFetching ? (
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <RefreshCw className="mr-2 h-3.5 w-3.5" aria-hidden />
            )}
            {t('remnaWavePage.live.refresh')}
          </Button>
        </CardContent>
      </Card>

      {nodeUuid === null ? null : isFetching && !sessions ? (
        <Card>
          <CardContent className="flex h-32 items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden />
          </CardContent>
        </Card>
      ) : !sessions || sessions.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            {t('remnaWavePage.live.empty')}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <Wifi className="h-4 w-4 text-emerald-500" aria-hidden />
              {t('remnaWavePage.live.online', { users: sessions.length, ips: totalIps })}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {sessions.map((s) => (
              <div key={s.userId} className="rounded-md border border-border/60 p-3">
                <p className="font-mono text-xs text-muted-foreground">{s.userId}</p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {s.ips.map((sample) => (
                    <Badge key={sample.ip} variant="secondary" className="font-mono text-[11px]">
                      {sample.ip}
                    </Badge>
                  ))}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
