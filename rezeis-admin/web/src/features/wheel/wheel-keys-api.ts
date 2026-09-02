import { api } from '@/lib/api'
import { expectArray } from '@/lib/api-utils'

import type { LocalizedText } from './wheel-prizes-api'

export interface KeyPoolSector {
  readonly id: string
  readonly title: LocalizedText
  readonly enabled: boolean
}

export interface KeyPool {
  readonly id: string
  readonly name: string
  readonly note: string | null
  readonly createdAt: string
  /** Everything ever loaded. */
  readonly total: number
  /** Handed out. */
  readonly claimed: number
  /** Still winnable — the number the draw actually cares about. */
  readonly available: number
  readonly sectors: readonly KeyPoolSector[]
}

export interface PoolKey {
  readonly id: string
  /** Masked unless the caller asked to reveal AND may read secrets. */
  readonly value: string
  readonly masked: boolean
  readonly claimedAt: string | null
  readonly claimedSpinId: string | null
  readonly claimedBy: {
    readonly id: string
    readonly name: string
    readonly username: string | null
    readonly telegramId: string | null
  } | null
}

export interface KeyPage {
  readonly items: readonly PoolKey[]
  readonly nextCursor: string | null
}

export interface LoadKeysResult {
  readonly received: number
  readonly added: number
  readonly duplicates: number
}

export const listKeyPools = () =>
  api.get('/admin/wheel/key-pools').then((r) => expectArray<KeyPool>(r.data))

export const createKeyPool = (payload: { name: string; note?: string }) =>
  api.post<KeyPool>('/admin/wheel/key-pools', payload).then((r) => r.data)

export const updateKeyPool = (poolId: string, payload: { name?: string; note?: string }) =>
  api
    .patch<KeyPool>(`/admin/wheel/key-pools/${encodeURIComponent(poolId)}`, payload)
    .then((r) => r.data)

export const deleteKeyPool = (poolId: string) =>
  api.delete(`/admin/wheel/key-pools/${encodeURIComponent(poolId)}`).then((r) => r.data)

/**
 * Load a pasted batch.
 *
 * The split happens here rather than on the server so the count the operator
 * is told about is the count of lines they actually pasted.
 */
export const loadKeys = (poolId: string, text: string) =>
  api
    .post<LoadKeysResult>(`/admin/wheel/key-pools/${encodeURIComponent(poolId)}/keys`, {
      values: text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== ''),
    })
    .then((r) => r.data)

export const listPoolKeys = (
  poolId: string,
  params: { claimed?: boolean; reveal?: boolean; cursor?: string | null; limit?: number },
) =>
  api
    .get<KeyPage>(`/admin/wheel/key-pools/${encodeURIComponent(poolId)}/keys`, {
      params: {
        ...(params.claimed === undefined ? {} : { claimed: params.claimed }),
        ...(params.reveal ? { reveal: true } : {}),
        ...(params.cursor ? { cursor: params.cursor } : {}),
        ...(params.limit ? { limit: params.limit } : {}),
      },
    })
    .then((r) => r.data)

export const deletePoolKey = (poolId: string, keyId: string) =>
  api
    .delete(
      `/admin/wheel/key-pools/${encodeURIComponent(poolId)}/keys/${encodeURIComponent(keyId)}`,
    )
    .then((r) => r.data)
