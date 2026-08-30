/**
 * Remnawave admin page — top-level router.
 *
 * Architecture (post-redesign):
 *
 *   Dashboard │ Live │ Infra │ Catalog │ Users │ Costs │ Settings
 *
 * Each tab is a self-contained file under ./<group>/<group>-tab.tsx and
 * owns its own queries. This file only wires the tab strip and the
 * top-level connectivity status. Heavy sections lazy-load below the fold.
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import {
  AlertCircle,
  CircleDollarSign,
  LayoutDashboard,
  Library,
  Radar,
  Server,
  Settings as SettingsIcon,
  UserSearch,
} from 'lucide-react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

import { remnawaveApi } from './remnawave-api'
import { RemnawaveIcon } from './remnawave-icon'
import { KEYS } from './remnawave-query-keys'

import { CatalogTab } from './catalog/catalog-tab'
import { CostsTab } from './costs/costs-tab'
import { DashboardTab } from './dashboard/dashboard-tab'
import { InfraTab } from './infra/infra-tab'
import { LiveTab } from './live/live-tab'
import { SettingsTab } from './settings/settings-tab'
import { UsersTab } from './users/users-tab'

export default function RemnaWavePage() {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState<TabKey>('dashboard')

  const { data: status, isLoading: statusLoading, error: statusError } = useQuery({
    queryKey: KEYS.status,
    queryFn: remnawaveApi.getStatus,
    retry: 1,
    refetchInterval: 60_000,
  })

  // Detected panel version + capability flags. The Live tab is gated on
  // `liveIpControl`, which answers "can this build read live sessions from
  // this panel" across BOTH endpoint families — `ip-control/*` once it matured
  // on 2.8, `connections/*` on 3.x. Deliberately not a version comparison
  // here: a `>= 2.8` test would have shown the tab on 3.x while every request
  // 404'd, and a `major === 2` test would hide a tab that works. No manual
  // toggle, no redeploy.
  const { data: capabilities } = useQuery({
    queryKey: KEYS.version,
    queryFn: remnawaveApi.getCapabilities,
    retry: 1,
    staleTime: 5 * 60_000,
  })
  const liveAvailable = capabilities?.liveIpControl ?? false

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
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <PageHeader />

      {/* Connectivity status pill row */}
      <div className="flex flex-wrap items-center gap-3">
        <Badge variant={status?.isReachable ? 'success' : 'destructive'}>
          {status?.isReachable ? t('remnaWavePage.connected') : t('remnaWavePage.unreachable')}
        </Badge>
        {capabilities?.version ? (
          <Badge variant="outline" className="font-mono text-[11px]">
            v{capabilities.version}
          </Badge>
        ) : null}
        {status?.branding?.title ? (
          <span className="text-sm text-muted-foreground">{status.branding.title}</span>
        ) : null}
      </div>

      {/* Untested-version notice: the panel responded with a version outside
          the set rezeis has been verified against — an exact set, not a range,
          because the versions between the tested ones are untested too.

          THE VERSIONS ARE DELIBERATELY NOT NAMED HERE. This comment used to
          list them and claimed in the same breath that "nothing here needs
          editing when the set grows" — so when the set changed, the only copy
          nobody checked was this one, and it sat here naming a set the product
          no longer supported. `remnawave-version.service.spec.ts` reads the
          backend set and both locales' prose and fails when they disagree; a
          comment is not one of the three, so it must not hold a fourth copy.
          Membership is decided backend-side by `supported`. */}
      {capabilities && capabilities.reachable && !capabilities.supported ? (
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>{t('remnaWavePage.versionWarning.title')}</AlertTitle>
          <AlertDescription>
            {t('remnaWavePage.versionWarning.description', { version: capabilities.version ?? '?' })}
          </AlertDescription>
        </Alert>
      ) : null}

      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as TabKey)}>
        <TabsList className="flex-wrap">
          <TabsTrigger value="dashboard" className="gap-1.5">
            <LayoutDashboard className="h-3.5 w-3.5" aria-hidden />
            {t('remnaWavePage.tabs.dashboard')}
          </TabsTrigger>
          {liveAvailable ? (
            <TabsTrigger value="live" className="gap-1.5">
              <Radar className="h-3.5 w-3.5" aria-hidden />
              {t('remnaWavePage.tabs.live')}
            </TabsTrigger>
          ) : null}
          <TabsTrigger value="infra" className="gap-1.5">
            <Server className="h-3.5 w-3.5" aria-hidden />
            {t('remnaWavePage.tabs.infra')}
          </TabsTrigger>
          <TabsTrigger value="catalog" className="gap-1.5">
            <Library className="h-3.5 w-3.5" aria-hidden />
            {t('remnaWavePage.tabs.catalog')}
          </TabsTrigger>
          <TabsTrigger value="users" className="gap-1.5">
            <UserSearch className="h-3.5 w-3.5" aria-hidden />
            {t('remnaWavePage.tabs.users')}
          </TabsTrigger>
          <TabsTrigger value="costs" className="gap-1.5">
            <CircleDollarSign className="h-3.5 w-3.5" aria-hidden />
            {t('remnaWavePage.tabs.costs')}
          </TabsTrigger>
          <TabsTrigger value="settings" className="gap-1.5">
            <SettingsIcon className="h-3.5 w-3.5" aria-hidden />
            {t('remnaWavePage.tabs.settings')}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="dashboard" className="mt-4">
          <DashboardTab />
        </TabsContent>
        <TabsContent value="live" className="mt-4">
          <LiveTab />
        </TabsContent>
        <TabsContent value="infra" className="mt-4">
          <InfraTab />
        </TabsContent>
        <TabsContent value="catalog" className="mt-4">
          <CatalogTab />
        </TabsContent>
        <TabsContent value="users" className="mt-4">
          <UsersTab />
        </TabsContent>
        <TabsContent value="costs" className="mt-4">
          <CostsTab />
        </TabsContent>
        <TabsContent value="settings" className="mt-4">
          <SettingsTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}

type TabKey = 'dashboard' | 'live' | 'infra' | 'catalog' | 'users' | 'costs' | 'settings'

function PageHeader() {
  const { t } = useTranslation()
  // Persist the heading until route mount completes — no flash of empty.
  useEffect(() => {
    document.title = `${t('remnaWavePage.title')} · Rezeis Admin`
    return () => {
      document.title = 'Rezeis Admin'
    }
  }, [t])
  return (
    <div>
      <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
        <RemnawaveIcon className="h-6 w-6" />
        {t('remnaWavePage.title')}
      </h1>
      <p className="text-muted-foreground">{t('remnaWavePage.subtitle')}</p>
    </div>
  )
}
