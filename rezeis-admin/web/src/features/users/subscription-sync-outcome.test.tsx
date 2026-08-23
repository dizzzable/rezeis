/**
 * `POST /admin/users/subscriptions/:id/sync` answers HTTP 200 for its REFUSALS
 * as well as its successes, and the card used to fire `toast.success` on the
 * status code alone.
 *
 * That is worse than a missing button. An operator presses sync to answer one
 * question — "is the panel current for this customer?" — and a green toast
 * answers YES at exactly the three moments the answer is no: nothing is linked,
 * the panel could not be reached, or the profile is gone. The mental model
 * "press sync and the panel is current" was being CONFIRMED by the UI while
 * being false.
 *
 * The backend keeps those three apart on purpose, and its own comment says why:
 * conflating "the panel merely blinked" with "the profile is genuinely gone" is
 * what sends an operator off repairing a link that was never broken. So these
 * specs pin three things, and each is a separate way for the repair to rot:
 *
 *   1. the BODY decides, never the status code;
 *   2. the three refusals stay three — different copy, different toast channel,
 *      because the operator's next action differs for each;
 *   3. every sentence an operator READS comes from the dictionaries. The
 *      backend's English prose is a diagnostic line, never operator copy —
 *      asserted by driving the whole thing in Russian;
 *   4. the CODE decides, and the sentence only when there is no code. The
 *      three refusals used to be told apart by matching that English prose
 *      byte for byte, em dash included, so one copy-edit on the controller
 *      would have collapsed all three into the generic notice — with a
 *      non-success message still on screen, so nothing looking broken, and
 *      the specific guidance simply gone. The sentence table stays as the
 *      rolling-deploy fallback and is exercised as one.
 *
 * ANTI-VACUITY DISCIPLINE. Nothing here waits on the text it is about to
 * assert: each spec waits for ANY toast to have fired and for the notice to
 * exist, then asserts which one and what it says. Waiting on the expected text
 * turns a real regression into a ten-second timeout and makes every "and NOT
 * the other two" assertion unreachable.
 */
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'

import { usePermissionStore } from '@/features/rbac'
import { i18n, loadFeatureBundle } from '@/i18n/i18n'
import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'

// ACROSS THE PACKAGE BOUNDARY, from a test, deliberately — the same move
// `rbac-catalog-parity.test.ts` makes and for the same reason: comparing the
// panel's table against a second COPY of the backend's list would reproduce
// the drift it is meant to catch. `tsconfig.app.json` excludes tests so the
// production build never follows this import, and `build-isolation.test.ts`
// pins that arrangement.
import { SUBSCRIPTION_SYNC_REFUSAL_CODES } from '../../../../src/modules/users/controllers/subscription-sync-refusals'

import { SYNC_REFUSAL_BY_CODE } from './subscription-sync-refusals'
import UserDetailPanel from './user-detail-panel'

/** Read from the ACTIVE bundle so the Russian spec drives the same helpers. */
const subscriptionsTabLabel = (): string => i18n.t('userDetailPanel.tabs.subscriptions')
const syncButtonLabel = (): string => i18n.t('userDetailPanel.subscriptions.syncTitle')

/** The exact sentences the controller returns. Byte for byte, em dash included. */
const REFUSAL_NOT_LINKED = 'No Remnawave profile linked'
const REFUSAL_UNAVAILABLE = 'Remnawave panel could not be reached — try again'
const REFUSAL_MISSING = 'Profile not found on panel'

const SUBSCRIPTION = {
  id: 'subscription-1',
  status: 'ACTIVE',
  remnawaveId: 'remnawave-4471',
  remnawaveProfileName: 'rz_alice_sub_1',
  remnawaveSyncState: 'SYNCED',
  remnawaveSyncJob: null,
  expireAt: '2099-01-01T00:00:00.000Z',
  trafficLimit: 50,
  deviceLimit: 3,
  plan: { id: 'plan-1', name: 'Base', type: 'BOTH' },
}

function userWith(sub: Record<string, unknown>) {
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
    createdAt: '2026-06-04T10:00:00.000Z',
    updatedAt: '2026-06-04T10:00:00.000Z',
    subscriptions: [sub],
    transactions: [],
    referralsGiven: [],
    partner: null,
    webAccount: null,
  }
}

function toastSpies() {
  return {
    success: vi.spyOn(toast, 'success').mockReturnValue('t-ok'),
    warning: vi.spyOn(toast, 'warning').mockReturnValue('t-warn'),
    error: vi.spyOn(toast, 'error').mockReturnValue('t-err'),
    info: vi.spyOn(toast, 'info').mockReturnValue('t-info'),
  }
}

type ToastSpies = ReturnType<typeof toastSpies>

/** Which channel fired, and with what. `null` when the operator got nothing. */
function firedToast(spies: ToastSpies): { channel: string; text: unknown } | null {
  for (const channel of ['success', 'warning', 'error', 'info'] as const) {
    const call = spies[channel].mock.calls[0]
    if (call !== undefined) return { channel, text: call[0] }
  }
  return null
}

function toastCount(spies: ToastSpies): number {
  return (
    spies.success.mock.calls.length +
    spies.warning.mock.calls.length +
    spies.error.mock.calls.length +
    spies.info.mock.calls.length
  )
}

/**
 * Press the card's sync button and wait for the answer to LAND — for any toast
 * at all, and for the card's own notice to exist. Deliberately not for any
 * particular words: the words are what every caller then asserts.
 */
async function pressSync(
  responseBody: unknown,
  overrides: Record<string, unknown> = {},
): Promise<{ spies: ToastSpies; notice: HTMLElement }> {
  const user = userEvent.setup()
  vi.spyOn(api, 'get').mockResolvedValue({ data: userWith({ ...SUBSCRIPTION, ...overrides }) })
  vi.spyOn(api, 'post').mockResolvedValue({ data: responseBody })
  const spies = toastSpies()

  renderWithProviders(<UserDetailPanel telegramId="12345" />)
  await user.click(await screen.findByRole('tab', { name: new RegExp(subscriptionsTabLabel()) }))
  await user.click(await screen.findByRole('button', { name: syncButtonLabel() }))

  await waitFor(() => expect(toastCount(spies)).toBeGreaterThan(0))
  const notice = await screen.findByRole('status')
  return { spies, notice }
}

describe('the sync button reports what the request actually did', () => {
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

  it('reports a write that landed as a success, naming what was rewritten', async () => {
    // The control for every refusal spec below. Without it, a card that showed
    // the refusal notice unconditionally would pass all of them.
    const { spies, notice } = await pressSync({
      synced: true,
      refreshed: { configUrl: 'https://panel/sub/abc', expiresAt: '2099-01-01T00:00:00.000Z' },
      panelReports: { trafficLimitBytes: 0, hwidDeviceLimit: 3 },
    })

    expect(firedToast(spies)?.channel).toBe('success')
    expect(notice).toHaveTextContent('Refreshed from the panel: subscription link, expiry')
  })

  it('says so when a landed sync rewrote nothing at all', async () => {
    const { spies, notice } = await pressSync({ synced: true, refreshed: {}, panelReports: null })

    expect(firedToast(spies)?.channel).toBe('success')
    expect(notice).toHaveTextContent('The panel stated nothing new — nothing was changed.')
  })

  /**
   * The three refusals, each with the copy and the channel it alone gets.
   *
   * `forbidden` is the point of the table: it is the other two refusals'
   * headlines, so any implementation that collapses them into one sentence
   * fails here rather than passing three near-identical specs.
   */
  const REFUSALS = [
    {
      name: 'nothing is linked',
      message: REFUSAL_NOT_LINKED,
      channel: 'info',
      headline: 'No Remnawave profile is linked',
      hint: 'Nothing to sync. Link a profile first.',
    },
    {
      name: 'the panel could not be reached',
      message: REFUSAL_UNAVAILABLE,
      channel: 'warning',
      headline: 'The panel could not be reached',
      hint: 'Nothing was written, and nothing is broken. Try again in a moment.',
    },
    {
      name: 'the profile is gone',
      message: REFUSAL_MISSING,
      channel: 'error',
      headline: 'The panel does not know this profile',
      hint: 'The link is broken — repair it before deleting anything.',
    },
  ] as const

  it.each(REFUSALS)(
    'refuses in its own words when $name, and never in green',
    async ({ message, channel, headline, hint }) => {
      const { spies, notice } = await pressSync({ synced: false, message })

      const fired = firedToast(spies)
      expect(fired?.channel).toBe(channel)
      expect(spies.success).not.toHaveBeenCalled()
      expect(notice).toHaveTextContent(headline)
      expect(notice).toHaveTextContent(hint)

      // ...and NOT either of the other two. This is what stops the three from
      // being quietly collapsed into one "sync failed" sentence.
      for (const other of REFUSALS) {
        if (other.message === message) continue
        expect(notice).not.toHaveTextContent(other.headline)
      }
    },
  )

  it('does not read a refusal as a success just because the key is there', async () => {
    // `{ synced: false }` is the shape of EVERY refusal. A truthy check, or a
    // `'synced' in body` check, reads all three as wins.
    const { spies, notice } = await pressSync({
      synced: false,
      message: REFUSAL_MISSING,
      refreshed: { configUrl: 'https://panel/sub/abc' },
    })

    expect(spies.success).not.toHaveBeenCalled()
    expect(firedToast(spies)?.channel).toBe('error')
    expect(notice).toHaveTextContent('The panel does not know this profile')
    expect(notice).not.toHaveTextContent('Refreshed from the panel')
  })

  it('shows a refusal it does not recognise without pretending it succeeded', async () => {
    const { spies, notice } = await pressSync({
      synced: false,
      message: 'Panel rejected the read: quota exceeded',
    })

    expect(spies.success).not.toHaveBeenCalled()
    expect(firedToast(spies)?.channel).toBe('error')
    expect(notice).toHaveTextContent('The sync was refused')
    // The operator-facing sentence is the dictionary's...
    expect(notice).toHaveTextContent('a reason this build does not recognise')
    // ...and the server's own words survive as a demoted diagnostic line.
    expect(notice).toHaveTextContent('Panel rejected the read: quota exceeded')
  })

  /**
   * THE SPEC THAT WOULD HAVE CAUGHT THE ORIGINAL FRAGILITY.
   *
   * The table above sends the sentence and NO code — an older backend, and the
   * rolling-deploy half of this contract. This one sends the code together with
   * a sentence that has been deliberately reworded, which is what any copy pass
   * on the controller produces: a full stop added, an em dash typed as a hyphen.
   * Before the code existed, every one of these degraded to the generic refusal
   * notice and the operator quietly stopped being told which of the three had
   * happened — while a non-success notice still appeared, so nothing looked
   * broken.
   *
   * Each row also asserts the reworded sentence is NOWHERE on screen. That is
   * what separates "the code decided this" from "the sentence happened to match
   * anyway": a recognised refusal is answered entirely from the dictionaries,
   * and only the unrecognised one quotes the server's own words.
   */
  const REWORDED = [
    {
      name: 'nothing is linked',
      code: SUBSCRIPTION_SYNC_REFUSAL_CODES.notLinked,
      message: 'No Remnawave profile is linked.',
      channel: 'info',
      headline: 'No Remnawave profile is linked',
    },
    {
      name: 'the panel could not be reached',
      code: SUBSCRIPTION_SYNC_REFUSAL_CODES.panelUnavailable,
      // The em dash typed as a plain hyphen. Not a hypothetical: it is what a
      // keyboard, a linter or a copy-editor does to that sentence first.
      message: 'Remnawave panel could not be reached - try again',
      channel: 'warning',
      headline: 'The panel could not be reached',
    },
    {
      name: 'the profile is gone',
      code: SUBSCRIPTION_SYNC_REFUSAL_CODES.profileMissing,
      message: 'Profile was not found on the panel',
      channel: 'error',
      headline: 'The panel does not know this profile',
    },
  ] as const

  it.each(REWORDED)(
    'classifies by the code when $name, even though the sentence was reworded',
    async ({ code, message, channel, headline }) => {
      const { spies, notice } = await pressSync({ synced: false, code, message })

      expect(firedToast(spies)?.channel).toBe(channel)
      expect(spies.success).not.toHaveBeenCalled()
      expect(notice).toHaveTextContent(headline)
      // NOT the generic branch: that is precisely the silent degradation.
      expect(notice).not.toHaveTextContent('The sync was refused')
      // ...and the server's reworded prose never reaches the operator, because
      // a recognised refusal is answered from the dictionaries in full.
      expect(notice).not.toHaveTextContent(message)

      for (const other of REWORDED) {
        if (other.code === code) continue
        expect(notice).not.toHaveTextContent(other.headline)
      }
    },
  )

  it.each(REWORDED)(
    'still classifies $name from the sentence alone when the backend is too old to send a code',
    async ({ name, channel, headline }) => {
      // THE ROLLING DEPLOY. This panel build ships before, after or between the
      // backend halves, and for that window the response carries the original
      // sentence and no code at all. Deleting the sentence table "now that there
      // is a code" breaks exactly this case, and only while a deploy is in
      // flight — the hardest kind of regression to see.
      const original = REFUSALS.find((refusal) => refusal.name === name)
      expect(original).toBeDefined()

      const { spies, notice } = await pressSync({
        synced: false,
        message: original?.message ?? '',
      })

      expect(firedToast(spies)?.channel).toBe(channel)
      expect(spies.success).not.toHaveBeenCalled()
      expect(notice).toHaveTextContent(headline)
      expect(notice).not.toHaveTextContent('The sync was refused')
    },
  )

  it('still trusts a sentence it knows when the code is one it has never seen', async () => {
    // A backend NEWER than this panel, refusing for a reason this build has no
    // branch for but wording it the way it always has. An older sentence it
    // does understand is better guidance than the generic notice, so the
    // unknown code falls through to the sentence rather than short-circuiting.
    const { spies, notice } = await pressSync({
      synced: false,
      code: 'sync_some_refusal_from_the_future',
      message: REFUSAL_UNAVAILABLE,
    })

    expect(firedToast(spies)?.channel).toBe('warning')
    expect(notice).toHaveTextContent('The panel could not be reached')
  })

  it('falls back to the generic refusal when neither the code nor the sentence is known', async () => {
    // The control for both fallbacks above. Without it, an implementation that
    // answered `panelUnavailable` for everything would satisfy them.
    const { spies, notice } = await pressSync({
      synced: false,
      code: 'sync_some_refusal_from_the_future',
      message: 'Panel rejected the read: quota exceeded',
    })

    expect(spies.success).not.toHaveBeenCalled()
    expect(firedToast(spies)?.channel).toBe('error')
    expect(notice).toHaveTextContent('The sync was refused')
    expect(notice).toHaveTextContent('Panel rejected the read: quota exceeded')
  })

  it('shows the drift the sync deliberately refused to adopt', async () => {
    // The panel enforcing twelve devices against the three an operator assigned
    // is a real problem to act on. Adopting the panel's number would let drift
    // silently replace the plan; hiding it leaves the operator with a customer
    // complaint and no signal.
    const { notice } = await pressSync({
      synced: true,
      refreshed: {},
      panelReports: { trafficLimitBytes: 0, hwidDeviceLimit: 12 },
    })

    expect(notice).toHaveTextContent('The panel is enforcing different limits:')
    expect(notice).toHaveTextContent('Devices: panel 12, assigned 3')
  })

  it('stays quiet when the panel agrees with what was assigned', async () => {
    // The control. A drift block that is always on screen is furniture.
    const { notice } = await pressSync({
      synced: true,
      refreshed: {},
      // 50 GB in bytes, and the assigned device limit, both matching SUBSCRIPTION.
      panelReports: { trafficLimitBytes: 50 * 1024 * 1024 * 1024, hwidDeviceLimit: 3 },
    })

    expect(notice).not.toHaveTextContent('The panel is enforcing different limits:')
    expect(notice).not.toHaveTextContent('Devices: panel')
  })

  it('refuses in Russian for a Russian operator', async () => {
    // The backend's `message` is English prose. If any of it were being
    // rendered as operator copy rather than looked up as a key, this spec is
    // where it shows: the whole notice is asserted in Russian.
    await i18n.changeLanguage('ru')
    await loadFeatureBundle('userDetail')
    try {
      const { spies, notice } = await pressSync({ synced: false, message: REFUSAL_MISSING })

      expect(firedToast(spies)?.text).toBe('Панель не знает этот профиль. Связь оборвана.')
      expect(notice).toHaveTextContent('Панель не знает этот профиль')
      expect(notice).toHaveTextContent('Связь оборвана — почините её, прежде чем что-либо удалять.')
      // The English sentence the server sent is nowhere on screen: this refusal
      // is one the build recognises, so the dictionary answers in full.
      expect(notice).not.toHaveTextContent(REFUSAL_MISSING)
    } finally {
      await i18n.changeLanguage('en')
      await loadFeatureBundle('userDetail')
    }
  })

  afterAll(async () => {
    await i18n.changeLanguage('en')
  })
})

/**
 * THE DRIFT GUARD: the backend's refusal codes against the panel's table.
 *
 * The codes only move the fragility if nothing watches them. A fourth refusal
 * added to the controller, or one of the three renamed, would leave the panel
 * with no branch for it — and the failure would look exactly like the one this
 * whole change removes: a non-success notice with the specific guidance quietly
 * missing, and every other spec in this file still green, because every other
 * spec in this file writes both sides of the wire itself.
 *
 * This is a REAL link, not a pair of literals someone must remember to keep in
 * step: the backend's own `SUBSCRIPTION_SYNC_REFUSAL_CODES` is imported and
 * compared against the panel's `SYNC_REFUSAL_BY_CODE`. Editing one and not the
 * other fails here by name.
 *
 * It does NOT run the controller — the panel could not load Nest and Prisma
 * into a jsdom worker, and should not try. What it proves is that the two
 * tables agree; that the controller actually puts each code on each refusal is
 * proved next door, in `test/admin-user-subscriptions.controller.spec.ts`,
 * against the same imported constant.
 */
describe('the panel understands every refusal code the backend can send', () => {
  it('is comparing two real, distinct tables', () => {
    // The anchor. Two empty collections satisfy every `toEqual([])` below.
    expect(Object.keys(SUBSCRIPTION_SYNC_REFUSAL_CODES)).toHaveLength(3)
    expect(SYNC_REFUSAL_BY_CODE.size).toBe(3)
  })

  it('has a branch for every code the backend can send', () => {
    // Names, not a count: the failure has to say which code to add.
    expect(
      Object.values(SUBSCRIPTION_SYNC_REFUSAL_CODES).filter(
        (code) => !SYNC_REFUSAL_BY_CODE.has(code),
      ),
    ).toEqual([])
  })

  it('claims no code the backend has never heard of', () => {
    // The quieter direction: a row here that nothing sends is dead weight that
    // reads as coverage, and it is how a rename leaves BOTH tables looking full.
    const backend = new Set<string>(Object.values(SUBSCRIPTION_SYNC_REFUSAL_CODES))
    expect([...SYNC_REFUSAL_BY_CODE.keys()].filter((code) => !backend.has(code))).toEqual([])
  })

  it('maps each code to the outcome the backend named it for', () => {
    // Membership is not enough. The backend keys its codes by the outcome each
    // one means, and those keys are spelled exactly like the panel's own kinds,
    // so a pair swapped between two rows — an outage rendered as a broken link —
    // is caught here and nowhere else.
    expect(
      Object.entries(SUBSCRIPTION_SYNC_REFUSAL_CODES).map(
        ([kind, code]) => `${kind} -> ${SYNC_REFUSAL_BY_CODE.get(code) ?? 'UNHANDLED'}`,
      ),
    ).toEqual(
      Object.keys(SUBSCRIPTION_SYNC_REFUSAL_CODES).map((kind) => `${kind} -> ${kind}`),
    )
  })
})
