import { Suspense, lazy } from 'react'
import type { JSX } from 'react'
import { Navigate, createBrowserRouter } from 'react-router-dom'
import { AdminShell } from '@/components/layout/admin-shell'
import { AuthGuard } from '@/components/layout/auth-guard'
import { PublicOnlyRoute } from '@/components/layout/public-only-route'
import { DashboardPage } from '@/features/dashboard/dashboard-page'
import { SectionPlaceholderPage } from '@/features/shared/section-placeholder-page'
import { ApiTokensPage } from '@/features/settings/api-tokens-page'
import { PanelSettingsPage } from '@/features/settings/panel-settings-page'
import { SettingsLayout } from '@/features/settings/settings-layout'
import { UsersLayout } from '@/features/users/users-layout'
import { UsersRoutePage } from '@/features/users/users-route-page'
import { useAuthStore } from '@/stores/auth-store'

const LoginPage = lazy(async () => import('@/features/auth/login-page').then((module) => ({ default: module.LoginPage })))
const PlatformSettingsPage = lazy(async () =>
  import('@/features/settings/platform-settings-page').then((module) => ({ default: module.PlatformSettingsPage })),
)

function RouteFallback(): JSX.Element {
  return <div className="min-h-[240px] animate-pulse rounded-[28px] border border-border/80 bg-card/80" />
}

function RootRedirect(): JSX.Element {
  const token: string = useAuthStore((state) => state.token)
  const destination: string = token ? '/dashboard' : '/login'
  return <Navigate replace to={destination} />
}

export const router = createBrowserRouter([
  {
    path: '/',
    element: <RootRedirect />,
  },
  {
    path: '/login',
    element: (
      <PublicOnlyRoute>
        <Suspense fallback={<RouteFallback />}>
          <LoginPage />
        </Suspense>
      </PublicOnlyRoute>
    ),
  },
  {
    path: '/',
    element: (
      <AuthGuard>
        <AdminShell />
      </AuthGuard>
    ),
    children: [
      {
        path: '/dashboard',
        element: <DashboardPage />,
      },
      {
        path: '/users',
        element: <UsersLayout />,
        children: [
          {
            path: 'search',
            element: <UsersRoutePage pageKey="search" />,
          },
          {
            path: 'recent-registered',
            element: <UsersRoutePage pageKey="recentRegistered" />,
          },
          {
            path: 'recent-active',
            element: <UsersRoutePage pageKey="recentActive" />,
          },
          {
            path: 'blacklist',
            element: <UsersRoutePage pageKey="blacklist" />,
          },
          {
            path: 'invited',
            element: <UsersRoutePage pageKey="invited" />,
          },
        ],
      },
      {
        path: '/broadcast',
        element: <SectionPlaceholderPage sectionKey="broadcast" />,
      },
      {
        path: '/promocodes',
        element: <SectionPlaceholderPage sectionKey="promocodes" />,
      },
      {
        path: '/access-mode',
        element: <SectionPlaceholderPage sectionKey="accessMode" />,
      },
      {
        path: '/remnawave',
        element: <SectionPlaceholderPage sectionKey="remnawave" />,
      },
      {
        path: '/ruid',
        element: <SectionPlaceholderPage sectionKey="ruid" />,
      },
      {
        path: '/imports',
        element: <SectionPlaceholderPage sectionKey="imports" />,
      },
      {
        path: '/settings',
        element: <SettingsLayout />,
        children: [
          {
            path: 'panel',
            element: <PanelSettingsPage />,
          },
          {
            path: 'platform',
            element: (
              <Suspense fallback={<RouteFallback />}>
                <PlatformSettingsPage />
              </Suspense>
            ),
          },
          {
            path: 'api-tokens',
            element: <ApiTokensPage />,
          },
        ],
      },
    ],
  },
  {
    path: '*',
    element: <Navigate replace to="/" />,
  },
])
