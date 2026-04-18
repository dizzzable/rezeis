import type { JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { PageTabs, type PageTabItem } from '@/components/layout/page-tabs'
import { Badge } from '@/components/ui/badge'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

export function UsersLayout(): JSX.Element {
  const { t } = useTranslation()
  const location = useLocation()
  const items: readonly PageTabItem[] = [
    { to: '/users/search', label: t('nav.userSearch') },
    { to: '/users/recent-registered', label: t('nav.usersRecentRegistered') },
    { to: '/users/recent-active', label: t('nav.usersRecentActive') },
    { to: '/users/blacklist', label: t('nav.usersBlacklist') },
    { to: '/users/invited', label: t('nav.usersInvited') },
  ]
  if (location.pathname === '/users') {
    return <Navigate replace to="/users/search" />
  }
  return (
    <div className="space-y-4">
      <Card className="bg-[linear-gradient(140deg,oklch(0.995_0.004_84.6)_0%,oklch(0.938_0.03_206.87/0.68)_100%)]">
        <CardHeader>
          <Badge className="w-fit">{t('users.badge')}</Badge>
          <CardTitle className="mt-4 text-2xl">{t('users.title')}</CardTitle>
          <CardDescription className="mt-2 max-w-3xl">{t('users.description')}</CardDescription>
        </CardHeader>
      </Card>
      <PageTabs items={items} />
      <Outlet />
    </div>
  )
}
