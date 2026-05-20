/**
 * Panel Settings Hub — unified settings page (Remnawave-style).
 *
 * Tabs:
 *   1. API Tokens — create/manage tokens for external services (reiwa, etc.)
 *   2. Appearance — theme, colors, radius, layout
 *   3. Security — TOTP 2FA management
 *   4. Branding — brand name, logo URL, profile naming template
 *   5. Backups — DB backup management
 *
 * Replaces the separate /appearance, /settings/api-tokens, /security/2fa,
 * and /backup routes. Accessible via sidebar:
 *   Конфигурация → Настройки панели
 */

import { lazy, Suspense } from 'react'
import { useTranslation } from 'react-i18next'
import { Archive, FileCog, Key, Paintbrush, Palette, Settings, Shield } from 'lucide-react'

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Skeleton } from '@/components/ui/skeleton'
import { FadeIn } from '@/lib/motion'

const ApiTokensTab = lazy(() =>
  import('@/features/settings/api-tokens-page').then((m) => ({
    default: m.ApiTokensPage,
  })),
)
const AppearanceTab = lazy(() => import('@/features/appearance/appearance-page'))
const SecurityTab = lazy(() => import('@/features/two-factor/two-factor-page'))
const BrandingTab = lazy(() => import('./panel-branding-tab'))
const BackupTab = lazy(() => import('@/features/backup/backup-page'))
const ConfigPortabilityTab = lazy(() => import('@/features/config-portability/config-portability-page'))

function TabFallback() {
  return (
    <div className="space-y-4 pt-4">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-64 w-full" />
    </div>
  )
}

export default function PanelSettingsHub() {
  const { t } = useTranslation()

  return (
    <div className="space-y-6">
      <FadeIn>
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <Settings className="h-6 w-6" />
            {t('panelSettings.title')}
          </h1>
          <p className="text-muted-foreground">
            {t('panelSettings.subtitle')}
          </p>
        </div>
      </FadeIn>

      <Tabs defaultValue="api-tokens" className="space-y-4">
        <TabsList className="flex-wrap">
          <TabsTrigger value="api-tokens" className="gap-1.5">
            <Key className="h-3.5 w-3.5" />
            {t('panelSettings.tabs.apiTokens')}
          </TabsTrigger>
          <TabsTrigger value="appearance" className="gap-1.5">
            <Palette className="h-3.5 w-3.5" />
            {t('panelSettings.tabs.appearance')}
          </TabsTrigger>
          <TabsTrigger value="security" className="gap-1.5">
            <Shield className="h-3.5 w-3.5" />
            {t('panelSettings.tabs.security')}
          </TabsTrigger>
          <TabsTrigger value="backups" className="gap-1.5">
            <Archive className="h-3.5 w-3.5" />
            {t('panelSettings.tabs.backups')}
          </TabsTrigger>
          <TabsTrigger value="branding" className="gap-1.5">
            <Paintbrush className="h-3.5 w-3.5" />
            {t('panelSettings.tabs.branding')}
          </TabsTrigger>
          <TabsTrigger value="config" className="gap-1.5">
            <FileCog className="h-3.5 w-3.5" />
            {t('panelSettings.tabs.config')}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="api-tokens">
          <Suspense fallback={<TabFallback />}>
            <ApiTokensTab />
          </Suspense>
        </TabsContent>

        <TabsContent value="appearance">
          <Suspense fallback={<TabFallback />}>
            <AppearanceTab />
          </Suspense>
        </TabsContent>

        <TabsContent value="security">
          <Suspense fallback={<TabFallback />}>
            <SecurityTab />
          </Suspense>
        </TabsContent>

        <TabsContent value="backups">
          <Suspense fallback={<TabFallback />}>
            <BackupTab />
          </Suspense>
        </TabsContent>

        <TabsContent value="branding">
          <Suspense fallback={<TabFallback />}>
            <BrandingTab />
          </Suspense>
        </TabsContent>

        <TabsContent value="config">
          <Suspense fallback={<TabFallback />}>
            <ConfigPortabilityTab embedded />
          </Suspense>
        </TabsContent>
      </Tabs>
    </div>
  )
}
