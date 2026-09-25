/**
 * «Link an existing Remnawave profile» on the customer's card, and the
 * operator's word for a profile nothing proves (owner's decision, 19.09.2026).
 *
 * The panel-link repair and the duplicate merge refuse every profile whose
 * description names no owner and send the operator here. The server links such
 * a profile only when the request says, in so many words, that the operator
 * checked it (`confirmedWithoutProof: true`), and records that in the audit
 * log; a `reiwa_id` line naming another customer refuses whatever is sent.
 * These pin the dialog's half: the confirmation is an explicit tick, it travels
 * with the request, and it belongs to one attempt.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { usePermissionStore } from '@/features/rbac'
import { i18n, loadFeatureBundle } from '@/i18n/i18n'
import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'

import UserDetailPanel from './user-detail-panel'

const UNLINKED_SUBSCRIPTION = {
  id: 'subscription-1',
  status: 'ACTIVE',
  remnawaveId: null,
  remnawaveProfileName: null,
  remnawaveSyncState: 'UNLINKED',
  remnawaveSyncJob: null,
  expireAt: '2099-01-01T00:00:00.000Z',
  trafficLimit: 50,
  deviceLimit: 3,
  plan: { id: 'plan-1', name: 'Base', type: 'BOTH' },
}

/** A subscription linked on 2.x that still stores the uuid — a 3.x panel knows no such id. */
const STALE_SUBSCRIPTION = {
  ...UNLINKED_SUBSCRIPTION,
  id: 'subscription-2x',
  remnawaveId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
  remnawaveSyncState: 'MISSING',
}

/** A working 3.x link. */
const LINKED_SUBSCRIPTION = {
  ...UNLINKED_SUBSCRIPTION,
  id: 'subscription-3x',
  remnawaveId: '4471',
  remnawaveProfileName: 'rz_alice_sub',
  remnawaveSyncState: 'SYNCED',
}

function customer(subscriptions: ReadonlyArray<Record<string, unknown>> = [UNLINKED_SUBSCRIPTION]) {
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
    subscriptions,
    transactions: [],
    referralsGiven: [],
    partner: null,
    webAccount: null,
  }
}

const text = (key: string): string => i18n.t(`userDetailPanel.subscriptions.remnawaveProfile.${key}`)

async function openLinkDialog(user: ReturnType<typeof userEvent.setup>) {
  vi.spyOn(api, 'get').mockResolvedValue({ data: customer() } as never)
  const patch = vi.spyOn(api, 'patch').mockResolvedValue({ data: {} } as never)
  renderWithProviders(<UserDetailPanel telegramId="12345" />)
  await user.click(
    await screen.findByRole('tab', { name: new RegExp(i18n.t('userDetailPanel.tabs.subscriptions')) }),
  )
  await user.click((await screen.findAllByRole('button', { name: text('link') }))[0] as HTMLElement)
  const dialog = await screen.findByRole('dialog')
  return { dialog, patch }
}

describe('linking a Remnawave profile on the card', () => {
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

  it('sends no confirmation unless the operator ticks it', async () => {
    const user = userEvent.setup()
    const { dialog, patch } = await openLinkDialog(user)

    await user.type(within(dialog).getByLabelText(text('linkLabel')), '5150')
    await user.click(within(dialog).getByRole('button', { name: text('linkAction') }))

    expect(patch).toHaveBeenCalledWith('/admin/users/subscriptions/subscription-1/remnawave-link', {
      remnawaveId: '5150',
      confirmedWithoutProof: false,
    })
  })

  it('a ticked confirmation travels with the link, in the operator\'s own words', async () => {
    const user = userEvent.setup()
    const { dialog, patch } = await openLinkDialog(user)

    await user.type(within(dialog).getByLabelText(text('linkLabel')), '5150')
    await user.click(within(dialog).getByRole('checkbox', { name: text('confirmWithoutProof') }))
    await user.click(within(dialog).getByRole('button', { name: text('linkAction') }))

    expect(patch).toHaveBeenCalledWith('/admin/users/subscriptions/subscription-1/remnawave-link', {
      remnawaveId: '5150',
      confirmedWithoutProof: true,
    })
  })

  it('the confirmation belongs to one attempt: the dialog opens unticked again', async () => {
    const user = userEvent.setup()
    const { dialog } = await openLinkDialog(user)

    await user.click(within(dialog).getByRole('checkbox', { name: text('confirmWithoutProof') }))
    await user.click(within(dialog).getByRole('button', { name: i18n.t('userDetailPanel.subscriptions.cancel') }))
    await user.click((await screen.findAllByRole('button', { name: text('link') }))[0] as HTMLElement)

    const reopened = await screen.findByRole('dialog')
    expect(within(reopened).getByRole('checkbox', { name: text('confirmWithoutProof') })).not.toBeChecked()
  })

  it('refuses a 2.x UUID next to the field — the panel this build speaks has no such id — and sends nothing', async () => {
    const user = userEvent.setup()
    const { dialog, patch } = await openLinkDialog(user)

    // The uuid is refused twice over — too long AND not digits — so the short
    // shapes below are what pin the digits-only rule on its own.
    for (const refused of ['f47ac10b-58cc-4372-a567-0e02b2c3d479', '-4471', '44-71', '4e3', '1'.repeat(21)]) {
      const field = within(dialog).getByLabelText(text('linkLabel'))
      await user.clear(field)
      await user.type(field, refused)

      expect(within(dialog).getByRole('alert')).toHaveTextContent(text('linkInvalid'))
      expect(within(dialog).getByRole('button', { name: text('linkAction') })).toBeDisabled()
      expect(field).toHaveAttribute('aria-invalid', 'true')
    }
    expect(patch).not.toHaveBeenCalled()

    // Control: the same field takes the number, so the refusals above are about
    // the value, not a dialog that refuses everything.
    const field = within(dialog).getByLabelText(text('linkLabel'))
    await user.clear(field)
    await user.type(field, '4471')
    expect(within(dialog).queryByRole('alert')).toBeNull()
    expect(within(dialog).getByRole('button', { name: text('linkAction') })).toBeEnabled()
  })

  it('says when the tick is needed and what it can never override', async () => {
    const user = userEvent.setup()
    const { dialog } = await openLinkDialog(user)

    const checkbox = within(dialog).getByRole('checkbox', { name: text('confirmWithoutProof') })
    expect(checkbox).toHaveAccessibleDescription(/verified web-account e-mail/)
    expect(checkbox).toHaveAccessibleDescription(/naming another customer refuses the link whatever you confirm/)
  })
})

/**
 * A subscription that still stores a 2.x id is linked from the card too
 * (owner's decision, 24.09.2026): the server replaces a non-decimal id under
 * the same ownership proof, and «Подписки» → «Инструменты» was the only place
 * that offered it. A NUMERIC link is a working one — never offered.
 */
describe('linking over a 2.x id on the card', () => {
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

  async function renderCard(user: ReturnType<typeof userEvent.setup>) {
    vi.spyOn(api, 'get').mockResolvedValue({ data: customer([STALE_SUBSCRIPTION, LINKED_SUBSCRIPTION]) } as never)
    const patch = vi.spyOn(api, 'patch').mockResolvedValue({ data: {} } as never)
    renderWithProviders(<UserDetailPanel telegramId="12345" />)
    await user.click(
      await screen.findByRole('tab', { name: new RegExp(i18n.t('userDetailPanel.tabs.subscriptions')) }),
    )
    // Both cards are on screen before anything is counted.
    await screen.findByText('rz_alice_sub')
    return { patch }
  }

  it('offers «Link» for the 2.x id — and only for it, never over the numeric link', async () => {
    const user = userEvent.setup()
    await renderCard(user)

    const buttons = screen.getAllByRole('button', { name: text('link') })
    expect(buttons).toHaveLength(1)
  })

  it('says the 2.x id is replaced, and sends the link like any other', async () => {
    const user = userEvent.setup()
    const { patch } = await renderCard(user)

    await user.click(screen.getByRole('button', { name: text('link') }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent(
      i18n.t('userDetailPanel.subscriptions.remnawaveProfile.linkReplacesStale', {
        id: STALE_SUBSCRIPTION.remnawaveId,
      }),
    )
    await user.type(within(dialog).getByLabelText(text('linkLabel')), '5150')
    await user.click(within(dialog).getByRole('button', { name: text('linkAction') }))

    expect(patch).toHaveBeenCalledWith('/admin/users/subscriptions/subscription-2x/remnawave-link', {
      remnawaveId: '5150',
      confirmedWithoutProof: false,
    })
  })
})
