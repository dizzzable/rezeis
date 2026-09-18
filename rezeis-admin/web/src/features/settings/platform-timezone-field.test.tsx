import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { renderWithProviders } from '@/test/test-utils'
import { api } from '@/lib/api'
import { i18n } from '@/i18n/i18n'
import { en } from '@/i18n/en'
import { ru } from '@/i18n/ru'

import { listTimeZones, zoneOffsetLabel } from './platform-timezone'
import { PlatformTab } from './settings-page'

/**
 * «Часовой пояс» on Settings → «Платформа», card «Настройки платформы»: the
 * only mounted screen that sets `platformBranding.timezone`, the zone Telegram
 * cards, customer notices, the partner's cabinet and the analytics count in.
 */

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(), patch: vi.fn() },
}))

const toastError = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: toastError } }))

const PLATFORM = {
  accessMode: 'PUBLIC',
  defaultCurrency: 'RUB',
  rulesRequired: false,
  channelRequired: false,
} as const

function platformTab(timezone: string | null) {
  return <PlatformTab settings={{ ...PLATFORM, platformBranding: { projectName: 'Rezeis', timezone } }} />
}

beforeEach(() => {
  i18n.addResourceBundle('ru', 'translation', ru, true, true)
  i18n.addResourceBundle('en', 'translation', en, true, true)
  vi.mocked(api.patch).mockReset()
  vi.mocked(api.patch).mockResolvedValue({ data: {} })
  toastError.mockReset()
})

afterEach(async () => {
  await i18n.changeLanguage('en')
})

describe('«Часовой пояс» on the «Настройки платформы» card', () => {
  it('offers the zones the browser knows, searchable, with «UTC (not set)» first and the time there now — and saves the one chosen', async () => {
    const user = userEvent.setup()
    renderWithProviders(platformTab(null))

    const field = screen.getByRole('combobox', { name: 'Time zone' })
    expect(field).toHaveTextContent('UTC (not set)')
    expect(document.querySelector('[data-platform-timezone-clock]')?.textContent).toMatch(/^It is \d{1,2} \w+ at \d{2}:\d{2} UTC now$/)

    await user.click(field)
    await user.type(screen.getByPlaceholderText('Find a zone: Moscow, Europe/…'), 'Tokyo')
    const tokyo = await screen.findByRole('option', { name: /Asia\/Tokyo/ })
    expect(tokyo).toHaveTextContent('Asia/Tokyo')
    expect(tokyo).toHaveTextContent('UTC+09:00')
    await user.click(tokyo)

    expect(field).toHaveTextContent('Asia/Tokyo · UTC+09:00')
    expect(document.querySelector('[data-platform-timezone-clock]')?.textContent).toMatch(
      /^It is \d{1,2} \w+ at \d{2}:\d{2} there now \(UTC\+09:00\)$/,
    )
    await user.click(screen.getByRole('button', { name: 'Save Platform Settings' }))
    expect(api.patch).toHaveBeenCalledWith(
      '/admin/settings/platform',
      expect.objectContaining({ platformBranding: { timezone: 'Asia/Tokyo' } }),
    )
  })

  it('sends the zone only when the operator changed it — a stored value the save would refuse does not block the rest of the card', async () => {
    const user = userEvent.setup()
    renderWithProviders(platformTab('MSK'))
    await user.click(screen.getByRole('button', { name: 'Save Platform Settings' }))
    expect(api.patch).toHaveBeenCalledTimes(1)
    expect(vi.mocked(api.patch).mock.calls[0]?.[1]).not.toHaveProperty('platformBranding')
  })

  it('warns about a stored zone no list knows: the panel counts in UTC until one is chosen', () => {
    renderWithProviders(platformTab('MSK'))
    expect(document.querySelector('[data-platform-timezone-unknown]')?.textContent).toBe(
      'The saved zone “MSK” is not in the list — times are counted in UTC everywhere. Choose a zone from the list.',
    )
  })

  it('names the server’s refusal in the operator’s words, and lets a name be typed where the list has none', async () => {
    vi.mocked(api.patch).mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 400,
        data: { message: 'PLATFORM_TIMEZONE_NOT_A_ZONE_NAME: platformBranding.timezone "CET" is an abbreviation or an alias, not a zone name; send the zone itself, such as Europe/Brussels' },
      },
    })
    await i18n.changeLanguage('ru')
    const user = userEvent.setup()
    renderWithProviders(platformTab(null))
    await user.click(screen.getByRole('combobox', { name: 'Часовой пояс' }))
    await user.type(screen.getByPlaceholderText('Найти пояс: Moscow, Europe/…'), 'CET')
    await user.click(await screen.findByRole('option', { name: 'Использовать «CET»' }))
    await user.click(screen.getByRole('button', { name: 'Сохранить настройки платформы' }))
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        '«CET» — сокращение или устаревшее имя, а не пояс. Выберите сам пояс из списка — например, Europe/Brussels вместо CET.',
      ),
    )
  })

  it('says it in Russian, and its (i) names every place the zone reaches', async () => {
    await i18n.changeLanguage('ru')
    const user = userEvent.setup()
    renderWithProviders(platformTab(null))
    expect(screen.getByRole('combobox', { name: 'Часовой пояс' })).toHaveTextContent('UTC (не задан)')
    expect(document.querySelector('[data-platform-timezone-clock]')?.textContent).toMatch(/^Сейчас по UTC \d{1,2} [а-я]+ в \d{2}:\d{2}$/)
    await user.click(screen.getByRole('button', { name: 'Что зависит от часового пояса' }))
    const [tip] = await screen.findAllByText(/В этом поясе панель пишет время/)
    expect(tip?.textContent).toContain('в карточках событий, которые приходят в чат из «Уведомления → Доставка в Telegram»')
    expect(tip?.textContent).toContain('когда кончается подписка («Уведомления → Уведомления пользователям»)')
    expect(tip?.textContent).toContain('в кабинете партнёра — до какого часа заморожен баланс')
    expect(tip?.textContent).toContain('«Аналитика» и «Платежи → Аналитика» считают, какие сутки — один день')
    expect(tip?.textContent).toContain('Не задан — везде UTC.')
  })
})

describe('the list itself', () => {
  it('is the browser’s own, UTC aside, and every zone in it carries its offset', () => {
    const zones = listTimeZones()
    expect(zones).not.toBeNull()
    expect(zones).toContain('Europe/Moscow')
    expect(zones).not.toContain('UTC')
    const at = new Date('2026-07-01T12:00:00Z')
    expect(zoneOffsetLabel('Europe/Moscow', at)).toBe('UTC+03:00')
    expect(zoneOffsetLabel('America/New_York', at)).toBe('UTC-04:00')
    expect(zoneOffsetLabel('Mars/Olympus_Mons', at)).toBeNull()
    for (const zone of zones ?? []) expect(zoneOffsetLabel(zone, at), zone).not.toBeNull()
  })
})
