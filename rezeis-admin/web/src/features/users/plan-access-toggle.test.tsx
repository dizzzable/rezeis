/**
 * THE PLAN-ACCESS TOGGLE READ THE WRONG IDENTIFIER, AND WAS GATED ON A THIRD
 * PERMISSION.
 *
 * `Plan.allowedUserIds` holds REIWA IDS (cuids) — `plan-catalog.service.ts`
 * decides who may buy an `ALLOWED` plan with `plan.allowedUserIds.includes(
 * user.id)`, and the grant endpoint pushes `user.id`. The toggle asked
 * `plan.allowedUserIds.includes(telegramId)`, i.e. it compared a list of cuids
 * against the string in the URL. A card opened by TELEGRAM ID — which is how
 * the users table opens every card — therefore showed the switch OFF no matter
 * what the allow-list held, including immediately after a grant the operator
 * had just made and the server had accepted. Pressing it again re-sent a grant;
 * turning it off was impossible, because the control never showed on.
 *
 * A card opened by reiwa id happened to work, which is why this survived: the
 * two identifiers are the same parameter (`findUserByTelegramId` accepts
 * either), so the bug is invisible on the one path a developer is most likely
 * to try by hand.
 *
 * The gate was `subscriptions:edit` — a THIRD permission, agreeing with neither
 * the plan editor (`plans:edit`) nor the endpoint it calls (`users:edit`, now
 * corrected to `plans:edit`). A UI gate that disagrees with the server either
 * hides a button that would have worked or shows one that 403s; here it did
 * both, depending on the role.
 *
 * ── WHAT THESE CASES ASSERT ──────────────────────────────────────────────────
 *
 * Rendered state, from the REAL panel driven through the REAL query client, and
 * the REAL requests it issues. Not the helper: there is no helper, the defect
 * was one expression inside the JSX, and the identifier it should have read is
 * not even a prop the component had.
 *
 * ANTI-VACUITY. Every "the switch is on" case renders a SECOND plan in the same
 * pass whose allow-list does not hold this user, and asserts that one is off.
 * Without it, "checked" could pass on a component that renders every switch on,
 * and "unchecked" could pass on a component that renders nothing at all.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { usePermissionStore } from '@/features/rbac'
import { i18n, loadFeatureBundle } from '@/i18n/i18n'
import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'

import UserDetailPanel from './user-detail-panel'

/** The two identifiers that address the same customer. */
const REIWA_ID = 'cmsxo98e8006r01jgn33gtpbe'
const TELEGRAM_ID = '12345'

const subscriptionsTabLabel = (): string => i18n.t('userDetailPanel.tabs.subscriptions')
const toggleLabel = (planName: string): string =>
  `${i18n.t('userDetailPanel.subscriptions.planAccessToggle')} ${planName}`

const USER = {
  id: REIWA_ID,
  telegramId: TELEGRAM_ID,
  username: 'alice',
  name: 'Alice',
  email: 'alice@example.com',
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
  subscriptions: [],
  transactions: [],
  referralsGiven: [],
  partner: null,
  webAccount: null,
}

/**
 * A restricted plan, allow-list supplied by the caller.
 *
 * `allowedUserIds` carries reiwa ids because that is what the server stores;
 * a fixture holding telegram ids would agree with the defect.
 */
function allowedPlan(
  id: string,
  name: string,
  allowedUserIds: readonly string[],
): Record<string, unknown> {
  return {
    id,
    name,
    availability: 'ALLOWED',
    allowedUserIds: [...allowedUserIds],
    isActive: true,
    isArchived: false,
    trafficLimit: null,
    deviceLimit: 3,
    durations: [],
  }
}

/** Every request the panel issues, so a test can assert what the server was told. */
interface Harness {
  readonly planFetches: () => number
  readonly posts: readonly string[]
  readonly deletes: readonly string[]
}

/**
 * Renders the card on the Subscriptions tab and hands back the request log.
 *
 * `plansByFetch` is read by ORDINAL: the first `/admin/plans` answers with
 * entry 0, the second with entry 1, and so on — the last entry repeating. That
 * is how "the catalogue after the grant committed" is expressed without a
 * timer, and it means a test that expects a refetch fails if none is issued.
 */
async function openSubscriptionsTab(
  plansByFetch: ReadonlyArray<ReadonlyArray<Record<string, unknown>>>,
  options?: { readonly telegramId?: string },
): Promise<Harness> {
  const user = userEvent.setup()
  const posts: string[] = []
  const deletes: string[] = []
  let planFetches = 0

  vi.spyOn(api, 'get').mockImplementation((url: string) => {
    if (url === '/admin/plans') {
      const index = Math.min(planFetches, plansByFetch.length - 1)
      planFetches += 1
      return Promise.resolve({ data: plansByFetch[index] })
    }
    return Promise.resolve({ data: USER })
  })
  vi.spyOn(api, 'post').mockImplementation((url: string) => {
    posts.push(url)
    return Promise.resolve({ data: { granted: true } })
  })
  vi.spyOn(api, 'delete').mockImplementation((url: string) => {
    deletes.push(url)
    return Promise.resolve({ data: { revoked: true } })
  })

  renderWithProviders(<UserDetailPanel telegramId={options?.telegramId ?? TELEGRAM_ID} />)
  await user.click(await screen.findByRole('tab', { name: new RegExp(subscriptionsTabLabel()) }))

  return { planFetches: () => planFetches, posts, deletes }
}

describe('the plan-access toggle reflects the allow-list the server keeps', () => {
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

  it('renders the switch ON for a card opened by TELEGRAM ID when the user is on the list', async () => {
    // THE DEFECT. `allowedUserIds` holds the reiwa id; the card was opened by
    // telegram id; the switch read the telegram id and found nothing.
    await openSubscriptionsTab([
      [
        allowedPlan('plan-granted', 'Inner Circle', [REIWA_ID]),
        allowedPlan('plan-other', 'Outer Circle', ['cmsxo98e8006r01jgn33gtpbf']),
      ],
    ])

    const granted = await screen.findByRole('switch', { name: toggleLabel('Inner Circle') })
    const notGranted = screen.getByRole('switch', { name: toggleLabel('Outer Circle') })

    expect(granted).toBeChecked()
    // The control: the same render distinguishes the two, so "checked" cannot
    // pass on a component that turns every switch on.
    expect(notGranted).not.toBeChecked()
  })

  it('renders the switch ON for a card opened by REIWA ID too', async () => {
    // The path that always worked, kept so a "fix" that merely swaps one
    // identifier for the other fails here instead of shipping.
    await openSubscriptionsTab(
      [
        [
          allowedPlan('plan-granted', 'Inner Circle', [REIWA_ID]),
          allowedPlan('plan-other', 'Outer Circle', []),
        ],
      ],
      { telegramId: REIWA_ID },
    )

    expect(await screen.findByRole('switch', { name: toggleLabel('Inner Circle') })).toBeChecked()
    expect(screen.getByRole('switch', { name: toggleLabel('Outer Circle') })).not.toBeChecked()
  })

  it('turns ON after a grant, on a card opened by telegram id', async () => {
    // The operator-visible half of the same defect: the grant was accepted and
    // the control still read off, so the only thing pressing it again could do
    // was re-send the grant.
    const harness = await openSubscriptionsTab([
      [allowedPlan('plan-granted', 'Inner Circle', [])],
      [allowedPlan('plan-granted', 'Inner Circle', [REIWA_ID])],
    ])
    const user = userEvent.setup()

    const toggle = await screen.findByRole('switch', { name: toggleLabel('Inner Circle') })
    expect(toggle).not.toBeChecked()

    await user.click(toggle)

    expect(harness.posts).toEqual([`/admin/users/${TELEGRAM_ID}/plan-access/plan-granted`])
    await waitFor(() => {
      expect(
        screen.getByRole('switch', { name: toggleLabel('Inner Circle') }),
      ).toBeChecked()
    })
    // The catalogue was re-read. Without this the assertion above could pass on
    // a component that flipped its own local state and never asked the server.
    expect(harness.planFetches()).toBeGreaterThan(1)
  })

  it('turns OFF after a revoke, on a card opened by telegram id', async () => {
    const harness = await openSubscriptionsTab([
      [allowedPlan('plan-granted', 'Inner Circle', [REIWA_ID])],
      [allowedPlan('plan-granted', 'Inner Circle', [])],
    ])
    const user = userEvent.setup()

    const toggle = await screen.findByRole('switch', { name: toggleLabel('Inner Circle') })
    expect(toggle).toBeChecked()

    await user.click(toggle)

    expect(harness.deletes).toEqual([`/admin/users/${TELEGRAM_ID}/plan-access/plan-granted`])
    await waitFor(() => {
      expect(
        screen.getByRole('switch', { name: toggleLabel('Inner Circle') }),
      ).not.toBeChecked()
    })
    expect(harness.planFetches()).toBeGreaterThan(1)
  })
})

describe('the toggle is gated on the permission its endpoint requires', () => {
  beforeAll(async () => {
    await loadFeatureBundle('userDetail')
  })

  afterEach(() => {
    cleanup()
    usePermissionStore.getState().reset()
    vi.restoreAllMocks()
  })

  /** A non-DEV admin holding exactly these `resource:action` grants. */
  function signInWith(...granted: readonly string[]): void {
    usePermissionStore.setState({
      loaded: true,
      role: 'ADMIN',
      granted: new Set<string>(granted),
    })
  }

  it('shows the toggle to an admin holding plans:edit', async () => {
    signInWith('users:view', 'users:edit', 'plans:view', 'plans:edit')

    await openSubscriptionsTab([[allowedPlan('plan-granted', 'Inner Circle', [REIWA_ID])]])

    expect(await screen.findByRole('switch', { name: toggleLabel('Inner Circle') })).toBeChecked()
  })

  it('hides it from the shipped operator grant set, which the endpoint now refuses', async () => {
    // `operator` holds `users:edit`, `subscriptions:edit` and only `plans:view`
    // (`rbac.resources.ts`). Under the old `subscriptions:edit` gate the control
    // was offered to exactly the role the corrected endpoint answers 403 to.
    signInWith(
      'users:view',
      'users:edit',
      'subscriptions:view',
      'subscriptions:edit',
      'plans:view',
    )

    await openSubscriptionsTab([[allowedPlan('plan-granted', 'Inner Circle', [REIWA_ID])]])

    // The card itself still renders — this is a gate on the control, not on the
    // section — so the absence below is the toggle's, not the whole tab's.
    expect(
      await screen.findByText(i18n.t('userDetailPanel.subscriptions.planAccessTitle')),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('switch', { name: toggleLabel('Inner Circle') }),
    ).not.toBeInTheDocument()
  })
})
