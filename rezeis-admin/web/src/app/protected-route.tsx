import { Navigate, Outlet } from "react-router-dom";
import { useAuth } from "@/features/auth/auth-provider";

/**
 * Gates the admin shell behind a verified session.
 *
 * Three terminal states:
 *   - Loading → spinner (verifying token / probing /me).
 *   - Unauthenticated → redirect to /sign-in.
 *   - Authenticated but `mustChangePassword=true` → redirect to /change-password.
 *
 * All other authenticated states render the requested route via <Outlet />.
 */
export default function ProtectedRoute() {
  const { isAuthenticated, isLoading, mustChangePassword } = useAuth();

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <div className="h-9 w-9 animate-spin rounded-full border-4 border-muted border-t-primary" />
          <p className="text-sm text-muted-foreground">Verifying session…</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/sign-in" replace />;
  }

  if (mustChangePassword) {
    return <Navigate to="/change-password" replace />;
  }

  return <Outlet />;
}
