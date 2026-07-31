import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { loadFeatureBundle } from '@/i18n/i18n'
import { useThemeStore } from '@/lib/theme/theme-store'
import { renderWithProviders } from '@/test/test-utils'
import AppearancePage from './appearance-page'

describe('AppearancePage presets', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    localStorage.clear()
    useThemeStore.getState().reset()
  })

  it('preserves persisted operator CSS when another preset is selected', async () => {
    const user = userEvent.setup()
    const customCss = ':root { --primary: oklch(0.72 0.18 145); }'
    await loadFeatureBundle('appearance')
    useThemeStore.getState().setCustomCss(customCss)

    renderWithProviders(<AppearancePage />)
    await user.click(screen.getByRole('button', { name: 'Blue' }))

    expect(useThemeStore.getState()).toMatchObject({
      presetId: 'blue',
      customCss,
    })
    expect(
      JSON.parse(localStorage.getItem('rezeis-admin-theme') ?? '{}'),
    ).toMatchObject({
      state: {
        presetId: 'blue',
        customCss,
      },
      version: 2,
    })
  })
})
