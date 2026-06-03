import axios, { AxiosError, AxiosRequestConfig, InternalAxiosRequestConfig } from "axios";

import { authStorage, ADMIN_ACCESS_TOKEN_KEY } from "./auth-storage";
import { queryClient } from "./query-client";

export const TOKEN_KEY = ADMIN_ACCESS_TOKEN_KEY;

/** Path the auth provider redirects to on hard auth failure. */
const SIGN_IN_PATH = "/sign-in";

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
// point: replace `forceLogout` with a call into a real refresh mutex.

let isLoggingOut = false;

function forceLogout(): void {
  if (isLoggingOut) return;
  isLoggingOut = true;
  authStorage.clearToken();
  queryClient.clear();
  // Avoid a redirect loop on the sign-in page itself.
  if (typeof window !== "undefined" && !window.location.pathname.endsWith(SIGN_IN_PATH)) {
    window.location.href = SIGN_IN_PATH;
  }
}

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
      if (!isAuthProbe) {
        forceLogout();
      }
    }
    return Promise.reject(error);
  },
);

export default api;
