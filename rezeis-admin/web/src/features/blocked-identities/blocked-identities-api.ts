import { api } from '@/lib/api'

/**
 * The identity blocklist — the pre-emptive half of banning.
 *
 * `POST /admin/users/:id/block` can only refuse somebody who already exists.
 * This one refuses an identity whether or not an account was ever created,
 * which is the case an operator actually has: a list handed over from another
 * install, a raid, a name they never want to see sign up.
 */

export type BlockedIdentityKind =
  | 'TELEGRAM_ID'
  | 'EMAIL'
  | 'WEB_LOGIN'
  | 'DEVICE_HWID'
  | 'DEVICE_FP'

export interface BlockedIdentity {
  id: string
  kind: BlockedIdentityKind
  value: string
  reason: string | null
  /** `manual` typed by a person, `cascade` captured when a user was blocked. */
  source: string
  createdById: string | null
  originUserId: string | null
  expiresAt: string | null
  createdAt: string
  updatedAt: string
}

/**
 * The per-row outcome of a paste.
 *
 * Deliberately not a success/failure pair: a list of two hundred with three
 * typos in it must not fail as a unit, and the operator has to be able to see
 * WHICH three. Refusing the whole paste teaches people to paste smaller lists,
 * not to fix the typos.
 */
export interface AddBlockedIdentitiesResult {
  added: number
  duplicates: string[]
  rejected: Array<{ value: string; reason: string }>
}

const BASE = '/admin/blocked-identities'

export async function listBlockedIdentities(
  params: { kind?: BlockedIdentityKind; search?: string } = {},
): Promise<{ items: BlockedIdentity[] }> {
  const res = await api.get<{ items: BlockedIdentity[] }>(BASE, { params })
  return res.data
}

export async function addBlockedIdentities(payload: {
  kind: BlockedIdentityKind
  values: string[]
  reason?: string
  expiresAt?: string
}): Promise<AddBlockedIdentitiesResult> {
  const res = await api.post<AddBlockedIdentitiesResult>(BASE, payload)
  return res.data
}

export async function deleteBlockedIdentity(id: string): Promise<void> {
  await api.delete(`${BASE}/${id}`)
}

/**
 * Splits a pasted block into values.
 *
 * Newlines, commas, semicolons and spaces all separate, because an operator
 * pastes whatever their source gave them — a column from a spreadsheet, a
 * comma-joined line from a chat message, a space-separated list from a log.
 * Deciding which one of those is "the" format guarantees the other three
 * arrive as one enormous single entry.
 *
 * Blank entries are dropped here rather than sent: a trailing newline is not a
 * typo worth reporting back to the person who made it.
 */
export function splitPastedValues(raw: string): string[] {
  return raw
    .split(/[\s,;]+/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
}
