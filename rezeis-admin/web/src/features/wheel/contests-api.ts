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

/** Who may enter — the broadcast filter's shape. */
export interface ContestAudienceFilter {
  readonly subscription?: string[]
  readonly planIds?: string[]
  readonly platforms?: string[]
  readonly contact?: string[]
  readonly inactiveDays?: number
}

export interface ContestChannel {
  readonly chatId: string
  readonly joinUrl: string
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
  readonly drawnTickets: number | null
  readonly order: number
  readonly createdAt: string
  readonly entries: number
  readonly winners: number
  readonly announce: boolean
  readonly announcedAt: string | null
  readonly resultsNotifiedAt: string | null
  readonly ticketsPerPurchase: number
  readonly ticketsPerReferral: number
  readonly maxTicketsPerUser: number | null
  readonly channel: ContestChannel | null
  /** SHA-256 of the draw's seed, from publish on. */
  readonly drawSeedHash: string | null
  /** The seed itself — only once drawn. */
  readonly drawSeed: string | null
  /** Why the last draw attempt failed, while it keeps failing. */
  readonly drawError: string | null
  readonly drawErrorAt: string | null
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
  readonly announce?: boolean
  readonly ticketsPerPurchase?: number
  readonly ticketsPerReferral?: number
  readonly maxTicketsPerUser?: number | null
  readonly channelLink?: string | null
  readonly channelId?: string | null
  readonly prizes: readonly Omit<ContestPrize, 'id'>[]
}

export interface ContestEntrant {
  readonly userId: string
  readonly name: string | null
  readonly username: string | null
  readonly telegramId: string | null
  readonly enteredAt: string
  readonly tickets: number
}

export interface ContestEntrantsPage {
  readonly total: number
  readonly rows: readonly ContestEntrant[]
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
  | { readonly drawn: true; readonly winners: number; readonly entrants: number; readonly tickets?: number }
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

export const listContestEntrants = (contestId: string, page: { readonly take: number; readonly skip: number }) =>
  api
    .get<ContestEntrantsPage>(`/admin/contests/${encodeURIComponent(contestId)}/entrants`, { params: page })
    .then((r) => ({ total: Number(r.data?.total ?? 0), rows: Array.isArray(r.data?.rows) ? r.data.rows : [] }))

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
