import { useEffect, useRef, type ReactElement, type ReactNode } from 'react'
import { LayoutDashboard, Layers3, WalletCards } from 'lucide-react'
import { NavLink, Outlet, createBrowserRouter, useLocation, type RouteObject } from 'react-router-dom'
import { DashboardPage } from '@/features/dashboard/dashboard-page'
import { useAuthSession } from '@/features/auth/auth-provider'
import { PlansPage } from '@/features/plans/plans-page'
import { SubscriptionPage } from '@/features/subscription/subscription-page'
import { WebAccountPage } from '@/features/web-account/web-account-page'
import { getWebAccountLogin } from '@/features/web-account/get-web-account-visibility-state'
import { cn } from '@/lib/utils'

interface NavigationItem {
  readonly label: string
  readonly path: string
  readonly icon: ReactNode
}

const navigationItems: readonly NavigationItem[] = [
  {
    label: 'Dashboard',
    path: '/',
    icon: <LayoutDashboard className="size-4" />,
  },
  {
    label: 'Plans',
    path: '/plans',
    icon: <Layers3 className="size-4" />,
  },
  {
    label: 'Subscription',
    path: '/subscription',
    icon: <WalletCards className="size-4" />,
  },
] as const

export const appRoutes: RouteObject[] = [
  {
    path: '/',
    element: <AppShell />,
    children: [
      {
        index: true,
        element: <DashboardPage />,
      },
      {
        path: 'plans',
        element: <PlansPage />,
      },
      {
        path: 'subscription',
        element: <SubscriptionPage />,
      },
      {
        path: 'web-account',
        element: <WebAccountPage />,
      },
    ],
  },
]

export const router = createBrowserRouter(appRoutes)

export function AppShell(): ReactElement {
  const location = useLocation()
  const authSession = useAuthSession()
  const hasMarkedShellReady = useRef<boolean>(false)
  useEffect(() => {
    if (!authSession.telegramWebApp || hasMarkedShellReady.current) {
      return
    }
    authSession.telegramWebApp.ready()
    if (!authSession.telegramWebApp.isExpanded) {
      authSession.telegramWebApp.expand()
    }
    hasMarkedShellReady.current = true
  }, [authSession.telegramWebApp])
  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top,_rgba(16,185,129,0.14),_transparent_30%),linear-gradient(180deg,_hsl(var(--background)),_hsl(var(--secondary)))] text-foreground">
      <div className="mx-auto flex min-h-screen max-w-7xl flex-col px-4 py-6 sm:px-6 lg:px-8">
        <header className="rounded-3xl border border-border/70 bg-background/85 px-6 py-5 shadow-sm backdrop-blur">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <p className="text-sm font-medium text-primary">RUID user workspace</p>
              <h1 className="mt-2 text-2xl font-semibold tracking-tight">First routed shell backed by the thin user edge.</h1>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
                This web app reads the user API for account, plan, subscription, and platform policy data. Its live write paths now cover rules acceptance, linked web-account login and password follow-up, linked email-verification challenge issuance, and linked email-verification completion. The dedicated plans and subscription routes remain the primary read surfaces, while the dashboard may also show compact summaries and diagnostics.
              </p>
            </div>
            <div className="rounded-2xl bg-secondary/60 px-4 py-3 text-sm">
              <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">{location.pathname === '/plans' ? 'Route context' : 'Session context'}</p>
              <p className="mt-1 font-medium">{getHeaderContextLabel({ authSession, pathname: location.pathname })}</p>
            </div>
          </div>
        </header>
        <div className="mt-6 grid flex-1 gap-6 lg:grid-cols-[240px_minmax(0,1fr)]">
          <aside className="rounded-3xl border border-border/70 bg-card/90 p-4 shadow-sm">
            <nav className="space-y-2">
              {navigationItems.map((item) => (
                <NavLink
                  key={item.path}
                  to={item.path}
                  end={item.path === '/'}
                  className={({ isActive }) =>
                    cn(
                      'flex items-center gap-3 rounded-2xl px-4 py-3 text-sm font-medium transition-colors',
                      isActive ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
                    )
                  }
                >
                  {item.icon}
                  <span>{item.label}</span>
                </NavLink>
              ))}
            </nav>
            <div className="mt-6 rounded-2xl border border-dashed border-border/80 bg-background/70 p-4 text-sm text-muted-foreground">
              <p className="font-medium text-foreground">Thin shell slice</p>
              <p className="mt-2 leading-6">
                Plans stay public. The dedicated plans and subscription routes remain the primary read surfaces, while the dashboard can surface compact summaries from the same read models. The shell now supports rules acceptance, linked web-account login and password follow-up, linked email-verification challenge issuance, and linked email-verification completion inside the existing session boundary.
              </p>
            </div>
          </aside>
          <section key={location.pathname} className="min-w-0">
            <Outlet />
          </section>
        </div>
      </div>
    </main>
  )
}

export function getHeaderContextLabel({ authSession, pathname }: { readonly authSession: ReturnType<typeof useAuthSession>; readonly pathname: string }): string {
  if (pathname === '/plans') {
    return 'Public plan catalog'
  }
  if (authSession.status === 'authenticated' && authSession.sessionQuery.data) {
    return getPrimarySessionIdentity(authSession.sessionQuery.data)
  }
  if (authSession.status === 'loading') {
    return authSession.canBootstrapWithTelegram ? 'Bootstrapping Telegram session' : 'Checking cookie session'
  }
  if (authSession.status === 'error') {
    return 'Session error'
  }
  return authSession.hasTelegramLaunch ? 'Telegram launch detected' : 'Authentication required'
}

function getPrimarySessionIdentity(session: NonNullable<ReturnType<typeof useAuthSession>['sessionQuery']['data']>): string {
  return getWebAccountLogin(session.webAccount) ?? session.username ?? session.email ?? session.id
}
