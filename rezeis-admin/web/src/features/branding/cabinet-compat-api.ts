/**
 * `GET /admin/reiwa-peers` — which Reiwa cabinet the panel is talking to
 * (pair reliability, 26.09.2026): its site-and-API process and its bot, their
 * versions, when each was last heard from, whether it said what it can do or
 * the panel placed it by the evidence it left, and what does not work until it
 * is updated. Read by the block at the top of «WEB Reiwa».
 */
import api from '@/lib/api'

export const CABINET_COMPAT_QUERY_KEY = ['reiwa-peers'] as const

/** How often the open page asks again: the cabinet may be updated while the operator watches. */
export const CABINET_COMPAT_REFRESH_MS = 60_000

export type CabinetSurface = 'api' | 'bot'
export const CABINET_SURFACES: readonly CabinetSurface[] = ['api', 'bot']

/**
 * `live`: heard from within its window. `quiet`: heard from before, not lately
 * — the last-known answer stands. `never`: nothing in 30 days. `unavailable`:
 * the panel could not read its own records.
 */
export type CabinetSurfaceState = 'live' | 'quiet' | 'never' | 'unavailable'
const STATES: readonly CabinetSurfaceState[] = ['live', 'quiet', 'never', 'unavailable']

/** One thing the cabinet cannot do yet, in both languages. `gate`: a sale the panel withholds. */
export interface CabinetMissing {
  readonly id: string
  readonly kind: 'gate' | 'degraded'
  readonly operatorText: string
  readonly operatorTextEn: string
}

export interface CabinetSurfaceReport {
  readonly state: CabinetSurfaceState
  readonly behind: boolean
  readonly version: string | null
  readonly lastSeenAt: string | null
  /** It said what it can do; `false` is a cabinet up to 0.9.7.53, placed by its poll or heartbeat. */
  readonly declared: boolean
  /** Capabilities it declared that this panel does not know — a cabinet newer than the panel. */
  readonly unknownToPanel: number
  readonly missing: readonly CabinetMissing[]
}

export interface CabinetCompat {
  readonly panelVersion: string
  /** The version a cabinet that has not reported itself is taken for (the panel's floor). */
  readonly floorVersion: string | null
  readonly surfaces: Readonly<Record<CabinetSurface, CabinetSurfaceReport>>
}

export async function fetchCabinetCompat(): Promise<unknown> {
  const { data } = await api.get<unknown>('/admin/reiwa-peers')
  return data
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readMissing(value: unknown): CabinetMissing | null {
  if (!isRecord(value)) return null
  const { id, kind, operatorText, operatorTextEn } = value
  if (typeof id !== 'string' || id.length === 0) return null
  const ru = typeof operatorText === 'string' ? operatorText : ''
  const en = typeof operatorTextEn === 'string' ? operatorTextEn : ''
  if (ru.length === 0 && en.length === 0) return null
  return { id, kind: kind === 'gate' ? 'gate' : 'degraded', operatorText: ru || en, operatorTextEn: en || ru }
}

function readSurface(value: unknown): CabinetSurfaceReport {
  if (!isRecord(value) || !(STATES as readonly unknown[]).includes(value['state'])) {
    return { state: 'unavailable', behind: false, version: null, lastSeenAt: null, declared: false, unknownToPanel: 0, missing: [] }
  }
  const missing = Array.isArray(value['missing'])
    ? value['missing'].map(readMissing).filter((row): row is CabinetMissing => row !== null)
    : []
  const unknown = value['unknownToPanel']
  return {
    state: value['state'] as CabinetSurfaceState,
    behind: value['behind'] === true,
    version: typeof value['version'] === 'string' ? value['version'] : null,
    lastSeenAt: typeof value['lastSeenAt'] === 'string' ? value['lastSeenAt'] : null,
    declared: value['declared'] === true,
    unknownToPanel: typeof unknown === 'number' && Number.isFinite(unknown) && unknown > 0 ? Math.floor(unknown) : 0,
    missing,
  }
}

/** The answer, or `null` for anything that is not one — the block then shows nothing. */
export function readCabinetCompat(data: unknown): CabinetCompat | null {
  if (!isRecord(data) || !isRecord(data['surfaces']) || typeof data['panelVersion'] !== 'string') return null
  const surfaces = data['surfaces']
  return {
    panelVersion: data['panelVersion'],
    floorVersion: typeof data['floorVersion'] === 'string' ? data['floorVersion'] : null,
    surfaces: { api: readSurface(surfaces['api']), bot: readSurface(surfaces['bot']) },
  }
}

/**
 * What the panel already withholds from a cabinet that has not reported
 * itself (review R1-12): the SALES of every surface in `never`, which the
 * panel judges by its floor. Only the sales — the degraded rows would be
 * guesses about a cabinet nobody has heard from (a panel without a bot would
 * list the bot's). Right after the panel's update this is a 0.9.7.52 cabinet
 * until its hourly heartbeat, and «до сброса» is already not sold.
 */
export function withheldUntilHeard(compat: CabinetCompat): readonly CabinetMissing[] {
  const seen = new Set<string>()
  const rows: CabinetMissing[] = []
  for (const surface of CABINET_SURFACES) {
    const report = compat.surfaces[surface]
    if (report.state !== 'never') continue
    for (const row of report.missing) {
      if (row.kind !== 'gate' || seen.has(row.id)) continue
      seen.add(row.id)
      rows.push(row)
    }
  }
  return rows
}

/**
 * What does not work until the cabinet is updated, over every surface that is
 * behind: each capability once, the withheld sales first.
 */
export function missingWhileBehind(compat: CabinetCompat): readonly CabinetMissing[] {
  const seen = new Set<string>()
  const all: CabinetMissing[] = []
  for (const surface of CABINET_SURFACES) {
    const report = compat.surfaces[surface]
    if (!report.behind) continue
    for (const row of report.missing) {
      if (seen.has(row.id)) continue
      seen.add(row.id)
      all.push(row)
    }
  }
  return [...all.filter((row) => row.kind === 'gate'), ...all.filter((row) => row.kind !== 'gate')]
}
