import { describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'

import { renderWithProviders } from '@/test/test-utils'
import { BrandingTab, MultiSubTab, PlatformTab } from './settings-page'

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

describe('MultiSubTab accessibility', () => {
  it('names multi-subscription controls', () => {
    renderWithProviders(
      <MultiSubTab
        settings={{
          multiSubscriptionSettings: {
            enabled: true,
            defaultMaxSubscriptions: 3,
          },
        }}
      />,
    )

    expect(screen.getByRole('switch', { name: 'Enable Multi-Subscription' })).toBeInTheDocument()
    expect(screen.getByRole('spinbutton', { name: 'Default Max Subscriptions per User' })).toBeInTheDocument()
  })
})

describe('BrandingTab accessibility', () => {
  it('names branding inputs', () => {
    renderWithProviders(
      <BrandingTab
        settings={{
          platformBranding: {
            projectName: 'Rezeis',
            webTitle: 'Rezeis VPN',
            channelUsername: '@rezeis',
          },
        }}
      />,
    )

    expect(screen.getByRole('textbox', { name: 'Project Name' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Web Title' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Channel Username' })).toBeInTheDocument()
    // The Telegram templates («Верификация», «Сброс пароля») are no longer
    // offered — nothing ever sent them (`settings-page-retired-templates.test.tsx`).
  })
})
