/**
 * Every tab on the Payments page renders behind ONE gate — `payments:view` —
 * and calls routes guarded by three different tokens. Two of the three
 * disagreed, and the disagreement was invisible:
 *
 *   Webhooks  → `payment_webhooks:view` (admin-payment-webhooks.controller.ts:30).
 *               An admin with `payments:view` alone reached the tab, the list
 *               403'd, `data` stayed undefined and `(data ?? []).map(…)` drew a
 *               header with no body. Verified before the fix: one row in the
 *               table (the header), and the rendered page contained no error,
 *               no empty-state copy and no explanation.
 *   Analytics → `analytics:view` (admin-payment-analytics.controller.ts:27,:40).
 *               The 403 landed in `isError`, which says "Failed to load payment
 *               analytics" — a transient message for a permanent refusal.
 *
 * These specs drive the page as an operator does and assert what is ON SCREEN
 * for each permission shape. Asserting that a gate component was used would
 * guard nothing: the defect was never a missing gate, it was a gate checking
 * the wrong token.
 *
 * The pair that carries the whole point is `refuses…` next to `…empty inbox`:
 * SAME tab, SAME empty-looking table, DIFFERENT sentence. If those two ever
 * render the same thing again the defect is back, whatever the gate is called.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useLocation } from 'react-router'

import { usePermissionStore, type RbacAction } from '@/features/rbac'
import { api } from '@/lib/api'
import { loadFeatureBundle } from '@/i18n/i18n'
import { renderWithProviders } from '@/test/test-utils'
import PaymentsPage from './payments-page'
import { paymentsRoutePermissions } from './payments-route-permissions'

const WEBHOOK_EVENTS_PATH = '/admin/payments/webhooks/events?limit=30'
const PROVIDERS_PATH = '/admin/analytics/payments/providers?days=30'
const ANALYTICS_WEBHOOKS_PATH = '/admin/analytics/payments/webhooks?days=30'

/** Copy that only ever appears when the panel refuses. */
const WEBHOOK_REFUSAL = 'Webhook events are restricted'
const ANALYTICS_REFUSAL = 'Payment analytics is restricted'
/** Copy that only ever appears when the panel looked and found nothing. */
const WEBHOOK_EMPTY = 'No webhook events to show.'
/** Copy that only ever appears when the panel looked and the answer never came. */
const WEBHOOK_UNAVAILABLE =
  'Webhook events could not be loaded. This does not mean none were received.'
/** Copy that only ever appears when a request the panel WAS allowed to make failed. */
const ANALYTICS_LOAD_ERROR = 'Failed to load payment analytics'

const EVENT = {
  id: '11111111-1111-4111-8111-111111111111',
  gatewayType: 'YOOKASSA',
  providerEventId: 'evt-visible-1',
  status: 'ENQUEUED',
  receivedAt: '2026-06-04T10:00:00.000Z',
  lastError: null,
}

const HEALTH = {
  queue: { waiting: 0, active: 0, delayed: 0, completed: 0, failed: 0 },
  eventsByStatus: { RECEIVED: 0, ENQUEUED: 1, PROCESSING: 0, PROCESSED: 0, FAILED: 0 },
  staleProcessingCount: 0,
  staleEnqueuedCount: 1,
  generatedAt: '2026-06-04T10:00:00.000Z',
}

const PROVIDERS_REPORT = {
  windowDays: 30,
  windowStart: '2026-05-05T00:00:00.000Z',
  previousWindowStart: '2026-04-05T00:00:00.000Z',
  generatedAt: '2026-06-04T00:00:00.000Z',
  totalGrossRevenue: 0,
  totalTransactions: 0,
  totalCompleted: 0,
  providers: [],
}

const ANALYTICS_WEBHOOK_REPORT = {
  windowDays: 30,
  windowStart: '2026-05-05T00:00:00.000Z',
  generatedAt: '2026-06-04T00:00:00.000Z',
  totalReceived: 0,
  totalProcessed: 0,
  totalFailed: 0,
  reconciliation: { transactionsMissingWebhook: 0, webhooksMissingTransaction: 0 },
  perGateway: [],
}

/**
 * A server that answers every route this page calls.
 *
 * It deliberately does NOT model RBAC: if the panel sends a request it is not
 * entitled to, this mock answers it happily and the row shows up — which is
 * exactly how the pre-fix specs passed against a server that would have
 * refused. So "the refusal renders" is always asserted together with "the
 * request never went out", and neither claim can carry the other.
 */
function mockApi(options: { readonly events?: readonly unknown[] } = {}) {
  const events = options.events ?? [EVENT]
  return vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    if (path.startsWith('/admin/payments/transactions?')) return { data: { items: [], total: 0 } }
    if (path === WEBHOOK_EVENTS_PATH) return { data: events }
    if (path === '/admin/payments/reconciliation/health') return { data: HEALTH }
    if (path === PROVIDERS_PATH) return { data: PROVIDERS_REPORT }
    if (path === ANALYTICS_WEBHOOKS_PATH) return { data: ANALYTICS_WEBHOOK_REPORT }
    return { data: {} }
  })
}

function grant(tokens: ReadonlyArray<{ resource: string; action: RbacAction }>): void {
  usePermissionStore.setState({
    loaded: true,
    loading: false,
    granted: new Set(tokens.map((p) => `${p.resource}:${p.action}`)),
    mustChangePassword: false,
    // Not 'DEV': `hasPermission` short-circuits to true for DEV, which would
    // make every shape below identical and every assertion vacuous.
    role: 'ADMIN',
    rbacRoleId: 'role-1',
    error: null,
  })
}

const PAYMENTS_VIEW = { resource: 'payments', action: 'view' as RbacAction }
const WEBHOOKS_VIEW = { resource: 'payment_webhooks', action: 'view' as RbacAction }
const ANALYTICS_VIEW = { resource: 'analytics', action: 'view' as RbacAction }

function calledPaths(spy: ReturnType<typeof mockApi>): string[] {
  return spy.mock.calls.map((call) => String(call[0]))
}

async function openTab(name: 'Webhooks' | 'Analytics'): Promise<void> {
  const user = userEvent.setup()
  renderWithProviders(<PaymentsPage />)
  await user.click(screen.getByRole('tab', { name }))
}

/**
 * The name of whichever tab is actually selected.
 *
 * Deliberately NOT `findByText` of something inside the expected panel: a
 * mutant that lands on the wrong tab would make that wait time out after the
 * full timeout and report "unable to find text", which says nothing about
 * which tab it did land on. A tab is always selected, so this resolves at
 * once and the caller's `toBe` fails immediately with both names in the
 * message.
 */
/** Renders the router's current path + hash so a spec can assert the URL. */
function LocationProbe() {
  const location = useLocation()
  return <span data-testid="wtp-location">{`${location.pathname}${location.hash}`}</span>
}

async function selectedTabName(): Promise<string> {
  const selected = await screen.findByRole('tab', { selected: true })
  return selected.textContent ?? ''
}

beforeEach(async () => {
  usePermissionStore.getState().reset()
  vi.restoreAllMocks()
  await loadFeatureBundle('payments')
})

describe('the token the refusal names is the token that was checked', () => {
  // Pinned literals, not `${resource}:${action}`. These strings are copied
  // from the backend decorators; if someone edits the constant so it no longer
  // matches its controller, this fails instead of the panel quietly telling an
  // operator to ask for a permission that does not gate anything.
  it('matches admin-payment-webhooks.controller.ts:30', () => {
    expect(paymentsRoutePermissions.webhookEvents.token).toBe('payment_webhooks:view')
  })

  it('matches admin-payment-analytics.controller.ts:27 and :40', () => {
    expect(paymentsRoutePermissions.paymentAnalytics.token).toBe('analytics:view')
  })
})

describe('Webhooks tab', () => {
  it('refuses in words, and names the token, without payment_webhooks:view', async () => {
    const getSpy = mockApi()
    grant([PAYMENTS_VIEW])

    await openTab('Webhooks')

    expect(await screen.findByText(WEBHOOK_REFUSAL)).toBeInTheDocument()
    // The exact string the operator quotes to whoever administers roles.
    expect(screen.getByText('payment_webhooks:view')).toBeInTheDocument()
    // Not the silent empty table: no table at all, and specifically NOT the
    // copy that means "we looked and there was nothing".
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(screen.queryByText(WEBHOOK_EMPTY)).not.toBeInTheDocument()
    // And the panel does not send a request it already knows will 403.
    expect(calledPaths(getSpy)).not.toContain(WEBHOOK_EVENTS_PATH)
  })

  it('shows the real table with payment_webhooks:view', async () => {
    // Anti-vacuity control for the spec above: a gate that refused everyone
    // would satisfy it and fail here.
    const getSpy = mockApi()
    grant([PAYMENTS_VIEW, WEBHOOKS_VIEW])

    await openTab('Webhooks')

    expect(await screen.findByText('evt-visible-1')).toBeInTheDocument()
    expect(screen.getByRole('table')).toBeInTheDocument()
    expect(screen.queryByText(WEBHOOK_REFUSAL)).not.toBeInTheDocument()
    expect(screen.queryByText('payment_webhooks:view')).not.toBeInTheDocument()
    expect(calledPaths(getSpy)).toContain(WEBHOOK_EVENTS_PATH)
  })

  it('says "empty inbox" in different words than "not allowed"', async () => {
    // The whole defect in one spec. Same tab, same absence of rows, and the
    // list really is empty this time — so the sentence on screen has to be the
    // other one. Two opposite states that render identically is what the fix
    // exists to end.
    const getSpy = mockApi({ events: [] })
    grant([PAYMENTS_VIEW, WEBHOOKS_VIEW])

    await openTab('Webhooks')

    expect(await screen.findByText(WEBHOOK_EMPTY)).toBeInTheDocument()
    expect(screen.getByRole('table')).toBeInTheDocument()
    expect(screen.queryByText(WEBHOOK_REFUSAL)).not.toBeInTheDocument()
    // It was refused nothing — the request went out and came back empty.
    expect(calledPaths(getSpy)).toContain(WEBHOOK_EVENTS_PATH)
  })

  it('says "could not load" in different words again when the request fails', async () => {
    // The third state, and the reason the empty-inbox row could not be added
    // on its own: before it, a failed load drew a bare header; with it and
    // nothing else, a failed load would have stated outright that no webhooks
    // arrived. `array-endpoint-unavailable.test.tsx` is the project-wide
    // version of this rule.
    vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
      if (path.startsWith('/admin/payments/transactions?')) return { data: { items: [], total: 0 } }
      if (path === '/admin/payments/reconciliation/health') return { data: HEALTH }
      // The realistic shape: a stale `/api` path answered by nginx with an
      // HTML page and HTTP 200. A string has a working `.length`, so it walks
      // past a `length === 0` guard; `expectArray` is what stops it.
      if (path === WEBHOOK_EVENTS_PATH) {
        return { data: '<!doctype html><html><body><div id="root"></div></body></html>' }
      }
      return { data: {} }
    })
    grant([PAYMENTS_VIEW, WEBHOOKS_VIEW])

    await openTab('Webhooks')

    expect(await screen.findByText(WEBHOOK_UNAVAILABLE)).toBeInTheDocument()
    // Not "there are none", and not "you are not allowed".
    expect(screen.queryByText(WEBHOOK_EMPTY)).not.toBeInTheDocument()
    expect(screen.queryByText(WEBHOOK_REFUSAL)).not.toBeInTheDocument()
    // The tab survives rather than taking the route down with it.
    expect(screen.getByRole('table')).toBeInTheDocument()
    expect(screen.getByText('Reconciliation health')).toBeInTheDocument()
  })

  it('keeps the reconciliation card, which the operator IS entitled to read', async () => {
    // `/admin/payments/reconciliation/health` needs `payments:view`
    // (admin-payment-reconciliation.controller.ts:17), so it survives the
    // refusal below it. That split is the reason the refusal copy explains
    // where the two halves come from rather than just saying "no".
    const getSpy = mockApi()
    grant([PAYMENTS_VIEW])

    await openTab('Webhooks')

    expect(await screen.findByText('Reconciliation health')).toBeInTheDocument()
    expect(calledPaths(getSpy)).toContain('/admin/payments/reconciliation/health')
    expect(screen.getByText(WEBHOOK_REFUSAL)).toBeInTheDocument()
  })
})

describe('Analytics tab', () => {
  it('refuses in words, and names the token, without analytics:view', async () => {
    const getSpy = mockApi()
    grant([PAYMENTS_VIEW])

    await openTab('Analytics')

    expect(await screen.findByText(ANALYTICS_REFUSAL)).toBeInTheDocument()
    expect(screen.getByText('analytics:view')).toBeInTheDocument()
    // Specifically NOT the transient-failure copy the 403 used to land in.
    expect(screen.queryByText(ANALYTICS_LOAD_ERROR)).not.toBeInTheDocument()
    expect(calledPaths(getSpy)).not.toContain(PROVIDERS_PATH)
    expect(calledPaths(getSpy)).not.toContain(ANALYTICS_WEBHOOKS_PATH)
    // Exactly one refusal, though both sections carry the branch.
    expect(screen.getAllByText(ANALYTICS_REFUSAL)).toHaveLength(1)
  })

  it('shows the real reports with analytics:view', async () => {
    // Anti-vacuity control for the spec above.
    const getSpy = mockApi()
    grant([PAYMENTS_VIEW, ANALYTICS_VIEW])

    await openTab('Analytics')

    expect(await screen.findByText('Webhook health')).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Analytics window' })).toBeInTheDocument()
    expect(screen.queryByText(ANALYTICS_REFUSAL)).not.toBeInTheDocument()
    expect(screen.queryByText(ANALYTICS_LOAD_ERROR)).not.toBeInTheDocument()
    expect(calledPaths(getSpy)).toContain(PROVIDERS_PATH)
    expect(calledPaths(getSpy)).toContain(ANALYTICS_WEBHOOKS_PATH)
  })
})

describe('Transactions tab', () => {
  it('still opens on payments:view alone — its route needs nothing else', async () => {
    // The one tab whose gate already matched its route
    // (admin-payment-transactions.controller.ts:30). Here so that "fix the
    // mismatches" cannot quietly become "gate everything harder".
    const getSpy = mockApi()
    grant([PAYMENTS_VIEW])

    renderWithProviders(<PaymentsPage />)

    expect(await screen.findByRole('textbox', { name: 'User' })).toBeInTheDocument()
    // The table replaces a skeleton once the list resolves, so wait for it.
    expect(await screen.findByRole('table')).toBeInTheDocument()
    expect(screen.queryByText(WEBHOOK_REFUSAL)).not.toBeInTheDocument()
    expect(screen.queryByText(ANALYTICS_REFUSAL)).not.toBeInTheDocument()
    expect(
      calledPaths(getSpy).some((path) => path.startsWith('/admin/payments/transactions?')),
    ).toBe(true)
  })
})

/**
 * `#hash` deep links into the tabs.
 * ─────────────────────────────────
 * `Tabs` was uncontrolled here, so the URL could not name a tab. The only
 * artefact that tried — `webhooks-page.tsx`, redirecting to
 * `/payments?tab=webhooks` — was dead twice over: nothing routed to it, and
 * this page never read a `tab` param. It has been deleted and the page now
 * uses `useTabSync`, the same hook `/admins`, `/audit`, `/partners` and
 * `/settings/panel` already use, so the spelling is `#hash` like theirs.
 *
 * Every case below asserts WHICH PANEL IS ACTIVE. A spec that read
 * `searchParams.get('tab')` would guard the parsing and nothing an operator
 * sees — which is how the two hubs stayed green while their deep links were
 * decorative (`components/layout/hub-tab-anchors.test.tsx`).
 */
describe('tab deep links', () => {
  it('opens the Webhooks tab from #webhooks', async () => {
    mockApi()
    grant([PAYMENTS_VIEW, WEBHOOKS_VIEW])

    renderWithProviders(<PaymentsPage />, { route: '/payments#webhooks' })

    expect(await selectedTabName()).toBe('Webhooks')
    expect(await screen.findByText('evt-visible-1')).toBeInTheDocument()
  })

  it('opens the Analytics tab from #analytics', async () => {
    // Not hard-wired to one hash: a mutant that always selects Webhooks passes
    // the case above and fails here.
    mockApi()
    grant([PAYMENTS_VIEW, ANALYTICS_VIEW])

    renderWithProviders(<PaymentsPage />, { route: '/payments#analytics' })

    expect(await selectedTabName()).toBe('Analytics')
  })

  it('falls back to Transactions for a misspelt hash', async () => {
    // `#wehbooks` is the typo an operator makes. It must land somewhere real
    // rather than rendering an empty tab panel.
    mockApi()
    grant([PAYMENTS_VIEW, WEBHOOKS_VIEW])

    renderWithProviders(<PaymentsPage />, { route: '/payments#wehbooks' })

    expect(await selectedTabName()).toBe('Transactions')
  })

  it('still defaults to Transactions with no hash at all', async () => {
    // Anti-vacuity control for the two cases above: an implementation that
    // honoured the hash so eagerly that an absent one stopped defaulting would
    // satisfy them both and fail here.
    mockApi()
    grant([PAYMENTS_VIEW, WEBHOOKS_VIEW])

    renderWithProviders(<PaymentsPage />, { route: '/payments' })

    expect(await selectedTabName()).toBe('Transactions')
  })

  it('lands a #webhooks link on the refusal, not silently on Transactions', async () => {
    // THE ONE THAT MATTERS. Making `webhooks` unaddressable for an admin who
    // cannot read the events would send this link to Transactions with no
    // signal — recreating exactly the ambiguity the refusal card removed, one
    // level up: "my link was wrong" and "I am not allowed" would again render
    // identically. The tab is permission-independent so the tab can answer.
    const getSpy = mockApi()
    grant([PAYMENTS_VIEW])

    renderWithProviders(<PaymentsPage />, { route: '/payments#webhooks' })

    expect(await selectedTabName()).toBe('Webhooks')
    expect(await screen.findByText(WEBHOOK_REFUSAL)).toBeInTheDocument()
    expect(screen.getByText('payment_webhooks:view')).toBeInTheDocument()
    expect(calledPaths(getSpy)).not.toContain(WEBHOOK_EVENTS_PATH)
  })

  it('writes the hash when the operator clicks a tab', async () => {
    // Read-and-write, not read-only: a URL copied out of the address bar after
    // clicking around has to point at the tab on screen. `useTabSync`
    // navigates with `replace`, so Back leaves the page rather than walking
    // back through every tab the operator tried.
    mockApi()
    grant([PAYMENTS_VIEW, WEBHOOKS_VIEW])
    const user = userEvent.setup()

    renderWithProviders(
      <>
        <PaymentsPage />
        <LocationProbe />
      </>,
      { route: '/payments' },
    )
    expect(await selectedTabName()).toBe('Transactions')

    await user.click(screen.getByRole('tab', { name: 'Webhooks' }))

    expect(await selectedTabName()).toBe('Webhooks')
    // The ROUTER's location, not `window.location` — `MemoryRouter` keeps its
    // history in memory and never touches the document's URL, so reading
    // `window.location.hash` here would assert '' forever and pass for any
    // implementation that wrote nothing at all.
    expect(screen.getByTestId('wtp-location').textContent).toBe('/payments#webhooks')
  })
})
