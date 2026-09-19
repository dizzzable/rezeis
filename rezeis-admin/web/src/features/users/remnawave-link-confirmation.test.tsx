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

function customer() {
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
    subscriptions: [UNLINKED_SUBSCRIPTION],
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

  it('says when the tick is needed and what it can never override', async () => {
    const user = userEvent.setup()
    const { dialog } = await openLinkDialog(user)

    const checkbox = within(dialog).getByRole('checkbox', { name: text('confirmWithoutProof') })
    expect(checkbox).toHaveAccessibleDescription(/verified web-account e-mail/)
    expect(checkbox).toHaveAccessibleDescription(/naming another customer refuses the link whatever you confirm/)
  })
})
