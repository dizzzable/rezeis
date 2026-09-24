/**
 * ↻ SAYS WHAT IT DID with a subscription in the durable term model.
 *
 * There a Remnawave read never writes the limits, writes the expiry only when
 * nothing pushed from here is newer than the read, and a profile holding other
 * limits gets the assigned ones sent back. The server's answer carries that
 * verdict (`readback`); the card used to know nothing of it and went on
 * printing «The panel is enforcing different limits» over limits that were
 * already being sent back, or that the read was too old to speak for.
 *
 * Pinned here: every verdict's words, in both languages; the card's own
 * comparison silenced exactly where the server's verdict speaks instead; and a
 * subscription outside the model — no `readback` — told what it always was.
 *
 * ANTI-VACUITY, as next door: nothing waits on the words it asserts, and every
 * "not shown" is paired with a case on the same input that does show it.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'

import { usePermissionStore } from '@/features/rbac'
import { i18n, loadFeatureBundle } from '@/i18n/i18n'
import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'

// Across the package boundary, from a test, as `subscription-sync-outcome.test.tsx`
// does for the refusal codes: the backend's own list, never a second copy.
import { SUBSCRIPTION_SYNC_PANEL_LIMITS } from '../../../../src/modules/users/controllers/subscription-sync-readback'

import { LIMITS_NOT_SENT_BACK, SYNC_PANEL_LIMITS_VERDICTS } from './subscription-sync-readback'
import UserDetailPanel from './user-detail-panel'

const GIB = 1024 * 1024 * 1024

const subscriptionsTabLabel = (): string => i18n.t('userDetailPanel.tabs.subscriptions')
const syncButtonLabel = (): string => i18n.t('userDetailPanel.subscriptions.syncTitle')
const driftHeadline = (): string => i18n.t('userDetailPanel.subscriptions.syncOutcome.drift.headline')

/** 3 devices and 100 GB assigned; the panel's reading below disagrees on both. */
const SUBSCRIPTION = {
  id: 'subscription-1',
  status: 'ACTIVE',
  remnawaveId: '4471',
  remnawaveProfileName: 'rz_alice_sub_1',
  remnawaveSyncState: 'SYNCED',
  remnawaveSyncJob: null,
  expireAt: '2099-01-01T00:00:00.000Z',
  trafficLimit: 100,
  deviceLimit: 3,
  plan: { id: 'plan-1', name: 'Base', type: 'BOTH' },
}

/** What Remnawave holds: 12 devices, 300 GB — a drift the card can compute on its own. */
const DRIFTED = { trafficLimitBytes: 300 * GIB, hwidDeviceLimit: 12 }

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
 * Press ↻ on a subscription (`overrides` on SUBSCRIPTION) with a synced answer
 * carrying `readback` (omitted when `undefined`), and hand back the notice.
 */
async function pressSync(options: {
  readonly readback?: unknown
  readonly panelReports?: unknown
  readonly overrides?: Record<string, unknown>
}): Promise<HTMLElement> {
  const user = userEvent.setup()
  vi.spyOn(api, 'get').mockResolvedValue({ data: userWith({ ...SUBSCRIPTION, ...options.overrides }) })
  vi.spyOn(api, 'post').mockResolvedValue({
    data: {
      synced: true,
      refreshed: { expiresAt: '2099-01-01T00:00:00.000Z' },
      panelReports: options.panelReports ?? DRIFTED,
      ...(options.readback === undefined ? {} : { readback: options.readback }),
    },
  })
  const success = vi.spyOn(toast, 'success').mockReturnValue('t-ok')

  renderWithProviders(<UserDetailPanel telegramId="12345" />)
  await user.click(await screen.findByRole('tab', { name: new RegExp(subscriptionsTabLabel()) }))
  await user.click(await screen.findByRole('button', { name: syncButtonLabel() }))

  await waitFor(() => expect(success.mock.calls.length).toBeGreaterThan(0))
  return screen.findByRole('status')
}

const PUT_BACK = {
  panelLimits: 'PUT_BACK',
  expiryTaken: true,
  limitsPutBack: { syncJobId: 'job-7', trafficLimit: 100, deviceLimit: 5 },
}

describe('↻ reports the verdict on a subscription in the term model', () => {
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

  afterAll(async () => {
    await i18n.changeLanguage('en')
  })

  it('outside the model the card compares the limits itself, as it always did', async () => {
    // The control for every case below that silences the comparison.
    const notice = await pressSync({})

    expect(notice).toHaveTextContent(driftHeadline())
    expect(notice).toHaveTextContent('Devices: panel 12, assigned 3')
    expect(notice).toHaveTextContent('Traffic: panel 300 GB, assigned 100 GB')
    expect(notice).not.toHaveTextContent('Remnawave')
  })

  it('names the limits being sent back, instead of calling them a drift to chase', async () => {
    const notice = await pressSync({ readback: PUT_BACK })

    expect(notice).toHaveTextContent(
      'Remnawave had different limits — the assigned ones are being sent there: 5 devices, 100 GB.',
    )
    expect(notice).not.toHaveTextContent(driftHeadline())
    // What Remnawave held stays on the card, beside the sentence.
    expect(notice).toHaveTextContent('Devices: panel 12, assigned 3')
    expect(notice).not.toHaveTextContent('The expiry from Remnawave was not taken')
  })

  it('names unlimited limits in words, not as a zero', async () => {
    const notice = await pressSync({
      readback: { ...PUT_BACK, limitsPutBack: { syncJobId: 'job-7', trafficLimit: null, deviceLimit: 0 } },
    })

    expect(notice).toHaveTextContent('the assigned ones are being sent there: unlimited devices, unlimited traffic.')
  })

  it('says the expiry was not taken when a push from here is newer than the read, and prints no drift from that stale read', async () => {
    const notice = await pressSync({
      readback: { panelLimits: 'OUTRANKED', expiryTaken: false, limitsPutBack: null },
    })

    expect(notice).toHaveTextContent(
      'The expiry from Remnawave was not taken: the latest change to this subscription has not reached it yet.',
    )
    expect(notice).not.toHaveTextContent(driftHeadline())
    expect(notice).not.toHaveTextContent('Devices: panel')
    expect(notice).not.toHaveTextContent('being sent there')
  })

  it('prints no drift when the server found Remnawave in step, whatever the card’s own comparison says', async () => {
    // `-1` and the panel's `0` are both unlimited; the card's own comparison
    // reads them as a difference, the server's (in the units it pushes) does not.
    const notice = await pressSync({
      readback: { panelLimits: 'IN_STEP', expiryTaken: true, limitsPutBack: null },
      panelReports: { trafficLimitBytes: 100 * GIB, hwidDeviceLimit: 0 },
      overrides: { deviceLimit: -1 },
    })

    expect(notice).not.toHaveTextContent(driftHeadline())
    expect(notice).not.toHaveTextContent('Devices: panel')
    expect(notice).toHaveTextContent('Refreshed from the panel: expiry')
  })

  it('the same answer without a verdict shows the card’s comparison — the silence above is the verdict’s', async () => {
    const notice = await pressSync({
      panelReports: { trafficLimitBytes: 100 * GIB, hwidDeviceLimit: 0 },
      overrides: { deviceLimit: -1 },
    })

    expect(notice).toHaveTextContent('Devices: panel 0, assigned -1')
  })

  const NOT_SENT_BACK = [
    { verdict: 'PROFILE_DELETED', reason: 'it reports the profile deleted' },
    { verdict: 'SHARED_PROFILE', reason: 'Merge them: Subscriptions → “Duplicate subscription merge”.' },
    { verdict: 'UNLINKED', reason: 'the subscription has no link to a Remnawave profile' },
  ] as const

  it.each(NOT_SENT_BACK)(
    'keeps the drift and says why the assigned limits were not sent back: $verdict',
    async ({ verdict, reason }) => {
      const notice = await pressSync({ readback: { panelLimits: verdict, expiryTaken: true, limitsPutBack: null } })

      expect(notice).toHaveTextContent(driftHeadline())
      expect(notice).toHaveTextContent('Devices: panel 12, assigned 3')
      expect(notice).toHaveTextContent('The assigned limits were not sent to Remnawave:')
      expect(notice).toHaveTextContent(reason)
      expect(notice).not.toHaveTextContent('being sent there')
    },
  )

  it('says the limits differ even where the card cannot see how', async () => {
    const notice = await pressSync({
      readback: { panelLimits: 'SHARED_PROFILE', expiryTaken: true, limitsPutBack: null },
      panelReports: { trafficLimitBytes: 100 * GIB, hwidDeviceLimit: 3 },
    })

    expect(notice).toHaveTextContent(driftHeadline())
    expect(notice).not.toHaveTextContent('Devices: panel')
  })

  it('falls back to its own comparison for a verdict it has no words for', async () => {
    const notice = await pressSync({
      readback: { panelLimits: 'SOME_VERDICT_FROM_THE_FUTURE', expiryTaken: true, limitsPutBack: null },
    })

    expect(notice).toHaveTextContent(driftHeadline())
    expect(notice).toHaveTextContent('Devices: panel 12, assigned 3')
  })

  it('does not name a put-back whose limits it cannot read', async () => {
    const notice = await pressSync({ readback: { ...PUT_BACK, limitsPutBack: { syncJobId: 'job-7' } } })

    expect(notice).not.toHaveTextContent('being sent there')
    expect(notice).toHaveTextContent(driftHeadline())
  })

  it('says it all in Russian for a Russian operator', async () => {
    await i18n.changeLanguage('ru')
    await loadFeatureBundle('userDetail')
    try {
      const putBack = await pressSync({ readback: PUT_BACK })
      expect(putBack).toHaveTextContent(
        'Лимиты в Remnawave отличались — туда отправляются назначенные: 5 устройств, 100 ГБ.',
      )
      cleanup()

      const one = await pressSync({
        readback: { ...PUT_BACK, limitsPutBack: { syncJobId: 'job-7', trafficLimit: null, deviceLimit: 1 } },
      })
      expect(one).toHaveTextContent('туда отправляются назначенные: 1 устройство, безлимитный трафик.')
      cleanup()

      const few = await pressSync({
        readback: { ...PUT_BACK, limitsPutBack: { syncJobId: 'job-7', trafficLimit: 50, deviceLimit: 2 } },
      })
      expect(few).toHaveTextContent('туда отправляются назначенные: 2 устройства, 50 ГБ.')
      cleanup()

      const unlimitedDevices = await pressSync({
        readback: { ...PUT_BACK, limitsPutBack: { syncJobId: 'job-7', trafficLimit: 50, deviceLimit: 0 } },
      })
      expect(unlimitedDevices).toHaveTextContent('туда отправляются назначенные: без ограничения устройств, 50 ГБ.')
      cleanup()

      const outranked = await pressSync({
        readback: { panelLimits: 'OUTRANKED', expiryTaken: false, limitsPutBack: null },
      })
      expect(outranked).toHaveTextContent(
        'Срок из Remnawave не принят: туда ещё не дошло последнее изменение подписки.',
      )
      cleanup()

      const shared = await pressSync({
        readback: { panelLimits: 'SHARED_PROFILE', expiryTaken: true, limitsPutBack: null },
      })
      expect(shared).toHaveTextContent('В панели действуют другие ограничения:')
      expect(shared).toHaveTextContent(
        'Назначенные лимиты в Remnawave не отправлены: этот профиль числится ещё за одной подпиской. Объедините их: страница «Подписки» → «Слияние подписок-дубликатов».',
      )
    } finally {
      await i18n.changeLanguage('en')
      await loadFeatureBundle('userDetail')
    }
  })
})

/**
 * THE DRIFT GUARD: the backend's verdicts against the card's words. Every
 * other case above writes both sides of the wire itself, so a verdict added to
 * the server and not here would leave them all green while the card fell back
 * to calling a put-back a drift.
 */
describe('the card has words for every verdict the server can send', () => {
  it('is comparing two real lists', () => {
    expect(SUBSCRIPTION_SYNC_PANEL_LIMITS.length).toBeGreaterThan(0)
    expect(SYNC_PANEL_LIMITS_VERDICTS.length).toBeGreaterThan(0)
  })

  it('knows every verdict the server sends, and none it does not', () => {
    expect([...SYNC_PANEL_LIMITS_VERDICTS].sort()).toEqual([...SUBSCRIPTION_SYNC_PANEL_LIMITS].sort())
  })

  it('has a reason in both languages for every verdict that sends nothing back', async () => {
    for (const language of ['en', 'ru']) {
      await i18n.changeLanguage(language)
      await loadFeatureBundle('userDetail')
      for (const verdict of LIMITS_NOT_SENT_BACK) {
        const key = `userDetailPanel.subscriptions.syncOutcome.readback.notSentBack.${verdict}`
        expect(i18n.exists(key), `${language}: ${key}`).toBe(true)
      }
    }
    await i18n.changeLanguage('en')
  })
})
