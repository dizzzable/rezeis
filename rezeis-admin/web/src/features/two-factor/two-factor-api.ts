import { api } from '@/lib/api'

// ── Wire types ───────────────────────────────────────────────────────────────

export interface TwoFactorStatus {
  enabled: boolean
  enrolledAt: string | null
  recoveryCodesRemaining: number
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

export async function enrollTwoFactor(): Promise<TwoFactorEnrollment> {
  const response = await api.post<TwoFactorEnrollment>('/admin/2fa/enroll')
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
