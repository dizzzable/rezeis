import type { JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { PageTabs, type PageTabItem } from '@/components/layout/page-tabs'
import { Badge } from '@/components/ui/badge'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

export function SettingsLayout(): JSX.Element {
  const { t } = useTranslation()
  const location = useLocation()
  const items: readonly PageTabItem[] = [
    { to: '/settings/panel', label: t('nav.settingsPanel') },
    { to: '/settings/platform', label: t('nav.settingsPlatform') },
    { to: '/settings/api-tokens', label: t('nav.settingsApiTokens') },
  ]
  if (location.pathname === '/settings') {
    return <Navigate replace to="/settings/panel" />
  }
  return (
    <div className="space-y-4">
      <Card className="bg-[linear-gradient(140deg,oklch(0.995_0.004_84.6)_0%,oklch(0.938_0.03_206.87/0.68)_100%)]">
        <CardHeader>
          <Badge className="w-fit">{t('settings.badge')}</Badge>
          <CardTitle className="mt-4 text-2xl">{t('settings.title')}</CardTitle>
          <CardDescription className="mt-2 max-w-3xl">{t('settings.description')}</CardDescription>
        </CardHeader>
      </Card>
      <PageTabs items={items} />
      <Outlet />
    </div>
  )
}
