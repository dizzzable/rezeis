import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { renderWithProviders } from '@/test/test-utils'
import { api } from '@/lib/api'
import { i18n } from '@/i18n/i18n'
import { en } from '@/i18n/en'
import { ru } from '@/i18n/ru'

import { instantToLocalInput, localInputToInstant } from './channel-new-users'
import { PlatformTab } from './settings-page'

/**
 * «Проверять только новых» on Settings → «Платформа», card «Настройки
 * платформы». One stored instant is the whole feature: NULL asks every account
 * to subscribe, a moment asks only accounts created at or after it.
 */

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(), patch: vi.fn() },
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const PLATFORM = {
  accessMode: 'PUBLIC',
  defaultCurrency: 'RUB',
  rulesRequired: false,
  channelRequired: true,
  channelLink: 'https://t.me/rezeis',
} as const

function savedPayload(): Record<string, unknown> {
  const call = vi.mocked(api.patch).mock.calls[0]
  if (call === undefined) throw new Error('the card saved nothing')
  return call[1] as Record<string, unknown>
}

beforeEach(() => {
  i18n.addResourceBundle('ru', 'translation', ru, true, true)
  i18n.addResourceBundle('en', 'translation', en, true, true)
  vi.mocked(api.patch).mockReset()
  vi.mocked(api.patch).mockResolvedValue({ data: {} })
})

afterEach(async () => {
  await i18n.changeLanguage('en')
})

describe('«Проверять только новых»', () => {
  it('starts from now when switched on, and saves that moment', async () => {
    const user = userEvent.setup()
    const before = Date.now()
    renderWithProviders(<PlatformTab settings={{ ...PLATFORM, channelNewUsersSince: null }} />)

    const toggle = screen.getByRole('switch', { name: 'Check new users only' })
    expect(toggle).not.toBeChecked()
    // No date to edit while it is off: the date IS the switch.
    expect(screen.queryByLabelText('Check accounts registered from')).toBeNull()

    await user.click(toggle)
    expect(toggle).toBeChecked()
    expect(screen.getByLabelText('Check accounts registered from')).toHaveValue(
      instantToLocalInput(new Date(before).toISOString()),
    )

    await user.click(screen.getByRole('button', { name: 'Save Platform Settings' }))
    const saved = savedPayload()['channelNewUsersSince']
    expect(typeof saved).toBe('string')
    // «Now», to the minute the input can hold: everyone already here stays in.
    const savedMs = Date.parse(saved as string)
    expect(savedMs).toBeGreaterThanOrEqual(Math.floor(before / 60_000) * 60_000)
    expect(savedMs).toBeLessThanOrEqual(Date.now())
  })

  it('shows a stored moment and saves NULL when switched off', async () => {
    // ANTI-VACUITY for the one above. Off must reach the server as `null` —
    // a card that just stopped sending the field would leave the old moment
    // in place, and the switch could never be turned off.
    const user = userEvent.setup()
    renderWithProviders(
      <PlatformTab settings={{ ...PLATFORM, channelNewUsersSince: '2026-09-01T09:30:00.000Z' }} />,
    )
    const toggle = screen.getByRole('switch', { name: 'Check new users only' })
    expect(toggle).toBeChecked()
    expect(screen.getByLabelText('Check accounts registered from')).toHaveValue(
      instantToLocalInput('2026-09-01T09:30:00.000Z'),
    )

    await user.click(toggle)
    await user.click(screen.getByRole('button', { name: 'Save Platform Settings' }))
    expect(savedPayload()['channelNewUsersSince']).toBeNull()
  })

  it('keeps a stored moment unchanged through a save of the rest of the card', async () => {
    // The input holds minutes; the column holds milliseconds. A moment the
    // panel set on the minute must survive an unrelated save byte for byte.
    const user = userEvent.setup()
    renderWithProviders(
      <PlatformTab settings={{ ...PLATFORM, channelNewUsersSince: '2026-09-01T09:30:00.000Z' }} />,
    )
    await user.click(screen.getByRole('button', { name: 'Save Platform Settings' }))
    expect(savedPayload()['channelNewUsersSince']).toBe('2026-09-01T09:30:00.000Z')
  })

  it('keeps the field while the date is retyped, and will not save half a date', async () => {
    // A `datetime-local` input reports '' the moment one part of it is cleared.
    // With the switch read off that value, Backspace in the day turned the
    // check off and took the field away mid-edit, and a save then stored NULL —
    // «ask everyone» — under a switch the operator had left on.
    const user = userEvent.setup()
    renderWithProviders(
      <PlatformTab settings={{ ...PLATFORM, channelNewUsersSince: '2026-09-01T09:30:00.000Z' }} />,
    )
    fireEvent.change(screen.getByLabelText('Check accounts registered from'), { target: { value: '' } })

    expect(screen.getByRole('switch', { name: 'Check new users only' })).toBeChecked()
    expect(screen.getByLabelText('Check accounts registered from')).toBeInTheDocument()
    expect(screen.getByText(/Enter the full date and time/)).toBeInTheDocument()
    const save = screen.getByRole('button', { name: 'Save Platform Settings' })
    expect(save).toBeDisabled()

    fireEvent.change(screen.getByLabelText('Check accounts registered from'), {
      target: { value: '2026-10-01T12:00' },
    })
    expect(save).toBeEnabled()
    expect(screen.queryByText(/Enter the full date and time/)).toBeNull()
    await user.click(save)
    expect(savedPayload()['channelNewUsersSince']).toBe(localInputToInstant('2026-10-01T12:00'))
  })

  it('is not offered while «Канал обязателен» is off', () => {
    renderWithProviders(<PlatformTab settings={{ ...PLATFORM, channelRequired: false }} />)
    expect(screen.queryByRole('switch', { name: 'Check new users only' })).toBeNull()
  })

  it('speaks Russian on a Russian panel', async () => {
    await i18n.changeLanguage('ru')
    renderWithProviders(<PlatformTab settings={{ ...PLATFORM, channelNewUsersSince: null }} />)
    expect(screen.getByRole('switch', { name: 'Проверять только новых' })).toBeInTheDocument()
  })
})

describe('the two shapes of the moment', () => {
  it('round-trips an instant on the minute through the input unchanged', () => {
    const iso = '2026-09-22T06:15:00.000Z'
    expect(localInputToInstant(instantToLocalInput(iso))).toBe(iso)
  })

  it('reads empty and unreadable values as OFF, never as a date', () => {
    expect(instantToLocalInput(null)).toBe('')
    expect(instantToLocalInput(undefined)).toBe('')
    expect(instantToLocalInput('not a date')).toBe('')
    expect(localInputToInstant('')).toBeNull()
    expect(localInputToInstant('garbage')).toBeNull()
  })
})
