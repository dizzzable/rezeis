/**
 * «ВЫДАТЬ ПОДПИСКУ» CAN HAND OUT A WHOLE BUNDLE.
 *
 * A merged subscription is one link over several plans, and before this the
 * dialog could only name ONE plan: an operator who wanted the merge had to
 * remember which plans the grouping holds, grant them one by one, and then had
 * no way to read the merged link — the panel only ever printed the per-profile
 * Remnawave URL (the cabinet minted the link and the operator never saw it).
 *
 * These cases drive the real dialog through the real Radix Selects: switch to
 * the bundle mode, pick a bundle, and read what the panel sends and what it
 * shows afterwards. The bundle's plan names are part of the option row on
 * purpose — a grouping is named by the operator, and «Double» alone says
 * nothing about what the customer is about to receive.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { usePermissionStore } from '@/features/rbac'
import { i18n, loadFeatureBundle } from '@/i18n/i18n'
import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'

import UserDetailPanel from './user-detail-panel'

const MERGE_URL = 'https://stin.cloudre.store/merge/tok123'

const PLANS = [
  { id: 'plan-base', name: 'Base', trafficLimit: 100, isArchived: false },
  { id: 'plan-plus', name: 'Plus', trafficLimit: null, isArchived: false },
  // The tariff a bundle is issued as: a normal plan row with a `bundle` mark.
  {
    id: 'plan-double',
    name: 'Double',
    trafficLimit: 50,
    isArchived: false,
    bundle: { id: 'bundle-1', name: 'Double' },
  },
]

const BUNDLES = [
  {
    id: 'bundle-1',
    name: 'Double',
    description: null,
    isActive: true,
    orderIndex: 1,
    planIds: ['plan-base', 'plan-plus'],
    planId: 'plan-double',
    deviceLimit: 2,
    visiblePlanId: 'plan-base',
    createdAt: '2026-06-04T10:00:00.000Z',
    updatedAt: '2026-06-04T10:00:00.000Z',
  },
  {
    id: 'bundle-off',
    name: 'Retired',
    description: null,
    isActive: false,
    orderIndex: 2,
    planIds: ['plan-base', 'plan-plus'],
    planId: 'plan-retired',
    deviceLimit: 1,
    visiblePlanId: 'plan-base',
    createdAt: '2026-06-04T10:00:00.000Z',
    updatedAt: '2026-06-04T10:00:00.000Z',
  },
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
  subscriptions: [],
  transactions: [],
  referralsGiven: [],
  partner: null,
  webAccount: null,
}

const t = (key: string): string => i18n.t(key) as string

async function openGiveDialog() {
  const user = userEvent.setup()
  vi.spyOn(api, 'get').mockImplementation((url: string) => {
    if (url === '/admin/plans') return Promise.resolve({ data: PLANS })
    if (url === '/admin/plan-bundles') return Promise.resolve({ data: BUNDLES })
    return Promise.resolve({ data: USER })
  })

  renderWithProviders(<UserDetailPanel telegramId="12345" />)
  await user.click(
    await screen.findByRole('tab', { name: new RegExp(t('userDetailPanel.tabs.subscriptions')) }),
  )
  await user.click(
    await screen.findByRole('button', { name: t('userDetailPanel.subscriptions.giveSub') }),
  )
  return user
}

async function switchToBundleMode(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    await screen.findByRole('combobox', { name: t('userDetailPanel.subscriptions.giveMode') }),
  )
  await user.click(
    await screen.findByRole('option', { name: t('userDetailPanel.subscriptions.giveModeBundle') }),
  )
}

describe('the give-subscription dialog can issue a merged subscription', () => {
  // Radix's Select drives itself with Pointer Events APIs jsdom does not
  // implement; vitest isolates per file, so this prototype patch does not leak.
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

  it('issues one subscription per plan of the bundle and shows the merged link', async () => {
    const user = await openGiveDialog()
    const postSpy = vi.spyOn(api, 'post').mockResolvedValue({
      data: { mergeUrl: MERGE_URL, subscriptions: [], bundle: { id: 'bundle-1', name: 'Double' } },
    })

    await switchToBundleMode(user)
    await user.click(
      await screen.findByRole('combobox', { name: t('userDetailPanel.subscriptions.bundle') }),
    )
    // The option row names the bundle AND its plans: the grouping's own name is
    // the operator's label, not a description of what the customer receives.
    await user.click(await screen.findByRole('option', { name: /Double — Base \+ Plus/ }))
    await user.click(
      screen.getByRole('button', { name: t('userDetailPanel.subscriptions.giveBundle') }),
    )

    expect(postSpy).toHaveBeenCalledWith('/admin/users/12345/give-bundle-subscription', {
      bundleId: 'bundle-1',
      durationDays: 30,
    })

    // The dialog stays open on the link: it is the one thing the operator needs
    // from this screen, and a toast is a worse place to lose it.
    expect(await screen.findByDisplayValue(MERGE_URL)).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: t('userDetailPanel.subscriptions.mergeLinkCopy') }),
    ).toBeInTheDocument()
    expect(screen.getByText(t('userDetailPanel.subscriptions.bundleGranted'))).toBeInTheDocument()
  })

  it('never offers a switched-off bundle', async () => {
    const user = await openGiveDialog()
    await switchToBundleMode(user)
    await user.click(
      await screen.findByRole('combobox', { name: t('userDetailPanel.subscriptions.bundle') }),
    )

    const options = await screen.findAllByRole('option')
    expect(options.map((option) => option.textContent)).toEqual(['Double — Base + Plus'])
  })

  it('says so instead of rendering an empty picker when there is no active bundle', async () => {
    vi.spyOn(api, 'get').mockImplementation((url: string) => {
      if (url === '/admin/plans') return Promise.resolve({ data: PLANS })
      if (url === '/admin/plan-bundles') return Promise.resolve({ data: [] })
      return Promise.resolve({ data: USER })
    })
    const user = userEvent.setup()
    renderWithProviders(<UserDetailPanel telegramId="12345" />)
    await user.click(
      await screen.findByRole('tab', { name: new RegExp(t('userDetailPanel.tabs.subscriptions')) }),
    )
    await user.click(
      await screen.findByRole('button', { name: t('userDetailPanel.subscriptions.giveSub') }),
    )
    await switchToBundleMode(user)

    expect(await screen.findByText(t('userDetailPanel.subscriptions.noBundles'))).toBeInTheDocument()
    expect(
      screen.queryByRole('combobox', { name: t('userDetailPanel.subscriptions.bundle') }),
    ).toBeNull()
  })

  it('shows the merged link when a bundle’s tariff is granted through the ordinary picker', async () => {
    const user = await openGiveDialog()
    const postSpy = vi.spyOn(api, 'post').mockResolvedValue({
      data: { id: 'sub-1', mergeUrl: MERGE_URL },
    })

    await user.click(
      await screen.findByRole('combobox', { name: t('userDetailPanel.subscriptions.plan') }),
    )
    await user.click(await screen.findByRole('option', { name: /Double — merged/ }))
    await user.click(screen.getByRole('button', { name: t('userDetailPanel.subscriptions.give') }))

    expect(postSpy).toHaveBeenCalledWith('/admin/users/12345/give-subscription', {
      planId: 'plan-double',
      durationDays: 30,
      isTrial: false,
    })
    // The merged link rides on the same answer — the operator must not have to
    // open the cabinet to learn it.
    expect(await screen.findByDisplayValue(MERGE_URL)).toBeInTheDocument()
  })

  it('keeps the single-plan grant exactly as it was', async () => {
    const user = await openGiveDialog()
    const postSpy = vi.spyOn(api, 'post').mockResolvedValue({ data: { id: 'sub-1' } })

    await user.click(
      await screen.findByRole('combobox', { name: t('userDetailPanel.subscriptions.plan') }),
    )
    await user.click(await screen.findByRole('option', { name: 'Base' }))
    await user.click(screen.getByRole('button', { name: t('userDetailPanel.subscriptions.give') }))

    expect(postSpy).toHaveBeenCalledWith('/admin/users/12345/give-subscription', {
      planId: 'plan-base',
      durationDays: 30,
      isTrial: false,
    })
    expect(
      screen.queryByRole('button', { name: t('userDetailPanel.subscriptions.giveBundle') }),
    ).toBeNull()
  })
})
