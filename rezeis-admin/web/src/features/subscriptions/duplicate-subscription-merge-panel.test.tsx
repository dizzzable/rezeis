/**
 * `POST /admin/profile-sync/duplicate-subscription-merge` had no caller anywhere
 * in the SPA — a write that was built, tested and documented, and that an
 * operator had no way to run, so duplicate pairs were being cleaned by hand in
 * production. So the first thing these specs pin is REACHABILITY: a panel that
 * only ever renders in isolation reproduces the defect it was written to close.
 *
 * The rest pin the things that make the surface SAFE rather than merely
 * present. Every one of them fails silently if it rots:
 *
 *   • `dryRun` reaches the wire as a BOOLEAN. The endpoint writes only on the
 *     literal `false`, so the string `'false'` is TRUTHY prose that the backend
 *     reads as "not false" — a preview turned into a live write by a
 *     stringifying request shape. `?flag=false` coercing to `true` is a
 *     documented defect class here. The runtime TYPE is asserted, not the value.
 *   • A write cannot happen without the confirmation, and the confirmation says
 *     WHAT it writes and TO HOW MANY PAIRS. Both entry points are covered,
 *     including "continue" — a second, unconfirmed path to the same write is
 *     exactly how that guarantee usually dies.
 *   • The survivor and the duplicate are named unmistakably, and the row that
 *     holds the LIVE panel identity is stated rather than left to be inferred.
 *     Reading those two backwards is how somebody destroys a paying customer's
 *     profile.
 *   • `reattached` is ITEMISED per pair. A single counter cannot tell four
 *     payments from four sync-job rows, and those need different repairs.
 *   • Retryable refusals are separated from ones that will never change, and
 *     every refusal carries its remedy. Without that separation an operator
 *     either presses forever or gives up on a pair a retry would have merged.
 *   • `hasMore` reaches the operator, in both of the shapes the service emits —
 *     including the truncated run whose cursor is deliberately `null`.
 *
 * ANTI-VACUITY DISCIPLINE. Nothing here waits on the text it is about to
 * assert: each spec waits for a STABLE anchor (the report heading, or the spy
 * having been called) and then asserts the specific fact synchronously. Waiting
 * on the expected text turns a real regression into a ten second timeout and
 * makes every "and NOT the other one" assertion unreachable.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { usePermissionStore, type RbacAction } from '@/features/rbac'
import { loadFeatureBundle } from '@/i18n/i18n'
import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'
import {
  DUPLICATE_MERGE_REFUSALS,
  DUPLICATE_MERGE_REFUSALS_BLOCKED,
  DUPLICATE_MERGE_REFUSALS_NEVER,
  DUPLICATE_MERGE_REFUSALS_RETRYABLE,
  refusalClass,
} from './duplicate-subscription-merge-api'
import { DuplicateSubscriptionMergePanel } from './duplicate-subscription-merge-panel'
import SubscriptionsPage from './subscriptions-page'

const ENDPOINT = '/admin/profile-sync/duplicate-subscription-merge'

/** The seven relations the service enumerates, with the counts a real pair has. */
const REATTACHED = [
  { relation: 'transactions', model: 'Transaction', column: 'subscription_id', moved: 3 },
  { relation: 'transactionItems', model: 'TransactionItem', column: 'subscription_id', moved: 5 },
  {
    relation: 'promocodeActivations',
    model: 'PromocodeActivation',
    column: 'target_subscription_id',
    moved: 1,
  },
  {
    relation: 'referralPointsExchanges',
    model: 'ReferralPointsExchange',
    column: 'target_subscription_id',
    moved: 0,
  },
  { relation: 'trialClaim', model: 'TrialClaim', column: 'subscription_id', moved: 1 },
  { relation: 'currentSubscriptionOf', model: 'User', column: 'current_subscription_id', moved: 1 },
  { relation: 'syncJobs', model: 'ProfileSyncJob', column: 'subscription_id', moved: 0 },
]

/**
 * The pair this defect actually produces: the OLDER row holds a dead 2.x uuid
 * and carries the history; the NEWER duplicate holds the live decimal identity.
 */
const MERGEABLE_PAIR = {
  survivorSubscriptionId: 'sub-older-1',
  duplicateSubscriptionId: 'sub-newer-2',
  userId: 'user-1',
  outcome: 'wouldMerge',
  refusal: null,
  reason: null,
  remnawaveId: '4471',
  remnawavePanelId: 4471,
  panelUsername: 'rz_alice_sub_1',
  configUrl: 'https://panel.example/sub/abc123',
  survivorPreviousRemnawaveId: 'dead-uuid-1111',
  survivorPreviousPanelId: null,
  duplicatePreviousRemnawaveId: '4471',
  duplicatePreviousPanelId: 4471,
  // STATED BY THE SERVER, which calls `namesProfile` — not inferred here from
  // the four fields above. That inference used to live in the SPA and was a
  // second copy of a rule whose polarity decides whether an operator deletes a
  // paying customer's panel profile.
  survivorHoldsLiveIdentity: false,
  duplicateHoldsLiveIdentity: true,
  reattached: REATTACHED,
  supersededSyncJobs: 2,
}

function refusedPair(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    survivorSubscriptionId: 'sub-refused-a',
    duplicateSubscriptionId: 'sub-refused-b',
    userId: 'user-9',
    outcome: 'refused',
    refusal: null,
    reason: null,
    remnawaveId: null,
    remnawavePanelId: null,
    panelUsername: null,
    configUrl: null,
    survivorPreviousRemnawaveId: null,
    survivorPreviousPanelId: null,
    duplicatePreviousRemnawaveId: null,
    duplicatePreviousPanelId: null,
    // Refused before the panel was ever asked: the server states `null`, and
    // `null` is not `false`.
    survivorHoldsLiveIdentity: null,
    duplicateHoldsLiveIdentity: null,
    reattached: [],
    supersededSyncJobs: 0,
    ...overrides,
  }
}

const REFUSED_NEVER = refusedPair({
  survivorSubscriptionId: 'sub-alice-1',
  duplicateSubscriptionId: 'sub-bob-1',
  refusal: 'differentCustomers',
  reason: 'subscription sub-alice-1 belongs to customer alice and sub-bob-1 to customer bob',
})

const REFUSED_RETRYABLE = refusedPair({
  survivorSubscriptionId: 'sub-busy-1',
  duplicateSubscriptionId: 'sub-busy-2',
  refusal: 'syncJobRunning',
  reason: '1 sync job(s) for subscription sub-busy-2 are RUNNING',
})

const REFUSED_BLOCKED = refusedPair({
  survivorSubscriptionId: 'sub-unbound-1',
  duplicateSubscriptionId: 'sub-unbound-2',
  refusal: 'neitherHoldsIdentity',
  reason: 'both rows resolve to panel profile 5150, but neither of them is bound to it',
  // The panel WAS asked here and the answer was "neither" — a real finding,
  // reported as two `false`s rather than as silence.
  remnawaveId: '5150',
  remnawavePanelId: 5150,
  survivorHoldsLiveIdentity: false,
  duplicateHoldsLiveIdentity: false,
})

/**
 * The pair the SHARED-IDENTITY arm of the reconciliation sweep discovers: two
 * live rows that ALREADY store the same well-formed identity, so the server
 * reports BOTH halves bound.
 *
 * This is the case every other sentence on these two surfaces was NOT written
 * for. There is no unbound half to find, and a cell that names one holder tells
 * the operator the other row is spare — it is not, and deleting it takes the
 * live profile with it.
 */
const BOTH_HALVES_LIVE_PAIR = {
  ...MERGEABLE_PAIR,
  survivorSubscriptionId: 'sub-shared-older',
  duplicateSubscriptionId: 'sub-shared-newer',
  userId: 'user-4',
  remnawaveId: '5150',
  remnawavePanelId: 5150,
  survivorPreviousRemnawaveId: '5150',
  survivorPreviousPanelId: 5150,
  duplicatePreviousRemnawaveId: '5150',
  duplicatePreviousPanelId: 5150,
  survivorHoldsLiveIdentity: true,
  duplicateHoldsLiveIdentity: true,
}

function reportBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dryRun: true,
    pairsExamined: 4,
    merged: 0,
    wouldMerge: 1,
    refused: 3,
    rows: [MERGEABLE_PAIR, REFUSED_NEVER, REFUSED_RETRYABLE, REFUSED_BLOCKED],
    hasMore: false,
    nextCursor: 'sub-newer-2',
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
 * The `<tr>` whose FIRST cell is this survivor id.
 *
 * A subscription id can appear in more than one cell — the survivor column, the
 * duplicate column of another pair, a reason sentence — so `closest('tr')` on
 * any matching node does not say WHICH row was found.
 */
function rowBySurvivor(survivorId: string): HTMLElement | undefined {
  return screen
    .getAllByText(survivorId)
    .map((node) => node.closest('tr'))
    .find(
      (tr): tr is HTMLTableRowElement =>
        tr !== null && within(tr).getAllByRole('cell')[0]?.textContent === survivorId,
    )
}

async function runPreview(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole('button', { name: 'Preview the merge' }))
  // The report heading appears for ANY successful run, so waiting on it never
  // smuggles in the fact under test.
  await screen.findByText('Merge report')
}

describe('duplicate subscription merge surface', () => {
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

    const { container } = renderWithProviders(<DuplicateSubscriptionMergePanel />)

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

    expect(await screen.findByText('Duplicate subscription merge')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Preview the merge' })).toBeInTheDocument()
    // ...and its neighbour is still there and still distinguishable. The two
    // surfaces sit on one page, so a shared button label would make either
    // one's controls unaddressable.
    expect(screen.getByText('Panel link repair')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Run preview' })).toBeInTheDocument()
  })

  it('sends dryRun as the boolean true on a preview, never a string', async () => {
    const postSpy = mockPost()
    grantPermissions([{ resource: 'subscriptions', action: 'edit' }])
    const user = userEvent.setup()

    renderWithProviders(<DuplicateSubscriptionMergePanel />)
    await user.click(screen.getByRole('button', { name: 'Preview the merge' }))

    await waitFor(() => expect(postSpy).toHaveBeenCalledTimes(1))
    expect(postSpy.mock.calls[0]?.[0]).toBe(ENDPOINT)
    const body = sentBody(postSpy)
    expect(typeof body.dryRun).toBe('boolean')
    expect(body.dryRun).toBe(true)
    // Discovery only. An explicit `pairs` list is a NOMINATION of which half
    // survives, and the service refuses a nomination with this defect's
    // polarity backwards — so this surface never makes one.
    expect('pairs' in body).toBe(false)
  })

  it('sends dryRun as the boolean false on a real run, never the string "false"', async () => {
    // The endpoint writes only on `body.dryRun !== false`, so EVERY other
    // spelling of "no" previews. `'false'` is truthy prose: a UI that sent it
    // would merge nothing while looking like it had.
    const postSpy = mockPost(reportBody({ dryRun: false, merged: 1, wouldMerge: 0 }))
    grantPermissions([{ resource: 'subscriptions', action: 'edit' }])
    const user = userEvent.setup()

    renderWithProviders(<DuplicateSubscriptionMergePanel />)
    await user.click(screen.getByRole('button', { name: 'Merge for real' }))
    const dialog = await screen.findByRole('alertdialog')
    await user.click(within(dialog).getByRole('button', { name: 'Merge the pairs' }))

    await waitFor(() => expect(postSpy).toHaveBeenCalledTimes(1))
    const body = sentBody(postSpy)
    expect(typeof body.dryRun).toBe('boolean')
    expect(body.dryRun).toBe(false)
  })

  it('writes nothing until the confirmation is accepted', async () => {
    const postSpy = mockPost()
    grantPermissions([{ resource: 'subscriptions', action: 'edit' }])
    const user = userEvent.setup()

    renderWithProviders(<DuplicateSubscriptionMergePanel />)
    await user.click(screen.getByRole('button', { name: 'Merge for real' }))

    const dialog = await screen.findByRole('alertdialog', {
      name: 'Merge these duplicate pairs for real?',
    })
    expect(postSpy).not.toHaveBeenCalled()

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(postSpy).not.toHaveBeenCalled()
  })

  it('states what the real run writes and to how many pairs, before it runs', async () => {
    mockPost(reportBody({ wouldMerge: 2 }))
    grantPermissions([{ resource: 'subscriptions', action: 'edit' }])
    const user = userEvent.setup()

    renderWithProviders(<DuplicateSubscriptionMergePanel />)
    fireEvent.change(screen.getByLabelText('Pairs per run'), { target: { value: '9' } })
    await runPreview(user)

    await user.click(screen.getByRole('button', { name: 'Merge for real' }))
    const dialog = await screen.findByRole('alertdialog')

    // The COUNT of pairs...
    expect(
      within(dialog).getByText('The last preview found 2 mergeable pair(s) in this sweep.'),
    ).toBeInTheDocument()
    expect(
      within(dialog).getByText('This run merges up to 9 pair(s), starting from the beginning of the selection.'),
    ).toBeInTheDocument()
    // ...and WHAT is written, in the words that matter: a customer's payment
    // history moving between two rows. "Are you sure?" is not a statement an
    // operator can check anything against.
    expect(dialog).toHaveTextContent('retires the newer subscription')
    expect(dialog).toHaveTextContent('payments, receipt lines, promocode activations')
    expect(dialog).toHaveTextContent('Nothing on the panel is created, changed or deleted.')
  })

  it('says how many pairs are unknown when no preview has been run', async () => {
    // The control for the spec above: without it a dialog that always printed
    // the "no preview" sentence would pass it.
    mockPost()
    grantPermissions([{ resource: 'subscriptions', action: 'edit' }])
    const user = userEvent.setup()

    renderWithProviders(<DuplicateSubscriptionMergePanel />)
    await user.click(screen.getByRole('button', { name: 'Merge for real' }))
    const dialog = await screen.findByRole('alertdialog')

    expect(dialog).toHaveTextContent('No preview has been run in this sweep')
    expect(within(dialog).queryByText(/mergeable pair\(s\) in this sweep/)).not.toBeInTheDocument()
  })

  it('names the survivor and the duplicate in their own columns, never interchangeably', async () => {
    // Reading these two the wrong way round destroys a paying customer's
    // history, so the ids never share a cell and neither column is called
    // simply "subscription".
    mockPost()
    grantPermissions([{ resource: 'subscriptions', action: 'edit' }])
    const user = userEvent.setup()

    renderWithProviders(<DuplicateSubscriptionMergePanel />)
    await runPreview(user)

    const headers = screen.getAllByRole('columnheader').map((cell) => cell.textContent)
    expect(headers.slice(0, 2)).toEqual(['Survivor — kept', 'Duplicate — retired'])

    const row = rowBySurvivor('sub-older-1')
    expect(row).not.toBeUndefined()
    const cells = within(row as HTMLElement).getAllByRole('cell')
    // survivor(0) | duplicate(1) | customer(2) | live identity(3) | holder(4) …
    expect(cells[0]).toHaveTextContent('sub-older-1')
    expect(cells[1]).toHaveTextContent('sub-newer-2')
    // Direction-complete: neither cell carries the OTHER row's id.
    expect(cells[0]).not.toHaveTextContent('sub-newer-2')
    expect(cells[1]).not.toHaveTextContent('sub-older-1')
    expect(cells[2]).toHaveTextContent('user-1')
  })

  it('says which half holds the live panel identity right now', async () => {
    // The polarity is backwards from instinct: the older, legitimate-looking
    // row is bound to nothing and the wrong-looking duplicate is the live one.
    mockPost()
    grantPermissions([{ resource: 'subscriptions', action: 'edit' }])
    const user = userEvent.setup()

    renderWithProviders(<DuplicateSubscriptionMergePanel />)
    await runPreview(user)

    const cells = within(rowBySurvivor('sub-older-1') as HTMLElement).getAllByRole('cell')
    expect(cells[3]).toHaveTextContent('4471')
    expect(cells[3]).toHaveTextContent('panel id 4471')
    expect(cells[4]).toHaveTextContent('The duplicate')
    expect(cells[4]).not.toHaveTextContent('The survivor')
  })

  it('says the SURVIVOR holds it when the survivor is the bound half', async () => {
    // The control. Without it, a cell hard-coded to "The duplicate" — which is
    // the common case — would pass the spec above.
    mockPost(
      reportBody({
        rows: [
          {
            ...MERGEABLE_PAIR,
            survivorHoldsLiveIdentity: true,
            duplicateHoldsLiveIdentity: false,
          },
        ],
      }),
    )
    grantPermissions([{ resource: 'subscriptions', action: 'edit' }])
    const user = userEvent.setup()

    renderWithProviders(<DuplicateSubscriptionMergePanel />)
    await runPreview(user)

    const cells = within(rowBySurvivor('sub-older-1') as HTMLElement).getAllByRole('cell')
    expect(cells[4]).toHaveTextContent('The survivor')
    expect(cells[4]).not.toHaveTextContent('The duplicate')
  })

  it('does not guess a holder when the report resolved no identity at all', async () => {
    mockPost(reportBody({ rows: [REFUSED_NEVER], wouldMerge: 0, refused: 1, pairsExamined: 1 }))
    grantPermissions([{ resource: 'subscriptions', action: 'edit' }])
    const user = userEvent.setup()

    renderWithProviders(<DuplicateSubscriptionMergePanel />)
    await runPreview(user)

    const cells = within(rowBySurvivor('sub-alice-1') as HTMLElement).getAllByRole('cell')
    expect(cells[4]).toHaveTextContent('not reported')
    expect(cells[4]).not.toHaveTextContent('The duplicate')
    expect(cells[4]).not.toHaveTextContent('The survivor')
  })

  it('reads the flag rather than re-deriving it from the previous columns', async () => {
    // THE POINT OF MOVING THE RULE TO THE SERVER. Here the four `previous`
    // columns describe the canonical pair — the duplicate is the half holding
    // the live identity by every column comparison — while the server states
    // the opposite. A surface still deriving the answer for itself renders "The
    // duplicate" and disagrees with the report it is displaying; the server's
    // answer is the one that came from `namesProfile`, so the server wins.
    mockPost(
      reportBody({
        rows: [
          {
            ...MERGEABLE_PAIR,
            survivorPreviousRemnawaveId: 'dead-uuid-1111',
            survivorPreviousPanelId: null,
            duplicatePreviousRemnawaveId: '4471',
            duplicatePreviousPanelId: 4471,
            survivorHoldsLiveIdentity: true,
            duplicateHoldsLiveIdentity: false,
          },
        ],
      }),
    )
    grantPermissions([{ resource: 'subscriptions', action: 'edit' }])
    const user = userEvent.setup()

    renderWithProviders(<DuplicateSubscriptionMergePanel />)
    await runPreview(user)

    const cells = within(rowBySurvivor('sub-older-1') as HTMLElement).getAllByRole('cell')
    expect(cells[4]).toHaveTextContent('The survivor')
    expect(cells[4]).not.toHaveTextContent('The duplicate')
  })

  it('says "not reported" — never "the duplicate" — when the backend omits the flags', async () => {
    // A panel build meeting an API image that predates the field. Every
    // `previous` column is populated, so the derivation this surface used to
    // carry would confidently answer "The duplicate" and point the operator
    // straight at the destructive action for a report that said nothing at all.
    const { survivorHoldsLiveIdentity, duplicateHoldsLiveIdentity, ...withoutFlags } =
      MERGEABLE_PAIR
    void survivorHoldsLiveIdentity
    void duplicateHoldsLiveIdentity
    mockPost(reportBody({ rows: [withoutFlags] }))
    grantPermissions([{ resource: 'subscriptions', action: 'edit' }])
    const user = userEvent.setup()

    renderWithProviders(<DuplicateSubscriptionMergePanel />)
    await runPreview(user)

    const cells = within(rowBySurvivor('sub-older-1') as HTMLElement).getAllByRole('cell')
    // The identity itself IS reported — this row is not empty, and the cell
    // beside it proves the row rendered — but the holder is not.
    expect(cells[3]).toHaveTextContent('4471')
    expect(cells[4]).toHaveTextContent('not reported')
    expect(cells[4]).not.toHaveTextContent('The duplicate')
    expect(cells[4]).not.toHaveTextContent('The survivor')
  })

  it('does not invent a provenance for a MERGED row the backend said nothing about', async () => {
    // After a real merge the survivor holds the identity either way, so the
    // only fact left is where it CAME FROM — and that is the field an undo
    // needs. A binary choice over a tri-state answers "the survivor already
    // held it", which is a confident false statement about a live profile.
    const { survivorHoldsLiveIdentity, duplicateHoldsLiveIdentity, ...withoutFlags } =
      MERGEABLE_PAIR
    void survivorHoldsLiveIdentity
    void duplicateHoldsLiveIdentity
    mockPost(
      reportBody({
        dryRun: false,
        merged: 1,
        wouldMerge: 0,
        refused: 0,
        pairsExamined: 1,
        rows: [{ ...withoutFlags, outcome: 'merged' }],
      }),
    )
    grantPermissions([{ resource: 'subscriptions', action: 'edit' }])
    const user = userEvent.setup()

    renderWithProviders(<DuplicateSubscriptionMergePanel />)
    await user.click(screen.getByRole('button', { name: 'Merge for real' }))
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Merge the pairs',
      }),
    )
    await screen.findByText('Merge report')

    const cells = within(rowBySurvivor('sub-older-1') as HTMLElement).getAllByRole('cell')
    expect(cells[4]).toHaveTextContent('The survivor, now')
    expect(cells[4]).toHaveTextContent('Which half it came off was not reported.')
    expect(cells[4]).not.toHaveTextContent('The survivor already held it before this merge.')
    expect(cells[4]).not.toHaveTextContent('It came off the duplicate.')
  })

  it('states "neither half is bound" as an answer, not as a silence', async () => {
    // `neitherHoldsIdentity` is raised AFTER the panel round-trip: the two
    // `false`s are a finding the operator acts on — repair the link first —
    // and must not be rendered as "we did not look".
    mockPost(reportBody())
    grantPermissions([{ resource: 'subscriptions', action: 'edit' }])
    const user = userEvent.setup()

    renderWithProviders(<DuplicateSubscriptionMergePanel />)
    await runPreview(user)

    const cells = within(rowBySurvivor('sub-unbound-1') as HTMLElement).getAllByRole('cell')
    expect(cells[4]).not.toHaveTextContent('The duplicate')
    expect(cells[4]).not.toHaveTextContent('The survivor')
  })

  it('names BOTH halves when both are bound, never just one of them', async () => {
    // The shared-identity pair. `liveIdentityHolder` used to answer 'duplicate'
    // here — the service does take the duplicate as the identity source — and an
    // operator reading that concludes the survivor is bound to nothing and can be
    // tidied away. It is bound to the same live profile, and tidying it away is a
    // panel DELETE against a paying customer.
    mockPost(
      reportBody({ rows: [BOTH_HALVES_LIVE_PAIR], pairsExamined: 1, wouldMerge: 1, refused: 0 }),
    )
    grantPermissions([{ resource: 'subscriptions', action: 'edit' }])
    const user = userEvent.setup()

    renderWithProviders(<DuplicateSubscriptionMergePanel />)
    await runPreview(user)

    const cells = within(rowBySurvivor('sub-shared-older') as HTMLElement).getAllByRole('cell')
    expect(cells[4]).toHaveTextContent('Both halves \u2014 do not delete either')
    // Neither single-holder answer may appear: each of them says the other row
    // is unbound, which is the reading that ends in the DELETE.
    expect(cells[4]).not.toHaveTextContent('The duplicate')
    expect(cells[4]).not.toHaveTextContent('The survivor')
  })

  it('still names the single holder when only one half is bound', async () => {
    // The control for the branch above. The ordinary pair really does have one
    // bound half, and collapsing it into "both" would throw away the one fact
    // this column exists to state.
    mockPost()
    grantPermissions([{ resource: 'subscriptions', action: 'edit' }])
    const user = userEvent.setup()

    renderWithProviders(<DuplicateSubscriptionMergePanel />)
    await runPreview(user)

    const cells = within(rowBySurvivor('sub-older-1') as HTMLElement).getAllByRole('cell')
    expect(cells[4]).toHaveTextContent('The duplicate')
    expect(cells[4]).not.toHaveTextContent('Both halves')
  })

  it('says the identity came off BOTH halves once such a pair is merged', async () => {
    // Post-merge the survivor holds it either way, so the only thing left to
    // report is provenance. "The survivor already held it" would be true and
    // incomplete: it hides that the retired row held it too, which is exactly
    // what an undo needs to know.
    mockPost(
      reportBody({
        dryRun: false,
        rows: [{ ...BOTH_HALVES_LIVE_PAIR, outcome: 'merged' }],
        pairsExamined: 1,
        merged: 1,
        wouldMerge: 0,
        refused: 0,
      }),
    )
    grantPermissions([{ resource: 'subscriptions', action: 'edit' }])
    const user = userEvent.setup()

    renderWithProviders(<DuplicateSubscriptionMergePanel />)
    await runPreview(user)

    const cells = within(rowBySurvivor('sub-shared-older') as HTMLElement).getAllByRole('cell')
    expect(cells[4]).toHaveTextContent('The survivor, now')
    expect(cells[4]).toHaveTextContent('Both halves held it before this merge.')
    expect(cells[4]).not.toHaveTextContent('It came off the duplicate.')
  })

  it('itemises what followed the survivor, relation by relation', async () => {
    // "3 payments, 1 promocode activation and the trial claim followed the
    // survivor" IS the audit trail. A single count cannot tell four payments
    // from four sync-job rows, and those need entirely different repairs.
    mockPost()
    grantPermissions([{ resource: 'subscriptions', action: 'edit' }])
    const user = userEvent.setup()

    renderWithProviders(<DuplicateSubscriptionMergePanel />)
    await runPreview(user)

    const moved = within(rowBySurvivor('sub-older-1') as HTMLElement).getAllByRole('cell')[5]
    expect(moved).toHaveTextContent('Payments — 3')
    expect(moved).toHaveTextContent('Receipt lines — 5')
    expect(moved).toHaveTextContent('Promocode activations — 1')
    expect(moved).toHaveTextContent('Trial claim — 1')
    expect(moved).toHaveTextContent('Cabinet “current subscription” pointer — 1')
    // The relations that carry nothing are named too: an operator checking a
    // merge needs to see that the referral spends were considered and found
    // absent, not to wonder whether they were considered at all.
    expect(moved).toHaveTextContent('Nothing to move: Referral point spends')
    expect(moved).toHaveTextContent('Sync jobs defused on the retired row — 2')
    // ...and it is NOT collapsed into one number.
    expect(moved).not.toHaveTextContent('— 12')
  })

  it('says the audit trail was not reported rather than inventing an empty one', async () => {
    // A backend that predates the field must not be rendered as "nothing
    // referenced the duplicate" — that is a statement about a customer's
    // payment history, made from a field nobody sent.
    mockPost(
      reportBody({
        rows: [{ ...MERGEABLE_PAIR, reattached: undefined, supersededSyncJobs: undefined }],
      }),
    )
    grantPermissions([{ resource: 'subscriptions', action: 'edit' }])
    const user = userEvent.setup()

    renderWithProviders(<DuplicateSubscriptionMergePanel />)
    await runPreview(user)

    const moved = within(rowBySurvivor('sub-older-1') as HTMLElement).getAllByRole('cell')[5]
    expect(moved).toHaveTextContent('not reported')
    expect(moved).not.toHaveTextContent('Nothing referenced the duplicate')
    expect(moved).not.toHaveTextContent('Payments')
  })

  it('says nothing referenced the duplicate when the server really said so', async () => {
    // The control for the spec above: an empty ARRAY is a measurement, and it
    // must not read like the absent field.
    mockPost(reportBody({ rows: [{ ...MERGEABLE_PAIR, reattached: [], supersededSyncJobs: 0 }] }))
    grantPermissions([{ resource: 'subscriptions', action: 'edit' }])
    const user = userEvent.setup()

    renderWithProviders(<DuplicateSubscriptionMergePanel />)
    await runPreview(user)

    const moved = within(rowBySurvivor('sub-older-1') as HTMLElement).getAllByRole('cell')[5]
    expect(moved).toHaveTextContent('Nothing referenced the duplicate.')
    expect(moved).toHaveTextContent('Sync jobs defused on the retired row — 0')
    expect(moved).not.toHaveTextContent('not reported')
  })

  it('separates a refusal worth retrying from one that will never change', async () => {
    mockPost()
    grantPermissions([{ resource: 'subscriptions', action: 'edit' }])
    const user = userEvent.setup()

    renderWithProviders(<DuplicateSubscriptionMergePanel />)
    await runPreview(user)

    const retryable = screen.getByText('A sync job for the duplicate is running — 1 pair(s)')
    const never = screen.getByText('Two different customers — 1 pair(s)')
    const blocked = screen.getByText('Neither half is bound to the profile — 1 pair(s)')

    // Each heading carries its own verdict, and NOT either of the other two.
    expect(retryable.parentElement).toHaveTextContent('Try it again')
    expect(retryable.parentElement).not.toHaveTextContent('Never merge these')
    expect(never.parentElement).toHaveTextContent('Never merge these')
    expect(never.parentElement).not.toHaveTextContent('Try it again')
    expect(blocked.parentElement).toHaveTextContent('Blocked until something else is done')
    expect(blocked.parentElement).not.toHaveTextContent('Try it again')

    // And the "never" group says out loud that pressing it again is pointless.
    expect(never.closest('div')).toHaveTextContent(
      'Running the merge again will never change that',
    )
  })

  it('gives every refusal a remedy, not just a name', async () => {
    // A refusal without one is "something went wrong", and an operator told
    // only that goes back to editing rows by hand — the practice this endpoint
    // replaces.
    mockPost()
    grantPermissions([{ resource: 'subscriptions', action: 'edit' }])
    const user = userEvent.setup()

    renderWithProviders(<DuplicateSubscriptionMergePanel />)
    await runPreview(user)

    expect(
      screen.getByText(/^Wait for the running sync job to finish, then run the merge again\./),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/^Run the panel link repair above first\. Neither of these rows is bound/),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/^Leave them alone\. Two rows belonging to two customers/),
    ).toBeInTheDocument()
  })

  it('reports a refusal this build has never heard of by its raw name, with no retry verdict', async () => {
    mockPost(
      reportBody({
        rows: [refusedPair({ refusal: 'somethingNewServerSide', reason: 'server said so' })],
        wouldMerge: 0,
        refused: 1,
        pairsExamined: 1,
      }),
    )
    grantPermissions([{ resource: 'subscriptions', action: 'edit' }])
    const user = userEvent.setup()

    renderWithProviders(<DuplicateSubscriptionMergePanel />)
    await runPreview(user)

    const heading = screen.getByText('somethingNewServerSide — 1 pair(s)')
    expect(heading.parentElement).toHaveTextContent('Unknown to this build')
    expect(heading.parentElement).not.toHaveTextContent('Try it again')
    expect(heading.parentElement).not.toHaveTextContent('Never merge these')
    // The server's own sentence still reaches the operator.
    expect(screen.getByText('server said so')).toBeInTheDocument()
  })

  it('says the merge did not finish, and offers to carry on from the cursor', async () => {
    const postSpy = mockPost(
      reportBody({ hasMore: true, nextCursor: 'sub-newer-2' }),
      reportBody({ hasMore: false, nextCursor: 'sub-later-9', pairsExamined: 1, wouldMerge: 0, rows: [] }),
    )
    grantPermissions([{ resource: 'subscriptions', action: 'edit' }])
    const user = userEvent.setup()

    renderWithProviders(<DuplicateSubscriptionMergePanel />)
    await runPreview(user)

    expect(screen.getByText('The merge did not finish')).toBeInTheDocument()
    expect(screen.queryByText(/reached the end of the selection/)).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Continue the merge preview' }))

    await waitFor(() => expect(postSpy).toHaveBeenCalledTimes(2))
    expect(sentBody(postSpy, 1).startAfterId).toBe('sub-newer-2')
    // The second page drained the selection, so `hasMore` must CLEAR. A latched
    // flag sends the operator round a loop of runs that merge nothing.
    await screen.findByText('The merge reached the end of the selection')
    expect(screen.queryByText('The merge did not finish')).not.toBeInTheDocument()
    // One sweep, two runs, totals added up rather than replaced.
    expect(screen.getByText('Merge runs in this sweep: 2')).toBeInTheDocument()
  })

  it('says so when the merge did reach the end', async () => {
    // The control for the spec above: the same anchor, the opposite verdict.
    mockPost(reportBody({ hasMore: false }))
    grantPermissions([{ resource: 'subscriptions', action: 'edit' }])
    const user = userEvent.setup()

    renderWithProviders(<DuplicateSubscriptionMergePanel />)
    await runPreview(user)

    expect(screen.getByText('The merge reached the end of the selection')).toBeInTheDocument()
    expect(screen.queryByText('The merge did not finish')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Continue the merge preview' }),
    ).not.toBeInTheDocument()
  })

  it('handles the truncated run whose cursor is deliberately null', async () => {
    // The service reports `hasMore: true` with the cursor it STARTED from when
    // the run was capped by `limit` rather than by the scan, so the cursor
    // never advances past a pair nobody touched. On a first page that is
    // `null`, and there is nothing to continue FROM.
    mockPost(reportBody({ hasMore: true, nextCursor: null }))
    grantPermissions([{ resource: 'subscriptions', action: 'edit' }])
    const user = userEvent.setup()

    renderWithProviders(<DuplicateSubscriptionMergePanel />)
    await runPreview(user)

    expect(screen.getByText('The merge did not finish')).toBeInTheDocument()
    expect(screen.getByText(/Run it again from the beginning/)).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Continue the merge preview' }),
    ).not.toBeInTheDocument()
  })

  it('confirms a CONTINUED real run too, not just the first page', async () => {
    const postSpy = mockPost(
      reportBody({ dryRun: false, merged: 1, wouldMerge: 0, hasMore: true, nextCursor: 'sub-x' }),
    )
    grantPermissions([{ resource: 'subscriptions', action: 'edit' }])
    const user = userEvent.setup()

    renderWithProviders(<DuplicateSubscriptionMergePanel />)
    await user.click(screen.getByRole('button', { name: 'Merge for real' }))
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Merge the pairs',
      }),
    )
    await screen.findByText('Merge report')
    await waitFor(() => expect(postSpy).toHaveBeenCalledTimes(1))

    await user.click(screen.getByRole('button', { name: 'Continue merging from here' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(postSpy).toHaveBeenCalledTimes(1)
    expect(
      within(dialog).getByText('This run merges up to 25 pair(s), starting after subscription sub-x.'),
    ).toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: 'Merge the pairs' }))
    await waitFor(() => expect(postSpy).toHaveBeenCalledTimes(2))
    expect(sentBody(postSpy, 1).dryRun).toBe(false)
    expect(sentBody(postSpy, 1).startAfterId).toBe('sub-x')
  })

  it('says a merged pair now holds the identity, and where it came from', async () => {
    mockPost(
      reportBody({
        dryRun: false,
        merged: 1,
        wouldMerge: 0,
        refused: 0,
        pairsExamined: 1,
        rows: [{ ...MERGEABLE_PAIR, outcome: 'merged' }],
      }),
    )
    grantPermissions([{ resource: 'subscriptions', action: 'edit' }])
    const user = userEvent.setup()

    renderWithProviders(<DuplicateSubscriptionMergePanel />)
    await user.click(screen.getByRole('button', { name: 'Merge for real' }))
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Merge the pairs',
      }),
    )
    await screen.findByText('Merge report')

    expect(screen.getByText('Merged')).toBeInTheDocument()
    const cells = within(rowBySurvivor('sub-older-1') as HTMLElement).getAllByRole('cell')
    expect(cells[4]).toHaveTextContent('The survivor, now')
    expect(cells[4]).toHaveTextContent('It came off the duplicate.')
  })

  it('does not let an unknown panel era read like a known one', async () => {
    mockPost(reportBody({ panelEra: null, pairsExamined: 0, wouldMerge: 0, refused: 0, rows: [] }))
    grantPermissions([{ resource: 'subscriptions', action: 'edit' }])
    const user = userEvent.setup()

    renderWithProviders(<DuplicateSubscriptionMergePanel />)
    await runPreview(user)

    expect(screen.getByText('Discovery could not identify the panel era')).toBeInTheDocument()
    expect(screen.queryByText(/^Discovery panel era: /)).not.toBeInTheDocument()
  })

  it('names the panel era when discovery knew it', async () => {
    // The control: without it, a component that rendered the warning
    // unconditionally would pass the spec above.
    mockPost(reportBody({ panelEra: '2.x' }))
    grantPermissions([{ resource: 'subscriptions', action: 'edit' }])
    const user = userEvent.setup()

    renderWithProviders(<DuplicateSubscriptionMergePanel />)
    await runPreview(user)

    expect(screen.getByText('Discovery panel era: 2.x')).toBeInTheDocument()
    expect(
      screen.queryByText('Discovery could not identify the panel era'),
    ).not.toBeInTheDocument()
  })

  it('puts the operator-typed bounds on the wire as numbers, or not at all', async () => {
    // `userEvent.type` NORMALISES a number input; `fireEvent.change` is the
    // only way to pin what the raw string does.
    const postSpy = mockPost()
    grantPermissions([{ resource: 'subscriptions', action: 'edit' }])
    const user = userEvent.setup()

    renderWithProviders(<DuplicateSubscriptionMergePanel />)
    fireEvent.change(screen.getByLabelText('Pairs per run'), { target: { value: '7' } })
    fireEvent.change(screen.getByLabelText('Database page size'), { target: { value: '' } })
    await user.click(screen.getByRole('button', { name: 'Preview the merge' }))

    await waitFor(() => expect(postSpy).toHaveBeenCalledTimes(1))
    const body = sentBody(postSpy)
    expect(typeof body.limit).toBe('number')
    expect(body.limit).toBe(7)
    // The controller reads a bound as `typeof … === 'number' ? … : undefined`,
    // so a stringified one is SILENTLY replaced by the server default.
    expect('chunkSize' in body).toBe(false)
  })

  it('shows no report at all when the response is not the shape it claims', async () => {
    // `api.post<T>()` is a cast, not a check. An HTML error page served with
    // HTTP 200 — which `web/nginx.conf` really produces for an unmatched /api
    // path — must not be laundered into a confident "0 pairs, nothing broken".
    mockPost(reportBody({ rows: { nope: true } }))
    grantPermissions([{ resource: 'subscriptions', action: 'edit' }])
    const user = userEvent.setup()

    renderWithProviders(<DuplicateSubscriptionMergePanel />)
    await user.click(screen.getByRole('button', { name: 'Preview the merge' }))

    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Preview the merge' })).not.toBeDisabled(),
    )
    expect(screen.queryByText('Merge report')).not.toBeInTheDocument()
    expect(screen.queryByText('Pairs examined')).not.toBeInTheDocument()
  })

  it('rejects a row whose reattached field is present but not an array', async () => {
    // The same hazard one level down. `reattached: '<html>…'` has a working
    // `.length` and would walk past every emptiness guard before dying inside
    // render.
    mockPost(reportBody({ rows: [{ ...MERGEABLE_PAIR, reattached: 'not-an-array' }] }))
    grantPermissions([{ resource: 'subscriptions', action: 'edit' }])
    const user = userEvent.setup()

    renderWithProviders(<DuplicateSubscriptionMergePanel />)
    await user.click(screen.getByRole('button', { name: 'Preview the merge' }))

    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Preview the merge' })).not.toBeDisabled(),
    )
    expect(screen.queryByText('Merge report')).not.toBeInTheDocument()
  })

  it('gives repeated pairs distinct React keys across pages', async () => {
    // A refused pair can be re-examined on a later run, so a pair is not unique
    // within the accumulated report. Keyed by index React would reuse a mounted
    // row for a DIFFERENT pair — an operator reading one pair's survivor
    // against another pair's reattachment list.
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
    const postSpy = mockPost(
      reportBody({ hasMore: true, nextCursor: 'sub-a', rows: [REFUSED_NEVER] }),
      reportBody({ hasMore: false, nextCursor: 'sub-b', rows: [REFUSED_NEVER] }),
    )
    grantPermissions([{ resource: 'subscriptions', action: 'edit' }])
    const user = userEvent.setup()

    renderWithProviders(<DuplicateSubscriptionMergePanel />)
    await runPreview(user)
    await user.click(screen.getByRole('button', { name: 'Continue the merge preview' }))
    await waitFor(() => expect(postSpy).toHaveBeenCalledTimes(2))
    await screen.findByText('Merge runs in this sweep: 2')

    expect(screen.getByText('Two different customers — 2 pair(s)')).toBeInTheDocument()
    const duplicateKeyWarnings = warn.mock.calls.filter((call) =>
      call.some((arg) => typeof arg === 'string' && arg.includes('same key')),
    )
    expect(duplicateKeyWarnings).toEqual([])
  })
})

/**
 * THE DRIFT GUARD, read from the backend's own source.
 *
 * `DuplicateMergeRefusal` is a TYPE union, so there is no runtime constant to
 * import the way `subscription-sync-outcome.test.tsx` imports
 * `SUBSCRIPTION_SYNC_REFUSAL_CODES`. Comparing this panel's tables against a
 * second hand-kept COPY of that union would reproduce exactly the drift it is
 * meant to catch, so the union is read out of the service file itself: a code
 * added or renamed there fails this spec BY NAME instead of quietly falling
 * into the unknown bucket and losing the operator their retry verdict.
 *
 * Read rather than imported deliberately. `build-isolation.test.ts` permits a
 * cross-boundary IMPORT from a test — tests are excluded from
 * `tsconfig.app.json`, so the production image never follows one — but a type
 * import would give this guard the weakest possible failure mode: a rename
 * would break COMPILATION, and a spec that fails to compile reports zero tests
 * rather than a named failure. A file read fails loudly, by name, at runtime.
 */
describe('the refusal tables match the backend union', () => {
  const SERVICE = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../../src/modules/profile-sync/duplicate-subscription-merge.service.ts',
  )

  /**
   * The members of `export type DuplicateMergeRefusal`.
   *
   * Comments are stripped BEFORE the terminating `;` is looked for, because one
   * of the doc comments in that union contains a semicolon of its own — with
   * the naive order this extractor silently returned four of the sixteen and
   * every comparison below would have passed on a subset.
   */
  function backendRefusals(): string[] {
    const source = readFileSync(SERVICE, 'utf8')
    const start = source.indexOf('export type DuplicateMergeRefusal =')
    expect(start).toBeGreaterThan(-1)
    const stripped = source
      .slice(start)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '')
    const block = stripped.slice(0, stripped.indexOf(';'))
    return [...block.matchAll(/\|\s*'([A-Za-z]+)'/g)].map((match) => match[1] as string)
  }

  it('extracts a plausible union rather than comparing two empty sets', () => {
    // The anti-vacuity control for every spec below: a regex that matched
    // nothing would make all of them pass against an empty list.
    expect(backendRefusals().length).toBeGreaterThanOrEqual(10)
  })

  it('classifies every refusal the backend can send', () => {
    const missing = backendRefusals().filter((code) => refusalClass(code) === null)
    expect(missing).toEqual([])
  })

  it('invents no refusal the backend cannot send', () => {
    const backend = new Set(backendRefusals())
    const invented = DUPLICATE_MERGE_REFUSALS.filter((code) => !backend.has(code))
    expect(invented).toEqual([])
  })

  it('puts each refusal in exactly one bucket', () => {
    const all = [
      ...DUPLICATE_MERGE_REFUSALS_NEVER,
      ...DUPLICATE_MERGE_REFUSALS_BLOCKED,
      ...DUPLICATE_MERGE_REFUSALS_RETRYABLE,
    ]
    expect(new Set(all).size).toBe(all.length)
    expect(all.length).toBe(backendRefusals().length)
  })
})
