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
      if (!isAuthProbe) {
        forceEndAdminSession();
      }
    }
    return Promise.reject(error);
  },
);

export default api;
