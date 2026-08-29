import { api } from '@/lib/api'
import { expectArray } from '@/lib/api-utils'

export type HintMode = 'MODAL' | 'DRAWER' | 'TOAST' | 'INLINE' | 'SPOTLIGHT'
export type HintTone = 'INFO' | 'SUCCESS' | 'WARNING' | 'DANGER'
export type HintCtaKind = 'NONE' | 'ROUTE' | 'EXTERNAL'

export interface UserHint {
  id: string
  key: string
  titleRu: string
  bodyRu: string
  titleEn: string | null
  bodyEn: string | null
  mode: HintMode
  tone: HintTone
  ctaKind: HintCtaKind
  ctaLabelRu: string | null
  ctaLabelEn: string | null
  ctaTarget: string | null
  surfaces: string[]
  formFactors: string[]
  groupKey: string | null
  ttlHours: number
  isRepeatable: boolean
  isActive: boolean
  createdAt: string
  updatedAt: string
}

export interface UpsertUserHintInput {
  key: string
  titleRu: string
  bodyRu: string
  titleEn?: string
  bodyEn?: string
  mode?: HintMode
  tone?: HintTone
  ctaKind?: HintCtaKind
  ctaLabelRu?: string
  ctaLabelEn?: string
  ctaTarget?: string
  surfaces?: string[]
  formFactors?: string[]
  groupKey?: string
  ttlHours?: number
  isRepeatable?: boolean
  isActive?: boolean
}

/**
 * The pickers' vocabulary, served rather than duplicated here.
 *
 * The route list is a mirror of the CABINET's router, which lives in another
 * repository. Keeping the one copy on the server means the form offers exactly
 * what the server will accept — a second list in this file would be a third
 * place for the three to disagree.
 */
export interface HintVocabulary {
  routes: string[]
  surfaces: string[]
  formFactors: string[]
  modes: HintMode[]
}

export async function listUserHints(): Promise<UserHint[]> {
  const response = await api.get<UserHint[]>('/admin/user-hints')
  return expectArray<UserHint>(response.data)
}

export async function getHintVocabulary(): Promise<HintVocabulary> {
  const response = await api.get<HintVocabulary>('/admin/user-hints/vocabulary')
  return response.data
}

export async function createUserHint(input: UpsertUserHintInput): Promise<UserHint> {
  const response = await api.post<UserHint>('/admin/user-hints', input)
  return response.data
}

export async function updateUserHint(
  id: string,
  input: UpsertUserHintInput,
): Promise<UserHint> {
  const response = await api.put<UserHint>(`/admin/user-hints/${encodeURIComponent(id)}`, input)
  return response.data
}

export async function deleteUserHint(id: string): Promise<{ deletedDeliveries: number }> {
  const response = await api.delete<{ deletedDeliveries: number }>(
    `/admin/user-hints/${encodeURIComponent(id)}`,
  )
  return response.data
}
