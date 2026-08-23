import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'
import PartnerDetailSheet from './partner-detail-sheet'
import { partnersAdminApi, type Partner } from './partners-api'

/**
 * The per-partner accrual controls in the Partners tab drawer.
 *
 * Three things are pinned, and each of them is a way the feature can look
 * finished while doing nothing:
 *
 *   • The empty state is an explicit "Inherit (…)" naming the partner-wide
 *     value. A blank reads as "nothing set" for a level that is in fact
 *     tracking the toggle above, and the whole point of the nullable column is
 *     that inheriting is a live relationship, not an absence.
 *   • The controls are DISABLED while the partner is on global settings, and
 *     the screen says why. A live-looking control that the backend never reads
 *     is worse than no control.
 *   • What the form SUBMITS. A level left on Inherit must go out as an
 *     explicit `null` — that is what CLEARS a previously stored override.
 *     Omitting the key would leave the old value in the column.
 *
 * Assertions are on rendered values and on the payload handed to the API, never
 * on a spy's call count.
 *
 * No absolute dates: the fixture's timestamps are derived from `Date.now()`, so
 * this file cannot quietly become an assertion about something expiring.
 */

const DAY_MS = 24 * 60 * 60 * 1000

/** Radix's Select trigger needs these; jsdom ships none of them. */
beforeAll(() => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>
  proto['hasPointerCapture'] ??= () => false
  proto['setPointerCapture'] ??= () => {}
  proto['releasePointerCapture'] ??= () => {}
  proto['scrollIntoView'] ??= () => {}
})

afterEach(() => {
  vi.restoreAllMocks()
})

function partnerFixture(overrides: Partial<Partner> = {}): Partner {
  const createdAt = new Date(Date.now() - 60 * DAY_MS).toISOString()
  return {
    id: 'partner-1',
    user: {
      id: 'user-1',
      login: 'alice',
      username: 'alice',
      name: 'Alice',
      telegramId: '12345',
      createdAt,
    },
    balance: 12500,
    totalEarned: 50000,
    totalWithdrawn: 10000,
    isActive: true,
    referralsCount: 3,
    useGlobalSettings: false,
    accrualStrategy: 'ON_EACH_PAYMENT',
    rewardType: 'PERCENT',
    level1Percent: '10',
    level2Percent: '5',
    level3Percent: '1',
    level1FixedAmount: null,
    level2FixedAmount: null,
    level3FixedAmount: null,
    level1AccrualStrategy: null,
    level2AccrualStrategy: null,
    level3AccrualStrategy: null,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  }
}

/** Renders the drawer and opens its Settings tab, where the controls live. */
async function openSettingsTab(partner: Partner) {
  const user = userEvent.setup()
  renderWithProviders(
    <PartnerDetailSheet partner={partner} open onOpenChange={() => {}} />,
  )
  await user.click(await screen.findByRole('tab', { name: 'Settings' }))
  await screen.findByText('Accrual mode per level')
  return user
}

/** The three level triggers, in L1→L3 order, found by what they display. */
function levelTriggers(displayed: string): HTMLElement[] {
  return screen
    .getAllByText(displayed)
    .map((node) => node.closest('button'))
    .filter((node): node is HTMLButtonElement => node !== null)
}

describe('per-partner accrual mode — the empty state is Inherit, not a blank', () => {
  it('names the partner-wide value inside the Inherit option', async () => {
    await openSettingsTab(partnerFixture({ accrualStrategy: 'ON_EACH_PAYMENT' }))

    // One per level. The label carries the value the level would inherit, so
    // the operator can see what "inherit" resolves to without leaving the form.
    expect(levelTriggers('Inherit (On each payment)')).toHaveLength(3)
  })

  it('follows the partner-wide control when it says once per referral', async () => {
    await openSettingsTab(partnerFixture({ accrualStrategy: 'ONCE_PER_USER' }))

    expect(levelTriggers('Inherit (Once per referral)')).toHaveLength(3)
  })

  it('shows a STORED level as its own value and the rest as Inherit', async () => {
    await openSettingsTab(
      partnerFixture({
        accrualStrategy: 'ON_EACH_PAYMENT',
        level2AccrualStrategy: 'ONCE_PER_USER',
      }),
    )

    expect(levelTriggers('Inherit (On each payment)')).toHaveLength(2)
    // Level 2 no longer follows the toggle, and the control says so by showing
    // the stored mode instead of the inherit label.
    expect(levelTriggers('Once per referral')).toHaveLength(1)
  })
})

describe('per-partner accrual mode — dead controls are disabled and explained', () => {
  it('disables all three levels while the partner is on global settings', async () => {
    await openSettingsTab(partnerFixture({ useGlobalSettings: true }))

    const triggers = levelTriggers('Inherit (On each payment)')
    expect(triggers).toHaveLength(3)
    for (const trigger of triggers) {
      expect(trigger).toBeDisabled()
    }
  })

  it('says on screen why they are disabled', async () => {
    await openSettingsTab(partnerFixture({ useGlobalSettings: true }))

    expect(
      screen.getByText(/Ignored while this partner is on global settings/),
    ).toBeInTheDocument()
  })

  it('leaves them enabled and unexplained when the partner is individual', async () => {
    await openSettingsTab(partnerFixture({ useGlobalSettings: false }))

    for (const trigger of levelTriggers('Inherit (On each payment)')) {
      expect(trigger).toBeEnabled()
    }
    expect(
      screen.queryByText(/Ignored while this partner is on global settings/),
    ).not.toBeInTheDocument()
  })
})

describe('per-partner accrual mode — what the form actually submits', () => {
  it('sends an Inherit level as an explicit null, which is what CLEARS the column', async () => {
    const update = vi
      .spyOn(partnersAdminApi, 'updateIndividualSettings')
      .mockResolvedValue(undefined)

    const user = await openSettingsTab(
      partnerFixture({ level1AccrualStrategy: 'ONCE_PER_USER' }),
    )
    await user.click(screen.getByRole('button', { name: 'Save settings' }))

    await vi.waitFor(() => expect(update).toHaveBeenCalled())
    const payload = update.mock.calls[0]?.[0]
    expect(payload).toMatchObject({
      level1AccrualStrategy: 'ONCE_PER_USER',
      level2AccrualStrategy: null,
      level3AccrualStrategy: null,
    })
    // `null`, not absent: an absent key is the "leave it alone" request.
    expect(Object.keys(payload ?? {})).toEqual(
      expect.arrayContaining([
        'level1AccrualStrategy',
        'level2AccrualStrategy',
        'level3AccrualStrategy',
      ]),
    )
  })

  it('sends the mode the operator picked for one level and leaves the others inheriting', async () => {
    const update = vi
      .spyOn(partnersAdminApi, 'updateIndividualSettings')
      .mockResolvedValue(undefined)

    const user = await openSettingsTab(partnerFixture())

    const [levelOne] = levelTriggers('Inherit (On each payment)')
    expect(levelOne).toBeDefined()
    await user.click(levelOne as HTMLElement)
    await user.click(await screen.findByRole('option', { name: 'Once per referral' }))

    await user.click(screen.getByRole('button', { name: 'Save settings' }))

    await vi.waitFor(() => expect(update).toHaveBeenCalled())
    expect(update.mock.calls[0]?.[0]).toMatchObject({
      level1AccrualStrategy: 'ONCE_PER_USER',
      level2AccrualStrategy: null,
      level3AccrualStrategy: null,
    })
  })
})

describe('per-partner accrual mode — the hint is reachable on every control', () => {
  it('gives each level its own info trigger', async () => {
    await openSettingsTab(partnerFixture())

    for (const level of [1, 2, 3]) {
      expect(
        screen.getByRole('button', { name: `What the level ${level} accrual mode does` }),
      ).toBeInTheDocument()
    }
  })

  it('explains on hover that storing the toggle value is not a no-op', async () => {
    const user = await openSettingsTab(partnerFixture())

    await user.hover(
      screen.getByRole('button', { name: 'What the level 1 accrual mode does' }),
    )

    const tooltip = await screen.findByRole('tooltip')
    expect(
      within(tooltip).getByText(/is not a no-op/),
    ).toBeInTheDocument()
    expect(
      within(tooltip).getByText(
        /a stored value stops following that strategy, an inherited one keeps following it/,
      ),
    ).toBeInTheDocument()
  })
})

describe('per-partner accrual mode — what reaches the wire', () => {
  it('keeps the Inherit null in the serialised request body', async () => {
    const patch = vi.spyOn(api, 'patch').mockResolvedValue({ data: {} })

    const user = await openSettingsTab(
      partnerFixture({ level2AccrualStrategy: 'ONCE_PER_USER' }),
    )
    await user.click(screen.getByRole('button', { name: 'Save settings' }))

    await vi.waitFor(() => expect(patch).toHaveBeenCalled())
    const [url, body] = patch.mock.calls[0] as [string, Record<string, unknown>]
    expect(url).toBe('/admin/users/12345/partner/settings')

    // Axios serialises the body with `JSON.stringify`, which KEEPS a null and
    // DROPS an undefined. `null` is the value that CLEARS the column back to
    // inherit; a dropped key leaves the column exactly as it was. Those are two
    // different requests, and serialisation is where they stop being the same —
    // so this reads the body after it, not before.
    const wire = JSON.parse(JSON.stringify(body)) as Record<string, unknown>
    expect('level1AccrualStrategy' in wire).toBe(true)
    expect(wire.level1AccrualStrategy).toBeNull()
    expect(wire.level2AccrualStrategy).toBe('ONCE_PER_USER')
    expect('level3AccrualStrategy' in wire).toBe(true)
    expect(wire.level3AccrualStrategy).toBeNull()
  })
})
