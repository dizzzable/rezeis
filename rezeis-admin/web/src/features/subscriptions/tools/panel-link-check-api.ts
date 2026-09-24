/**
 * The automatic panel-link check, read from the SPA — the wire boundary.
 * ──────────────────────────────────────────────────────────────────────
 *   `GET   /admin/profile-sync/panel-links/unlinked`        tab «Подписки без привязки к Remnawave»
 *   `GET   /admin/profile-sync/panel-links/extra-profiles`  tab «Лишние профили в Remnawave»
 *   `PATCH /admin/users/subscriptions/:id/remnawave-link`   «Привязать профиль», both tabs
 *
 * The check replaced «Починка привязки к панели»: it runs by itself (at boot,
 * after each backup import, daily, and an hour after a run it could not
 * finish), so there is no endpoint to start it and nothing here writes except
 * the one link an operator confirms by hand.
 *
 * READ DEFENSIVELY, for the reason every wire file in this feature gives: the
 * SPA and the API ship as separate images, so a panel build can meet a backend
 * that predates a field or already sends a code this build has never heard of.
 *
 *  • Arrays are CHECKED with `expectArray`, never asserted: an HTML error page
 *    served with HTTP 200 is a string with a working `.length`, and it must
 *    fail here — as "the list did not load" — not inside render.
 *  • Reason and outcome codes stay STRINGS. A code added server-side renders
 *    under its own name with "this build does not know it", instead of being
 *    dropped or folded into a neighbour whose sentence would be a lie.
 *  • Counters the server did not send are `null`, not `0`: on these screens a
 *    zero reads as "nothing is wrong", which is the one claim they must never
 *    make by accident.
 */
import { api } from '@/lib/api'
import { expectArray, isRecord } from '@/lib/api-utils'

export const UNLINKED_SUBSCRIPTIONS_PATH = '/admin/profile-sync/panel-links/unlinked'
export const EXTRA_PROFILES_PATH = '/admin/profile-sync/panel-links/extra-profiles'

/** The user card's own endpoint; this sheet only calls it with a numeric id. */
export function remnawaveLinkPath(subscriptionId: string): string {
  return `/admin/users/subscriptions/${encodeURIComponent(subscriptionId)}/remnawave-link`
}

// ── Shared: the automatic check's status ─────────────────────────────────────

export const PANEL_LINK_CHECK_TRIGGERS = ['boot', 'import', 'retry', 'daily'] as const
export const PANEL_LINK_CHECK_OUTCOMES = ['complete', 'incomplete'] as const

export interface PanelLinkCheckStatus {
  /** When the last automatic run FINISHED; null = no run recorded yet. */
  readonly lastRunAt: string | null
  /** Kept open: a trigger added server-side must still reach the screen. */
  readonly lastRunTrigger: string | null
  readonly lastRunOutcome: string | null
  readonly nextRunAt: string | null
  readonly running: boolean
}

// ── Tab «Подписки без привязки к Remnawave» ──────────────────────────────────

/** Every `UnlinkedReasonCode` the contract names, in no particular order. */
export const UNLINKED_REASON_CODES = [
  'notCheckedYet',
  'noRoute',
  'notFound',
  'panelUnavailable',
  'profileUnreadable',
  'ownedByOther',
  'noOwnerProof',
  'markedForOtherSubscription',
  'profileTaken',
  'duplicatePair',
  'changedDuringCheck',
  'panelAgrees',
] as const

export type UnlinkedReasonCode = (typeof UNLINKED_REASON_CODES)[number]

export function isUnlinkedReasonCode(value: string): value is UnlinkedReasonCode {
  return (UNLINKED_REASON_CODES as readonly string[]).includes(value)
}

export interface UnlinkedSubscriptionRow {
  readonly subscriptionId: string
  readonly userId: string
  readonly userName: string | null
  readonly userTelegramId: string | null
  readonly status: string
  readonly planName: string | null
  readonly createdAt: string | null
  /** What the row holds now: null (empty link) or the non-numeric value. */
  readonly storedRemnawaveId: string | null
  readonly linkKind: string
  readonly reason: string
  /** The Remnawave profile id the check found (decimal string), when it found one. */
  readonly profileId: string | null
  readonly otherSubscriptionId: string | null
  readonly otherUserId: string | null
  readonly lookedUpBy: string | null
  /** When the check last looked at THIS row; null with `notCheckedYet`. */
  readonly checkedAt: string | null
}

export interface UnlinkedSubscriptionsReport {
  readonly check: PanelLinkCheckStatus
  /** Rows in the population right now (may exceed rows.length); null = not sent. */
  readonly total: number | null
  readonly rows: readonly UnlinkedSubscriptionRow[]
  readonly truncated: boolean
}

// ── Tab «Лишние профили в Remnawave» ─────────────────────────────────────────

/** Every `AutoLinkOutcome` the contract names. */
export const AUTO_LINK_OUTCOMES = [
  'linked',
  'noSubscriptionWithoutLink',
  'severalSubscriptions',
  'severalProfiles',
  'subscriptionMarkerMismatch',
  'subscriptionRecordsAnotherProfile',
  'takenByOtherRow',
  'namedByDeletedSubscription',
  'syncInFlight',
  'changedDuringCheck',
  'panelUnavailable',
] as const

export type AutoLinkOutcome = (typeof AUTO_LINK_OUTCOMES)[number]

export function isAutoLinkOutcome(value: string): value is AutoLinkOutcome {
  return (AUTO_LINK_OUTCOMES as readonly string[]).includes(value)
}

export interface ExtraProfile {
  readonly profileId: string
  readonly username: string
  readonly status: string | null
  readonly createdAt: string | null
  readonly usedTrafficBytes: number | null
  /** The profile's subscription_id line, when it has one. */
  readonly subscriptionMarker: string | null
  /**
   * The subscription that holds the profile although it is not this
   * customer's live one: a live row of ANOTHER customer (`takenByOtherRow`),
   * or a DELETED row that still names it (`namedByDeletedSubscription`). Read
   * the outcome to know which — the two must not be described alike.
   */
  readonly linkedBySubscriptionId: string | null
  readonly autoLink: string
  readonly autoLinkedSubscriptionId: string | null
  readonly autoLinkedAt: string | null
  /** A live subscription links this profile as the database stands now. */
  readonly linkedNow: boolean
}

export interface SubscriptionWithoutLink {
  readonly subscriptionId: string
  readonly status: string
  readonly planName: string | null
  readonly createdAt: string | null
  /** null = empty link; else the non-numeric value. */
  readonly storedRemnawaveId: string | null
}

export interface ExtraProfileCustomer {
  readonly userId: string
  readonly userExists: boolean
  readonly userName: string | null
  readonly userTelegramId: string | null
  readonly profiles: readonly ExtraProfile[]
  readonly subscriptionsWithoutLink: readonly SubscriptionWithoutLink[]
}

export interface ExtraProfilesReport {
  readonly check: PanelLinkCheckStatus
  /** When the comparison last read Remnawave; null = never. */
  readonly comparedAt: string | null
  readonly readOutcome: string | null
  readonly profilesRead: number | null
  readonly profilesWithoutOwner: number | null
  readonly autoLinked: number | null
  readonly customers: readonly ExtraProfileCustomer[]
  readonly truncated: boolean
}

// ── Readers ──────────────────────────────────────────────────────────────────

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * An id the server sends as a decimal string — or, from a build that did not
 * stringify it, as a number. Either way it reaches the screen as the digits.
 */
function readId(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value)
  return readString(value)
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readCheckStatus(value: unknown): PanelLinkCheckStatus {
  const record = isRecord(value) ? value : {}
  return {
    lastRunAt: readString(record.lastRunAt),
    lastRunTrigger: readString(record.lastRunTrigger),
    lastRunOutcome: readString(record.lastRunOutcome),
    nextRunAt: readString(record.nextRunAt),
    running: record.running === true,
  }
}

function readUnlinkedRow(value: unknown): UnlinkedSubscriptionRow | null {
  if (!isRecord(value)) return null
  const subscriptionId = readString(value.subscriptionId)
  // A row without its subscription id cannot be linked or even named.
  if (subscriptionId === null) return null
  return {
    subscriptionId,
    userId: readString(value.userId) ?? '',
    userName: readString(value.userName),
    userTelegramId: readId(value.userTelegramId),
    status: readString(value.status) ?? '',
    planName: readString(value.planName),
    createdAt: readString(value.createdAt),
    // `''` is a value a row can really hold — and it is not "empty" in the
    // sense of `null`: keep it, the cell shows what is stored.
    storedRemnawaveId: typeof value.storedRemnawaveId === 'string' ? value.storedRemnawaveId : null,
    linkKind: readString(value.linkKind) ?? '',
    reason: readString(value.reason) ?? '',
    profileId: readId(value.profileId),
    otherSubscriptionId: readString(value.otherSubscriptionId),
    otherUserId: readString(value.otherUserId),
    lookedUpBy: readString(value.lookedUpBy),
    checkedAt: readString(value.checkedAt),
  }
}

export async function fetchUnlinkedSubscriptions(): Promise<UnlinkedSubscriptionsReport> {
  const { data } = await api.get<unknown>(UNLINKED_SUBSCRIPTIONS_PATH)
  const body = isRecord(data) ? data : {}
  return {
    check: readCheckStatus(body.check),
    total: readNumber(body.total),
    rows: expectArray<unknown>(body.rows)
      .map(readUnlinkedRow)
      .filter((row): row is UnlinkedSubscriptionRow => row !== null),
    truncated: body.truncated === true,
  }
}

function readExtraProfile(value: unknown): ExtraProfile | null {
  if (!isRecord(value)) return null
  const profileId = readId(value.profileId)
  if (profileId === null) return null
  return {
    profileId,
    username: readString(value.username) ?? '',
    status: readString(value.status),
    createdAt: readString(value.createdAt),
    usedTrafficBytes: readNumber(value.usedTrafficBytes),
    subscriptionMarker: readString(value.subscriptionMarker),
    linkedBySubscriptionId: readString(value.linkedBySubscriptionId),
    autoLink: readString(value.autoLink) ?? '',
    autoLinkedSubscriptionId: readString(value.autoLinkedSubscriptionId),
    autoLinkedAt: readString(value.autoLinkedAt),
    linkedNow: value.linkedNow === true,
  }
}

function readSubscriptionWithoutLink(value: unknown): SubscriptionWithoutLink | null {
  if (!isRecord(value)) return null
  const subscriptionId = readString(value.subscriptionId)
  if (subscriptionId === null) return null
  return {
    subscriptionId,
    status: readString(value.status) ?? '',
    planName: readString(value.planName),
    createdAt: readString(value.createdAt),
    storedRemnawaveId: typeof value.storedRemnawaveId === 'string' ? value.storedRemnawaveId : null,
  }
}

function readCustomer(value: unknown): ExtraProfileCustomer | null {
  if (!isRecord(value)) return null
  const userId = readString(value.userId)
  if (userId === null) return null
  return {
    userId,
    // `=== true`: a customer is only claimed to exist when the server says so.
    userExists: value.userExists === true,
    userName: readString(value.userName),
    userTelegramId: readId(value.userTelegramId),
    profiles: expectArray<unknown>(value.profiles)
      .map(readExtraProfile)
      .filter((profile): profile is ExtraProfile => profile !== null),
    subscriptionsWithoutLink: expectArray<unknown>(value.subscriptionsWithoutLink)
      .map(readSubscriptionWithoutLink)
      .filter((row): row is SubscriptionWithoutLink => row !== null),
  }
}

export async function fetchExtraProfiles(): Promise<ExtraProfilesReport> {
  const { data } = await api.get<unknown>(EXTRA_PROFILES_PATH)
  const body = isRecord(data) ? data : {}
  return {
    check: readCheckStatus(body.check),
    comparedAt: readString(body.comparedAt),
    readOutcome: readString(body.readOutcome),
    profilesRead: readNumber(body.profilesRead),
    profilesWithoutOwner: readNumber(body.profilesWithoutOwner),
    autoLinked: readNumber(body.autoLinked),
    customers: expectArray<unknown>(body.customers)
      .map(readCustomer)
      .filter((customer): customer is ExtraProfileCustomer => customer !== null),
    truncated: body.truncated === true,
  }
}

// ── «Привязать профиль» ──────────────────────────────────────────────────────

/**
 * Longest identifier the server accepts (`MAX_REMNAWAVE_ID_LENGTH` in
 * `admin-user-subscriptions.controller.ts`). `^\d+$` alone is happy to match a
 * megabyte of digits, and the value is interpolated into a panel URL.
 */
const MAX_REMNAWAVE_ID_LENGTH = 36

/** A decimal integer, no sign, no separators — a Remnawave 3.x profile id. */
const DECIMAL_ID = /^\d+$/

/**
 * Whether the operator typed a numeric Remnawave profile id.
 *
 * The same rule the server applies (`isNumericPanelIdentity` under the length
 * ceiling), restated rather than shared — nothing crosses the SPA/Nest
 * boundary but JSON. Numeric only: a 2.x UUID is exactly the kind of link this
 * sheet exists to replace, so the dialog does not offer to write one.
 */
export function isNumericRemnawaveId(value: string): boolean {
  return value.length > 0 && value.length <= MAX_REMNAWAVE_ID_LENGTH && DECIMAL_ID.test(value)
}

export interface LinkRemnawaveProfileRequest {
  readonly subscriptionId: string
  /** Digits, as typed and trimmed — sent as a STRING, never a number. */
  readonly remnawaveId: string
  /** The operator's word that the profile is this customer's, for when nothing proves it. */
  readonly confirmedWithoutProof: boolean
}

/**
 * Links one subscription to one Remnawave profile.
 *
 * `remnawaveId` stays a string: the server reads `typeof body.remnawaveId ===
 * 'string'` and answers anything else with 400, and a large id would not
 * survive a round trip through a JS number anyway. `confirmedWithoutProof` is
 * an explicit boolean on both branches — the server links without proof only
 * on the literal `true`.
 */
export async function linkRemnawaveProfile(request: LinkRemnawaveProfileRequest): Promise<void> {
  await api.patch(remnawaveLinkPath(request.subscriptionId), {
    remnawaveId: request.remnawaveId,
    confirmedWithoutProof: request.confirmedWithoutProof === true,
  })
}
