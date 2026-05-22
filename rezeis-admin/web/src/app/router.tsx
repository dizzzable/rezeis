/* eslint-disable react-refresh/only-export-components */
import { createBrowserRouter, Navigate } from 'react-router-dom'
import { lazy, Suspense } from 'react'
import ProtectedRoute from './protected-route'
import AdminShell from '@/components/layout/admin-shell'
import { Skeleton } from '@/components/ui/skeleton'
import { ErrorBoundary } from '@/components/ErrorBoundary'

// Lazy-load pages
const SignInPage = lazy(() => import('@/features/auth/sign-in-page'))
const ForcePasswordChangePage = lazy(() => import('@/features/auth/force-password-change-page'))
const DashboardPage = lazy(() => import('@/features/dashboard/dashboard-page'))
const RemnaWavePage = lazy(() => import('@/features/remnawave/remnawave-page'))
const AdminsPage = lazy(() => import('@/features/admins/admins-page'))
const UsersPage = lazy(() => import('@/features/users/users-page'))
const UserDetailPage = lazy(() => import('@/features/users/user-detail-page'))
const PlansPage = lazy(() => import('@/features/plans/plans-page'))
const SubscriptionsPage = lazy(() => import('@/features/subscriptions/subscriptions-page'))
const PaymentsPage = lazy(() => import('@/features/payments/payments-page'))
const PromocodesPage = lazy(() => import('@/features/promocodes/promocodes-page'))
const ReferralsPage = lazy(() => import('@/features/referrals/referrals-page'))
const PartnersPage = lazy(() => import('@/features/partners/partners-page'))
const BroadcastPage = lazy(() => import('@/features/broadcast/broadcast-page'))
const SettingsPage = lazy(() => import('@/features/settings/settings-page'))
const ApiTokensPage = lazy(() => import('@/features/settings/api-tokens-page').then(m => ({ default: m.ApiTokensPage })))
const PanelSettingsHub = lazy(() => import('@/features/settings/panel-settings-hub'))
const AnalyticsPage = lazy(() => import('@/features/analytics/analytics-page'))
const BotConfigPage = lazy(() => import('@/features/bot-config/bot-config-page'))
const BotFlowPage = lazy(() => import('@/features/bot-flow/bot-flow-page'))
const NotificationsPage = lazy(() => import('@/features/notifications/notifications-page'))
const GatewaySettingsPage = lazy(() => import('@/features/payments/gateway-settings-page'))
const ReferralSettingsPage = lazy(() => import('@/features/settings/referral-settings-page'))
const PartnerSettingsPage = lazy(() => import('@/features/settings/partner-settings-page'))
// Backup UI is now embedded as a tab in /settings/panel; old route redirects.
const ImportsPage = lazy(() => import('@/features/imports/imports-page'))
const AuditPage = lazy(() => import('@/features/audit/audit-page'))
const FraudSignalsPage = lazy(() => import('@/features/fraud/fraud-page'))
const AutomationsPage = lazy(() => import('@/features/automations/automations-page'))
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
    <ErrorBoundary>
      <Suspense fallback={<PageFallback />}>{element}</Suspense>
    </ErrorBoundary>
  )
}

export const router = createBrowserRouter([
  {
    path: '/sign-in',
    element: withSuspense(<SignInPage />),
  },
  {
    path: '/change-password',
    element: withSuspense(<ForcePasswordChangePage />),
  },
  {
    element: <ProtectedRoute />,
    children: [
      {
        element: <AdminShell />,
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
          { path: 'remnawave', element: withSuspense(<RemnaWavePage />) },
          { path: 'settings', element: withSuspense(<SettingsPage />) },
          { path: 'settings/api-tokens', element: withSuspense(<ApiTokensPage />) },
          { path: 'settings/panel', element: withSuspense(<PanelSettingsHub />) },
          { path: 'bot-config', element: withSuspense(<BotConfigPage />) },
          { path: 'bot-flow', element: withSuspense(<BotFlowPage />) },
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
