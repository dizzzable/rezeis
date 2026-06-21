/* eslint-disable react-refresh/only-export-components */
import { createBrowserRouter, Navigate, useLocation } from 'react-router-dom'
import { lazy as reactLazy, Suspense, type ComponentType, type LazyExoticComponent } from 'react'
import ProtectedRoute from './protected-route'
import AdminShell from '@/components/layout/admin-shell'
import { Skeleton } from '@/components/ui/skeleton'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { withFeatureBundle } from '@/i18n/i18n'

/**
 * Wraps children in an ErrorBoundary that resets whenever the
 * route pathname changes so a previous page error does not block
 * navigation to a new route.
 */
function RouteErrorBoundary({ children }: { readonly children: React.ReactNode }) {
  const { pathname } = useLocation()
  return <ErrorBoundary key={pathname}>{children}</ErrorBoundary>
}

const CHUNK_RELOAD_KEY = 'reiwa:chunk-reload'

/**
 * Recover from stale lazy chunks after a deploy.
 *
 * When a new build ships, an old `index.html` still live in a user's tab or
 * PWA cache references chunk hashes that no longer exist on the server, so the
 * dynamic import 404s ("Failed to fetch dynamically imported module"). We force
 * a single full reload to pull the fresh `index.html` + asset graph. A
 * sessionStorage guard prevents a reload loop when the failure is genuine, and
 * is cleared on every successful load so a later deploy can recover again.
 */
function reloadOnStale<T extends { default: ComponentType<unknown> }>(
  factory: () => Promise<T>,
): () => Promise<T> {
  return async () => {
    try {
      const mod = await factory()
      sessionStorage.removeItem(CHUNK_RELOAD_KEY)
      return mod
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const isStaleChunk =
        /failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed/i.test(
          message,
        )
      if (isStaleChunk && sessionStorage.getItem(CHUNK_RELOAD_KEY) !== '1') {
        sessionStorage.setItem(CHUNK_RELOAD_KEY, '1')
        window.location.reload()
        // Never resolve so React keeps the Suspense fallback while the page reloads.
        return new Promise<T>(() => {})
      }
      throw error
    }
  }
}

/** Drop-in for `React.lazy` that auto-recovers from stale chunks post-deploy. */
function lazy<T extends ComponentType<unknown>>(
  factory: () => Promise<{ default: T }>,
): LazyExoticComponent<T> {
  return reactLazy(reloadOnStale(factory))
}

// Lazy-load pages
const SignInPage = lazy(() => import('@/features/auth/sign-in-page'))
const ForcePasswordChangePage = lazy(() => import('@/features/auth/force-password-change-page'))
const DashboardPage = lazy(
  withFeatureBundle('dashboard', () => import('@/features/dashboard/dashboard-page')),
)
const RemnaWavePage = lazy(
  withFeatureBundle('remnawave', () => import('@/features/remnawave/remnawave-page')),
)
const AdminsPage = lazy(() => import('@/features/admins/admins-page'))
const UsersPage = lazy(() => import('@/features/users/users-page'))
const UserDetailPage = lazy(
  withFeatureBundle('userDetail', () => import('@/features/users/user-detail-page')),
)
const PlansPage = lazy(() => import('@/features/plans/plans-page'))
const SubscriptionsPage = lazy(() => import('@/features/subscriptions/subscriptions-page'))
const PaymentsPage = lazy(
  withFeatureBundle('payments', () => import('@/features/payments/payments-page')),
)
const PromocodesPage = lazy(() => import('@/features/promocodes/promocodes-page'))
const ReferralsPage = lazy(() => import('@/features/referrals/referrals-page'))
const PartnersPage = lazy(() => import('@/features/partners/partners-page'))
const BroadcastPage = lazy(
  withFeatureBundle('broadcast', () => import('@/features/broadcast/broadcast-page')),
)
const SettingsPage = lazy(
  withFeatureBundle('platformSettings', () => import('@/features/settings/settings-page')),
)
const ApiTokensPage = lazy(
  withFeatureBundle('platformSettings', () =>
    import('@/features/settings/api-tokens-page').then(m => ({ default: m.ApiTokensPage })),
  ),
)
const PanelSettingsHub = lazy(() => import('@/features/settings/panel-settings-hub'))
const WebReiwaPage = lazy(() => import('@/features/branding/branding-page'))
const AnalyticsPage = lazy(
  withFeatureBundle('analytics', () => import('@/features/analytics/analytics-page')),
)
const BotMapPage = lazy(
  withFeatureBundle('botMap', () => import('@/features/bot-map/bot-map-page')),
)
const CustomEmojiPage = lazy(() => import('@/features/custom-emoji/custom-emoji-page'))
const NotificationsPage = lazy(
  withFeatureBundle('notifications', () => import('@/features/notifications/notifications-page')),
)
const GatewaySettingsPage = lazy(
  withFeatureBundle('payments', () => import('@/features/payments/gateway-settings-page')),
)
const ReferralSettingsPage = lazy(() => import('@/features/settings/referral-settings-page'))
const PartnerSettingsPage = lazy(() => import('@/features/settings/partner-settings-page'))
// Backup UI is now embedded as a tab in /settings/panel; old route redirects.
const ImportsPage = lazy(
  withFeatureBundle('imports', () => import('@/features/imports/imports-page')),
)
const AuditPage = lazy(() => import('@/features/audit/audit-page'))
const FraudSignalsPage = lazy(() => import('@/features/fraud/fraud-page'))
const AutomationsPage = lazy(
  withFeatureBundle('automations', () => import('@/features/automations/automations-page')),
)
// Blocked IPs page is now embedded as a tab in /admins; old route redirects.
// Roles UI is now embedded as a tab in /admins; old route redirects.
// Note: Withdrawals UI is now embedded as a tab in /partners. The standalone
// /withdrawals route redirects into the corresponding tab to preserve
// external deep links.
const SupportTicketsPage = lazy(() => import('@/features/support-tickets/support-tickets-page'))
const FaqPage = lazy(() => import('@/features/faq/faq-page'))
// Two-factor UI is now embedded as a tab in /settings/panel; old route redirects.
// IP allowlist, Webhooks, Blocked IPs are now embedded as tabs in /admins; old routes redirect.
// Config portability is now embedded as a tab in /settings/panel; old route redirects.
// System logs are now embedded as a tab in /audit; old route redirects.
// Bulk users UI is now embedded as a tab in /users; old route redirects.
const AddOnsPage = lazy(() => import('@/features/add-ons/add-ons-page'))
const NotFoundPage = lazy(() => import('./not-found-page'))

function PageFallback() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-64 w-full" />
    </div>
  )
}

function withSuspense(element: React.ReactNode) {
  return (
    <RouteErrorBoundary>
      <Suspense fallback={<PageFallback />}>{element}</Suspense>
    </RouteErrorBoundary>
  )
}

export const router = createBrowserRouter([
  {
    path: '/sign-in',
    element: withSuspense(<SignInPage />),
  },
  {
    element: <ProtectedRoute />,
    children: [
      {
        path: 'change-password',
        element: withSuspense(<ForcePasswordChangePage />),
      },
      {
        element: (
          <ErrorBoundary>
            <AdminShell />
          </ErrorBoundary>
        ),
        children: [
          { index: true, element: withSuspense(<DashboardPage />) },
          { path: 'users', element: withSuspense(<UsersPage />) },
          { path: 'users/:telegramId', element: withSuspense(<UserDetailPage />) },
          { path: 'plans', element: withSuspense(<PlansPage />) },
          { path: 'add-ons', element: withSuspense(<AddOnsPage />) },
          { path: 'subscriptions', element: withSuspense(<SubscriptionsPage />) },
          { path: 'payments', element: withSuspense(<PaymentsPage />) },
          { path: 'promocodes', element: withSuspense(<PromocodesPage />) },
          { path: 'referrals', element: withSuspense(<ReferralsPage />) },
          { path: 'partners', element: withSuspense(<PartnersPage />) },
          { path: 'broadcast', element: withSuspense(<BroadcastPage />) },
          { path: 'emoji-packs', element: withSuspense(<CustomEmojiPage />) },
          { path: 'remnawave', element: withSuspense(<RemnaWavePage />) },
          { path: 'settings', element: withSuspense(<SettingsPage />) },
          { path: 'web-reiwa', element: withSuspense(<WebReiwaPage />) },
          { path: 'settings/api-tokens', element: withSuspense(<ApiTokensPage />) },
          { path: 'settings/panel', element: withSuspense(<PanelSettingsHub />) },
          { path: 'bot-config', element: <Navigate to="/bot-map" replace /> },
          { path: 'bot-flow', element: <Navigate to="/bot-map" replace /> },
          { path: 'bot-map', element: withSuspense(<BotMapPage />) },
          { path: 'analytics', element: withSuspense(<AnalyticsPage />) },
          { path: 'admins', element: withSuspense(<AdminsPage />) },
          { path: 'admins/roles', element: <Navigate to="/admins#roles" replace /> },
          { path: 'appearance', element: <Navigate to="/settings/panel#appearance" replace /> },
          { path: 'branding', element: <Navigate to="/settings/panel#branding" replace /> },
          { path: 'notifications', element: withSuspense(<NotificationsPage />) },
          { path: 'payments/gateways', element: withSuspense(<GatewaySettingsPage />) },
          { path: 'settings/referral', element: withSuspense(<ReferralSettingsPage />) },
          { path: 'settings/partner', element: withSuspense(<PartnerSettingsPage />) },
          { path: 'backup', element: <Navigate to="/settings/panel#backups" replace /> },
          { path: 'imports', element: withSuspense(<ImportsPage />) },
          { path: 'audit', element: withSuspense(<AuditPage />) },
          { path: 'fraud', element: withSuspense(<FraudSignalsPage />) },
          { path: 'automations', element: withSuspense(<AutomationsPage />) },
          { path: 'blocked-ips', element: <Navigate to="/admins#blocked-ips" replace /> },
          { path: 'withdrawals', element: <Navigate to="/partners#withdrawals" replace /> },
          { path: 'support-tickets', element: withSuspense(<SupportTicketsPage />) },
          { path: 'faq', element: withSuspense(<FaqPage />) },
          { path: 'security/2fa', element: <Navigate to="/settings/panel#security" replace /> },
          { path: 'security/ip-allowlist', element: <Navigate to="/admins#ip-allowlist" replace /> },
          { path: 'webhooks', element: <Navigate to="/admins#webhooks" replace /> },
          { path: 'system/config-portability', element: <Navigate to="/settings/panel#config" replace /> },
          { path: 'system/logs', element: <Navigate to="/audit#system-logs" replace /> },
          { path: 'users/bulk', element: <Navigate to="/users#bulk" replace /> },
        ],
      },
    ],
  },
  {
    path: '*',
    element: withSuspense(<NotFoundPage />),
  },
])
