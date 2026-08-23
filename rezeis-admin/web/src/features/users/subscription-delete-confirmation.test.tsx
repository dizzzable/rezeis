/**
 * DELETING A SUBSCRIPTION IS THE ONE ACTION ON THIS CARD THAT LEAVES THE
 * DATABASE.
 *
 * `SubscriptionDeletionService.deleteSubscription` writes a `SyncAction.DELETE`
 * job whenever the row names a panel profile, and `ProfileSyncProcessor`
 * turns that job into `deletePanelUser` against the live Remnawave panel. Until
 * this change both delete controls on the card called `deleteSubMutation.mutate`
 * DIRECTLY — one misclick on a 24px icon ended a paying customer's service —
 * while the device-revoke control a few pixels away, whose worst outcome is
 * "reconnect your phone", had asked for confirmation all along.
 *
 * WHAT THESE SPECS PIN, and why each one is a separate way for the guard to rot:
 *
 *   1. BOTH ENTRY POINTS. The card offers delete twice: an icon in the header
 *      and a text button inside the collapsible. They are covered by two
 *      independent specs, because a guard on one of them is worse than a guard
 *      on neither — it teaches the operator that the button asks first, and
 *      then one day it does not.
 *   2. THE DIALOG NAMES THE SUBJECT. The mistake this guards is not "I did not
 *      mean to press delete", it is "I pressed delete on the wrong card", and
 *      "Are you sure?" is not a sentence anybody can check that against. So the
 *      plan and the customer are asserted by name, and a plan-less row is
 *      asserted to fall back to the subscription id rather than to an empty
 *      quote.
 *   3. THE PANEL CONSEQUENCE IS STATED, and stated conditionally — the job is
 *      only created when the row holds an identity, so a card with no linked
 *      profile must not claim a profile is about to be deleted. Both directions
 *      are asserted; without the second, hard-coded prose passes the first.
 *   4. CANCEL SENDS NOTHING. The direction-complete half: a dialog whose
 *      "Cancel" still fired the mutation would satisfy every spec above.
 *   5. EVERY WORD COMES FROM THE DICTIONARIES, asserted by driving the whole
 *      confirmation in Russian.
 *
 * ANTI-VACUITY DISCIPLINE. No spec waits for the text it is about to assert.
 * Each one asserts `api.delete` was NOT called the instant the trigger is
 * released — which fails in milliseconds if the confirmation is bypassed,
 * rather than sitting until a ten second timeout — and only then waits for ANY
 * dialog and interrogates its contents.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { usePermissionStore } from '@/features/rbac'
import { i18n, loadFeatureBundle } from '@/i18n/i18n'
import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'

import UserDetailPanel from './user-detail-panel'

/** Read from the ACTIVE bundle, so the Russian spec drives the same helpers. */
const tabLabel = (): string => i18n.t('userDetailPanel.tabs.subscriptions')
const deleteLabel = (): string => i18n.t('userDetailPanel.subscriptions.deleteTitle')
const quickEditsLabel = (): string => i18n.t('userDetailPanel.subscriptions.quickEdits')
const confirmLabel = (): string => i18n.t('userDetailPanel.subscriptions.deleteConfirm.action')
const cancelLabel = (): string => i18n.t('userDetailPanel.actions.cancel')

const SUBSCRIPTION = {
  id: 'subscription-1',
  status: 'ACTIVE',
  remnawaveId: '4471',
  remnawaveProfileName: 'rz_alice_sub_1',
  remnawaveSyncState: 'SYNCED',
  remnawaveSyncJob: null,
  expireAt: '2099-01-01T00:00:00.000Z',
  trafficLimit: 50,
  deviceLimit: 3,
  plan: { id: 'plan-1', name: 'Годовой Премиум', type: 'BOTH' },
}

function userWith(subscription: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'user-1',
    telegramId: '12345',
    username: 'alice_vpn',
    name: 'Alice Anderson',
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
    subscriptions: [subscription],
    transactions: [],
    referralsGiven: [],
    partner: null,
    webAccount: null,
  }
}

/**
 * The two delete controls, told apart by what they RENDER rather than by
 * position: the header control is icon-only (no text at all), the collapsible
 * one is a text button. Indexing into `getAllByRole` would silently follow a
 * reordering of the card and stop testing the control it names.
 */
function deleteControls(): { header: HTMLElement | null; inline: HTMLElement | null } {
  const all = screen.queryAllByRole('button', { name: deleteLabel() })
  const label = deleteLabel()
  return {
    header: all.find((node) => (node.textContent ?? '').trim() === '') ?? null,
    inline: all.find((node) => (node.textContent ?? '').trim() === label) ?? null,
  }
}

/** Renders the panel, opens the Subscriptions tab, and spies on the write. */
async function openSubscriptions(
  subscription: Record<string, unknown> = SUBSCRIPTION,
): Promise<{
  user: ReturnType<typeof userEvent.setup>
  deleteSpy: ReturnType<typeof vi.spyOn>
}> {
  const user = userEvent.setup()
  vi.spyOn(api, 'get').mockResolvedValue({ data: userWith(subscription) } as never)
  const deleteSpy = vi
    .spyOn(api, 'delete')
    .mockResolvedValue({ data: { ok: true } } as never) as ReturnType<typeof vi.spyOn>

  renderWithProviders(<UserDetailPanel telegramId="12345" />)
  await user.click(await screen.findByRole('tab', { name: new RegExp(tabLabel()) }))
  // The card itself is the stable anchor: it exists for any successful load and
  // says nothing about confirmations.
  await waitFor(() => expect(deleteControls().header).not.toBeNull())
  return { user, deleteSpy }
}

describe('deleting a subscription asks first, and says what it is deleting', () => {
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

  it('does not delete on the HEADER control until the confirmation is accepted', async () => {
    const { user, deleteSpy } = await openSubscriptions()

    await user.click(deleteControls().header as HTMLElement)

    // Asserted BEFORE any wait. A bypassed confirmation has already fired the
    // mutation by the time the click resolves, so this fails in milliseconds
    // instead of expiring a timeout.
    expect(deleteSpy).not.toHaveBeenCalled()

    // ANY dialog, not the text under test.
    const dialog = await screen.findByRole('alertdialog')
    await user.click(within(dialog).getByRole('button', { name: confirmLabel() }))

    await waitFor(() =>
      expect(deleteSpy).toHaveBeenCalledWith('/admin/users/subscriptions/subscription-1'),
    )
  })

  it('does not delete on the COLLAPSIBLE control until the confirmation is accepted', async () => {
    // The second entry point, covered independently. Guarding only the header
    // icon is the failure this spec exists to catch: the operator learns the
    // button asks first, and the one inside "Quick edits" does not.
    const { user, deleteSpy } = await openSubscriptions()

    await user.click(screen.getByRole('button', { name: quickEditsLabel() }))
    await waitFor(() => expect(deleteControls().inline).not.toBeNull())

    await user.click(deleteControls().inline as HTMLElement)

    expect(deleteSpy).not.toHaveBeenCalled()

    const dialog = await screen.findByRole('alertdialog')
    await user.click(within(dialog).getByRole('button', { name: confirmLabel() }))

    await waitFor(() =>
      expect(deleteSpy).toHaveBeenCalledWith('/admin/users/subscriptions/subscription-1'),
    )
  })

  it('names the plan and the customer, not merely the action', async () => {
    // "Are you sure?" cannot be checked against anything. These two facts are
    // exactly what differs between the card the operator meant and the card
    // they hit.
    const { user } = await openSubscriptions()

    await user.click(deleteControls().header as HTMLElement)
    const dialog = await screen.findByRole('alertdialog')

    expect(dialog).toHaveTextContent('Годовой Премиум')
    expect(dialog).toHaveTextContent('Alice Anderson')
  })

  it('falls back to the subscription id when the row has no plan at all', async () => {
    // A confirmation that names nothing is the "are you sure?" this replaces,
    // and a plan-less row is real — the importer mints them.
    const { user } = await openSubscriptions({
      ...SUBSCRIPTION,
      plan: null,
      planSnapshot: null,
    })

    await user.click(deleteControls().header as HTMLElement)
    const dialog = await screen.findByRole('alertdialog')

    expect(dialog).toHaveTextContent('#subscrip…')
    expect(dialog).toHaveTextContent('Alice Anderson')
  })

  it('says the panel profile goes with it when the row is linked', async () => {
    const { user } = await openSubscriptions()

    await user.click(deleteControls().header as HTMLElement)
    const dialog = await screen.findByRole('alertdialog')

    expect(dialog).toHaveTextContent(
      'Its Remnawave profile is deleted from the panel as well, so every device connected through this subscription stops working immediately.',
    )
  })

  it('does NOT claim a panel profile is going when the row holds none', async () => {
    // The direction-complete half. `deleteSubscription` only creates the
    // `SyncAction.DELETE` job inside `if (current.remnawaveId !== null)`, so
    // promising a panel deletion for an unlinked row is a false statement — and
    // hard-coded prose would pass the spec above without it.
    const { user } = await openSubscriptions({ ...SUBSCRIPTION, remnawaveId: null })

    await user.click(deleteControls().header as HTMLElement)
    const dialog = await screen.findByRole('alertdialog')

    expect(dialog).toHaveTextContent(
      'No Remnawave profile is linked to this subscription, so nothing is removed from the panel.',
    )
    expect(dialog).not.toHaveTextContent('Its Remnawave profile is deleted from the panel')
  })

  it('sends nothing when the confirmation is cancelled', async () => {
    // Without this, a dialog whose Cancel still fired the mutation satisfies
    // every spec above.
    const { user, deleteSpy } = await openSubscriptions()

    await user.click(deleteControls().header as HTMLElement)
    const dialog = await screen.findByRole('alertdialog')
    await user.click(within(dialog).getByRole('button', { name: cancelLabel() }))

    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(deleteSpy).not.toHaveBeenCalled()
  })

  it('asks in Russian for a Russian operator', async () => {
    await i18n.changeLanguage('ru')
    await loadFeatureBundle('userDetail')
    try {
      const { user, deleteSpy } = await openSubscriptions()

      await user.click(deleteControls().header as HTMLElement)
      expect(deleteSpy).not.toHaveBeenCalled()

      const dialog = await screen.findByRole('alertdialog')
      expect(dialog).toHaveTextContent('Удалить эту подписку?')
      expect(dialog).toHaveTextContent('«Годовой Премиум» — подписка клиента Alice Anderson.')
      expect(dialog).toHaveTextContent(
        'Профиль Remnawave, на котором она работает, тоже будет удалён из панели',
      )
      expect(dialog).toHaveTextContent('Вернуть подписку будет нельзя.')
      // Not one word of the English copy leaked through as a fallback.
      expect(dialog).not.toHaveTextContent('Delete this subscription?')
    } finally {
      await i18n.changeLanguage('en')
      await loadFeatureBundle('userDetail')
    }
  })

  afterAll(async () => {
    await i18n.changeLanguage('en')
  })
})
