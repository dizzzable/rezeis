import { Navigate, useLocation } from 'react-router';
import { useAuth, useAuthStore } from '@/stores/auth.store';
import { Loader2 } from 'lucide-react';

/**
 * Props for ProtectedRoute component
 */
interface ProtectedRouteProps {
  /** Child components to render if authenticated */
  children: React.ReactNode;
  /** Required role to access this route - if not provided, any authenticated user can access */
  requiredRole?: 'admin' | 'user';
  /** Custom redirect path - defaults to /login */
  redirectTo?: string;
}

/**
 * ProtectedRoute component that guards routes requiring authentication
 * Supports role-based access control with requiredRole prop
 * Redirects to login if user is not authenticated or lacks required role
 * Shows loading spinner while auth state is being initialized
 *
 * @example
 * // For admin routes
 * <ProtectedRoute requiredRole="admin">
 *   <AdminDashboard />
 * </ProtectedRoute>
 *
 * @example
 * // For client routes (any authenticated user)
 * <ProtectedRoute>
 *   <ClientDashboard />
 * </ProtectedRoute>
 */
export default function ProtectedRoute({
  children,
  requiredRole,
  redirectTo = '/login',
}: ProtectedRouteProps): React.ReactElement {
  const { isAuthenticated, isLoading } = useAuth();
  const user = useAuthStore((state) => state.user);
  const location = useLocation();

  // Show loading state while checking authentication
  if (isLoading) {
    return (
      <div className="min-h-screen w-full flex items-center justify-center bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="h-8 w-8 animate-spin text-blue-500" aria-hidden="true" />
          <p className="text-sm text-slate-400">Загрузка...</p>
        </div>
      </div>
    );
  }

  // Redirect to login if not authenticated
  if (!isAuthenticated) {
    return <Navigate to={redirectTo} state={{ from: location }} replace />;
  }

  // Check role requirement if specified
  if (requiredRole && user?.role !== requiredRole) {
    return <Navigate to={redirectTo} state={{ from: location }} replace />;
  }

  // Render children if authenticated and has required role
  return <>{children}</>;
}
