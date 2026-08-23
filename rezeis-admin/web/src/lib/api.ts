import axios, { AxiosError, AxiosRequestConfig, InternalAxiosRequestConfig } from "axios";

import { authStorage, ADMIN_ACCESS_TOKEN_KEY } from "./auth-storage";
import { forceEndAdminSession } from "./admin-session";

export const TOKEN_KEY = ADMIN_ACCESS_TOKEN_KEY;

export const api = axios.create({
  baseURL: "/api",
  timeout: 30_000,
});

// ── Request interceptor — inject the bearer token ──────────────────────────
api.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  const token = authStorage.getToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// ── 401 handling ────────────────────────────────────────────────────────────
//
// rezeis-admin currently issues only access tokens (no refresh tokens). On a
// 401 we therefore do the simplest correct thing: drop the access token and
// redirect to the sign-in page. The mutex below guarantees that even a
// burst of concurrent failures triggers the redirect at most once and never
// double-clears the token while another request is mid-flight.
//
// When refresh tokens land (Phase 2 RBAC work), this is the integration
// point: replace `forceEndAdminSession` with a call into a real refresh mutex.

// -- Which 401s mean "the session is gone" ---------------------------------
//
// The rule, written out because what stood here was a hand-list of two URLs
// that had already been extended once:
//
//   A 401 tears the session down only when the SESSION was the request's whole
//   authority. When the request ALSO submitted a credential of its own — a
//   password, a TOTP or recovery code, a WebAuthn assertion — the 401 is the
//   endpoint's verdict on THAT credential, and says nothing about the session.
//
// The damage from getting it wrong is not cosmetic. `forceEndAdminSession`
// runs `queryClient.clear()`, which is what unmounted the login form mid-flow
// on the sign-in route (`features/auth/sign-in-totp-required.test.tsx` holds
// that case). The identical shape reappears everywhere a credential is checked
// INSIDE an existing session: one mistyped digit while enabling 2FA, disabling
// it, or regenerating recovery codes threw the operator out of a session that
// was never invalid, and re-typing the current password one character wrong on
// the change-password screen did the same.
//
// Two mechanisms, deliberately:
//
//   1. `submitsCredential: true` on the request config. That is the rule
//      itself, declared where the knowledge lives — at the call site that
//      knows it is sending a password or a code. A new flow needs no edit here.
//   2. The path list below, for the call sites that predate the flag and live
//      in files this change does not own. It is a compatibility shim, not the
//      rule: every entry names the credential the request carries, and an entry
//      that cannot name one does not belong in it.
//
// Matching is on the exact normalised path rather than `includes`, because the
// two ways of being wrong are not symmetric. A path missing from the list falls
// back to the old forced logout — bad, but the behaviour we already had. A
// loose substring match would exempt a URL that merely CONTAINS one of these,
// and quietly keep a genuinely dead session alive.

declare module "axios" {
  interface AxiosRequestConfig {
    /**
     * This request carries a credential of its own — a password, a TOTP or
     * recovery code, a WebAuthn assertion — so a 401 is the answer about that
     * credential and must not end the session.
     */
    submitsCredential?: boolean;
  }
}

const CREDENTIAL_VERIFICATION_PATHS: ReadonlySet<string> = new Set([
  "/admin/auth/login", // the password, plus the TOTP code on the second step
  "/admin/auth/password", // the CURRENT password, re-checked before rotating it
  "/admin/2fa/confirm", // the first TOTP code, proving the enrollment works
  "/admin/2fa/disable", // a live TOTP or recovery code
  "/admin/2fa/recovery-codes/regenerate", // a live TOTP or recovery code
  "/admin/passkey/authenticate/verify", // a WebAuthn assertion — on the SIGN-IN page
  "/admin/passkey/register/options", // the fresh factor demanded before enrolment
  "/admin/passkey/register/verify", // a WebAuthn attestation
]);

/**
 * The auth probe, exempt for an unrelated reason and kept apart so the two do
 * not get collapsed into one list: a 401 here really does mean the session is
 * gone, but the auth provider that owns the probe tears it down itself, and
 * doing it from both places races.
 */
const AUTH_PROBE_PATH = "/admin/auth/me";

/**
 * `/api/admin/2fa/disable?x=1` -> `/admin/2fa/disable`.
 *
 * Config urls are normally relative to `baseURL` ("/api") and written with a
 * leading slash, but an absolute URL is legal and the slash is optional, so all
 * three spellings have to land on the same string.
 */
export function normalizeRequestPath(url: string | undefined): string | null {
  if (typeof url !== "string" || url.length === 0) return null;
  const withoutQuery = url.split("?")[0].split("#")[0];
  const withoutOrigin = withoutQuery.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "");
  const rooted = withoutOrigin.startsWith("/") ? withoutOrigin : `/${withoutOrigin}`;
  const withoutApiPrefix = rooted.startsWith("/api/") ? rooted.slice(4) : rooted;
  return withoutApiPrefix.length > 1
    ? withoutApiPrefix.replace(/\/+$/, "")
    : withoutApiPrefix;
}

/**
 * True when a 401 from this request is a verdict on a credential the request
 * itself carried — so the session, if there is one, must survive it.
 */
export function submitsOwnCredential(config: AxiosRequestConfig | undefined): boolean {
  if (config?.submitsCredential === true) return true;
  const path = normalizeRequestPath(config?.url);
  return path !== null && CREDENTIAL_VERIFICATION_PATHS.has(path);
}

api.interceptors.response.use(
  (response) => response,
  (error: AxiosError) => {
    if (error.response?.status === 401) {
      const original = error.config as
        | (AxiosRequestConfig & { _retry?: boolean })
        | undefined;
      // The auth probe: the auth provider is already going to clear the session
      // in that case, and clearing it from both places races.
      const isAuthProbe = normalizeRequestPath(original?.url) === AUTH_PROBE_PATH;
      // Everything else is decided by the rule above — did this request carry a
      // credential of its own? The sign-in POST is the original case: a 401
      // there is "wrong password", or the `totp_required` pivot to the second
      // factor, never an expired session, because there is no session yet. It
      // is now one entry among the several that behave identically.
      if (!isAuthProbe && !submitsOwnCredential(original)) {
        forceEndAdminSession();
      }
    }
    return Promise.reject(error);
  },
);

export default api;
