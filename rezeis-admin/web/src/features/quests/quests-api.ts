import { api } from '@/lib/api'

export type QuestType =
  | 'LINK_TELEGRAM'
  | 'LINK_EMAIL'
  | 'INVITE_FRIENDS'
  | 'SUBSCRIBE_CHANNEL'
  | 'PARTNER_TASK'
  | 'CUSTOM'

export type QuestRewardType = 'POINTS' | 'DAYS' | 'PROMOCODE' | 'DISCOUNT' | 'TRAFFIC'
export type QuestRepeat = 'ONCE' | 'REPEATABLE'
export type QuestIconKind = 'PRESET' | 'SVG'
export type QuestDaysFallback = 'GRANT_TRIAL' | 'MINT_PROMOCODE'

export interface LocalizedText {
  readonly ru: string
  readonly en: string
}

export interface QuestAudienceFilter {
  readonly subscription?: string[]
  readonly planIds?: string[]
  readonly inactiveDays?: number
  readonly platforms?: string[]
  readonly contact?: string[]
}

export interface Quest {
  readonly id: string
  readonly type: QuestType
  readonly title: LocalizedText
  readonly description: LocalizedText
  readonly iconKind: QuestIconKind
  readonly iconRef: string
  readonly rewardType: QuestRewardType
  readonly rewardAmount: number
  readonly rewardPlanId: string | null
  readonly daysFallback: QuestDaysFallback
  readonly audienceFilter: QuestAudienceFilter | null
  readonly repeat: QuestRepeat
  readonly cooldownHours: number | null
  readonly startAt: string | null
  readonly endAt: string | null
  readonly maxCompletionsGlobal: number | null
  readonly issuedCount: number
  readonly params: Record<string, unknown> | null
  readonly order: number
  readonly enabled: boolean
}

export interface QuestIconAsset {
  readonly id: string
  readonly name: string
  readonly sizeBytes: number
  readonly createdAt: string
}

export interface QuestPayload {
  readonly type: QuestType
  readonly title: LocalizedText
  readonly description?: LocalizedText
  readonly iconKind?: QuestIconKind
  readonly iconRef?: string
  readonly rewardType: QuestRewardType
  readonly rewardAmount?: number
  readonly rewardPlanId?: string | null
  readonly daysFallback?: QuestDaysFallback
  readonly audienceFilter?: QuestAudienceFilter | null
  readonly repeat?: QuestRepeat
  readonly cooldownHours?: number | null
  readonly startAt?: string | null
  readonly endAt?: string | null
  readonly maxCompletionsGlobal?: number | null
  readonly params?: Record<string, unknown> | null
  readonly enabled?: boolean
}

export const listQuests = () => api.get<Quest[]>('/admin/quests').then((r) => r.data)

export const createQuest = (payload: QuestPayload) =>
  api.post<Quest>('/admin/quests', payload).then((r) => r.data)

export const updateQuest = (id: string, payload: Partial<QuestPayload>) =>
  api.patch<Quest>(`/admin/quests/${encodeURIComponent(id)}`, payload).then((r) => r.data)

export const deleteQuest = (id: string) =>
  api.delete(`/admin/quests/${encodeURIComponent(id)}`).then((r) => r.data)

export const reorderQuests = (orderedIds: string[]) =>
  api.post<Quest[]>('/admin/quests/reorder', { orderedIds }).then((r) => r.data)

export const listQuestIcons = () =>
  api.get<QuestIconAsset[]>('/admin/quests/icons/list').then((r) => r.data)

export const uploadQuestIcon = (file: File) => {
  const form = new FormData()
  form.append('file', file)
  return api
    .post<QuestIconAsset>('/admin/quests/icons', form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
    .then((r) => r.data)
}

/** Same-origin URL for an uploaded icon (admin preview via authenticated axios). */
export const questIconAdminUrl = (iconId: string) =>
  `/admin/quests/icons/${encodeURIComponent(iconId)}`
