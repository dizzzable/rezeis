import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { renderWithProviders } from '@/test/test-utils'
import { api } from '@/lib/api'
import { usePermissionStore } from '@/features/rbac'

import { BrandingTab } from './settings-page'

/**
 * «Верификация (RU/EN)» and «Сброс пароля (RU/EN)» — four template fields in
 * Settings → Branding that nothing ever sent: a password reset goes out as a
 * link with the bot's own text, an e-mail code with the e-mail's own. An
 * operator could fill them in and wait for customers to see them, so the card
 * no longer offers them and no longer sends them back.
 *
 * What an install stored is not erased (the panel keeps it in `platformPolicy`
 * untouched, `settings-retired-telegram-templates.spec.ts`). Here: a stored
 * value is neither shown nor carried into the next save.
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
    role: 'ADMIN',
    rbacRoleId: null,
    error: null,
  })
}

/**
 * The branding an older panel answers with — both retired templates still in
 * it. A variable rather than a literal at the prop: the card's own type no
 * longer knows the field, which is the point.
 */
const STORED = {
  platformBranding: {
    projectName: 'Rezeis',
    verification: {
      telegramTemplate: { ru: 'СТАРЫЙ КОД ВЕРИФИКАЦИИ', en: 'OLD VERIFICATION CODE' },
      passwordResetTelegramTemplate: { ru: 'СТАРЫЙ ШАБЛОН СБРОСА', en: 'OLD RESET TEMPLATE' },
    },
  },
}

const RETIRED_FIELDS = ['Verification (RU)', 'Verification (EN)', 'Password Reset (RU)', 'Password Reset (EN)']
const RETIRED_VALUES = ['СТАРЫЙ КОД ВЕРИФИКАЦИИ', 'OLD VERIFICATION CODE', 'СТАРЫЙ ШАБЛОН СБРОСА', 'OLD RESET TEMPLATE']

beforeEach(() => {
  vi.mocked(api.patch).mockReset()
  vi.mocked(api.patch).mockResolvedValue({ data: {} })
  grant(['settings:view', 'settings:edit'])
})

afterEach(() => {
  grant([])
})

describe('Settings → Branding: the retired Telegram templates', () => {
  it('are not offered, and a stored one is not shown', () => {
    renderWithProviders(<BrandingTab settings={STORED} />)

    for (const name of RETIRED_FIELDS) {
      expect(screen.queryByRole('textbox', { name }), name).not.toBeInTheDocument()
    }
    for (const value of RETIRED_VALUES) {
      expect(screen.queryByDisplayValue(value), value).not.toBeInTheDocument()
    }
    expect(screen.queryByText('Verification Templates')).not.toBeInTheDocument()
    // The card itself still works: the fields it keeps are there.
    expect(screen.getByRole('textbox', { name: 'Project Name' })).toHaveValue('Rezeis')
  })

  it('are not sent back with a save', async () => {
    const user = userEvent.setup()
    renderWithProviders(<BrandingTab settings={STORED} />)

    await user.click(screen.getByRole('button', { name: 'Save Branding' }))

    expect(api.patch).toHaveBeenCalledTimes(1)
    const [url, body] = vi.mocked(api.patch).mock.calls[0]!
    expect(url).toBe('/admin/settings/platform')
    const branding = (body as { platformBranding: Record<string, unknown> }).platformBranding
    expect(Object.keys(branding)).not.toContain('verification')
    expect(branding['projectName']).toBe('Rezeis')
  })
})
