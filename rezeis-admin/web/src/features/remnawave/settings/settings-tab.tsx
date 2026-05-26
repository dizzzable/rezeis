/**
 * Settings tab — read-only mirror of Remnawave's own configuration surface.
 *
 * Two cards:
 *   1. "Subscription delivery" — the same toggle map that Catalog renders,
 *      duplicated here for operators who land on Settings expecting a
 *      Remnawave-mirror experience.
 *   2. "Node plugins" — installed plugins per node (read-only inventory).
 *      Currently empty on the live panel.
 *
 * Nothing here mutates Remnawave settings yet — that ships in a later
 * iteration once we have a clean RBAC story for cross-panel writes.
 */
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { Loader2, Plug } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

import { remnawaveApi } from '../remnawave-api'
import { KEYS } from '../remnawave-query-keys'
import { TabHeader } from '../shared/tab-header'

export function SettingsTab() {
  const { t } = useTranslation()
  const { data: settings, isLoading: loadingSettings } = useQuery({
    queryKey: KEYS.subscriptionSettings,
    queryFn: remnawaveApi.getSubscriptionSettings,
  })
  const { data: plugins, isLoading: loadingPlugins } = useQuery({
    queryKey: KEYS.nodePlugins,
    queryFn: remnawaveApi.getNodePlugins,
  })

  return (
    <div className="space-y-4">
      <TabHeader
        title={t('remnaWavePage.tabs.settings')}
        subtitle={t('remnaWavePage.settings.subtitle')}
      />

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">{t('remnaWavePage.settings.delivery.title')}</CardTitle>
          <CardDescription className="text-xs">
            {settings?.profileTitle ?? t('remnaWavePage.catalog.settings.untitled')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {loadingSettings ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden />
          ) : !settings ? (
            <p className="text-sm text-muted-foreground">{t('remnaWavePage.catalog.settings.empty')}</p>
          ) : (
            <div className="grid gap-2 text-sm sm:grid-cols-2">
              <Row label={t('remnaWavePage.settings.delivery.uuid')} value={<span className="font-mono text-[11px]">{settings.uuid}</span>} />
              <Row label={t('remnaWavePage.settings.delivery.supportLink')} value={settings.supportLink ?? '—'} />
              <Row label={t('remnaWavePage.settings.delivery.profileUpdate')} value={t('remnaWavePage.settings.delivery.everyHours', { hours: settings.profileUpdateInterval })} />
              <Row label={t('remnaWavePage.settings.delivery.serveJson')} value={settings.serveJsonAtBaseSubscription ? t('remnaWavePage.settings.delivery.on') : t('remnaWavePage.settings.delivery.off')} />
              <Row label={t('remnaWavePage.settings.delivery.profileWebpage')} value={settings.isProfileWebpageUrlEnabled ? t('remnaWavePage.settings.delivery.on') : t('remnaWavePage.settings.delivery.off')} />
              <Row label={t('remnaWavePage.settings.delivery.randomizeHosts')} value={settings.randomizeHosts ? t('remnaWavePage.settings.delivery.on') : t('remnaWavePage.settings.delivery.off')} />
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <Plug className="h-4 w-4 text-muted-foreground" aria-hidden />
            {t('remnaWavePage.settings.plugins.title')}
          </CardTitle>
          <CardDescription className="text-xs">
            {t('remnaWavePage.settings.plugins.description', { count: plugins?.length ?? 0 })}
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          {loadingPlugins ? (
            <div className="flex h-24 items-center justify-center">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden />
            </div>
          ) : !plugins || plugins.length === 0 ? (
            <p className="px-6 pb-4 text-sm text-muted-foreground">{t('remnaWavePage.settings.plugins.empty')}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('remnaWavePage.settings.plugins.name')}</TableHead>
                  <TableHead>{t('remnaWavePage.settings.plugins.version')}</TableHead>
                  <TableHead>{t('remnaWavePage.settings.plugins.node')}</TableHead>
                  <TableHead className="text-right">{t('remnaWavePage.settings.plugins.enabled')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {plugins.map((p) => (
                  <TableRow key={p.uuid}>
                    <TableCell className="font-medium">{p.name}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{p.version ?? '—'}</TableCell>
                    <TableCell className="font-mono text-[10px] text-muted-foreground/70">
                      {p.nodeUuid ? `${p.nodeUuid.slice(0, 8)}…` : '—'}
                    </TableCell>
                    <TableCell className="text-right">
                      <Badge variant={p.enabled ? 'success' : 'outline'} className="px-2 text-[10px]">
                        {p.enabled ? t('remnaWavePage.settings.delivery.on') : t('remnaWavePage.settings.delivery.off')}
                      </Badge>
                    </TableCell>
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

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  )
}
