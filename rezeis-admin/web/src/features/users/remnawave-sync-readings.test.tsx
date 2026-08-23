/**
 * What an OPERATOR sees on a subscription card for each `remnawaveSyncState`.
 *
 * `remnawaveSyncState` answers two independent questions with one enum — "is the
 * profile there?" (UNLINKED / MISSING / UNAVAILABLE, from the panel lookup) and
 * "did the last job land?" (PENDING / FAILED / SYNCED, from `ProfileSyncJob`).
 * Rendered as a single chip beside the profile name and id, it could only be
 * read as answering the first, so a failed UPDATE — stale limits on a profile
 * that is present and reachable — said "Sync failed" next to the profile id.
 *
 * These tests assert the RENDERED TEXT and WHERE IT SITS, not that a prop was
 * passed: the defect was entirely one of reading, and a prop-level assertion
 * would have been satisfied by the broken version.
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { i18n, loadFeatureBundle } from '@/i18n/i18n'
import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'
import { usePermissionStore } from '@/features/rbac'
import UserDetailPanel from './user-detail-panel'

/** Both labels are read from the ACTIVE bundle so the Russian case drives the
 *  same helper rather than a second, drifting copy of it. */
const profileRowLabel = (): string => i18n.t('userDetailPanel.subscriptions.remnawaveProfile.label')
const subscriptionsTabLabel = (): string => i18n.t('userDetailPanel.tabs.subscriptions')

type WireSyncState = 'UNLINKED' | 'PENDING' | 'SYNCED' | 'MISSING' | 'UNAVAILABLE' | 'FAILED'

interface WireJob {
  readonly status: string
  readonly action: string
  readonly attempts: number
  readonly lastError: string | null
  readonly updatedAt: string
}

const FAILED_UPDATE_JOB: WireJob = {
  status: 'FAILED',
  action: 'UPDATE',
  attempts: 3,
  lastError: 'panel refused: device limit out of range',
  updatedAt: '2026-02-03T04:05:06.000Z',
}

function subscription(overrides: {
  readonly remnawaveSyncState: WireSyncState
  readonly remnawaveId?: string | null
  readonly remnawaveSyncJob?: WireJob | null
}) {
  return {
    id: 'subscription-1',
    status: 'ACTIVE',
    remnawaveId: 'remnawave-4471',
    remnawaveProfileName: 'rz_alice_sub_1',
    remnawaveSyncJob: null,
    expireAt: '2099-01-01T00:00:00.000Z',
    plan: { id: 'plan-1', name: 'Base', type: 'BOTH' },
    ...overrides,
  }
}

function userWith(sub: ReturnType<typeof subscription>) {
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

/** Render the panel and open the Subscriptions tab. */
async function openSubscriptions(sub: ReturnType<typeof subscription>) {
  const user = userEvent.setup()
  vi.spyOn(api, 'get').mockResolvedValue({ data: userWith(sub) })

  renderWithProviders(<UserDetailPanel telegramId="12345" />)

  await user.click(await screen.findByRole('tab', { name: new RegExp(subscriptionsTabLabel()) }))
  return screen.findByText(profileRowLabel())
}

/** The row that carries the profile name and id — the identity's own home. */
function profileRowOf(label: HTMLElement): HTMLElement {
  const row = label.closest('div')
  expect(row).not.toBeNull()
  return row as HTMLElement
}

describe('the subscription card splits the two readings of remnawaveSyncState', () => {
  beforeAll(async () => {
    await loadFeatureBundle('userDetail')
  })

  beforeEach(() => {
    vi.restoreAllMocks()
    usePermissionStore.setState({ loaded: true, role: 'DEV' })
  })

  /**
   * One row per state the wire can carry. `identityChip` is what the operator
   * reads beside the profile name; `failureNotice` is whether the card-level
   * notice about the JOB appears at all.
   */
  const CASES: ReadonlyArray<{
    readonly state: WireSyncState
    readonly remnawaveId?: string | null
    readonly job?: WireJob | null
    readonly identityChip: string
    readonly failureNotice: boolean
  }> = [
    { state: 'UNLINKED', remnawaveId: null, identityChip: 'Not linked', failureNotice: false },
    { state: 'SYNCED', identityChip: 'Linked', failureNotice: false },
    { state: 'PENDING', job: { ...FAILED_UPDATE_JOB, status: 'PENDING', lastError: null }, identityChip: 'Linked', failureNotice: false },
    { state: 'MISSING', identityChip: 'Not found on the panel', failureNotice: false },
    { state: 'UNAVAILABLE', identityChip: 'Panel unavailable', failureNotice: false },
    { state: 'FAILED', job: FAILED_UPDATE_JOB, identityChip: 'Linked', failureNotice: true },
  ]

  it.each(CASES)(
    '$state: the chip beside the profile reads "$identityChip" and never mentions the job',
    async ({ state, remnawaveId, job, identityChip, failureNotice }) => {
      const label = await openSubscriptions(
        subscription({
          remnawaveSyncState: state,
          ...(remnawaveId !== undefined ? { remnawaveId } : {}),
          ...(job !== undefined ? { remnawaveSyncJob: job } : {}),
        }),
      )
      const row = profileRowOf(label)

      expect(within(row).getByText(identityChip)).toBeInTheDocument()

      // PLACEMENT — the job's fate must not be inside the identity row. This is
      // the whole defect: a chip here is read as a claim about the link.
      expect(within(row).queryByRole('status')).toBeNull()
      expect(within(row).queryByText(/Not applied on the panel/)).toBeNull()
      // ...and the old conflated wording is gone from the card entirely.
      expect(screen.queryByText('Sync failed')).toBeNull()
      expect(screen.queryByText('Synced')).toBeNull()

      const notice = screen.queryByRole('status')
      expect(notice === null).toBe(!failureNotice)
    },
  )

  it('names the change that did not land, and says the link itself is fine', async () => {
    const label = await openSubscriptions(
      subscription({ remnawaveSyncState: 'FAILED', remnawaveSyncJob: FAILED_UPDATE_JOB }),
    )

    const notice = screen.getByRole('status')
    // The change, not the profile.
    expect(
      within(notice).getByText('Not applied on the panel: the latest settings — limits, expiry, squads'),
    ).toBeInTheDocument()
    // The sentence that denies the reading the old chip forced.
    expect(
      within(notice).getByText('The profile itself is linked and reachable — only this change is outstanding.'),
    ).toBeInTheDocument()
    // And the identity says so too, in its own place.
    expect(within(profileRowOf(label)).getByText('Linked')).toBeInTheDocument()
  })

  it('still loses none of the failure detail PR #40 put on the wire', async () => {
    await openSubscriptions(
      subscription({ remnawaveSyncState: 'FAILED', remnawaveSyncJob: FAILED_UPDATE_JOB }),
    )

    const notice = screen.getByRole('status')
    expect(within(notice).getByText('Attempts: 3')).toBeInTheDocument()
    expect(
      within(notice).getByText('panel refused: device limit out of range'),
    ).toBeInTheDocument()
  })

  it('names a failed CREATE as creating the profile, and claims nothing about a link there is none of', async () => {
    const label = await openSubscriptions(
      subscription({
        remnawaveSyncState: 'FAILED',
        remnawaveId: null,
        remnawaveSyncJob: { ...FAILED_UPDATE_JOB, action: 'CREATE' },
      }),
    )

    const notice = screen.getByRole('status')
    expect(within(notice).getByText('Not applied on the panel: creating the profile')).toBeInTheDocument()
    // No reassurance about a link that does not exist.
    expect(within(notice).queryByText(/The profile itself is linked/)).toBeNull()
    expect(within(profileRowOf(label)).getByText('Not linked')).toBeInTheDocument()
  })

  /**
   * ANTI-VACUITY CONTROL.
   *
   * Every assertion above would still pass if the identity chip had been muted
   * into saying nothing useful — "silence" satisfies "does not mention the job".
   * A genuinely absent profile must still say so plainly, and must NOT collect
   * the reassurance sentence, even while a job for it is failing.
   */
  it('a profile the panel cannot find still says so plainly, even with a failing job', async () => {
    const label = await openSubscriptions(
      subscription({ remnawaveSyncState: 'MISSING', remnawaveSyncJob: FAILED_UPDATE_JOB }),
    )
    const row = profileRowOf(label)

    expect(within(row).getByText('Not found on the panel')).toBeInTheDocument()

    const notice = screen.getByRole('status')
    expect(within(notice).queryByText(/The profile itself is linked/)).toBeNull()
  })

  it('renders the same split in Russian', async () => {
    await i18n.changeLanguage('ru')
    await loadFeatureBundle('userDetail')
    try {
      const label = await openSubscriptions(
        subscription({ remnawaveSyncState: 'FAILED', remnawaveSyncJob: FAILED_UPDATE_JOB }),
      )

      expect(
        await within(profileRowOf(label)).findByText('Привязан'),
      ).toBeInTheDocument()
      const notice = screen.getByRole('status')
      expect(
        within(notice).getByText('Не применилось в панели: актуальные настройки — лимиты, срок, сквады'),
      ).toBeInTheDocument()
      expect(
        within(notice).getByText('Сам профиль привязан и доступен — не применилось только это изменение.'),
      ).toBeInTheDocument()
    } finally {
      await i18n.changeLanguage('en')
      await loadFeatureBundle('userDetail')
    }
  })

  afterAll(async () => {
    await i18n.changeLanguage('en')
  })
})
