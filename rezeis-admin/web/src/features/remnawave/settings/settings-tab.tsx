/**
 * Settings tab — Remnawave-related operator settings.
 *
 * Cards:
 *   1. "Expired profile cleanup" — EDITABLE panel-managed policy: whether (and
 *      how many days after expiry) the panel deletes the upstream Remnawave
 *      profile. Stored in the panel's own Settings, not in Remnawave. Safe for
 *      multi-project panels (can be turned off entirely).
 *   2. "Subscription delivery" — read-only mirror of Remnawave's own config.
 *   3. "Node plugins" — installed plugins per node (read-only inventory).
 *
 * The delivery + plugins cards are read-only mirrors of Remnawave; only the
 * cleanup policy writes (and it writes to OUR Settings, never to Remnawave).
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Plug, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
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

import { remnawaveApi, type RemnawaveCleanupSettings } from '../remnawave-api'
import { KEYS } from '../remnawave-query-keys'
import { TabHeader } from '../shared/tab-header'
import { getCleanupSettingsFormKey } from './cleanup-settings-form-key'
import { truncate } from '@/lib/utils'

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

      <CleanupCard />

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
            /* Plugin rows are `{ uuid, viewPosition, name, pluginConfig }` on
               both 2.7.4 and 2.8.0. The Version and Node columns read fields
               neither sends, and the Enabled badge read `enabled` — also not
               sent — so `Boolean(undefined)` rendered EVERY plugin as
               disabled. There is no enablement flag upstream to replace it
               with; what the panel does report is the plugin's position and
               whether it carries a config blob. */
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10 text-right">{t('remnaWavePage.settings.plugins.position')}</TableHead>
                  <TableHead>{t('remnaWavePage.settings.plugins.name')}</TableHead>
                  <TableHead className="text-right">{t('remnaWavePage.settings.plugins.config')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {plugins.map((p) => (
                  <TableRow key={p.uuid}>
                    <TableCell className="text-right tabular-nums text-xs text-muted-foreground">
                      {p.viewPosition}
                    </TableCell>
                    <TableCell>
                      <p className="font-medium">{p.name}</p>
                      <p className="font-mono text-[10px] text-muted-foreground/70">{truncate(p.uuid, 8)}</p>
                    </TableCell>
                    <TableCell className="text-right">
                      <Badge variant={p.hasConfig ? 'success' : 'outline'} className="px-2 text-[10px]">
                        {p.hasConfig
                          ? t('remnaWavePage.settings.plugins.configured')
                          : t('remnaWavePage.settings.plugins.configEmpty')}
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

/**
 * Editable Remnawave expired-profile cleanup policy. Persisted in the panel's
 * Settings (NOT in Remnawave) — controls whether and how long after expiry the
 * panel deletes the upstream Remnawave profile. Important for multi-project
 * panels where deleting a profile could wipe another project's user.
 */
function CleanupCard() {
  const { data, isLoading } = useQuery({
    queryKey: KEYS.cleanupSettings,
    queryFn: remnawaveApi.getCleanupSettings,
  })

  return (
    <CleanupCardForm
      key={getCleanupSettingsFormKey(data)}
      initialSettings={data}
      isLoading={isLoading}
    />
  )
}

function CleanupCardForm({
  initialSettings,
  isLoading,
}: {
  initialSettings: RemnawaveCleanupSettings | undefined
  isLoading: boolean
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [deleteEnabled, setDeleteEnabled] = useState(initialSettings?.deleteEnabled ?? true)
  const [graceDays, setGraceDays] = useState(() => String(initialSettings?.graceDays ?? 3))

  const mutation = useMutation({
    mutationFn: () =>
      remnawaveApi.updateCleanupSettings({
        deleteEnabled,
        graceDays: Math.max(0, Math.min(365, Math.trunc(Number(graceDays) || 0))),
      }),
    onSuccess: (next) => {
      queryClient.setQueryData(KEYS.cleanupSettings, next)
      toast.success(t('remnaWavePage.settings.cleanup.saved'))
    },
    onError: () => toast.error(t('remnaWavePage.settings.cleanup.error')),
  })

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <Trash2 className="h-4 w-4 text-muted-foreground" aria-hidden />
          {t('remnaWavePage.settings.cleanup.title')}
        </CardTitle>
        <CardDescription className="text-xs">
          {t('remnaWavePage.settings.cleanup.subtitle')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden />
        ) : (
          <>
            <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
              <div className="space-y-0.5">
                <Label className="text-sm font-medium">
                  {t('remnaWavePage.settings.cleanup.deleteLabel')}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t('remnaWavePage.settings.cleanup.deleteHint')}
                </p>
              </div>
              <Switch
                checked={deleteEnabled}
                onCheckedChange={setDeleteEnabled}
                aria-label={t('remnaWavePage.settings.cleanup.deleteLabel')}
              />
            </div>

            <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
              <div className="space-y-0.5">
                <Label htmlFor="cleanup-grace-days" className="text-sm font-medium">
                  {t('remnaWavePage.settings.cleanup.graceLabel')}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {deleteEnabled
                    ? t('remnaWavePage.settings.cleanup.graceHint')
                    : t('remnaWavePage.settings.cleanup.disabledNote')}
                </p>
              </div>
              <Input
                id="cleanup-grace-days"
                type="number"
                min={0}
                max={365}
                value={graceDays}
                disabled={!deleteEnabled}
                onChange={(e) => setGraceDays(e.target.value)}
                className="w-24"
              />
            </div>

            <div className="flex justify-end">
              <Button
                onClick={() => mutation.mutate()}
                disabled={mutation.isPending}
              >
                {mutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
                {t('remnaWavePage.settings.cleanup.save')}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
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
