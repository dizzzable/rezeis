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

api.interceptors.response.use(
  (response) => response,
  (error: AxiosError) => {
    if (error.response?.status === 401) {
      const original = error.config as
        | (AxiosRequestConfig & { _retry?: boolean })
        | undefined;
      // Do not redirect if the failed request was the auth probe itself —
      // the auth provider is already going to clear the session in that case.
      const isAuthProbe = typeof original?.url === "string" && original.url.includes("/admin/auth/me");
      // Nor if it was the sign-in request itself. A 401 there is the login
      // form's own answer — "wrong password", or the `totp_required` pivot to
      // the second factor — never an expired session, because there is no
      // session yet. The redirect below is already a no-op on this route (the
      // path matches), but `forceEndAdminSession` still runs
      // `queryClient.clear()`, which removes the sign-in page's own
      // `auth-status` query. Nothing changes at that instant; the next
      // re-render of the page rebuilds that query as pending, shows the
      // loading skeleton, and unmounts the form mid-login — throwing the
      // operator back to step one just as the code field should appear.
      const isSignIn = typeof original?.url === "string" && original.url.includes("/admin/auth/login");
      if (!isAuthProbe && !isSignIn) {
        forceEndAdminSession();
      }
    }
    return Promise.reject(error);
  },
);

export default api;
