import { api } from '@/lib/api'

/**
 * event-catalog-api
 * ─────────────────
 * Every event a rule could be bound to, with what it has actually done on this
 * installation.
 *
 * `seen` is a count from the operator's own audit log over `windowDays`, not a
 * claim about the source. The panel cannot honestly say "this type is never
 * emitted" — an event emitted through a variable or an aliased constant is
 * invisible to any scan of it — but it can say how many times the thing has
 * happened here, which is the more useful answer anyway.
 */

export interface CatalogEvent {
  readonly type: string
  readonly namespace: string
  readonly popupCapable: boolean
  readonly seen: number
  readonly lastSeenAt: string | null
}

export interface EventCatalog {
  readonly events: readonly CatalogEvent[]
  readonly windowDays: number
}

export async function getEventCatalog(): Promise<EventCatalog> {
  const response = await api.get<EventCatalog>('/admin/automations/events')
  return response.data
}

/**
 * Whether a trigger spec would select this event at run time.
 *
 * The FOURTH copy of this grammar would be one too many, so it is not one: the
 * authority is the bridge's `matchEventPattern`, the browser bundle cannot
 * import it, and `trigger-map.ts` already holds the one browser-side copy with
 * a test pinning the two together. This delegates to that.
 */
export { matchEventPattern as matchesKnownEvent } from './trigger-map'
