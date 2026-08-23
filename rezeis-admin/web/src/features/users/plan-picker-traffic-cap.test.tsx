/**
 * A LEGACY ZERO MUST NOT RENDER AS "NO CAP".
 *
 * The give-subscription plan picker wrote `plan.trafficLimit ? '(N GB)' : ''`
 * — a two-state reading of a three-state column. `null` is UNLIMITED and `0` is
 * a real cap of zero gigabytes: opposite product facts, both falsy, both
 * printed as the empty string. So a plan authored before the DTO was raised to
 * `@Min(1)` appeared in the picker as a bare name, indistinguishable from an
 * uncapped plan, and an operator assigning it handed the customer a
 * subscription that carries no traffic at all.
 *
 * These cases drive the REAL picker through the REAL Radix Select and read the
 * option rows the operator would read. A unit test of `planTrafficSuffix` alone
 * would not do: the defect was never in a helper, it was in the JSX choosing a
 * two-branch expression, and a helper test agrees with a component that never
 * calls it.
 *
 * ANTI-VACUITY. Every case asserts the string it MUST show AND the strings it
 * must not, and the three states are asserted against one another in the same
 * render, so "the zero row is right" cannot pass because the picker rendered
 * nothing, failed to open, or listed one plan.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { usePermissionStore } from '@/features/rbac'
import { i18n, loadFeatureBundle } from '@/i18n/i18n'
import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'

import UserDetailPanel from './user-detail-panel'

const subscriptionsTabLabel = (): string => i18n.t('userDetailPanel.tabs.subscriptions')
const assignPlanLabel = (): string => i18n.t('userDetailPanel.subscriptions.assignPlan')
const selectPlanLabel = (): string => i18n.t('userDetailPanel.subscriptions.selectPlan')
/** Read from the ACTIVE bundle rather than re-typed, so a copy edit cannot lie. */
const zeroLabel = (): string => i18n.t('userDetailPanel.subscriptions.planTrafficZero')

/**
 * Three plans differing ONLY in `trafficLimit`, so the three option rows are a
 * direct comparison. `trafficLimit` is declared `number` on the wire type while
 * the server declares it `number | null`; the `null` row is the state the type
 * denies and the runtime produces, which is why it is cast rather than avoided.
 */
const PLANS = [
  { id: 'plan-unlimited', name: 'Boundless', trafficLimit: null, isArchived: false },
  { id: 'plan-zero', name: 'Legacy Zero', trafficLimit: 0, isArchived: false },
  { id: 'plan-capped', name: 'Fifty', trafficLimit: 50, isArchived: false },
]

const USER = {
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
  subscriptions: [
    {
      id: 'subscription-1',
      status: 'ACTIVE',
      remnawaveId: null,
      remnawaveProfileName: 'rz_alice_sub_1',
      remnawaveSyncState: 'SYNCED',
      remnawaveSyncJob: null,
      expireAt: '2099-01-01T00:00:00.000Z',
      trafficLimit: 50,
      deviceLimit: 3,
      plan: { id: 'plan-capped', name: 'Fifty', type: 'BOTH' },
    },
  ],
  transactions: [],
  referralsGiven: [],
  partner: null,
  webAccount: null,
}

/** Open the bulk plan picker and hand back its three option rows. */
async function openPlanPicker(): Promise<readonly HTMLElement[]> {
  const user = userEvent.setup()
  vi.spyOn(api, 'get').mockImplementation((url: string) =>
    Promise.resolve({ data: url === '/admin/plans' ? PLANS : USER }),
  )

  renderWithProviders(<UserDetailPanel telegramId="12345" />)
  await user.click(await screen.findByRole('tab', { name: new RegExp(subscriptionsTabLabel()) }))
  await user.click(await screen.findByRole('button', { name: new RegExp(assignPlanLabel()) }))
  await user.click(await screen.findByRole('combobox', { name: selectPlanLabel() }))

  const options = await screen.findAllByRole('option')
  // The picker must have listed EVERY plan. Without this, a case asserting
  // "the zero row does not say ∞" would pass on a picker that rendered no rows.
  expect(options).toHaveLength(PLANS.length)
  return options
}

function optionNamed(options: readonly HTMLElement[], name: string): HTMLElement {
  const row = options.find((option) => within(option).queryByText(new RegExp(name)) !== null)
  expect(row, `no option row for ${name}`).toBeDefined()
  return row as HTMLElement
}

describe('the give-subscription plan picker states a traffic cap in three ways', () => {
  // Radix's Select drives itself with Pointer Events APIs jsdom does not
  // implement, so opening one throws `hasPointerCapture is not a function`
  // before any assertion runs. vitest isolates per file, so this prototype
  // patch does not leak.
  beforeAll(async () => {
    const proto = window.Element.prototype as unknown as Record<string, unknown>
    proto.hasPointerCapture ??= (): boolean => false
    proto.setPointerCapture ??= (): void => {}
    proto.releasePointerCapture ??= (): void => {}
    proto.scrollIntoView ??= (): void => {}
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

  it('does not render a legacy zero the way it renders an uncapped plan', async () => {
    // THE REGRESSION THIS FILE EXISTS FOR. `trafficLimit ? … : ''` printed the
    // zero plan and the unlimited plan identically — a bare name — so the row
    // that means "this customer may move nothing" read as the row that means
    // "this customer may move anything".
    const options = await openPlanPicker()

    const zero = optionNamed(options, 'Legacy Zero')
    const unlimited = optionNamed(options, 'Boundless')

    expect(zero).toHaveTextContent(zeroLabel())
    expect(zero).not.toHaveTextContent('∞')
    expect(unlimited).toHaveTextContent('∞')
    expect(unlimited).not.toHaveTextContent(zeroLabel())
    expect(zero.textContent).not.toEqual(unlimited.textContent?.replace('Boundless', 'Legacy Zero'))
  })

  it('states an unlimited plan positively rather than by saying nothing', async () => {
    // `null` used to fall into the same empty branch as `0`. Saying nothing is
    // not a statement of "no cap" — it is the absence of one, and it is what
    // let the zero row hide.
    const options = await openPlanPicker()

    const unlimited = optionNamed(options, 'Boundless')

    expect(unlimited).toHaveTextContent('∞')
    expect(unlimited).not.toHaveTextContent('GB')
  })

  it('still prints a real cap as its number of gigabytes', async () => {
    // The pair for the two specs above: the branch that already worked has to
    // keep working, or "the zero row is distinct" would be satisfied by a
    // picker that stopped stating caps at all.
    const options = await openPlanPicker()

    const capped = optionNamed(options, 'Fifty')

    expect(capped).toHaveTextContent('(50 GB)')
    expect(capped).not.toHaveTextContent('∞')
    expect(capped).not.toHaveTextContent(zeroLabel())
  })

  it('gives the three states three different strings', async () => {
    // Stated once, directly. Any two of these collapsing is the defect,
    // whichever pair it is.
    const options = await openPlanPicker()

    const suffixes = ['Boundless', 'Legacy Zero', 'Fifty'].map((name) =>
      (optionNamed(options, name).textContent ?? '').replace(name, '').trim(),
    )

    expect(new Set(suffixes).size).toBe(3)
    expect(suffixes.every((suffix) => suffix.length > 0)).toBe(true)
  })
})
