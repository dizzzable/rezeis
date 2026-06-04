import { describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'

import { renderWithProviders } from '@/test/test-utils'
import { PlatformTab } from './settings-page'

describe('PlatformTab accessibility', () => {
  it('names compact platform settings controls', () => {
    renderWithProviders(
      <PlatformTab
        settings={{
          accessMode: 'PUBLIC',
          defaultCurrency: 'RUB',
          rulesRequired: true,
          rulesLink: 'https://example.com/rules',
          channelRequired: true,
          channelLink: 'https://t.me/rezeis',
          channelId: '-1001234567890',
        }}
      />,
    )

    expect(screen.getByRole('combobox', { name: 'Access Mode' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Default Currency' })).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Rules Required' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Rules Link' })).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Channel Required' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Channel Link' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Channel ID' })).toBeInTheDocument()
  })
})
