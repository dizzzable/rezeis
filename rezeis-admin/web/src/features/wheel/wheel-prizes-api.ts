import { api } from '@/lib/api'

/**
 * The prizes a person hands over.
 *
 * `SETTLED` covers both "the machine paid it" and "an operator handed it
 * over" — `settledBy` is what separates them, and it is `null` for the
 * machine. Nothing on this screen shows a machine-settled prize, because a
 * manual sector is never settled by one.
 */
export type WheelSpinStatus = 'EMPTY' | 'SETTLED' | 'PENDING' | 'REFUSED'

export interface LocalizedText {
  readonly ru?: string
  readonly en?: string
}

export interface ManualPrize {
  readonly spinId: string
  readonly status: WheelSpinStatus
  readonly createdAt: string
  readonly settledAt: string | null
  readonly settledBy: string | null
  readonly settlementNote: string | null
  /** The conversation opened so the operator can reach the winner. */
  readonly ticketId: string | null
  /** What the operator has to do, as they wrote it on the sector. */
  readonly instructions: string
  readonly sector: {
    readonly id: string | null
    readonly title: LocalizedText
    readonly rarity: string | null
  }
  readonly winner: {
    readonly id: string
    readonly name: string
    readonly username: string | null
    readonly telegramId: string | null
    readonly email: string | null
  }
}

export interface ManualPrizePage {
  readonly items: readonly ManualPrize[]
  readonly nextCursor: string | null
}

export const listManualPrizes = (params: {
  readonly status?: WheelSpinStatus
  readonly cursor?: string | null
  readonly limit?: number
}) =>
  api
    .get<ManualPrizePage>('/admin/wheel/prizes', {
      params: {
        ...(params.status ? { status: params.status } : {}),
        ...(params.cursor ? { cursor: params.cursor } : {}),
        ...(params.limit ? { limit: params.limit } : {}),
      },
    })
    .then((r) => r.data)

export const issueManualPrize = (spinId: string, note: string | null) =>
  api
    .post<ManualPrize>(`/admin/wheel/prizes/${encodeURIComponent(spinId)}/issue`, {
      ...(note ? { note } : {}),
    })
    .then((r) => r.data)

export const refuseManualPrize = (spinId: string, reason: string) =>
  api
    .post<ManualPrize>(`/admin/wheel/prizes/${encodeURIComponent(spinId)}/refuse`, { reason })
    .then((r) => r.data)

/** The sector's name as the operator wrote it, RU first. */
export const prizeTitle = (prize: ManualPrize, fallback: string): string => {
  const ru = prize.sector.title?.ru
  const en = prize.sector.title?.en
  if (ru && ru.trim() !== '') return ru
  if (en && en.trim() !== '') return en
  return fallback
}
