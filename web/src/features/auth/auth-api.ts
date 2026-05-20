import { api } from '@/lib/api'

import { authUserSchema, type AuthUser } from './auth-user'

// ── Wire types ───────────────────────────────────────────────────────────────

export interface AuthStatusResponse {
  hasAdmins: boolean
  /**
   * Operator-supplied locales from the backend's `.env`. Optional for
   * backwards compatibility with older backends that did not advertise
   * them.
   */
  locales?: readonly string[]
  defaultLocale?: string
}

export interface LoginRequest {
  username: string
  password: string
  /**
   * Optional 6-digit TOTP code (or 10-character recovery code). Sent on
   * the second login step when the backend has previously responded with
   * `code: 'totp_required'`.
   */
  totpCode?: string
}

export interface RegisterRequest {
  username: string
  password: string
  email?: string
  name?: string
}

export interface AuthResponse {
  accessToken: string
  tokenType: 'Bearer'
  expiresIn: string
  admin: AuthUser
}

interface MeResponseEnvelope {
  admin: AuthUser
}

// ── API calls ────────────────────────────────────────────────────────────────

const AUTH_BASE = '/admin/auth'

/** Discover whether at least one admin exists. */
export async function getAuthStatus(): Promise<AuthStatusResponse> {
  const response = await api.get<AuthStatusResponse>(`${AUTH_BASE}/status`)
  return response.data
}

/** Bootstrap the very first DEV admin (only allowed while the table is empty). */
export async function registerApi(payload: RegisterRequest): Promise<AuthResponse> {
  const response = await api.post(`${AUTH_BASE}/register`, payload)
  const parsed = authResponseFromUnknown(response.data)
  return parsed
}

/** Authenticate an existing admin and receive a JWT. */
export async function loginApi(payload: LoginRequest): Promise<AuthResponse> {
  const response = await api.post(`${AUTH_BASE}/login`, payload)
  return authResponseFromUnknown(response.data)
}

/** Fetch the currently authenticated admin profile. */
export async function getMeApi(): Promise<AuthUser> {
  const response = await api.get<MeResponseEnvelope>(`${AUTH_BASE}/me`)
  return authUserSchema.parse(response.data.admin)
}

// Back-compat alias for callers that previously imported `AdminProfile`.
export type AdminProfile = AuthUser

// ── Helpers ─────────────────────────────────────────────────────────────────

function authResponseFromUnknown(value: unknown): AuthResponse {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Malformed auth response payload')
  }
  const candidate = value as Record<string, unknown>
  const accessToken = candidate.accessToken
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new Error('Malformed auth response: missing access token')
  }
  const expiresIn =
    typeof candidate.expiresIn === 'string' ? candidate.expiresIn : ''
  const admin = authUserSchema.parse(candidate.admin)
  return {
    accessToken,
    tokenType: 'Bearer',
    expiresIn,
    admin,
  }
}
