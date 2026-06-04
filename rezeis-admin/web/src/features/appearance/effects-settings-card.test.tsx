import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { loadFeatureBundle } from '@/i18n/i18n'
import { useEffectsStore } from '@/lib/theme/effects-store'
import { renderWithProviders } from '@/test/test-utils'
import { EffectsSettingsCard } from './effects-settings-card'

describe('EffectsSettingsCard accessibility', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    useEffectsStore.getState().reset()
  })

  it('makes the click-effect preview keyboard-operable and named', async () => {
    const user = userEvent.setup()
    await loadFeatureBundle('appearance')

    renderWithProviders(<EffectsSettingsCard />)

    const preview = screen.getByRole('button', { name: 'Preview click effect' })
    expect(preview).toBeInTheDocument()

    preview.focus()
    expect(preview).toHaveFocus()
    await user.keyboard('{Enter}')
  })

  it('makes the hover-effect preview focusable and named', async () => {
    await loadFeatureBundle('appearance')

    renderWithProviders(<EffectsSettingsCard />)

    const preview = screen.getByRole('button', { name: 'Preview hover effect' })
    expect(preview).toBeInTheDocument()

    preview.focus()
    expect(preview).toHaveFocus()
  })

  it('makes the cursor-effect preview keyboard-operable and named', async () => {
    const user = userEvent.setup()
    await loadFeatureBundle('appearance')
    useEffectsStore.getState().setCursorEffect('splash')

    renderWithProviders(<EffectsSettingsCard />)

    const preview = screen.getByRole('button', { name: 'Preview cursor effect' })
    expect(preview).toBeInTheDocument()

    preview.focus()
    expect(preview).toHaveFocus()
    await user.keyboard('{Enter}')
  })
})
