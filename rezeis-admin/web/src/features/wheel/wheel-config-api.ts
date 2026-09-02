import { api } from '@/lib/api'

import type { LocalizedText } from './wheel-prizes-api'

export type WheelSectorKind =
  | 'NOTHING'
  | 'POINTS'
  | 'SPINS'
  | 'DAYS'
  | 'TRAFFIC'
  | 'DISCOUNT'
  | 'PROMOCODE'
  | 'KEY'
  | 'MANUAL'

export type WheelRarity = 'COMMON' | 'RARE' | 'EPIC' | 'LEGENDARY'

export type PromocodeRewardType =
  | 'DURATION'
  | 'TRAFFIC'
  | 'DEVICES'
  | 'SUBSCRIPTION'
  | 'PERSONAL_DISCOUNT'
  | 'PURCHASE_DISCOUNT'

/** Why the wheel may not be switched on. */
export type WheelBlocker = 'PERPETUAL' | 'NO_SECTORS' | 'NO_LOSS_SECTOR'

export interface WheelSector {
  readonly id: string
  readonly kind: WheelSectorKind
  readonly title: LocalizedText
  readonly iconKind: 'PRESET' | 'SVG'
  readonly iconRef: string
  readonly rarity: WheelRarity
  readonly weight: number
  readonly amount: number
  readonly promoRewardType: PromocodeRewardType | null
  readonly promoPlanId: string | null
  readonly promoPlanIds: readonly string[]
  readonly promoLifetime: number | null
  readonly keyPoolId: string | null
  readonly manualInstructions: string | null
  readonly maxWinsPerUser: number | null
  readonly maxWinsTotal: number | null
  readonly wonCount: number
  readonly order: number
  readonly enabled: boolean
  /** Derived from the weights, so the column always totals exactly 100. */
  readonly chancePercent: number
  /** Keys left in this sector's pool; `null` when it is not a KEY sector. */
  readonly keysAvailable: number | null
}

export interface WheelEconomy {
  readonly totalWeight: number
  /** R: expected spins returned per spin. */
  readonly spinsReturnedPerSpin: number
  /** How many spins one spin becomes; `null` when it never stops. */
  readonly expectedTotalSpins: number | null
  readonly perpetual: boolean
  readonly generous: boolean
}

export interface WheelSettings {
  readonly enabled: boolean
  readonly freeSpinCooldownHours: number | null
  readonly spinPricePoints: number | null
}

export interface WheelOverview {
  readonly settings: WheelSettings
  readonly sectors: readonly WheelSector[]
  readonly economy: WheelEconomy
  readonly blockers: readonly WheelBlocker[]
  readonly spins: { readonly total: number; readonly pending: number }
}

export interface WheelSectorPayload {
  readonly kind: WheelSectorKind
  readonly title: LocalizedText
  readonly rarity?: WheelRarity
  readonly weight: number
  readonly amount: number
  readonly promoRewardType?: PromocodeRewardType | null
  readonly promoPlanId?: string | null
  readonly promoPlanIds?: readonly string[]
  readonly promoLifetime?: number | null
  readonly keyPoolId?: string | null
  readonly manualInstructions?: string | null
  readonly maxWinsPerUser?: number | null
  readonly maxWinsTotal?: number | null
  readonly enabled?: boolean
}

export const getWheel = () => api.get<WheelOverview>('/admin/wheel').then((r) => r.data)

export const createSector = (payload: WheelSectorPayload) =>
  api.post<WheelOverview>('/admin/wheel/sectors', payload).then((r) => r.data)

export const updateSector = (sectorId: string, payload: WheelSectorPayload) =>
  api
    .patch<WheelOverview>(`/admin/wheel/sectors/${encodeURIComponent(sectorId)}`, payload)
    .then((r) => r.data)

export const deleteSector = (sectorId: string) =>
  api
    .delete<WheelOverview>(`/admin/wheel/sectors/${encodeURIComponent(sectorId)}`)
    .then((r) => r.data)

export const reorderSectors = (orderedIds: readonly string[]) =>
  api
    .post<WheelOverview>('/admin/wheel/sectors/reorder', { orderedIds: [...orderedIds] })
    .then((r) => r.data)

export const updateWheelSettings = (patch: Partial<WheelSettings>) =>
  api.patch<WheelOverview>('/admin/wheel/settings', patch).then((r) => r.data)

/** The sector's name as the operator wrote it, RU first. */
export const sectorTitle = (sector: { readonly title: LocalizedText }, fallback: string): string => {
  const ru = sector.title?.ru
  const en = sector.title?.en
  if (ru && ru.trim() !== '') return ru
  if (en && en.trim() !== '') return en
  return fallback
}

/**
 * The colour a rarity paints a slice.
 *
 * Kept here rather than in the page so the preview and the table cannot
 * disagree about what "legendary" looks like.
 */
export const RARITY_COLOR: Readonly<Record<WheelRarity, string>> = {
  COMMON: '#94a3b8',
  RARE: '#38bdf8',
  EPIC: '#a78bfa',
  LEGENDARY: '#fbbf24',
}
