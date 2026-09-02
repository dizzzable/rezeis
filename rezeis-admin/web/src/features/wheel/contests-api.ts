import { api } from '@/lib/api'
import { expectArray } from '@/lib/api-utils'

import type { PromocodeRewardType, WheelSectorKind } from './wheel-config-api'
import type { LocalizedText, WheelSpinStatus } from './wheel-prizes-api'

export type ContestStatus = 'DRAFT' | 'ACTIVE' | 'DRAWN' | 'CANCELLED'

export interface ContestPrize {
  readonly id?: string
  readonly place: number
  readonly kind: WheelSectorKind
  readonly title: LocalizedText
  readonly amount: number
  readonly promoRewardType: PromocodeRewardType | null
  readonly promoPlanId: string | null
  readonly promoPlanIds: readonly string[]
  readonly promoLifetime: number | null
  readonly keyPoolId: string | null
  readonly manualInstructions: string | null
}

export interface ContestAudienceFilter {
  readonly subscription?: string[]
  readonly planIds?: string[]
}

export interface Contest {
  readonly id: string
  readonly title: LocalizedText
  readonly description: LocalizedText
  readonly status: ContestStatus
  readonly startAt: string
  readonly endAt: string
  readonly audienceFilter: ContestAudienceFilter | null
  readonly maxEntries: number | null
  readonly drawnAt: string | null
  readonly drawnEntries: number | null
  readonly order: number
  readonly createdAt: string
  readonly entries: number
  readonly winners: number
  readonly prizes: readonly ContestPrize[]
  /** Why it cannot be published as it stands. Empty means it can. */
  readonly problems: readonly string[]
}

export interface ContestPayload {
  readonly title: LocalizedText
  readonly description?: LocalizedText
  readonly startAt: string
  readonly endAt: string
  readonly audienceFilter?: ContestAudienceFilter | null
  readonly maxEntries?: number | null
  readonly prizes: readonly Omit<ContestPrize, 'id'>[]
}

export interface ContestWinner {
  readonly id: string
  readonly contestId: string
  readonly contestTitle: LocalizedText
  readonly place: number
  readonly kind: WheelSectorKind
  readonly prizeTitle: LocalizedText
  readonly status: WheelSpinStatus
  readonly createdAt: string
  readonly settledAt: string | null
  readonly settledBy: string | null
  readonly settlementNote: string | null
  readonly ticketId: string | null
  readonly instructions: string
  readonly winner: {
    readonly id: string
    readonly name: string
    readonly username: string | null
    readonly telegramId: string | null
    readonly email: string | null
  }
}

export type DrawResult =
  | { readonly drawn: true; readonly winners: number; readonly entrants: number }
  | { readonly drawn: false; readonly reason: 'NOT_ACTIVE' | 'NOT_OVER' | 'ALREADY_DRAWN' }

export const listContests = () =>
  api.get('/admin/contests').then((r) => expectArray<Contest>(r.data))

export const createContest = (payload: ContestPayload) =>
  api.post<Contest>('/admin/contests', payload).then((r) => r.data)

export const updateContest = (contestId: string, payload: ContestPayload) =>
  api.patch<Contest>(`/admin/contests/${encodeURIComponent(contestId)}`, payload).then((r) => r.data)

export const deleteContest = (contestId: string) =>
  api.delete(`/admin/contests/${encodeURIComponent(contestId)}`).then((r) => r.data)

export const publishContest = (contestId: string) =>
  api.post<Contest>(`/admin/contests/${encodeURIComponent(contestId)}/publish`).then((r) => r.data)

export const cancelContest = (contestId: string) =>
  api.post<Contest>(`/admin/contests/${encodeURIComponent(contestId)}/cancel`).then((r) => r.data)

export const drawContest = (contestId: string) =>
  api.post<DrawResult>(`/admin/contests/${encodeURIComponent(contestId)}/draw`).then((r) => r.data)

export const listContestWinners = (contestId: string) =>
  api
    .get(`/admin/contests/${encodeURIComponent(contestId)}/winners`)
    .then((r) => expectArray<ContestWinner>(r.data))

export const listPendingContestWinners = () =>
  api.get('/admin/contests/winners/pending').then((r) => expectArray<ContestWinner>(r.data))

export const issueContestPrize = (winnerId: string, note: string | null) =>
  api
    .post<ContestWinner>(`/admin/contests/winners/${encodeURIComponent(winnerId)}/issue`, {
      ...(note ? { note } : {}),
    })
    .then((r) => r.data)

export const refuseContestPrize = (winnerId: string, reason: string) =>
  api
    .post<ContestWinner>(`/admin/contests/winners/${encodeURIComponent(winnerId)}/refuse`, { reason })
    .then((r) => r.data)
