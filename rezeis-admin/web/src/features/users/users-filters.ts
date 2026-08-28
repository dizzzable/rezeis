/**
 * The filter state behind the Users list, and the pure functions around it.
 *
 * ── Why this is a module and not state inside the page ───────────────────
 *
 * Three things have to agree about a filter: the request that fetches the
 * list, the badge that says how many are active, and the URL that makes a
 * filtered view shareable. Each is a small transformation of the same object,
 * and each is the kind of thing that quietly goes wrong — a filter that is
 * counted but not sent, or sent but not restored from the link somebody
 * pasted. Keeping the three transformations together, and testable without
 * rendering anything, is what stops them drifting.
 */

/** A tri-state toggle: unset means the filter is not applied at all. */
export type TriState = boolean | undefined

export interface UserFilters {
  readonly planIds: readonly string[]
  readonly subscriptionStatuses: readonly string[]
  readonly roles: readonly string[]
  readonly languages: readonly string[]
  readonly hasSubscription: TriState
  readonly isTrial: TriState
  readonly isBlocked: TriState
  readonly hasTelegram: TriState
  readonly hasWebAccount: TriState
  readonly flagged: TriState
}

export const EMPTY_FILTERS: UserFilters = {
  planIds: [],
  subscriptionStatuses: [],
  roles: [],
  languages: [],
  hasSubscription: undefined,
  isTrial: undefined,
  isBlocked: undefined,
  hasTelegram: undefined,
  hasWebAccount: undefined,
  flagged: undefined,
}

export const SUBSCRIPTION_STATUSES = [
  'ACTIVE',
  'EXPIRED',
  'DISABLED',
  'LIMITED',
  'DELETED',
] as const

/**
 * Every role the `UserRole` enum declares, in the order an operator scans them.
 *
 * `DEV` was missing, and its absence hid accounts rather than merely offering
 * fewer boxes: an operator ticking both offered roles believes that means "any
 * role", and every DEV account — the role that short-circuits every permission
 * check — silently vanished from the list.
 */
export const USER_ROLES = ['DEV', 'ADMIN', 'USER'] as const

/**
 * Every locale the `Locale` enum declares.
 *
 * Two of twenty-seven were offered. Same failure as the roles above: a customer
 * whose language is anything but RU or EN could not be filtered to, and ticking
 * every visible box still excluded them.
 */
export const USER_LANGUAGES = [
  'RU',
  'EN',
  'AR',
  'AZ',
  'BE',
  'CS',
  'DE',
  'ES',
  'FA',
  'FR',
  'HE',
  'HI',
  'ID',
  'IT',
  'JA',
  'KK',
  'KO',
  'MS',
  'NL',
  'PL',
  'PT',
  'RO',
  'SR',
  'TR',
  'UK',
  'UZ',
  'VI',
] as const

/** Every tri-state key, so the switches render and serialise from one list. */
export const TRI_STATE_KEYS = [
  'hasSubscription',
  'isTrial',
  'isBlocked',
  'hasTelegram',
  'hasWebAccount',
  'flagged',
] as const

export type TriStateKey = (typeof TRI_STATE_KEYS)[number]

const LIST_KEYS = ['planIds', 'subscriptionStatuses', 'roles', 'languages'] as const
type ListKey = (typeof LIST_KEYS)[number]

/**
 * How many filters are switched on.
 *
 * A multi-value filter counts ONCE however many members it has: the badge
 * answers "how much am I narrowing this by", and a plan filter with four plans
 * ticked is one decision, not four.
 */
export function countActiveFilters(filters: UserFilters): number {
  let count = 0
  for (const key of LIST_KEYS) {
    if (filters[key].length > 0) count += 1
  }
  for (const key of TRI_STATE_KEYS) {
    if (filters[key] !== undefined) count += 1
  }
  return count
}

/**
 * The query parameters for a filter set.
 *
 * Multi-value filters are comma-joined; the server splits on commas and also
 * accepts repeated keys, so either shape works — this one keeps a shared link
 * readable.
 *
 * A tri-state is sent as the literal `'true'` / `'false'`, and the SERVER reads
 * those strings deliberately: `Boolean('false')` is `true`, so a filter for
 * "not blocked" sent as a bare boolean would come back with the blocked ones.
 */
export function filtersToParams(filters: UserFilters): Record<string, string> {
  const params: Record<string, string> = {}
  for (const key of LIST_KEYS) {
    const values = filters[key]
    if (values.length > 0) params[key] = values.join(',')
  }
  for (const key of TRI_STATE_KEYS) {
    const value = filters[key]
    if (value !== undefined) params[key] = value ? 'true' : 'false'
  }
  return params
}

/**
 * Rebuilds a filter set from a URL.
 *
 * Anything unrecognised is ignored rather than refused: a link saved before a
 * filter was renamed should still open the list, narrowed by whatever it can
 * still understand.
 */
export function filtersFromParams(params: URLSearchParams): UserFilters {
  const readList = (key: ListKey): string[] => {
    const raw = params.get(key)
    if (raw === null) return []
    return raw
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
  }
  const readTri = (key: TriStateKey): TriState => {
    const raw = params.get(key)
    if (raw === 'true') return true
    if (raw === 'false') return false
    return undefined
  }
  return {
    planIds: readList('planIds'),
    subscriptionStatuses: readList('subscriptionStatuses'),
    roles: readList('roles'),
    languages: readList('languages'),
    hasSubscription: readTri('hasSubscription'),
    isTrial: readTri('isTrial'),
    isBlocked: readTri('isBlocked'),
    hasTelegram: readTri('hasTelegram'),
    hasWebAccount: readTri('hasWebAccount'),
    flagged: readTri('flagged'),
  }
}

/** Adds or removes one member of a multi-value filter. */
export function toggleListValue(
  filters: UserFilters,
  key: ListKey,
  value: string,
): UserFilters {
  const current = filters[key]
  const next = current.includes(value)
    ? current.filter((entry) => entry !== value)
    : [...current, value]
  return { ...filters, [key]: next }
}

/**
 * Advances a tri-state: unset → yes → no → unset.
 *
 * Three states and not two, because "blocked" and "not blocked" are different
 * questions from "I do not care", and a plain checkbox can only express two of
 * the three — which is how a filter ends up silently excluding everybody it was
 * never asked about.
 */
export function cycleTriState(filters: UserFilters, key: TriStateKey): UserFilters {
  const current = filters[key]
  const next: TriState = current === undefined ? true : current ? false : undefined
  return { ...filters, [key]: next }
}
