import { useEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createBrowserRouter, RouterProvider, Navigate, Outlet } from 'react-router';
import { useAuthStore } from '@/stores/auth.store';
import { initializeWebSocketService, getWebSocketService } from '@/services/websocket';
import { ThemeProvider } from '@/components/ThemeProvider';
import ProtectedRoute from '@/components/ProtectedRoute';
import { MainLayout } from '@/components/layout/MainLayout';
import { ClientLayout } from '@/components/client/ClientLayout';
import Login from '@/pages/Login';
import Setup from '@/pages/Setup';
import Dashboard from '@/pages/Dashboard';
import Users from '@/pages/Users';
import UserDetails from '@/pages/UserDetails';
import Subscriptions from '@/pages/Subscriptions';
import Plans from '@/pages/Plans';
import Statistics from '@/pages/Statistics';
import Settings from '@/pages/Settings';
import Access from '@/pages/Access';
import Backup from '@/pages/Backup';
import Broadcast from '@/pages/Broadcast';
import Promocodes from '@/pages/Promocodes';
import Gateways from '@/pages/Gateways';
import Banners from '@/pages/Banners';
import Partners from '@/pages/Partners';
import Referrals from '@/pages/Referrals';
import Remnawave from '@/pages/Remnawave';
import Importer from '@/pages/Importer';
import Multisubscriptions from '@/pages/Multisubscriptions';
import Notifications from '@/pages/Notifications';
import Monitoring from '@/pages/Monitoring';
import AdminPromocodes from '@/pages/admin/Promocodes';
import AdminTrialSettings from '@/pages/admin/TrialSettings';
import {
  ClientDashboard,
  ClientSubscriptions,
  ClientPlans,
  ClientPaymentHistory,
  ClientReferrals,
  ClientPartner,
  ClientSettings,
} from '@/pages/client';
import { MiniAppHome, MiniAppServers } from '@/pages/miniapp';
import { isInTelegram } from '@/services/telegram';

/**
 * Query client for React Query
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5,
      retry: 1,
    },
  },
});

/**
 * Check if running in Telegram Mini App
 */
const isMiniApp = isInTelegram();

/**
 * App initialization component
 * Handles auth state initialization on app load
 * and WebSocket connection setup
 */
function AppInitializer({ children }: { children: React.ReactNode }): React.ReactElement {
  const initialize = useAuthStore((state) => state.initialize);
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);

  useEffect(() => {
    initialize();
  }, [initialize]);

  // Initialize WebSocket when authenticated
  useEffect(() => {
    if (isAuthenticated && !getWebSocketService()) {
      initializeWebSocketService(
        import.meta.env.VITE_WS_URL || 'ws://localhost:4000',
        'client'
      );
    }
  }, [isAuthenticated]);

  return <>{children}</>;
}

/**
 * Layout wrapper for admin routes
 */
function ProtectedLayout(): React.ReactElement {
  return (
    <ProtectedRoute requiredRole="admin">
      <MainLayout>
        <Outlet />
      </MainLayout>
    </ProtectedRoute>
  );
}

/**
 * Layout wrapper for client routes
 */
function ClientProtectedLayout(): React.ReactElement {
  return (
    <ProtectedRoute>
      <ClientLayout>
        <Outlet />
      </ClientLayout>
    </ProtectedRoute>
  );
}

/**
 * Layout wrapper for Mini App routes
 */
function MiniAppProtectedLayout(): React.ReactElement {
  return (
    <ProtectedRoute>
      <Outlet />
    </ProtectedRoute>
  );
}

/**
 * Router configuration
 */
const router = createBrowserRouter([
  {
    path: '/',
    element: isMiniApp ? <Navigate to="/miniapp" replace /> : <Navigate to="/dashboard" replace />,
  },
  {
    path: '/login',
    element: <Login />,
  },
  {
    path: '/setup',
    element: <Setup />,
  },
  // Mini App Routes (Telegram WebApp)
  {
    path: '/miniapp',
    element: <MiniAppProtectedLayout />,
    children: [
      {
        path: '',
        element: <MiniAppHome />,
      },
      {
        path: 'servers',
        element: <MiniAppServers />,
      },
    ],
  },
  // Admin Routes
  {
    path: '/',
    element: <ProtectedLayout />,
    children: [
      {
        path: 'dashboard',
        element: <Dashboard />,
      },
      {
        path: 'users',
        element: <Users />,
      },
      {
        path: 'users/active',
        element: <Users />,
      },
      {
        path: 'users/expired',
        element: <Users />,
      },
      {
        path: 'users/:id',
        element: <UserDetails />,
      },
      {
        path: 'subscriptions',
        element: <Subscriptions />,
      },
      {
        path: 'subscriptions/active',
        element: <Subscriptions />,
      },
      {
        path: 'subscriptions/expiring',
        element: <Subscriptions />,
      },
      {
        path: 'plans',
        element: <Plans />,
      },
      {
        path: 'statistics',
        element: <Statistics />,
      },
      {
        path: 'settings',
        element: <Settings />,
      },
      {
        path: 'access',
        element: <Access />,
      },
      {
        path: 'backup',
        element: <Backup />,
      },
      {
        path: 'broadcast',
        element: <Broadcast />,
      },
      {
        path: 'promocodes',
        element: <Promocodes />,
      },
      {
        path: 'gateways',
        element: <Gateways />,
      },
      {
        path: 'banners',
        element: <Banners />,
      },
      {
        path: 'partners',
        element: <Partners />,
      },
      {
        path: 'referrals',
        element: <Referrals />,
      },
      {
        path: 'remnawave',
        element: <Remnawave />,
      },
      {
        path: 'importer',
        element: <Importer />,
      },
      {
        path: 'multisubscriptions',
        element: <Multisubscriptions />,
      },
      {
        path: 'notifications',
        element: <Notifications />,
      },
      {
        path: 'monitoring',
        element: <Monitoring />,
      },
      // Admin Routes
      {
        path: 'admin/promocodes',
        element: <AdminPromocodes />,
      },
      {
        path: 'admin/trial-settings',
        element: <AdminTrialSettings />,
      },
    ],
  },
  // Client Routes
  {
    path: '/client',
    element: <ClientProtectedLayout />,
    children: [
      {
        path: '',
        element: <ClientDashboard />,
      },
      {
        path: 'subscriptions',
        element: <ClientSubscriptions />,
      },
      {
        path: 'plans',
        element: <ClientPlans />,
      },
      {
        path: 'payments',
        element: <ClientPaymentHistory />,
      },
      {
        path: 'referrals',
        element: <ClientReferrals />,
      },
      {
        path: 'partner',
        element: <ClientPartner />,
      },
      {
        path: 'settings',
        element: <ClientSettings />,
      },
    ],
  },
  {
    path: '*',
    element: <Navigate to={isMiniApp ? '/miniapp' : '/dashboard'} replace />,
  },
]);

/**
 * Main App component
 */
function App(): React.ReactElement {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <AppInitializer>
          <RouterProvider router={router} />
        </AppInitializer>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

export default App;
