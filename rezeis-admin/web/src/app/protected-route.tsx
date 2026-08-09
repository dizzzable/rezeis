import { useEffect } from "react";
import { Navigate, Outlet, useLocation } from "react-router";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/features/auth/auth-provider";
import { translateErrorMessage } from "@/lib/translate-error";
import { captureReturnTo } from "@/lib/return-to";

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

  // Capture the deep link before bouncing to /sign-in, so signing in returns
  // the operator to the page they asked for.
  //
  // `sign-in-page` and `oauth-buttons` have always CONSUMED this key (four
  // call sites, `consumeReturnTo() ?? '/'`), but the only writer was
  // `components/layout/auth-guard.tsx` — a component imported from nowhere,
  // still redirecting to a `/login` route that does not exist. So nothing ever
  // wrote the key and every deep link landed on `/` after sign-in. The dead
  // guard is gone; this is the live gate, so the capture belongs here.
  //
  // In an effect, not in render: render must stay pure because React may
  // replay or discard it, and `captureReturnTo` writes sessionStorage.
  // sessionStorage rather than router state because the OAuth flow leaves the
  // document entirely and comes back — router state would not survive it.
  const willRedirectToSignIn = !isLoading && !sessionError && !isAuthenticated;
  useEffect(() => {
    if (!willRedirectToSignIn) return;
    captureReturnTo(location.pathname + location.search + location.hash);
  }, [willRedirectToSignIn, location.pathname, location.search, location.hash]);

  // min-h-dvh, not -screen. On iOS `100vh` is the LARGE viewport — the height
  // the page WOULD have with the address bar collapsed — so with the bar
  // showing, a `min-h-screen` shell overflows and its centred content sits
  // low, partly under the bar. `dvh` tracks what is actually visible. The
  // safe-area padding is not optional either: index.html ships
  // `viewport-fit=cover` with a black-translucent status bar, so content
  // extends under the notch and home indicator unless it is padded off them.
  //
  // This spinner in particular is the whole post-login round trip on a phone
  // — it is on screen for as long as /me takes, which is where it is seen.
  if (isLoading) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]">
        <div className="flex flex-col items-center gap-3">
          <div className="h-9 w-9 animate-spin rounded-full border-4 border-muted border-t-primary" />
          <p className="text-sm text-muted-foreground">{t("auth.verifyingSession")}</p>
        </div>
      </div>
    );
  }

  if (sessionError) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] pl-[max(1.5rem,env(safe-area-inset-left))] pr-[max(1.5rem,env(safe-area-inset-right))]">
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
