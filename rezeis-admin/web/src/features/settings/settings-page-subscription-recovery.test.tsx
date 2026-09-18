import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { renderWithProviders } from '@/test/test-utils'
import { api } from '@/lib/api'
import { usePermissionStore } from '@/features/rbac'
import { i18n } from '@/i18n/i18n'
import { en } from '@/i18n/en'
import { ru } from '@/i18n/ru'

import { BrandingTab, RECOVERY_WITHDRAWAL_HOLD_HOURS } from './settings-page'

/**
 * «Восстановление пароля по ссылке подписки» — the operator's switch in the
 * Branding card of Settings, next to the cabinet's other sign-in policy.
 */

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(), patch: vi.fn() },
}))

function grant(tokens: readonly string[]): void {
  usePermissionStore.setState({
    loaded: true,
    loading: false,
    granted: new Set(tokens),
    mustChangePassword: false,
    // Not 'DEV': that role short-circuits every check.
    role: 'ADMIN',
    rbacRoleId: null,
    error: null,
  })
}

const SWITCH = 'Password recovery by subscription link'
const INFO = 'About password recovery by subscription link'

beforeEach(() => {
  vi.mocked(api.patch).mockReset()
  vi.mocked(api.patch).mockResolvedValue({ data: {} })
})

afterEach(() => {
  grant([])
})

describe('Settings → Branding: recovery by subscription link', () => {
  it('is ON when the stored settings say nothing, and saves the operator’s OFF', async () => {
    grant(['settings:view', 'settings:edit'])
    const user = userEvent.setup()
    renderWithProviders(<BrandingTab settings={{ platformBranding: { projectName: 'Rezeis' } }} />)

    const toggle = screen.getByRole('switch', { name: SWITCH })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    await user.click(screen.getByRole('button', { name: 'Save Branding' }))

    expect(api.patch).toHaveBeenCalledTimes(1)
    expect(api.patch).toHaveBeenCalledWith('/admin/settings/platform', {
      platformBranding: expect.objectContaining({ subscriptionLinkRecovery: false, projectName: 'Rezeis' }),
    })
  })

  it('shows a stored OFF as OFF', () => {
    grant(['settings:view', 'settings:edit'])
    renderWithProviders(<BrandingTab settings={{ platformBranding: { subscriptionLinkRecovery: false } }} />)
    expect(screen.getByRole('switch', { name: SWITCH })).toHaveAttribute('aria-checked', 'false')
  })

  it('sends nothing without settings:edit — the switch and the save are disabled', async () => {
    grant(['settings:view'])
    const user = userEvent.setup()
    renderWithProviders(<BrandingTab settings={{ platformBranding: {} }} />)

    const toggle = screen.getByRole('switch', { name: SWITCH })
    const save = screen.getByRole('button', { name: 'Save Branding' })
    expect(toggle).toBeDisabled()
    expect(save).toBeDisabled()
    await user.click(toggle)
    await user.click(save)
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    expect(api.patch).not.toHaveBeenCalled()
  })

  it('explains the trade-off behind the (i)', async () => {
    grant(['settings:view', 'settings:edit'])
    const user = userEvent.setup()
    renderWithProviders(<BrandingTab settings={{ platformBranding: {} }} />)

    await user.click(screen.getByRole('button', { name: INFO }))

    const [tip] = await screen.findAllByText(/Anyone else who has that link can do the same/)
    expect(tip.textContent).toContain('pasting the subscription link from their VPN app')
    // The whole balance, not only withdrawals: paying with it is held too.
    expect(tip.textContent).toContain('the partner balance is held for 72 hours')
    expect(tip.textContent).toContain('neither withdrawn nor used to pay for a subscription')
    expect(tip.textContent).toContain('Operators get a notice')
  })
})

describe('the (i) in both languages', () => {
  beforeEach(() => {
    i18n.addResourceBundle('ru', 'translation', ru, true, true)
    i18n.addResourceBundle('en', 'translation', en, true, true)
  })

  it('states the same three facts, with the hours as a real plural', () => {
    expect(RECOVERY_WITHDRAWAL_HOLD_HOURS).toBe(72)
    const key = 'settingsPage.branding.subscriptionLinkRecoveryInfo'
    const russian = i18n.t(key, { lng: 'ru', count: RECOVERY_WITHDRAWAL_HOLD_HOURS })
    const english = i18n.t(key, { lng: 'en', count: RECOVERY_WITHDRAWAL_HOLD_HOURS })

    expect(russian).toContain('вставив ссылку на подписку из своего VPN-приложения')
    expect(russian).toContain('То же сможет сделать любой, у кого есть эта ссылка')
    expect(russian).toContain(
      'партнёрский баланс замораживается на 72 часа: с него нельзя ни вывести деньги, ни оплатить подписку',
    )
    expect(russian).toContain('Операторам приходит уведомление')
    expect(english).toContain('Anyone else who has that link can do the same')
    expect(english).toContain(
      'the partner balance is held for 72 hours: it can be neither withdrawn nor used to pay for a subscription',
    )
    expect(english).toContain('Operators get a notice')

    expect(i18n.t(key, { lng: 'ru', count: 1 })).toContain('на 1 час:')
    expect(i18n.t(key, { lng: 'ru', count: 5 })).toContain('на 5 часов:')
    expect(i18n.t(key, { lng: 'en', count: 1 })).toContain('for 1 hour:')
    expect(i18n.t('settingsPage.branding.subscriptionLinkRecovery', { lng: 'ru' })).toBe(
      'Восстановление пароля по ссылке подписки',
    )
    expect(i18n.t('settingsPage.branding.subscriptionLinkRecovery', { lng: 'en' })).toBe(SWITCH)
  })
})
