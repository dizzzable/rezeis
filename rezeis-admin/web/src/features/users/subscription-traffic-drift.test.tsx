/**
 * THE DRIFT NOTICE MUST NOT REPORT A DRIFT THAT DOES NOT EXIST.
 *
 * The sync card shows the panel's own reading of the two columns rezeis owns,
 * so an operator can see the panel enforcing something other than what was
 * assigned. That is only useful while it is TRUE — a notice that cries drift
 * over two agreeing sides is worse than no notice, because the operator spends
 * the afternoon looking for a fault that is not there and learns to ignore the
 * block afterwards.
 *
 * Two defects made it lie, and both are pinned here.
 *
 * 1. A SEVENTH COPY OF THE CONVERSION, in the old defective spelling —
 *    `Math.round(bytes / 1024 ** 3)`, no floor. The server's shared converter
 *    floors any positive cap at 1 GB precisely so a sub-gigabyte cap cannot
 *    collapse to `0` (a stored `0` is pushed to the panel as UNLIMITED). Once
 *    the server had the floor and this card did not, they disagreed BY
 *    CONSTRUCTION: a 0.4 GB panel cap stored as `1`, rendered as `0`, reported
 *    as drift.
 *
 * 2. `sub.trafficLimit ?? 0`, which made an UNLIMITED row and a genuine
 *    ZERO-GIGABYTE row the same number. `trafficLimit === null` is unlimited
 *    and `0` means no traffic at all; collapsing them threw away the one
 *    distinction the column is required to keep, in the notice whose entire job
 *    is telling an operator what the two sides actually say.
 *
 * ANTI-VACUITY. Every spec that asserts silence is paired with one that asserts
 * the notice CAN speak on the same input shape, so "no drift shown" can never
 * be passing because the block is broken, absent, or never rendered.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'

import { usePermissionStore } from '@/features/rbac'
import { i18n, loadFeatureBundle } from '@/i18n/i18n'
import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'

import UserDetailPanel from './user-detail-panel'

const GIB = 1024 * 1024 * 1024

/** The drift headline, read from the ACTIVE bundle rather than re-typed. */
const driftHeadline = (): string =>
  i18n.t('userDetailPanel.subscriptions.syncOutcome.drift.headline')
const subscriptionsTabLabel = (): string => i18n.t('userDetailPanel.tabs.subscriptions')
const syncButtonLabel = (): string => i18n.t('userDetailPanel.subscriptions.syncTitle')

/**
 * Devices deliberately AGREE with the panel in every case below (3 against 3),
 * so the only thing that can put the drift block on screen is traffic. A device
 * drift would satisfy the headline assertions for the wrong reason.
 */
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

/**
 * Press sync with a given panel reading against a given assigned cap, and hand
 * back the notice.
 *
 * Waits for the notice to EXIST, never for the words a caller is about to
 * assert — waiting on expected text turns a real regression into a timeout and
 * makes every "and NOT the other thing" assertion unreachable.
 */
async function syncWith(options: {
  readonly assignedTrafficGb: number | null
  readonly panelTrafficLimitBytes: number | null
}): Promise<HTMLElement> {
  const user = userEvent.setup()
  vi.spyOn(api, 'get').mockResolvedValue({
    data: userWith({ ...SUBSCRIPTION, trafficLimit: options.assignedTrafficGb }),
  })
  vi.spyOn(api, 'post').mockResolvedValue({
    data: {
      synced: true,
      refreshed: {},
      panelReports: {
        trafficLimitBytes: options.panelTrafficLimitBytes,
        hwidDeviceLimit: 3,
      },
    },
  })
  const success = vi.spyOn(toast, 'success').mockReturnValue('t-ok')

  renderWithProviders(<UserDetailPanel telegramId="12345" />)
  await user.click(await screen.findByRole('tab', { name: new RegExp(subscriptionsTabLabel()) }))
  await user.click(await screen.findByRole('button', { name: syncButtonLabel() }))

  await waitFor(() => expect(success.mock.calls.length).toBeGreaterThan(0))
  return screen.findByRole('status')
}

describe('the panel-vs-record traffic drift notice', () => {
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

  // ── The floor ────────────────────────────────────────────────────────────

  it('stays quiet when a sub-gigabyte panel cap matches the gigabyte we stored', async () => {
    // THE REGRESSION THIS FILE EXISTS FOR. The server floors 0.4 GB to `1` and
    // stores it. An unfloored `Math.round(0.4 GB)` here computes `0`, and the
    // card then tells the operator the panel is enforcing 0 against an assigned
    // 1 — a drift between two sides that agree completely.
    const notice = await syncWith({
      assignedTrafficGb: 1,
      panelTrafficLimitBytes: Math.round(0.4 * GIB),
    })

    expect(notice).not.toHaveTextContent(driftHeadline())
    expect(notice).not.toHaveTextContent('Traffic: panel')
  })

  it('still speaks when a sub-gigabyte cap genuinely disagrees', async () => {
    // The pair for the spec above. Same input SHAPE — a sub-gigabyte panel
    // reading — so silence there cannot be a drift block that never renders.
    const notice = await syncWith({
      assignedTrafficGb: 50,
      panelTrafficLimitBytes: Math.round(0.4 * GIB),
    })

    expect(notice).toHaveTextContent(driftHeadline())
    expect(notice).toHaveTextContent('Traffic: panel 1 GB, assigned 50 GB')
  })

  // ── Unlimited is not zero ────────────────────────────────────────────────

  it('says "unlimited" for an unlimited row, not "0 GB"', async () => {
    // `?? 0` rendered this as "assigned 0 GB" — the row claiming the customer
    // may move nothing, when the row says they may move anything.
    const notice = await syncWith({ assignedTrafficGb: null, panelTrafficLimitBytes: 50 * GIB })

    expect(notice).toHaveTextContent(driftHeadline())
    expect(notice).toHaveTextContent('Traffic: panel 50 GB, assigned unlimited')
    expect(notice).not.toHaveTextContent('assigned 0 GB')
  })

  it('says "0 GB" for a genuine zero-gigabyte row, and means it', async () => {
    // The other half of the distinction. These two specs must render DIFFERENT
    // sentences from the same panel reading; that difference is the whole point
    // of keeping `null` and `0` apart in this column.
    const notice = await syncWith({ assignedTrafficGb: 0, panelTrafficLimitBytes: 50 * GIB })

    expect(notice).toHaveTextContent(driftHeadline())
    expect(notice).toHaveTextContent('Traffic: panel 50 GB, assigned 0 GB')
    expect(notice).not.toHaveTextContent('assigned unlimited')
  })

  it('stays quiet when both sides are unlimited', async () => {
    // The panel spells unlimited `0` BYTES. With `?? 0` the assigned side read
    // as `0` gigabytes and this pair looked like a disagreement between
    // "unlimited" and "zero" — a permanent drift notice on every unlimited
    // subscription in the system.
    const notice = await syncWith({ assignedTrafficGb: null, panelTrafficLimitBytes: 0 })

    expect(notice).not.toHaveTextContent(driftHeadline())
    expect(notice).not.toHaveTextContent('Traffic: panel')
  })

  it('reports the panel going unlimited on a zero-gigabyte row', async () => {
    // The reverse, and a real fault worth showing: the panel cannot express
    // "zero bytes", so a row that says zero is uncapped upstream. The operator
    // needs to see exactly that, in words, rather than an impossible "panel 0".
    const notice = await syncWith({ assignedTrafficGb: 0, panelTrafficLimitBytes: 0 })

    expect(notice).toHaveTextContent(driftHeadline())
    expect(notice).toHaveTextContent('Traffic: panel unlimited, assigned 0 GB')
  })

  // ── Absence is not a statement ───────────────────────────────────────────

  it('claims no traffic drift when the panel never stated a cap', async () => {
    // `trafficLimitBytes: null` means the payload did not mention traffic at
    // all, which is NOT "the panel said unlimited". Reading absence as a
    // positive statement invents a drift out of a truncated response.
    const notice = await syncWith({ assignedTrafficGb: 50, panelTrafficLimitBytes: null })

    expect(notice).not.toHaveTextContent(driftHeadline())
    expect(notice).not.toHaveTextContent('Traffic: panel')
  })
})
