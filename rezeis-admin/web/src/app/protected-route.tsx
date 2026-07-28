import { Navigate, Outlet, useLocation } from "react-router";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/features/auth/auth-provider";
import { translateErrorMessage } from "@/lib/translate-error";

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
  const { t } = useTranslation();
  const { isAuthenticated, isLoading, mustChangePassword, sessionError, retrySession } = useAuth();
  const location = useLocation();
  const isPasswordChangeRoute = location.pathname === "/change-password";

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <div className="h-9 w-9 animate-spin rounded-full border-4 border-muted border-t-primary" />
          <p className="text-sm text-muted-foreground">{t("auth.verifyingSession")}</p>
        </div>
      </div>
    );
  }

  if (sessionError) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-6">
        <div className="flex w-full max-w-sm flex-col items-center rounded-3xl border border-border/80 bg-card/95 p-8 text-center shadow-sm">
          <p className="text-lg font-semibold">{t("auth.sessionCheckFailedTitle")}</p>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            {t("auth.sessionCheckFailedDescription")}
          </p>
          <p className="mt-4 text-sm text-destructive">{translateErrorMessage(t, sessionError.message)}</p>
          <button
            type="button"
            className="mt-6 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            onClick={retrySession}
          >
            {t("auth.sessionCheckRetry")}
          </button>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/sign-in" replace />;
  }

  if (mustChangePassword && !isPasswordChangeRoute) {
    return <Navigate to="/change-password" replace />;
  }

  if (!mustChangePassword && isPasswordChangeRoute) {
    return <Navigate to="/" replace />;
  }

  return <Outlet />;
}
