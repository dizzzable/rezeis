/**
 * What the bot adds to its main menu by itself, in the menu's inspector on
 * «Карта бота».
 *
 * reiwa builds the greeting's keyboard from the operator's buttons AND puts a
 * trial button on top for a customer with no active subscription while a trial
 * is on offer (`start.ts` → `resolveTrialButton` → `buildMainKeyboard`): «Попробовать
 * бесплатно», or «Попробовать за {{price}}» for a paid trial. Neither caption
 * was anywhere on the map, and neither were the texts the bot writes around the
 * greeting: its fallback when the greeting is empty and the subscription lines
 * under it.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'

import { api } from '@/lib/api'
import { i18n, loadFeatureBundle } from '@/i18n/i18n'
import { emojiStudioPayload, packsPayload } from '@/features/custom-emoji/emoji-catalog.fixtures'
import { renderWithProviders } from '@/test/test-utils'

import { MainMenuSystemPanel } from './MainMenuSystemPanel'

function mockTextsApi(texts: Readonly<Record<string, string>> = {}): void {
  vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    if (path === '/admin/bot-config/texts') {
      return {
        data: Object.entries(texts).map(([key, value], index) => ({
          id: `text-${index}`,
          key,
          value,
          visible: true,
          valueEn: null,
          createdAt: '2026-09-23T00:00:00.000Z',
          updatedAt: '2026-09-23T00:00:00.000Z',
        })),
      }
    }
    if (path === '/admin/custom-emoji/packs') return packsPayload([])
    if (path === '/admin/bot-config/emoji-studio') return emojiStudioPayload()
    return { data: [] }
  })
}

// What the route loads with the page: part of these words live in it.
beforeAll(async () => {
  await loadFeatureBundle('botMap')
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the main menu’s own buttons', () => {
  it('lists the trial button in both its forms, each editing the caption the bot reads, and when it shows', async () => {
    mockTextsApi({ 'menu.btn_trial_free': 'Free caption', 'menu.btn_trial_paid': 'Paid caption {{price}}' })
    renderWithProviders(<MainMenuSystemPanel />)

    const region = screen.getByRole('region', { name: i18n.t('botFlow.mainMenu.title') })
    const free = within(region).getByRole('group', { name: i18n.t('botFlow.systemButtons.mainMenu.trial') })
    const paid = within(region).getByRole('group', { name: i18n.t('botFlow.systemButtons.mainMenu.trialPaid') })
    expect(await within(free).findByDisplayValue('Free caption')).toBeInTheDocument()
    expect(await within(paid).findByDisplayValue('Paid caption {{price}}')).toBeInTheDocument()
    expect(within(free).getByText(i18n.t('botFlow.systemButtons.conditions.trial'))).toBeInTheDocument()
    expect(within(paid).getByText(i18n.t('botFlow.systemButtons.conditions.trialPaid'))).toBeInTheDocument()
    // Its icon is the emoji registry's, not a system-button slot.
    expect(within(free).queryByRole('button', { name: 'Custom Emoji ID' })).toBeNull()
  })
})

describe('the texts the bot writes around the greeting', () => {
  it.each([
    'bot.welcome_message',
    'menu.choose_action',
    'profile.subscription',
    'profile.devices',
    'profile.devices_unlimited',
    'profile.traffic',
    // The second traffic line of an объединённая подписка — its own key, so it
    // can be renamed («Обходы») without touching the line above it.
    'profile.traffic_extra',
    'profile.unlimited',
    'profile.until',
    'common.not_available',
    // «Меню обновилось» over the menu, for an old button (24.09.2026).
    'menu.updated',
  ])('lists %s', async (key) => {
    mockTextsApi()
    renderWithProviders(<MainMenuSystemPanel />)

    expect(await screen.findByText(key)).toBeInTheDocument()
  })

  it('says when the greeting’s fallback and the subscription lines are shown', async () => {
    mockTextsApi()
    renderWithProviders(<MainMenuSystemPanel />)

    expect(await screen.findByText(i18n.t('botFlow.screenTexts.captions.welcomeMessage'))).toBeInTheDocument()
    expect(screen.getByText(i18n.t('botFlow.screenTexts.captions.chooseAction'))).toBeInTheDocument()
    // One caption for the whole block of subscription lines, above each of them
    // (eight now: the merged subscription's extra traffic line is one of them).
    expect(screen.getAllByText(i18n.t('botFlow.screenTexts.captions.subscriptionLine'))).toHaveLength(8)
    // The pop-up an old button gets says when it is shown: its key says nothing.
    const staleCaption = i18n.t('botFlow.screenTexts.captions.menuUpdated')
    expect(staleCaption).not.toBe('botFlow.screenTexts.captions.menuUpdated')
    expect(screen.getByText(staleCaption)).toBeInTheDocument()
  })
})

describe('the extra «Трафик доп.» caption of a merged subscription', () => {
  it('edits the caption of the first extra line and offers no «+» windows', async () => {
    mockTextsApi({ 'profile.traffic_extra': 'Обходы' })
    renderWithProviders(<MainMenuSystemPanel />)

    // The 2nd tariff's line is captioned by the base key, which is always shown.
    expect(await screen.findByText('profile.traffic_extra')).toBeInTheDocument()
    expect(await screen.findByDisplayValue('Обходы')).toBeInTheDocument()
    // Per-tariff captions from the third tariff on moved to the merged-tariff
    // card, so the bot map holds no «+» window machinery any more.
    expect(screen.queryByText('profile.traffic_extra_2')).toBeNull()
    expect(
      screen.queryByRole('button', { name: /Добавить подпись|Add a caption/ }),
    ).toBeNull()
  })
})
