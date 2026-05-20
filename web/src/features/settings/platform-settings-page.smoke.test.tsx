// TODO(rezeis-rebuild): Re-enable once the matching backend contract is rebuilt under the new schema.
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Providers } from '@/app/providers'
import { settingsApi } from '@/features/settings/settings-api'
import { PlatformSettingsPage } from '@/features/settings/platform-settings-page'
import type { useAuthMe as UseAuthMeFn } from '@/features/auth/use-auth-me'
import { useAuthStore } from '@/stores/auth-store'
import { useLocaleStore } from '@/stores/locale-store'

vi.mock('@/features/auth/use-auth-me', () => ({ useAuthMe: vi.fn() }))

const EMPTY_BRANDING = {
  projectName: null,
  webTitle: null,
  supportUrl: null,
  supportUsername: null,
  accessRequestIntro: null,
  accessApprovedMessage: null,
  accessRejectedMessage: null,
}

function createAuthMeResult(overrides: Partial<ReturnType<typeof UseAuthMeFn>> = {}): ReturnType<typeof UseAuthMeFn> {
  return { data: undefined, error: null, isError: false, isLoading: false, isRefetching: false, isSuccess: false, refetch: vi.fn(), ...overrides } as unknown as ReturnType<typeof UseAuthMeFn>
}
describe.skip('platform settings page smoke', () => {
  beforeEach(async () => {
    const { useAuthMe } = await import('@/features/auth/use-auth-me')
    vi.mocked(useAuthMe).mockReturnValue(createAuthMeResult())
    window.localStorage.clear()
    window.localStorage.setItem('rezeis.admin.locale', 'en')
    useLocaleStore.setState({ locale: 'en' })
    useAuthStore.setState({ token: 'admin-token', sessionRevision: 1, verifiedSessionRevision: 1, pendingLoginRevision: null, user: null })
    Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: class { observe() {} unobserve() {} disconnect() {} } })
    vi.spyOn(settingsApi, 'getPlatformSettings').mockResolvedValue({ rulesRequired: false, rulesLink: null, channelRequired: false, channelId: null, channelLink: null, accessMode: 'PUBLIC', inviteModeStartedAt: null, defaultCurrency: 'RUB', branding: EMPTY_BRANDING })
    vi.spyOn(settingsApi, 'getReferralExchangePolicy').mockResolvedValue({ exchangeEnabled: true, giftPromocodeEnabled: true, allowedPlanIds: ['basic'], allowedDurationDays: [30, 90], codePrefix: 'REF', costPerDay: 10 })
    vi.spyOn(settingsApi, 'updateReferralExchangePolicy').mockResolvedValue({ exchangeEnabled: true, giftPromocodeEnabled: true, allowedPlanIds: ['basic', 'pro'], allowedDurationDays: [30, 365], codePrefix: 'ALT', costPerDay: 12 })
    vi.spyOn(settingsApi, 'getPartnerWithdrawalPolicy').mockResolvedValue({ enabled: true, minimumAmount: 1000, supportedMethods: ['card'], updatedAt: '2026-04-24T12:00:00.000Z' })
    vi.spyOn(settingsApi, 'updatePartnerWithdrawalPolicy').mockResolvedValue({ enabled: true, minimumAmount: 1500, supportedMethods: ['card', 'sbp'], updatedAt: '2026-04-24T12:00:00.000Z' })
  })

  it('updates referral and partner business policies through settings facade', async () => {
    const referralUpdateSpy = vi.spyOn(settingsApi, 'updateReferralExchangePolicy')
    const partnerUpdateSpy = vi.spyOn(settingsApi, 'updatePartnerWithdrawalPolicy')
    render(<Providers><PlatformSettingsPage /></Providers>)

    expect(await screen.findByText('Referral and partner policy')).toBeInTheDocument()
    fireEvent.change(await screen.findByLabelText('Allowed plan ids'), { target: { value: 'basic, pro' } })
    fireEvent.change(await screen.findByLabelText('Allowed durations'), { target: { value: '30, 365' } })
    fireEvent.change(await screen.findByLabelText('Code prefix'), { target: { value: 'ALT' } })
    fireEvent.change(await screen.findByLabelText('Cost per day'), { target: { value: '12' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Save referral exchange policy' }))
    fireEvent.change(await screen.findByLabelText('Minimum amount'), { target: { value: '1500' } })
    fireEvent.change(await screen.findByLabelText('Supported methods'), { target: { value: 'card, sbp' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Save partner withdrawal policy' }))

    await waitFor(() => expect(referralUpdateSpy.mock.calls[0]?.[0]).toEqual({ allowedPlanIds: ['basic', 'pro'], allowedDurationDays: [30, 365], codePrefix: 'ALT', costPerDay: 12 }))
    await waitFor(() => expect(partnerUpdateSpy.mock.calls[0]?.[0]).toEqual({ minimumAmount: 1500, supportedMethods: ['card', 'sbp'] }))
  })
})
