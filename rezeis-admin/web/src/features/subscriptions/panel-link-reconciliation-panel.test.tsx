/**
 * `POST /admin/profile-sync/panel-link-reconciliation` had no caller anywhere
 * in the SPA: a bulk repair that was built, tested and documented, and that an
 * operator had no way to run. So the first thing these specs pin is
 * REACHABILITY — a panel that only ever renders in isolation reproduces the
 * defect it was written to close.
 *
 * The rest pin the four things that make the surface safe rather than merely
 * present, each chosen because its failure is SILENT:
 *
 *   • `dryRun` reaches the wire as a BOOLEAN. The endpoint writes only on the
 *     literal `false`, so the string `'false'` previews — and a UI that
 *     stringified the flag would look like it worked while never repairing a
 *     single row. `?flag=false` coercing to `true` is a documented defect
 *     class in this repository. The TYPE is asserted, not just the value.
 *   • A write cannot happen without the confirmation. Both entry points to a
 *     real run are covered, including "continue" — a second, unconfirmed path
 *     to the same write is exactly how that guarantee usually dies.
 *   • `hasMore` reaches the operator. A sweep that stopped at its cap has
 *     examined a PREFIX of the backlog; a UI that shows the counters and says
 *     nothing lets them believe the job is done.
 *   • `panelEra: null` does not read like a known era. Zero repairs from a
 *     sweep that could not identify the panel means "nothing answered", not
 *     "nothing is broken".
 *
 * Every assertion waits on a STABLE anchor (the report heading, or the spy
 * having been called) and then asserts the specific fact synchronously.
 * Waiting on the expected text itself would turn a real failure into a ten
 * second timeout and would make the absence assertions unreachable.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { usePermissionStore, type RbacAction } from '@/features/rbac'
import { i18n, loadFeatureBundle } from '@/i18n/i18n'
import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'
import { PanelLinkReconciliationPanel } from './panel-link-reconciliation-panel'
import SubscriptionsPage from './subscriptions-page'

const ENDPOINT = '/admin/profile-sync/panel-link-reconciliation'

const REPAIRABLE_ROW = {
  subscriptionId: 'sub-repairable-1',
  userId: 'user-1',
  panelUsername: 'reiwa-user-1',
  resolvedBy: 'shortUuid',
  outcome: 'wouldLink',
  remnawaveId: 'live-uuid-1',
  storedRemnawaveId: null,
  panelId: 41,
  duplicateOfSubscriptionId: null,
  holdsLiveIdentity: false,
  reason: null,
}

const DUPLICATE_ROW = {
  subscriptionId: 'sub-duplicate-2',
  userId: 'user-2',
  panelUsername: 'reiwa-user-2',
  resolvedBy: 'username',
  outcome: 'duplicatePair',
  remnawaveId: 'live-uuid-2',
  storedRemnawaveId: 'dead-uuid-2',
  panelId: 42,
  duplicateOfSubscriptionId: 'sub-holder-9',
  // The half that LOOKS legitimate and is bound to nothing.
  holdsLiveIdentity: false,
  reason: 'subscription sub-holder-9 is already live on panel profile live-uuid-2',
}

/**
 * The partner row a `duplicatePair` contributes. It is the wrong-looking one
 * and it is the LIVE one — the whole reason the server states
 * `holdsLiveIdentity` outright instead of leaving it to be inferred.
 */
const PARTNER_ROW = {
  subscriptionId: 'sub-holder-9',
  userId: 'user-2',
  panelUsername: 'reiwa-user-2',
  resolvedBy: 'username',
  outcome: 'duplicatePair',
  remnawaveId: 'live-uuid-2',
  storedRemnawaveId: 'live-uuid-2',
  panelId: 42,
  duplicateOfSubscriptionId: 'sub-duplicate-2',
  holdsLiveIdentity: true,
  reason: 'this is the LIVE half of the pair with sub-duplicate-2',
}

/**
 * The pair the SHARED-IDENTITY arm finds, and the reason it needed copy of its
 * own: `resolvedBy: 'storedIdentity'` and `holdsLiveIdentity: true` on BOTH
 * halves.
 *
 * Every other duplicate pair has a wrong-looking half — the one bound to
 * nothing — and all the existing advice on this screen leans on that. Here
 * neither half is wrong: both rows already store the same well-formed
 * identity, both are bound to the same real profile, and only the creation
 * date tells them apart. Nothing was resolved because nothing needed to be, so
 * `storedRemnawaveId` equals `remnawaveId` on both rows rather than carrying a
 * dead uuid.
 */
const SHARED_IDENTITY_OLDER_ROW = {
  subscriptionId: 'sub-shared-older',
  userId: 'user-4',
  panelUsername: 'reiwa-user-4',
  resolvedBy: 'storedIdentity',
  outcome: 'duplicatePair',
  remnawaveId: 'live-uuid-4',
  storedRemnawaveId: 'live-uuid-4',
  panelId: 44,
  duplicateOfSubscriptionId: 'sub-shared-newer',
  holdsLiveIdentity: true,
  reason: 'subscription sub-shared-newer stores the same identity live-uuid-4',
}

const SHARED_IDENTITY_NEWER_ROW = {
  ...SHARED_IDENTITY_OLDER_ROW,
  subscriptionId: 'sub-shared-newer',
  duplicateOfSubscriptionId: 'sub-shared-older',
  reason: 'subscription sub-shared-older stores the same identity live-uuid-4',
}

const STALE_ROW = {
  subscriptionId: 'sub-stale-3',
  userId: 'user-3',
  panelUsername: 'reiwa-user-3',
  resolvedBy: 'shortUuid',
  outcome: 'staleIdentity',
  remnawaveId: 'live-uuid-3',
  storedRemnawaveId: 'dead-uuid-3',
  panelId: 43,
  duplicateOfSubscriptionId: null,
  holdsLiveIdentity: false,
  reason: "panel did not resolve shortUuid 'abc123'",
}

function reportBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dryRun: true,
    scanned: 3,
    linked: 0,
    wouldLink: 1,
    repaired: [REPAIRABLE_ROW],
    unrepaired: [DUPLICATE_ROW, PARTNER_ROW, STALE_ROW],
    hasMore: false,
    nextCursor: 'sub-stale-3',
    staleIdentityScanned: 7,
    duplicatePairs: 1,
    // The base report's pair came off a RESOLVE route, so none of its
    // duplicates are the two-live-halves kind. Stated rather than omitted:
    // this is the fixture every "and not the other population" control below
    // leans on.
    sharedIdentityPairs: 0,
    panelEra: '3.x',
    ...overrides,
  }
}

function mockPost(...bodies: ReadonlyArray<Record<string, unknown>>) {
  const spy = vi.spyOn(api, 'post')
  if (bodies.length === 0) {
    spy.mockResolvedValue({ data: reportBody() } as never)
    return spy
  }
  for (const body of bodies) spy.mockResolvedValueOnce({ data: body } as never)
  spy.mockResolvedValue({ data: bodies[bodies.length - 1] } as never)
  return spy
}

/** The two queries `SubscriptionsPage` itself issues. */
function mockPageGets() {
  return vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    if (path === '/admin/subscriptions/stats') {
      return { data: { total: 0, byStatus: {}, trialCount: 0, expiringIn7d: 0 } } as never
    }
    return { data: { items: [], total: 0 } } as never
  })
}

function grantPermissions(permissions: ReadonlyArray<{ resource: string; action: RbacAction }>) {
  usePermissionStore.setState({
    loaded: true,
    loading: false,
    granted: new Set(permissions.map((p) => `${p.resource}:${p.action}`)),
    mustChangePassword: false,
    role: 'ADMIN',
    rbacRoleId: 'role-1',
    error: null,
  })
}

/** The body of the n-th POST, as it really went on the wire. */
function sentBody(spy: ReturnType<typeof mockPost>, index = 0): Record<string, unknown> {
  const call = spy.mock.calls[index]
  expect(call).toBeDefined()
  return call?.[1] as Record<string, unknown>
}

/**
 * The `<tr>` whose FIRST cell is this id.
 *
 * A subscription id appears twice in a duplicate-pair report — once as the row
 * it names, once in the other half's "Duplicate of" cell — so `closest('tr')`
 * on any matching node is not enough to say WHICH row was found.
 */
function rowStartingWith(subscriptionId: string): HTMLElement | undefined {
  return screen
    .getAllByText(subscriptionId)
    .map((node) => node.closest('tr'))
    .find(
      (tr): tr is HTMLTableRowElement =>
        tr !== null &&
        within(tr).getAllByRole('cell')[0]?.textContent === subscriptionId,
    )
}

async function runPreview(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole('button', { name: 'Run preview' }))
  // The report heading is the anchor every later assertion hangs off: it
  // appears for ANY successful run, so waiting for it never smuggles in the
  // fact under test.
  await screen.findByText('Report')
}

describe('panel link reconciliation surface', () => {
  beforeAll(async () => {
    await loadFeatureBundle('panelLinkReconciliation')
  })

  beforeEach(() => {
    usePermissionStore.getState().reset()
    vi.restoreAllMocks()
  })

  it('renders nothing and reaches no endpoint without subscriptions:edit', () => {
    const postSpy = mockPost()
    grantPermissions([{ resource: 'subscriptions', action: 'view' }])

    const { container } = renderWithProviders(<PanelLinkReconciliationPanel />)

    expect(container).toBeEmptyDOMElement()
    expect(postSpy).not.toHaveBeenCalled()
  })

  it('is reachable from the subscriptions page', async () => {
    // The defect was reachability. A spec that only mounts the panel directly
    // would pass against the exact tree that shipped with no caller.
    mockPageGets()
    mockPost()
    grantPermissions([{ resource: 'subscriptions', action: 'edit' }])

    renderWithProviders(<SubscriptionsPage />)

    expect(await screen.findByText('Panel link repair')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Run preview' })).toBeInTheDocument()
  })

  it('sends dryRun as the boolean true on a preview, never a string', async () => {
    const postSpy = mockPost()
    grantPermissions([{ resource: 'subscriptions', action: 'edit' }])
    const user = userEvent.setup()

    renderWithProviders(<PanelLinkReconciliationPanel />)
    await user.click(screen.getByRole('button', { name: 'Run preview' }))

    await waitFor(() => expect(postSpy).toHaveBeenCalledTimes(1))
    expect(postSpy.mock.calls[0]?.[0]).toBe(ENDPOINT)
    const body = sentBody(postSpy)
    expect(typeof body.dryRun).toBe('boolean')
    expect(body.dryRun).toBe(true)
  })

  it('sends dryRun as the boolean false on a real run, never the string "false"', async () => {
    // The whole point of the endpoint's `body.dryRun !== false` is that every
    // other spelling of "no" previews. `'false'` is truthy prose, and a UI
    // that sent it would repair nothing while looking like it had.
    const postSpy = mockPost(reportBody({ dryRun: false, linked: 1, wouldLink: 0 }))
    grantPermissions([{ resource: 'subscriptions', action: 'edit' }])
    const user = userEvent.setup()

    renderWithProviders(<PanelLinkReconciliationPanel />)
    await user.click(screen.getByRole('button', { name: 'Repair for real' }))
    const dialog = await screen.findByRole('alertdialog')
    await user.click(within(dialog).getByRole('button', { name: 'Write links' }))

    await waitFor(() => expect(postSpy).toHaveBeenCalledTimes(1))
    const body = sentBody(postSpy)
    expect(typeof body.dryRun).toBe('boolean')
    expect(body.dryRun).toBe(false)
  })

  it('writes nothing until the confirmation is accepted', async () => {
    const postSpy = mockPost()
    grantPermissions([{ resource: 'subscriptions', action: 'edit' }])
    const user = userEvent.setup()

    renderWithProviders(<PanelLinkReconciliationPanel />)
    await user.click(screen.getByRole('button', { name: 'Repair for real' }))

    const dialog = await screen.findByRole('alertdialog', {
      name: 'Write panel links for real?',
    })
    expect(postSpy).not.toHaveBeenCalled()

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(postSpy).not.toHaveBeenCalled()
  })

  it('states what the real run writes and how many rows, before it runs', async () => {
    mockPost(reportBody({ wouldLink: 2, repaired: [REPAIRABLE_ROW, REPAIRABLE_ROW] }))
    grantPermissions([{ resource: 'subscriptions', action: 'edit' }])
    const user = userEvent.setup()

    renderWithProviders(<PanelLinkReconciliationPanel />)
    fireEvent.change(screen.getByLabelText('Rows per run'), { target: { value: '75' } })
    await runPreview(user)

    await user.click(screen.getByRole('button', { name: 'Repair for real' }))
    const dialog = await screen.findByRole('alertdialog')

    expect(
      within(dialog).getByText('The last preview found 2 repairable row(s) in this sweep.'),
    ).toBeInTheDocument()
    expect(
      within(dialog).getByText(
        'This run examines up to 75 row(s), starting from the beginning of the selection.',
      ),
    ).toBeInTheDocument()
  })

  it('puts the operator-typed bounds on the wire as numbers, or not at all', async () => {
    // `userEvent.type` NORMALISES a number input; `fireEvent.change` is the
    // only way to pin what the raw string does.
    const postSpy = mockPost()
    grantPermissions([{ resource: 'subscriptions', action: 'edit' }])
    const user = userEvent.setup()

    renderWithProviders(<PanelLinkReconciliationPanel />)
    fireEvent.change(screen.getByLabelText('Rows per run'), { target: { value: '50' } })
    fireEvent.change(screen.getByLabelText('Database page size'), { target: { value: '' } })
    await user.click(screen.getByRole('button', { name: 'Run preview' }))

    await waitFor(() => expect(postSpy).toHaveBeenCalledTimes(1))
    const body = sentBody(postSpy)
    expect(typeof body.limit).toBe('number')
    expect(body.limit).toBe(50)
    // The controller reads a bound as `typeof … === 'number' ? … : undefined`,
    // so a stringified one is SILENTLY replaced by the server default. Omitting
    // the key produces the same default and does not pretend otherwise.
    expect('chunkSize' in body).toBe(false)
  })

  it('names every unrepaired row, grouped by outcome, with its reason', async () => {
    mockPost()
    grantPermissions([{ resource: 'subscriptions', action: 'edit' }])
    const user = userEvent.setup()

    renderWithProviders(<PanelLinkReconciliationPanel />)
    await runPreview(user)

    expect(screen.getByText('Not repaired')).toBeInTheDocument()
    // A pair is TWO rows: the scanned half and the partner it collided with.
    expect(screen.getByText('Duplicate of another subscription — 2 row(s)')).toBeInTheDocument()
    expect(screen.getByText('Stale identity, not repairable — 1 row(s)')).toBeInTheDocument()
    expect(rowStartingWith('sub-duplicate-2')).not.toBeUndefined()
    expect(rowStartingWith('sub-stale-3')).not.toBeUndefined()
    expect(screen.getByText(DUPLICATE_ROW.reason)).toBeInTheDocument()
    expect(screen.getByText(PARTNER_ROW.reason)).toBeInTheDocument()
    expect(screen.getByText(STALE_ROW.reason)).toBeInTheDocument()
    expect(screen.getAllByText('sub-holder-9').length).toBeGreaterThanOrEqual(1)
    // Non-emptiness is only the anchor; the direction-complete fact is that
    // BOTH halves of the pair are on screen under the same heading.
    expect(rowStartingWith('sub-holder-9')).not.toBeUndefined()
  })

  it('shows the dead stored identity beside the resolved one', async () => {
    mockPost()
    grantPermissions([{ resource: 'subscriptions', action: 'edit' }])
    const user = userEvent.setup()

    renderWithProviders(<PanelLinkReconciliationPanel />)
    await runPreview(user)

    const row = rowStartingWith('sub-duplicate-2')
    expect(row).not.toBeUndefined()
    const cells = within(row as HTMLElement).getAllByRole('cell')
    // subscription | user | panel username | resolved by | STORED | RESOLVED | …
    expect(cells[4]).toHaveTextContent('dead-uuid-2')
    expect(cells[5]).toHaveTextContent('live-uuid-2')
    // A row that holds NO identity says so rather than showing a blank cell.
    const repairable = rowStartingWith('sub-repairable-1')
    expect(within(repairable as HTMLElement).getAllByRole('cell')[4]).toHaveTextContent('empty')
  })

  it('says the sweep did not finish, and offers to carry on from the cursor', async () => {
    const postSpy = mockPost(
      reportBody({ hasMore: true, nextCursor: 'sub-stale-3' }),
      reportBody({ hasMore: false, nextCursor: 'sub-later-9', scanned: 2, wouldLink: 0 }),
    )
    grantPermissions([{ resource: 'subscriptions', action: 'edit' }])
    const user = userEvent.setup()

    renderWithProviders(<PanelLinkReconciliationPanel />)
    await runPreview(user)

    expect(screen.getByText('The sweep did not finish')).toBeInTheDocument()
    expect(screen.queryByText(/reached the end of the selection/)).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Continue preview from here' }))

    await waitFor(() => expect(postSpy).toHaveBeenCalledTimes(2))
    expect(sentBody(postSpy, 1).startAfterId).toBe('sub-stale-3')
    // The second page drained the selection, so `hasMore` must CLEAR. A latched
    // flag sends the operator round a loop of runs that repair nothing.
    await screen.findByText('The sweep reached the end of the selection')
    expect(screen.queryByText('The sweep did not finish')).not.toBeInTheDocument()
    // One sweep, two runs, totals added up rather than replaced.
    expect(screen.getByText('Runs in this sweep: 2')).toBeInTheDocument()
  })

  it('says so when the sweep did reach the end', async () => {
    // The control for the spec above: the same anchor, the opposite verdict.
    mockPost(reportBody({ hasMore: false }))
    grantPermissions([{ resource: 'subscriptions', action: 'edit' }])
    const user = userEvent.setup()

    renderWithProviders(<PanelLinkReconciliationPanel />)
    await runPreview(user)

    expect(screen.getByText('The sweep reached the end of the selection')).toBeInTheDocument()
    expect(screen.queryByText('The sweep did not finish')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Continue preview from here' }),
    ).not.toBeInTheDocument()
  })

  it('confirms a CONTINUED real run too, not just the first page', async () => {
    const postSpy = mockPost(
      reportBody({ dryRun: false, linked: 1, wouldLink: 0, hasMore: true, nextCursor: 'sub-x' }),
    )
    grantPermissions([{ resource: 'subscriptions', action: 'edit' }])
    const user = userEvent.setup()

    renderWithProviders(<PanelLinkReconciliationPanel />)
    await user.click(screen.getByRole('button', { name: 'Repair for real' }))
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Write links' }),
    )
    await screen.findByText('Report')
    await waitFor(() => expect(postSpy).toHaveBeenCalledTimes(1))

    await user.click(screen.getByRole('button', { name: 'Continue repairing from here' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(postSpy).toHaveBeenCalledTimes(1)
    expect(within(dialog).getByText('This run examines up to 200 row(s), starting after subscription sub-x.')).toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: 'Write links' }))
    await waitFor(() => expect(postSpy).toHaveBeenCalledTimes(2))
    expect(sentBody(postSpy, 1).dryRun).toBe(false)
    expect(sentBody(postSpy, 1).startAfterId).toBe('sub-x')
  })

  it('does not let an unknown panel era read like a known one', async () => {
    mockPost(reportBody({ panelEra: null, scanned: 0, wouldLink: 0, repaired: [], unrepaired: [] }))
    grantPermissions([{ resource: 'subscriptions', action: 'edit' }])
    const user = userEvent.setup()

    renderWithProviders(<PanelLinkReconciliationPanel />)
    await runPreview(user)

    expect(screen.getByText('Panel era unknown')).toBeInTheDocument()
    expect(screen.queryByText(/^Panel era: /)).not.toBeInTheDocument()
  })

  it('names the panel era when the sweep knew it', async () => {
    // The control: without it, a component that rendered the warning
    // unconditionally would pass the spec above.
    mockPost(reportBody({ panelEra: '2.x' }))
    grantPermissions([{ resource: 'subscriptions', action: 'edit' }])
    const user = userEvent.setup()

    renderWithProviders(<PanelLinkReconciliationPanel />)
    await runPreview(user)

    expect(screen.getByText('Panel era: 2.x')).toBeInTheDocument()
    expect(screen.queryByText('Panel era unknown')).not.toBeInTheDocument()
  })

  it('says 2.x and 3.x searched DIFFERENT populations', async () => {
    // Zero repairs means something different under each era, so one shared
    // "the sweep knew the era" sentence would tell a 2.x operator their stale
    // rows came back clean when they were never selected at all.
    grantPermissions([{ resource: 'subscriptions', action: 'edit' }])

    mockPost(reportBody({ panelEra: '3.x' }))
    const first = renderWithProviders(<PanelLinkReconciliationPanel />)
    await runPreview(userEvent.setup())
    const onThreeX = screen.getByText('Panel era: 3.x').parentElement?.textContent ?? ''
    expect(onThreeX).toContain('Both populations were searched')
    first.unmount()

    vi.restoreAllMocks()
    mockPost(reportBody({ panelEra: '2.x' }))
    renderWithProviders(<PanelLinkReconciliationPanel />)
    await runPreview(userEvent.setup())
    const onTwoX = screen.getByText('Panel era: 2.x').parentElement?.textContent ?? ''

    expect(onTwoX).toContain('does not exist here')
    expect(onTwoX).not.toBe(onThreeX)
  })

  it('shouts before an operator hand-cleans a duplicate pair', async () => {
    // Deleting either half through the panel destroys a paying customer's
    // service, and the half an operator reaches for first is the wrong one.
    mockPost()
    grantPermissions([{ resource: 'subscriptions', action: 'edit' }])
    const user = userEvent.setup()

    renderWithProviders(<PanelLinkReconciliationPanel />)
    await runPreview(user)

    const warning = screen.getByText('Do not clean these duplicates up by hand')
    expect(warning).toBeInTheDocument()
    expect(warning.closest('[role="alert"]')).toHaveTextContent(
      'destroys a paying customer’s service',
    )
    expect(warning.closest('[role="alert"]')).toHaveTextContent(
      'Merging the two subscriptions',
    )
  })

  it('does not shout when the sweep found no duplicate pair', async () => {
    // The control. A warning that is always on screen is furniture, not a
    // warning, and the operator stops reading it.
    mockPost(reportBody({ duplicatePairs: 0, unrepaired: [STALE_ROW] }))
    grantPermissions([{ resource: 'subscriptions', action: 'edit' }])
    const user = userEvent.setup()

    renderWithProviders(<PanelLinkReconciliationPanel />)
    await runPreview(user)

    expect(screen.getByText('Stale identity, not repairable — 1 row(s)')).toBeInTheDocument()
    expect(
      screen.queryByText('Do not clean these duplicates up by hand'),
    ).not.toBeInTheDocument()
  })

  it('renders both halves of a pair even when a later page rescans one of them', async () => {
    // `subscriptionId` is not unique inside a group: a pair emits two rows, and
    // a later page can scan the partner in its own right. Keyed by id alone
    // React drops the repeat; keyed by index it reuses a mounted row for a
    // different subscription. Either way the operator reads one row's identity
    // against another row's reason.
    const postSpy = mockPost(
      reportBody({ hasMore: true, nextCursor: 'sub-stale-3', unrepaired: [DUPLICATE_ROW, PARTNER_ROW] }),
      reportBody({ hasMore: false, nextCursor: 'sub-holder-9', unrepaired: [PARTNER_ROW] }),
    )
    grantPermissions([{ resource: 'subscriptions', action: 'edit' }])
    const user = userEvent.setup()

    renderWithProviders(<PanelLinkReconciliationPanel />)
    await runPreview(user)
    await user.click(screen.getByRole('button', { name: 'Continue preview from here' }))
    await waitFor(() => expect(postSpy).toHaveBeenCalledTimes(2))
    await screen.findByText('Runs in this sweep: 2')

    // Three rows in the group, two of them the same subscription.
    expect(screen.getByText('Duplicate of another subscription — 3 row(s)')).toBeInTheDocument()
    const partnerRows = screen
      .getAllByText('sub-holder-9')
      .map((node) => node.closest('tr'))
      .filter(
        (tr): tr is HTMLTableRowElement =>
          tr !== null && within(tr).getAllByRole('cell')[0]?.textContent === 'sub-holder-9',
      )
    expect(partnerRows).toHaveLength(2)
    for (const row of partnerRows) {
      expect(within(row).getAllByRole('cell')[8]).toHaveTextContent('Live — do not delete')
    }
  })

  it('gives the repeated subscription distinct React keys', async () => {
    // The rows above are stateless text cells, so a duplicate key does not
    // visibly corrupt them TODAY — it corrupts them the moment one of these
    // cells grows a checkbox, an input, or any other state React reconciles by
    // key. React says so out loud on every render, and this is the assertion
    // that stops the warning being scrolled past for the months in between.
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
    const postSpy = mockPost(
      reportBody({ hasMore: true, nextCursor: 'sub-a', unrepaired: [DUPLICATE_ROW, PARTNER_ROW] }),
      reportBody({ hasMore: false, nextCursor: 'sub-b', unrepaired: [PARTNER_ROW] }),
    )
    grantPermissions([{ resource: 'subscriptions', action: 'edit' }])
    const user = userEvent.setup()

    renderWithProviders(<PanelLinkReconciliationPanel />)
    await runPreview(user)
    await user.click(screen.getByRole('button', { name: 'Continue preview from here' }))
    await waitFor(() => expect(postSpy).toHaveBeenCalledTimes(2))
    await screen.findByText('Runs in this sweep: 2')

    const duplicateKeyWarnings = warn.mock.calls.filter((call) =>
      call.some((arg) => typeof arg === 'string' && arg.includes('same key')),
    )
    expect(duplicateKeyWarnings).toEqual([])
  })

  it('treats the era string "unknown" exactly like a missing one', async () => {
    mockPost(reportBody({ panelEra: 'unknown' }))
    grantPermissions([{ resource: 'subscriptions', action: 'edit' }])
    const user = userEvent.setup()

    renderWithProviders(<PanelLinkReconciliationPanel />)
    await runPreview(user)

    expect(screen.getByText('Panel era unknown')).toBeInTheDocument()
    expect(screen.queryByText('Panel era: unknown')).not.toBeInTheDocument()
  })

  it('reports a counter the server never sent as unreported, not as zero', async () => {
    // The two new counters are landing in the backend in parallel with this
    // surface. Printing `0` for a field that never arrived would let a
    // half-deployed backend look like a clean panel.
    mockPost(reportBody({ staleIdentityScanned: undefined, duplicatePairs: undefined }))
    grantPermissions([{ resource: 'subscriptions', action: 'edit' }])
    const user = userEvent.setup()

    renderWithProviders(<PanelLinkReconciliationPanel />)
    await runPreview(user)

    const stale = screen.getByText('Stale identities examined').closest('div')
    const duplicates = screen.getByText('Duplicate pairs found').closest('div')
    expect(stale).toHaveTextContent('not reported')
    expect(stale).not.toHaveTextContent(/\b0\b/)
    expect(duplicates).toHaveTextContent('not reported')
    // The counters the server DID send are still numbers, so "not reported"
    // cannot be what this panel says about everything.
    expect(screen.getByText('Rows examined').closest('div')).toHaveTextContent('3')
  })

  it('renders the counters the server did send', async () => {
    mockPost(reportBody({ staleIdentityScanned: 7, duplicatePairs: 1 }))
    grantPermissions([{ resource: 'subscriptions', action: 'edit' }])
    const user = userEvent.setup()

    renderWithProviders(<PanelLinkReconciliationPanel />)
    await runPreview(user)

    expect(screen.getByText('Stale identities examined').closest('div')).toHaveTextContent('7')
    expect(screen.getByText('Duplicate pairs found').closest('div')).toHaveTextContent('1')
  })

  it('flags which half of a duplicate pair is bound to the LIVE panel profile', async () => {
    // The polarity is backwards from instinct: the older, legitimate-looking
    // row is bound to nothing, and the wrong-looking duplicate is the live one.
    // An operator who cannot see which is which deletes a paying customer's
    // profile, so both halves are asserted — one of them is the control.
    mockPost()
    grantPermissions([{ resource: 'subscriptions', action: 'edit' }])
    const user = userEvent.setup()

    renderWithProviders(<PanelLinkReconciliationPanel />)
    await runPreview(user)

    const deadHalf = rowStartingWith('sub-duplicate-2')
    const liveHalf = rowStartingWith('sub-holder-9')
    expect(deadHalf).not.toBeUndefined()
    expect(liveHalf).not.toBeUndefined()
    // … | duplicate of (7) | BOUND TO LIVE PROFILE (8) | reason (9)
    expect(within(liveHalf as HTMLElement).getAllByRole('cell')[8]).toHaveTextContent(
      'Live — do not delete',
    )
    expect(within(deadHalf as HTMLElement).getAllByRole('cell')[8]).toHaveTextContent('Not bound')
  })

  it('does not guess "not bound" for a row whose live flag the server omitted', async () => {
    mockPost(
      reportBody({ unrepaired: [{ ...DUPLICATE_ROW, holdsLiveIdentity: undefined }] }),
    )
    grantPermissions([{ resource: 'subscriptions', action: 'edit' }])
    const user = userEvent.setup()

    renderWithProviders(<PanelLinkReconciliationPanel />)
    await runPreview(user)

    const cell = within(rowStartingWith('sub-duplicate-2') as HTMLElement).getAllByRole('cell')[8]
    expect(cell).toHaveTextContent('not reported')
    expect(cell).not.toHaveTextContent('Not bound')
  })

  it('names the shared-identity route instead of printing its wire value', async () => {
    // `resolvedBy` is read as a plain string with a raw fallback, so an
    // unlabelled route reaches a Russian-speaking operator as the literal
    // `storedIdentity`. Both halves are asserted: the arm emits the same route
    // on each, and a label wired to only one of them would still leave a raw
    // identifier on screen.
    mockPost(
      reportBody({
        duplicatePairs: 1,
        unrepaired: [SHARED_IDENTITY_OLDER_ROW, SHARED_IDENTITY_NEWER_ROW],
      }),
    )
    grantPermissions([{ resource: 'subscriptions', action: 'edit' }])
    const user = userEvent.setup()

    renderWithProviders(<PanelLinkReconciliationPanel />)
    await runPreview(user)

    const older = rowStartingWith('sub-shared-older')
    const newer = rowStartingWith('sub-shared-newer')
    expect(older).not.toBeUndefined()
    expect(newer).not.toBeUndefined()
    // subscription (0) | user (1) | panel username (2) | RESOLVED BY (3)
    for (const row of [older, newer]) {
      expect(within(row as HTMLElement).getAllByRole('cell')[3]).toHaveTextContent(
        'the identity both live rows already store',
      )
    }
    expect(screen.queryByText('storedIdentity')).not.toBeInTheDocument()
  })

  it('says neither half is the broken one when both rows store the identity', async () => {
    // The operative fact. Every other duplicate pair has a wrong-looking half,
    // and `duplicateDangerBody` — still on screen above this — tells the
    // operator to look for it. Against these rows that sentence is FALSE, not
    // merely incomplete, so the correction has to be present, has to say both
    // halves are bound to the same real profile, and has to name the survivor.
    mockPost(
      reportBody({
        duplicatePairs: 1,
        unrepaired: [SHARED_IDENTITY_OLDER_ROW, SHARED_IDENTITY_NEWER_ROW],
      }),
    )
    grantPermissions([{ resource: 'subscriptions', action: 'edit' }])
    const user = userEvent.setup()

    renderWithProviders(<PanelLinkReconciliationPanel />)
    await runPreview(user)

    const alert = screen
      .getByText('Do not clean these duplicates up by hand')
      .closest('[role="alert"]')
    expect(alert).toHaveTextContent('neither half looks wrong')
    expect(alert).toHaveTextContent('Both are bound to the same real panel profile')
    expect(alert).toHaveTextContent('there is no dead row to delete safely')
    // Why the OLDER row is the survivor, which is the only thing left to
    // choose on once neither row is broken.
    expect(alert).toHaveTextContent('the merge keeps the OLDER row')
    expect(alert).toHaveTextContent('carrying the payments and the customer history')

    // And the column says it too, on BOTH halves — a warning nobody scrolls to
    // is not what stops the panel DELETE.
    for (const id of ['sub-shared-older', 'sub-shared-newer']) {
      expect(within(rowStartingWith(id) as HTMLElement).getAllByRole('cell')[8]).toHaveTextContent(
        'Live — do not delete',
      )
    }
  })

  it('does not claim both halves are live for a pair the panel resolved', async () => {
    // The control for the branch above. The resolve-route pair really does
    // have one dead half and one live half; printing "neither half looks
    // wrong" over it would send the operator to delete the bound row.
    mockPost()
    grantPermissions([{ resource: 'subscriptions', action: 'edit' }])
    const user = userEvent.setup()

    renderWithProviders(<PanelLinkReconciliationPanel />)
    await runPreview(user)

    const alert = screen
      .getByText('Do not clean these duplicates up by hand')
      .closest('[role="alert"]')
    // The pair IS reported — this is not an empty-report pass.
    expect(screen.getByText('Duplicate of another subscription — 2 row(s)')).toBeInTheDocument()
    expect(alert).toHaveTextContent('the polarity is backwards from instinct')
    expect(alert).not.toHaveTextContent('neither half looks wrong')
  })

  it('names the shared-identity route and its danger in Russian', async () => {
    // The defect this closes is a raw English-shaped identifier reaching a
    // Russian-speaking operator, so the whole cell and the whole correcting
    // paragraph are asserted in Russian — a fallback to the wire value or to
    // the English copy fails here by name.
    await i18n.changeLanguage('ru')
    await loadFeatureBundle('panelLinkReconciliation')
    try {
      mockPost(
        reportBody({
          duplicatePairs: 1,
          unrepaired: [SHARED_IDENTITY_OLDER_ROW, SHARED_IDENTITY_NEWER_ROW],
        }),
      )
      grantPermissions([{ resource: 'subscriptions', action: 'edit' }])
      const user = userEvent.setup()

      renderWithProviders(<PanelLinkReconciliationPanel />)
      await user.click(screen.getByRole('button', { name: 'Предпросмотр' }))
      await screen.findByText('Отчёт')

      expect(screen.getByText('Дубликат другой подписки — строк: 2')).toBeInTheDocument()
      for (const id of ['sub-shared-older', 'sub-shared-newer']) {
        const cells = within(rowStartingWith(id) as HTMLElement).getAllByRole('cell')
        expect(cells[3]).toHaveTextContent('сохранённому идентификатору обеих живых строк')
        expect(cells[8]).toHaveTextContent('Живая — не удалять')
      }
      expect(screen.queryByText('storedIdentity')).not.toBeInTheDocument()

      const alert = screen
        .getByText('Не чистите эти дубликаты вручную')
        .closest('[role="alert"]')
      expect(alert).toHaveTextContent('обе строки УЖЕ хранят один и тот же идентификатор')
      expect(alert).toHaveTextContent('«неправильной» на вид половины нет вовсе')
      expect(alert).toHaveTextContent('удаление любой из них уносит живой профиль')
      expect(alert).toHaveTextContent('при слиянии остаётся СТАРАЯ строка')
      expect(alert).toHaveTextContent('именно на ней платежи и история клиента')
      // Not one word of the English paragraph is on screen.
      expect(alert).not.toHaveTextContent('neither half looks wrong')
    } finally {
      await i18n.changeLanguage('en')
      await loadFeatureBundle('panelLinkReconciliation')
    }
  })

  it('counts the two-live-halves pairs beside the duplicate total', async () => {
    // The two populations take OPPOSITE advice, so an operator who can only
    // see one total has to open rows to find out which kind they have.
    mockPost(reportBody({ duplicatePairs: 3, sharedIdentityPairs: 2 }))
    grantPermissions([{ resource: 'subscriptions', action: 'edit' }])
    const user = userEvent.setup()

    renderWithProviders(<PanelLinkReconciliationPanel />)
    await runPreview(user)

    expect(screen.getByText('Duplicate pairs found').closest('div')).toHaveTextContent('3')
    expect(
      screen.getByText('Pairs with two live halves').closest('div'),
    ).toHaveTextContent('2')
  })

  it('reports the two-live-halves counter as unreported rather than zero', async () => {
    // A panel build can meet a backend that predates the arm. A `0` there
    // says "none of the dangerous kind", which is the one answer that makes
    // the danger invisible.
    mockPost(reportBody({ sharedIdentityPairs: undefined }))
    grantPermissions([{ resource: 'subscriptions', action: 'edit' }])
    const user = userEvent.setup()

    renderWithProviders(<PanelLinkReconciliationPanel />)
    await runPreview(user)

    const tile = screen.getByText('Pairs with two live halves').closest('div')
    expect(tile).toHaveTextContent('not reported')
    expect(tile).not.toHaveTextContent(/\b0\b/)
    // …and the counters the server DID send are still numbers.
    expect(screen.getByText('Duplicate pairs found').closest('div')).toHaveTextContent('1')
  })

  it('stops asserting a dead half when every pair on screen has two live ones', async () => {
    // `duplicateDangerBody` tells the operator the older row holds a dead
    // identity and to go and find the bound one. Over a report whose only
    // duplicates come from the shared-identity arm that is not incomplete, it
    // is FALSE — and the row it sends them to delete is live.
    mockPost(
      reportBody({
        duplicatePairs: 1,
        sharedIdentityPairs: 1,
        unrepaired: [SHARED_IDENTITY_OLDER_ROW, SHARED_IDENTITY_NEWER_ROW],
      }),
    )
    grantPermissions([{ resource: 'subscriptions', action: 'edit' }])
    const user = userEvent.setup()

    renderWithProviders(<PanelLinkReconciliationPanel />)
    await runPreview(user)

    const alert = screen
      .getByText('Do not clean these duplicates up by hand')
      .closest('[role="alert"]')
    expect(alert).toHaveTextContent('neither half looks wrong')
    expect(alert).not.toHaveTextContent('the polarity is backwards from instinct')
    expect(alert).not.toHaveTextContent('the wrong-looking duplicate is the one bound')
  })

  it('keeps both warnings when the sweep found both kinds of pair', async () => {
    // Suppressing either one would leave half the rows on screen unexplained,
    // and the half left unexplained is whichever the operator opens first.
    mockPost(
      reportBody({
        duplicatePairs: 2,
        sharedIdentityPairs: 1,
        unrepaired: [
          DUPLICATE_ROW,
          PARTNER_ROW,
          SHARED_IDENTITY_OLDER_ROW,
          SHARED_IDENTITY_NEWER_ROW,
        ],
      }),
    )
    grantPermissions([{ resource: 'subscriptions', action: 'edit' }])
    const user = userEvent.setup()

    renderWithProviders(<PanelLinkReconciliationPanel />)
    await runPreview(user)

    const alert = screen
      .getByText('Do not clean these duplicates up by hand')
      .closest('[role="alert"]')
    expect(alert).toHaveTextContent('the polarity is backwards from instinct')
    expect(alert).toHaveTextContent('neither half looks wrong')
    expect(screen.getByText('Duplicate of another subscription \u2014 4 row(s)')).toBeInTheDocument()
  })

  it('reports an outcome this build has never heard of by its raw name', async () => {
    mockPost(
      reportBody({
        unrepaired: [{ ...DUPLICATE_ROW, outcome: 'somethingNewServerSide' }],
      }),
    )
    grantPermissions([{ resource: 'subscriptions', action: 'edit' }])
    const user = userEvent.setup()

    renderWithProviders(<PanelLinkReconciliationPanel />)
    await runPreview(user)

    expect(screen.getByText('somethingNewServerSide — 1 row(s)')).toBeInTheDocument()
    expect(screen.getByText('sub-duplicate-2')).toBeInTheDocument()
  })

  it('shows no report at all when the response is not the shape it claims', async () => {
    // `api.post<T>()` is a cast, not a check. An HTML error page served with
    // HTTP 200 — which `web/nginx.conf` really produces for an unmatched /api
    // path — must not be laundered into a confident "0 rows, nothing broken".
    mockPost(reportBody({ repaired: { nope: true } }))
    grantPermissions([{ resource: 'subscriptions', action: 'edit' }])
    const user = userEvent.setup()

    renderWithProviders(<PanelLinkReconciliationPanel />)
    await user.click(screen.getByRole('button', { name: 'Run preview' }))

    // Anchor on the request having settled, then assert the absence.
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Run preview' })).not.toBeDisabled(),
    )
    expect(screen.queryByText('Report')).not.toBeInTheDocument()
    expect(screen.queryByText('Rows examined')).not.toBeInTheDocument()
  })

  // The Russian spec above restores the language in its own `finally`, so this
  // is the net rather than the mechanism: a failure that skips the `finally`
  // must not leave every later FILE in the run rendering in Russian.
  afterAll(async () => {
    await i18n.changeLanguage('en')
  })
})
