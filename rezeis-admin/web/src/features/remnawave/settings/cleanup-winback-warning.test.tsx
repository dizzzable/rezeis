/**
 * «Очистка профилей при истечении» says which «Возврат покупателя» reminders
 * its values would cut short — as typed, before saving — and stays quiet when
 * none would be (the owner, 15.10.2026: «либо 15 дней надо выставить либо
 * выключить данный функционал»).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { api } from '@/lib/api'
import { i18nReady, loadFeatureBundle } from '@/i18n/i18n'
import { renderWithProviders } from '@/test/test-utils'
import { SettingsTab } from './settings-tab'

const MESSAGE = /Win-back reminders \(.*\) will not arrive/

let cleanupServed = false

function serve(userNotifications: Record<string, boolean>, cleanup: { deleteEnabled: boolean; graceDays: number }) {
  cleanupServed = false
  vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    if (path === '/admin/settings') return { data: { userNotifications } }
    if (path === '/admin/settings/remnawave-cleanup') {
      cleanupServed = true
      return { data: cleanup }
    }
    throw new Error(`not served here: ${path}`)
  })
}

const warning = (): HTMLElement | null => screen.queryByText(MESSAGE)

beforeAll(async () => {
  await i18nReady
  await loadFeatureBundle('remnawave')
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('«Очистка профилей при истечении» and «Возврат покупателя»', () => {
  it('names the reminder 3 days would cut short, and asks for 15', async () => {
    serve({ expired_14_days_ago: true }, { deleteEnabled: true, graceDays: 3 })
    renderWithProviders(<SettingsTab />)

    const message = await screen.findByText(MESSAGE)
    expect(message).toHaveTextContent('after 14 days')
    expect(message).toHaveTextContent('at least 15')
  })

  it('reads the days as typed: 15 is enough, before anything is saved', async () => {
    const user = userEvent.setup()
    serve({ expired_14_days_ago: true }, { deleteEnabled: true, graceDays: 3 })
    renderWithProviders(<SettingsTab />)
    await screen.findByText(MESSAGE)

    const days = screen.getByLabelText('Delete after (days past expiry)', { exact: false })
    await user.clear(days)
    await user.type(days, '15')
    await waitFor(() => expect(warning()).toBeNull())
  })

  it('stays quiet while no reminder is switched on', async () => {
    serve({}, { deleteEnabled: true, graceDays: 3 })
    renderWithProviders(<SettingsTab />)
    await waitFor(() => expect(cleanupServed).toBe(true))
    await screen.findByDisplayValue('3')
    expect(warning()).toBeNull()
  })

  it('stays quiet when the deletion is off', async () => {
    serve({ expired_14_days_ago: true }, { deleteEnabled: false, graceDays: 3 })
    renderWithProviders(<SettingsTab />)
    await waitFor(() => expect(cleanupServed).toBe(true))
    await screen.findByDisplayValue('3')
    expect(warning()).toBeNull()
  })
})
