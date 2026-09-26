/* eslint-disable react-refresh/only-export-components */
import { createBrowserRouter, Navigate, useLocation, type RouteObject } from 'react-router';
import { Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import ProtectedRoute, { FullScreenSpinner } from './protected-route';
import {
  ADMIN_SHELL_ROUTE_ID,
  adminShell,
  shouldWarmAdminShellAtBoot,
} from './admin-shell-loader';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { withFeatureBundle } from '@/i18n/i18n';
import { lazyWithChunkRecovery as lazy } from '@/lib/lazy-chunk';
import { browserReportsOffline } from '@/lib/idle-prefetch';
import { useAuthStore } from '@/stores/auth-store';

/**
 * Wraps children in an ErrorBoundary that resets whenever the
 * route pathname changes so a previous page error does not block
 * navigation to a new route.
 */
function RouteErrorBoundary({ children }: { readonly children: React.ReactNode }) {
  const { pathname } = useLocation();
  return <ErrorBoundary key={pathname}>{children}</ErrorBoundary>;
}

// The frame around every signed-in page: sidebar, topbar, quick search, the
// notification bell, the realtime socket. Lazy like the pages it frames.
//
// It used to be a static import here, and this file is on the entry's static
// graph, so /sign-in downloaded the whole frame before its form could paint:
// dnd-kit (sidebar reordering), socket.io, the Radix menus and scroll areas —
// 259,657 B of the 1,688,272 B the login route took at 0.9.7.70. None of it
// renders before a session is verified. `scripts/check-build-graph.mjs`
// (DENIED_BUNDLES → admin-shell and the libraries after it) fails the build if
// the frame comes back onto the route.
//
// Lazy must not mean late: its download starts at boot when the first screen
// is the shell (`warmAdminShellForFirstScreen` below), or on the sign-in form's
// first sign of intent. The component and those warm-ups share one import,
// in `admin-shell-loader.ts`.
const AdminShell = adminShell.Component;
const SignInPage = lazy(() => import('@/features/auth/sign-in-page'));
const ForcePasswordChangePage = lazy(() => import('@/features/auth/force-password-change-page'));
const DashboardPage = lazy(
  withFeatureBundle('dashboard', () => import('@/features/dashboard/dashboard-page')),
);
const RemnaWavePage = lazy(
  withFeatureBundle('remnawave', () => import('@/features/remnawave/remnawave-page')),
);
const AdminsPage = lazy(() => import('@/features/admins/admins-page'));
const UsersPage = lazy(() => import('@/features/users/users-page'));
const UserDetailPage = lazy(
  withFeatureBundle('userDetail', () => import('@/features/users/user-detail-page')),
);
const PlansPage = lazy(() => import('@/features/plans/plans-page'));
const SubscriptionsPage = lazy(
  withFeatureBundle('subscriptionTools', () =>
    import('@/features/subscriptions/subscriptions-page'),
  ),
);
const PaymentsPage = lazy(
  withFeatureBundle('payments', () => import('@/features/payments/payments-page')),
);
const PromocodesPage = lazy(() => import('@/features/promocodes/promocodes-page'));
const ReferralsPage = lazy(() => import('@/features/referrals/referrals-page'));
const PartnersPage = lazy(() => import('@/features/partners/partners-page'));
const BroadcastPage = lazy(
  withFeatureBundle('broadcast', () => import('@/features/broadcast/broadcast-page')),
);
const SettingsPage = lazy(
  withFeatureBundle('platformSettings', () => import('@/features/settings/settings-page')),
);
const ApiTokensPage = lazy(
  withFeatureBundle('platformSettings', () =>
    import('@/features/settings/api-tokens-page').then((m) => ({ default: m.ApiTokensPage })),
  ),
);
const PanelSettingsHub = lazy(() => import('@/features/settings/panel-settings-hub'));
const WebReiwaPage = lazy(
  withFeatureBundle('branding', () => import('@/features/branding/branding-page')),
);
const AnalyticsPage = lazy(
  withFeatureBundle('analytics', () => import('@/features/analytics/analytics-page')),
);
const BotMapPage = lazy(
  withFeatureBundle('botMap', () => import('@/features/bot-map/bot-map-page')),
);
const CustomEmojiPage = lazy(() => import('@/features/custom-emoji/custom-emoji-page'));
const NotificationsPage = lazy(
  withFeatureBundle('notifications', () => import('@/features/notifications/notifications-page')),
);
// The operator's own alerts. Its dictionary lives in the core bundle, not a
// feature one: the bell in the header shows the same strings and is mounted
// on every page, so they are already loaded by the time this page is.
const NotificationCentrePage = lazy(
  () => import('@/features/notification-centre/notification-centre-page'),
);
const GatewaySettingsPage = lazy(
  withFeatureBundle('payments', () => import('@/features/payments/gateway-settings-page')),
);
const ExternalAuthPage = lazy(() => import('@/features/external-auth/external-auth-page'));
const SubpageConfigPage = lazy(
  withFeatureBundle('subpageConfig', () => import('@/features/subpage-config/subpage-config-page')),
);
const LandingBuilderPage = lazy(
  withFeatureBundle('landingBuilder', () => import('@/features/landing-builder/landing-builder-page')),
);
const LegalDocumentsPage = lazy(
  withFeatureBundle('legalDocuments', () => import('@/features/legal-documents/legal-documents-page')),
);
const ReferralSettingsPage = lazy(() => import('@/features/settings/referral-settings-page'));
const PointsSettingsPage = lazy(() => import('@/features/settings/points-settings-page'));
const QuestsPage = lazy(() => import('@/features/quests/quests-page'));
const WheelConfigPage = lazy(() => import('@/features/wheel/wheel-config-page'));
const ContestsPage = lazy(() => import('@/features/wheel/contests-page'));
const WheelPrizesPage = lazy(() => import('@/features/wheel/wheel-prizes-page'));
const WheelKeysPage = lazy(() => import('@/features/wheel/wheel-keys-page'));
const PartnerSettingsPage = lazy(() => import('@/features/settings/partner-settings-page'));
// Backup UI is now embedded as a tab in /settings/panel; old route redirects.
const ImportsPage = lazy(
  withFeatureBundle('imports', () => import('@/features/imports/imports-page')),
);
const AuditPage = lazy(() => import('@/features/audit/audit-page'));
const FraudSignalsPage = lazy(() => import('@/features/fraud/fraud-page'));
const AdvertisingPage = lazy(
  withFeatureBundle('advertising', () => import('@/features/advertising/advertising-page')),
);
const AutomationsPage = lazy(
  withFeatureBundle('automations', () => import('@/features/automations/automations-page')),
);
// Blocked IPs page is now embedded as a tab in /admins; old route redirects.
// Roles UI is now embedded as a tab in /admins; old route redirects.
// Note: Withdrawals UI is now embedded as a tab in /partners. The standalone
// /withdrawals route redirects into the corresponding tab to preserve
// external deep links.
const SupportTicketsPage = lazy(() => import('@/features/support-tickets/support-tickets-page'));
const AiSupportPage = lazy(() => import('@/features/settings/ai-support-page'));
const FaqPage = lazy(() => import('@/features/faq/faq-page'));
// Two-factor UI is now embedded as a tab in /settings/panel; old route redirects.
// IP allowlist, Webhooks, Blocked IPs are now embedded as tabs in /admins; old routes redirect.
// Config portability is now embedded as a tab in /settings/panel; old route redirects.
// System logs are now embedded as a tab in /audit; old route redirects.
// Bulk users UI is now embedded as a tab in /users; old route redirects.
const AddOnsPage = lazy(
  withFeatureBundle('addOns', () => import('@/features/add-ons/add-ons-page')),
);
const NotFoundPage = lazy(() => import('./not-found-page'));

function PageFallback() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

/**
 * What stands in for the admin frame while its chunk loads: the spinner the
 * session probe showed a moment earlier, so the operator sees one wait, not
 * a spinner followed by a skeleton of a page with no frame around it.
 *
 * Usually never on screen. The frame is fetched at boot or on the sign-in
 * form's first sign of intent, and once it is here it renders without
 * suspending (`lazyWithPreload`). It shows only when the session check
 * finishes before that download does.
 */
function ShellFallback() {
  const { t } = useTranslation();
  return <FullScreenSpinner label={t('common.loading')} />;
}

function withSuspense(element: React.ReactNode) {
  return (
    <RouteErrorBoundary>
      <Suspense fallback={<PageFallback />}>{element}</Suspense>
    </RouteErrorBoundary>
  );
}

export const routes: RouteObject[] = [
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
        // Named so the boot warm-up can tell whether the first screen is the
        // shell (`warmAdminShellForFirstScreen`).
        id: ADMIN_SHELL_ROUTE_ID,
        element: (
          <ErrorBoundary>
            <Suspense fallback={<ShellFallback />}>
              <AdminShell />
            </Suspense>
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
          { path: 'subpage-config', element: withSuspense(<SubpageConfigPage />) },
          { path: 'landing-builder', element: withSuspense(<LandingBuilderPage />) },
          { path: 'legal-documents', element: withSuspense(<LegalDocumentsPage />) },
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
          { path: 'notifications/inbox', element: withSuspense(<NotificationCentrePage />) },
          { path: 'payments/gateways', element: withSuspense(<GatewaySettingsPage />) },
          { path: 'external-auth', element: withSuspense(<ExternalAuthPage />) },
          { path: 'settings/referral', element: withSuspense(<ReferralSettingsPage />) },
          { path: 'settings/points', element: withSuspense(<PointsSettingsPage />) },
          { path: 'settings/partner', element: withSuspense(<PartnerSettingsPage />) },
          { path: 'backup', element: <Navigate to="/settings/panel#backups" replace /> },
          { path: 'imports', element: withSuspense(<ImportsPage />) },
          { path: 'audit', element: withSuspense(<AuditPage />) },
          { path: 'fraud', element: withSuspense(<FraudSignalsPage />) },
          { path: 'advertising', element: withSuspense(<AdvertisingPage />) },
          { path: 'quests', element: withSuspense(<QuestsPage />) },
          { path: 'wheel', element: withSuspense(<WheelConfigPage />) },
          { path: 'contests', element: withSuspense(<ContestsPage />) },
          { path: 'wheel/prizes', element: withSuspense(<WheelPrizesPage />) },
          { path: 'wheel/keys', element: withSuspense(<WheelKeysPage />) },
          { path: 'automations', element: withSuspense(<AutomationsPage />) },
          { path: 'blocked-ips', element: <Navigate to="/admins#blocked-ips" replace /> },
          { path: 'withdrawals', element: <Navigate to="/partners#withdrawals" replace /> },
          { path: 'support-tickets', element: withSuspense(<SupportTicketsPage />) },
          { path: 'ai-support', element: withSuspense(<AiSupportPage />) },
          { path: 'faq', element: withSuspense(<FaqPage />) },
          { path: 'security/2fa', element: <Navigate to="/settings/panel#security" replace /> },
          {
            path: 'security/ip-allowlist',
            element: <Navigate to="/admins#ip-allowlist" replace />,
          },
          { path: 'webhooks', element: <Navigate to="/admins#webhooks" replace /> },
          {
            path: 'system/config-portability',
            element: <Navigate to="/settings/panel#config" replace />,
          },
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
];

export const router = createBrowserRouter(routes);

/**
 * Start fetching the admin shell now if this tab's first screen will be it.
 *
 * Called once by `main.tsx`, right before the first render, so the download
 * runs in parallel with the session check that render starts. On 0.9.7.70 the
 * shell was part of the entry and was already there when the check finished.
 * This keeps it that way without putting it back on /sign-in. `router.state`
 * already holds the first URL's matches: routes here have no loaders, so
 * nothing is pending at creation.
 */
export function warmAdminShellForFirstScreen(): void {
  const warm = shouldWarmAdminShellAtBoot({
    hasSession: useAuthStore.getState().token.length > 0,
    routeIds: router.state.matches.map((match) => match.route.id),
    offline: browserReportsOffline(),
  });
  if (warm) void adminShell.preload();
}
