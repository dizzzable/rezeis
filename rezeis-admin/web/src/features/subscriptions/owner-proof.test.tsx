import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { usePermissionStore } from '@/features/rbac'
import { loadFeatureBundle } from '@/i18n/i18n'
import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'
import { DuplicateSubscriptionMergePanel } from './duplicate-subscription-merge-panel'
import { ownerProofKind, OWNER_UNPROVEN } from './owner-proof'

/**
 * «Подписки» → «Инструменты» → «Слияние подписок-дубликатов».
 *
 * The server refuses to link or merge a panel profile unless its description's
 * `reiwa_id` line PROVES the customer, and it reports every such refusal under
 * one code, `notOwned`. Three different facts hide behind it, and only one of
 * them is "the profile belongs to somebody else": the other two — no marker
 * line at all, or lines naming different customers — prove nothing either way,
 * and telling the operator to "leave it alone, it carries another account's
 * marker" sends them the wrong way.
 *
 * The sentences below are the server's own, verbatim
 * (`assertPanelProfileOwnership` in `profile-sync.processor.ts`); the server
 * suite runs the classifier on what that function actually throws
 * (`test/owner-proof-server-contract.spec.ts`).
 */
const OWNED_BY_ANOTHER =
  "Remnawave profile 'rz_alice_sub' is owned by reiwa_id user-999, not user-1 — refusing to link"
const NO_MARKER =
  "Remnawave profile 'rz_alice_sub' has no 'reiwa_id: <id>' line naming its owner, so it is not proven to be user-1's — refusing to link it automatically. If it is this customer's, link it on the customer's card with «Link an existing Remnawave profile»: a matching Telegram id, e-mail or verified web-account e-mail proves it, and with none of them you can confirm it yourself"
const CONFLICTING =
  "Remnawave profile 'rz_alice_sub' names more than one owner in its 'reiwa_id' lines (user-1, user-999) — refusing to link it to user-1 automatically. Correct the lines in Remnawave first: nothing links a profile while a line names somebody else"

describe('ownerProofKind', () => {
  it('keeps "belongs to somebody else" for a profile whose marker names another customer', () => {
    expect(ownerProofKind('notOwned', OWNED_BY_ANOTHER)).toBe('notOwned')
  })

  it('splits off "not proven" for no marker and for markers that disagree — in both reports\' wording', () => {
    expect(ownerProofKind('notOwned', NO_MARKER)).toBe(OWNER_UNPROVEN)
    expect(ownerProofKind('notOwned', CONFLICTING)).toBe(OWNER_UNPROVEN)
    // The merge appends its own sentence to the same reason.
    expect(ownerProofKind('notOwned', `${NO_MARKER}. Nothing was changed.`)).toBe(OWNER_UNPROVEN)
  })

  it('touches no other code, and no reason it cannot read', () => {
    expect(ownerProofKind('conflict', NO_MARKER)).toBe('conflict')
    expect(ownerProofKind('notOwned', null)).toBe('notOwned')
    expect(ownerProofKind('notOwned', 'something the server says one day')).toBe('notOwned')
  })
})

function grantEdit() {
  usePermissionStore.setState({
    loaded: true,
    loading: false,
    granted: new Set(['subscriptions:view', 'subscriptions:edit']),
    mustChangePassword: false,
    role: 'ADMIN',
    rbacRoleId: 'role-1',
    error: null,
  })
}

function mergeRefusal(survivor: string, duplicate: string, reason: string) {
  return {
    survivorSubscriptionId: survivor,
    duplicateSubscriptionId: duplicate,
    userId: 'user-1',
    outcome: 'refused',
    refusal: 'notOwned',
    reason: `${reason}. Nothing was changed.`,
    remnawaveId: null,
    remnawavePanelId: null,
    panelUsername: null,
    configUrl: null,
    survivorPreviousRemnawaveId: null,
    survivorPreviousPanelId: null,
    duplicatePreviousRemnawaveId: null,
    duplicatePreviousPanelId: null,
    survivorHoldsLiveIdentity: null,
    duplicateHoldsLiveIdentity: null,
    reattached: [],
    supersededSyncJobs: 0,
  }
}

describe('the merge tells "not proven" from "somebody else\'s"', () => {
  beforeAll(async () => {
    await loadFeatureBundle('subscriptionTools')
  })

  beforeEach(() => {
    usePermissionStore.getState().reset()
    vi.restoreAllMocks()
  })

  it('the merge gives an unproven profile its own refusal and a remedy that is not "another account\'s marker"', async () => {
    vi.spyOn(api, 'post').mockResolvedValue({
      data: {
        dryRun: true,
        pairsExamined: 2,
        merged: 0,
        wouldMerge: 0,
        refused: 2,
        rows: [
          mergeRefusal('sub-a-1', 'sub-a-2', OWNED_BY_ANOTHER),
          mergeRefusal('sub-b-1', 'sub-b-2', NO_MARKER),
        ],
        hasMore: false,
        nextCursor: null,
      },
    } as never)
    grantEdit()
    const user = userEvent.setup()
    renderWithProviders(<DuplicateSubscriptionMergePanel />)

    await user.click(screen.getByRole('button', { name: 'Preview the merge' }))
    await screen.findByText('Merge report')

    expect(screen.getByText('The profile belongs to somebody else — 1 pair(s)')).toBeInTheDocument()
    expect(screen.getByText('Not proven to be this customer’s — 1 pair(s)')).toBeInTheDocument()
    // Each group keeps its own remedy: the proven one still says to leave the
    // pair alone, the unproven one says how to prove it — by hand, because no
    // button pushes a description without also provisioning an unlinked half.
    expect(screen.getAllByText(/carries another account’s ownership marker/)).toHaveLength(1)
    expect(
      screen.getByText(/add the line «reiwa_id: <customer id>» to its description there and preview again/),
    ).toHaveTextContent(/removing any line that names somebody else/)
    // Pressing it again cannot help until that step is done.
    expect(screen.getAllByText('Blocked until something else is done').length).toBeGreaterThanOrEqual(1)
  })
})
