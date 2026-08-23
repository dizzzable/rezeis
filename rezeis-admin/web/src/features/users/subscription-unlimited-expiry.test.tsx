/**
 * A SUBSCRIPTION WITH NO EXPIRY IS UNLIMITED, AND THE PANEL MUST SAY SO.
 *
 * `GET /admin/users/:telegramId` maps `expireAt: s.expiresAt?.toISOString()`
 * (`admin-user-management.controller.ts`), and `JSON.stringify` drops a key
 * whose value is `undefined` — so a subscription that never expires arrives
 * here with the key ABSENT, not null and not empty.
 *
 * Both places this panel prints an expiry used to answer that with an em dash.
 * A dash says "we do not know", and we do know: `Subscription.expiresAt` is
 * `DateTime?` and the backend treats the empty one as the unlimited bucket —
 * `referral-points-exchange.service.ts` queries `{ status: ACTIVE,
 * expiresAt: null }` as exactly that population. Naming a known state
 * "unknown" is a false answer, not a cautious one.
 *
 * The two sites are on DIFFERENT TABS and are asserted SEPARATELY, one spec
 * each. A single spec covering both would go red either way and could not say
 * which render site regressed — and the profile summary and the subscription
 * card have been fixed independently before.
 *
 * The wrong answers are rejected by name, not merely by asserting the right
 * one. `—`, `-`, an empty cell and `1970` are each spelled out, so "fix it by
 * swapping one dash for another", `?? ''` and a `new Date(null)` epoch all stay
 * RED. That set is copied from `subscriptions-page.test.tsx`, which pins the
 * same statement on the subscriptions list.
 *
 * NO ABSOLUTE DATE LITERALS. A `2026-03-01` fixture in this repository was live
 * when it was written and silently became an "expired subscription" assertion
 * five months later, with thirty specs asserting the defect while staying
 * green. Every instant below is derived from the moment the suite runs.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { usePermissionStore } from '@/features/rbac'
import { i18n, loadFeatureBundle } from '@/i18n/i18n'
import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'

import UserDetailPanel from './user-detail-panel'

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Noon LOCAL, so no timezone offset can move the rendered calendar day away
 * from the one this file computes an expectation for.
 */
function isoDaysFromNow(days: number): string {
  const date = new Date(Date.now() + days * DAY_MS)
  date.setHours(12, 0, 0, 0)
  return date.toISOString()
}

/**
 * `m/d/yyyy` — the `en-US` short date, spelled out from the date's own parts.
 *
 * Deliberately NOT `toLocaleDateString`: that is the call under test, so
 * borrowing it here would assert only that it equals itself, and a fix that
 * formatted the wrong instant would sail through.
 */
function expectedEnUsDate(iso: string): string {
  const date = new Date(iso)
  return `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}`
}

const DATED_EXPIRY = isoDaysFromNow(30)

/** EN copy for the state under test. Asserted literally — see the header. */
const UNLIMITED = 'Unlimited'

const BASE_SUBSCRIPTION = {
  id: 'subscription-1',
  status: 'ACTIVE',
  isTrial: false,
  trafficLimit: null,
  deviceLimit: null,
  plan: { id: 'plan-1', name: 'Lifetime', type: 'BOTH' },
  remnawaveSyncState: 'UNLINKED',
  remnawaveSyncJob: null,
}

function userWith(sub: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'user-1',
    telegramId: '12345',
    username: 'alice',
    name: 'Alice',
    language: 'en',
    role: 'USER',
    isBlocked: false,
    isPartner: false,
    points: 0,
    personalDiscount: 0,
    purchaseDiscount: 0,
    maxSubscriptions: 1,
    createdAt: isoDaysFromNow(-90),
    updatedAt: isoDaysFromNow(-1),
    subscriptions: [sub],
    transactions: [],
    referralsGiven: [],
    partner: null,
    webAccount: null,
  }
}

/**
 * The body as the ENDPOINT delivers it, not as an object literal spells it.
 *
 * A fixture written `expireAt: undefined` still carries the key in memory,
 * which is a shape the panel never actually receives. Running the whole body
 * through JSON reproduces the wire: `undefined` values lose their keys exactly
 * the way `res.json()` loses them in production, so "absent" in this file is
 * absent for the same reason it is absent for an operator.
 */
function asWireBody<T>(body: T): T {
  return JSON.parse(JSON.stringify(body)) as T
}

function mockUser(sub: Record<string, unknown>): void {
  vi.spyOn(api, 'get').mockResolvedValue({ data: asWireBody(userWith(sub)) })
}

/**
 * The right-hand cell of the `InfoRow` whose left-hand cell reads `label`.
 *
 * `{ selector: 'span' }` keeps the query on the label cell itself: without it,
 * a row whose VALUE renders empty has a container whose text is also just the
 * label, and the query would fail on ambiguity rather than on the thing this
 * file is asserting.
 */
function valueCellFor(label: string): HTMLElement {
  const labelCell = screen.getByText(label, { selector: 'span' })
  const row = labelCell.parentElement
  if (row === null) throw new Error(`no InfoRow around ${JSON.stringify(label)}`)
  const value = row.children[1]
  if (!(value instanceof HTMLElement)) {
    throw new Error(`InfoRow for ${JSON.stringify(label)} has no value cell`)
  }
  return value
}

/** Label of the profile summary's expiry row (`userDetailPanel.profile.expiresAt`). */
const profileExpiryLabel = (): string => i18n.t('userDetailPanel.profile.expiresAt')
/** Label of the subscription card's expiry row (`userDetailPanel.subscriptions.expires`). */
const cardExpiryLabel = (): string => i18n.t('userDetailPanel.subscriptions.expires')

/** Render, then move to the tab that carries the subscription cards. */
async function openSubscriptionsTab(): Promise<void> {
  const user = userEvent.setup()
  renderWithProviders(<UserDetailPanel telegramId="12345" />)
  const tabLabel = i18n.t('userDetailPanel.tabs.subscriptions')
  await user.click(await screen.findByRole('tab', { name: new RegExp(tabLabel) }))
}

/**
 * The four wrong answers, rejected by name.
 *
 * `1970` is the `new Date(null)` epoch; the two dashes are the "we do not
 * know" answers; the empty cell is `?? ''`. Each has actually shipped in this
 * codebase for this exact field.
 */
function expectUnlimited(cell: HTMLElement): void {
  expect(cell).toHaveTextContent(UNLIMITED)
  expect(cell.textContent?.trim()).toBe(UNLIMITED)
  expect(cell).not.toHaveTextContent('1970')
  expect(cell.textContent?.trim()).not.toBe('')
  expect(cell.textContent?.trim()).not.toBe('—')
  expect(cell.textContent?.trim()).not.toBe('-')
}

describe('a subscription with no expiry, in the user detail panel', () => {
  beforeAll(async () => {
    await loadFeatureBundle('userDetail')
  })

  beforeEach(() => {
    usePermissionStore.setState({ loaded: true, role: 'DEV' })
  })

  afterEach(() => {
    cleanup()
    usePermissionStore.getState().reset()
    vi.restoreAllMocks()
  })

  // ── Absent expiry — the state this file exists for ───────────────────────

  it('reads "Unlimited" in the profile summary — not 1970, not blank, not a dash', async () => {
    // `expireAt` is not spelled at all: this is the whole point. The endpoint
    // omits it, and the summary must name the state rather than shrug.
    mockUser({ ...BASE_SUBSCRIPTION })

    renderWithProviders(<UserDetailPanel telegramId="12345" />)
    await screen.findByText(profileExpiryLabel(), { selector: 'span' })

    expectUnlimited(valueCellFor(profileExpiryLabel()))
  })

  it('reads "Unlimited" on the subscription card — not 1970, not blank, not a dash', async () => {
    // The second render site, on a different tab and in a different component.
    // Asserted on its own so a regression here cannot hide behind the summary.
    mockUser({ ...BASE_SUBSCRIPTION })

    await openSubscriptionsTab()
    await screen.findByText(cardExpiryLabel(), { selector: 'span' })

    expectUnlimited(valueCellFor(cardExpiryLabel()))
  })

  // ── A real expiry — the other half of the same statement ─────────────────

  it('still prints a real expiry as that date in the profile summary', async () => {
    // Without this, "unlimited" could become the summary's answer to
    // everything and the spec above would still be green.
    mockUser({ ...BASE_SUBSCRIPTION, expireAt: DATED_EXPIRY })

    renderWithProviders(<UserDetailPanel telegramId="12345" />)
    await screen.findByText(profileExpiryLabel(), { selector: 'span' })

    const cell = valueCellFor(profileExpiryLabel())
    expect(cell.textContent?.trim()).toBe(expectedEnUsDate(DATED_EXPIRY))
    expect(cell).not.toHaveTextContent(UNLIMITED)
  })

  it('still prints a real expiry as that date on the subscription card', async () => {
    mockUser({ ...BASE_SUBSCRIPTION, expireAt: DATED_EXPIRY })

    await openSubscriptionsTab()
    await screen.findByText(cardExpiryLabel(), { selector: 'span' })

    const cell = valueCellFor(cardExpiryLabel())
    expect(cell.textContent?.trim()).toBe(expectedEnUsDate(DATED_EXPIRY))
    expect(cell).not.toHaveTextContent(UNLIMITED)
  })

  // ── The third state, which is why the check is not a truthiness check ────
  //
  // An EMPTY STRING is falsy, so `!sub.expireAt` cannot tell it from an absent
  // one and would answer "Unlimited" for a value that says nothing of the
  // kind. Without the two specs below, swapping the explicit comparisons for
  // `!sub.expireAt` survives the whole file — every spec above is satisfied by
  // both spellings. Nothing is asserted about WHICH wrong-looking thing an
  // empty string renders as; the requirement is only that the panel must not
  // claim an expiry policy off a broken value.

  it('does not call an empty expiry unlimited in the profile summary', async () => {
    mockUser({ ...BASE_SUBSCRIPTION, expireAt: '' })

    renderWithProviders(<UserDetailPanel telegramId="12345" />)
    await screen.findByText(profileExpiryLabel(), { selector: 'span' })

    const cell = valueCellFor(profileExpiryLabel())
    expect(cell).not.toHaveTextContent(UNLIMITED)
    expect(cell.textContent?.trim()).not.toBe('')
  })

  it('does not call an empty expiry unlimited on the subscription card', async () => {
    mockUser({ ...BASE_SUBSCRIPTION, expireAt: '' })

    await openSubscriptionsTab()
    await screen.findByText(cardExpiryLabel(), { selector: 'span' })

    const cell = valueCellFor(cardExpiryLabel())
    expect(cell).not.toHaveTextContent(UNLIMITED)
    expect(cell.textContent?.trim()).not.toBe('')
  })

  // ── The other wire spelling of the same state ────────────────────────────

  it('reads an explicit null expiry as unlimited too — not the 1970 epoch', async () => {
    // `user-detail-shape.ts` declares `expireAt?: string | null` because
    // unlimited is spelled BOTH ways across the API: this endpoint omits the
    // key, `GET /admin/subscriptions` sends an explicit `null`. Checking only
    // `=== undefined` would drop a `null` into `new Date(null)`, which is the
    // epoch — the confident `01.01.1970` the subscriptions list used to print
    // on every unlimited row. Pinned on the card, the shared component.
    mockUser({ ...BASE_SUBSCRIPTION, expireAt: null })

    await openSubscriptionsTab()
    await screen.findByText(cardExpiryLabel(), { selector: 'span' })

    expectUnlimited(valueCellFor(cardExpiryLabel()))
  })
})
