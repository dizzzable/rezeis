import { api } from '@/lib/api'

// ── Wire types ───────────────────────────────────────────────────────────────

export interface TwoFactorStatus {
  enabled: boolean
  enrolledAt: string | null
  /** EVERY code still unspent — the weak ones below are a subset of these. */
  recoveryCodesRemaining: number
  /**
   * How many of `recoveryCodesRemaining` are still stored the old way: an
   * unsalted single-round SHA-256 of a 40-bit code.
   *
   * Codes already in operators' hands were deliberately not invalidated — a
   * recovery code is single-use, so there is never a moment where the
   * plaintext of a code that must SURVIVE is in hand to re-hash, and hard
   * invalidation would lock out precisely the operator who lost their
   * authenticator and is holding a printout. The only thing that fixes it is
   * regenerating, so the count exists to make that visible.
   *
   * OPTIONAL, and that is the whole point: a backend older than this field
   * sends nothing, which is NOT the same answer as `0`. Read it through
   * `readLegacyRecoveryCount()` and never with `?? 0`, which turns "this
   * server never said" into "you are fine".
   */
  recoveryCodesLegacy?: number
}

/** The server did not report the count — distinct from reporting zero. */
export const LEGACY_COUNT_UNREPORTED = 'unreported'

/** A count of weak codes, or the fact that nobody counted. */
export type LegacyRecoveryCount = number | typeof LEGACY_COUNT_UNREPORTED

/**
 * Reads `recoveryCodesLegacy` off a status without inventing a zero.
 *
 * Anything that is not a whole, non-negative number — absent, `null`, a
 * string from a proxy that stringified the body, `NaN` — is "not reported".
 * The panel then says so rather than showing an all-clear it has no basis for.
 */
export function readLegacyRecoveryCount(status: {
  readonly recoveryCodesLegacy?: unknown
}): LegacyRecoveryCount {
  const raw = status.recoveryCodesLegacy
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
    return LEGACY_COUNT_UNREPORTED
  }
  return raw
}

export interface TwoFactorEnrollment {
  secret: string
  otpauthUri: string
  recoveryCodes: readonly string[]
}

export interface VerifyCodePayload {
  code: string
}

export interface AdminIpAllowlistEntry {
  id: string
  address: string
  label: string
  isActive: boolean
  createdById: string | null
  createdAt: string
  updatedAt: string
}

interface AllowlistListResponse {
  items: readonly AdminIpAllowlistEntry[]
  total: number
}

export interface CreateAllowlistEntryPayload {
  address: string
  label?: string
  isActive?: boolean
}

export interface UpdateAllowlistEntryPayload {
  label?: string
  isActive?: boolean
}

// ── 2FA endpoints ───────────────────────────────────────────────────────────

export async function getTwoFactorStatus(): Promise<TwoFactorStatus> {
  const response = await api.get<TwoFactorStatus>('/admin/2fa/status')
  return response.data
}

/**
 * Beginning an enrolment mints a new second factor, so the server demands the
 * current password first. It is optional here only so the first attempt can go
 * without one and let the server raise the prompt — the same two-step the
 * passkey enrolment uses, so the operator is never asked for a credential the
 * account does not actually need.
 */
export async function enrollTwoFactor(
  payload?: { readonly password: string },
): Promise<TwoFactorEnrollment> {
  const response = await api.post<TwoFactorEnrollment>('/admin/2fa/enroll', payload ?? {})
  return response.data
}

export async function confirmTwoFactor(payload: VerifyCodePayload): Promise<TwoFactorStatus> {
  const response = await api.post<TwoFactorStatus>('/admin/2fa/confirm', payload)
  return response.data
}

export async function disableTwoFactor(payload: VerifyCodePayload): Promise<TwoFactorStatus> {
  const response = await api.post<TwoFactorStatus>('/admin/2fa/disable', payload)
  return response.data
}

export async function regenerateRecoveryCodes(
  payload: VerifyCodePayload,
): Promise<{ recoveryCodes: readonly string[] }> {
  const response = await api.post<{ recoveryCodes: readonly string[] }>(
    '/admin/2fa/recovery-codes/regenerate',
    payload,
  )
  return response.data
}

// ── IP Allowlist endpoints ─────────────────────────────────────────────────

export async function listAdminIpAllowlist(): Promise<AllowlistListResponse> {
  const response = await api.get<AllowlistListResponse>('/admin/ip-allowlist')
  return response.data
}

export async function createAdminIpAllowlistEntry(
  payload: CreateAllowlistEntryPayload,
): Promise<AdminIpAllowlistEntry> {
  const response = await api.post<AdminIpAllowlistEntry>('/admin/ip-allowlist', payload)
  return response.data
}

export async function updateAdminIpAllowlistEntry(
  id: string,
  payload: UpdateAllowlistEntryPayload,
): Promise<AdminIpAllowlistEntry> {
  const response = await api.patch<AdminIpAllowlistEntry>(`/admin/ip-allowlist/${id}`, payload)
  return response.data
}

export async function deleteAdminIpAllowlistEntry(id: string): Promise<void> {
  await api.delete(`/admin/ip-allowlist/${id}`)
}
