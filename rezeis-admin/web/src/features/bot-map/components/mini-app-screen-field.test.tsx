/**
 * A «Mini App» button's page, as the operator sets it.
 *
 * A tester set «Пригласить» to open the referral program: action «Mini App»,
 * and a box asking for «Полный https:// URL Mini App». The Mini App opened on
 * its home screen — where every path the cabinet has no page for lands. The
 * box is a list of the cabinet's pages now, in every form a Mini App button is
 * set in; these cases are the ways that can go wrong again.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { i18n, i18nReady, loadFeatureBundle } from '@/i18n/i18n'
import { renderWithProviders } from '@/test/test-utils'

import { ActionFields } from '@/features/bot-config/bot-button-dialogs'
import * as botMapApi from '../bot-map-api'
import type { BotMapPayload, MiniAppScreen, NotificationMapNode } from '../types'
import { NotificationEditor } from './inspector/NotificationEditor'

vi.mock('../bot-map-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../bot-map-api')>()),
  fetchBotMap: vi.fn(),
  patchNotificationTemplate: vi.fn(),
}))

const fetchBotMap = vi.mocked(botMapApi.fetchBotMap)
const patchNotificationTemplate = vi.mocked(botMapApi.patchNotificationTemplate)

const SCREENS: ReadonlyArray<MiniAppScreen> = [
  { route: '/dashboard', nameRu: 'Дашборд кабинета', nameEn: 'Cabinet dashboard', descriptionRu: '', descriptionEn: '' },
  { route: '/plans', nameRu: 'Тарифы', nameEn: 'Plans', descriptionRu: '', descriptionEn: '' },
  { route: '/referrals', nameRu: 'Реферальная программа', nameEn: 'Referral program', descriptionRu: '', descriptionEn: '' },
]

function payload(miniAppScreens?: ReadonlyArray<MiniAppScreen>): BotMapPayload {
  return {
    nodes: [],
    edges: [],
    ...(miniAppScreens === undefined ? {} : { miniAppScreens }),
    meta: { flowStatus: 'NONE', composedAt: '2026-09-23T00:00:00.000Z' },
  }
}

beforeAll(async () => {
  await i18nReady
  await i18n.changeLanguage('ru')
  await loadFeatureBundle('botMap')
})

beforeEach(() => {
  fetchBotMap.mockReset()
  fetchBotMap.mockResolvedValue(payload(SCREENS))
  patchNotificationTemplate.mockReset()
  patchNotificationTemplate.mockResolvedValue(undefined)
})

/** The main-menu button form: «Пригласить» in the constructor and on «Кнопки бота». */
function renderMenuButtonTarget(actionTarget: string) {
  const onActionTargetChange = vi.fn()
  renderWithProviders(
    <ActionFields
      idPrefix="invite"
      actionType="WEBAPP"
      actionTarget={actionTarget}
      onActionTypeChange={vi.fn()}
      onActionTargetChange={onActionTargetChange}
    />,
  )
  return { onActionTargetChange }
}

const pagePicker = () => screen.findByRole('combobox', { name: 'Цель действия' })

describe('a main-menu button set to «Mini App»', () => {
  it('takes the referral program from the list, as the route the cabinet has', async () => {
    const user = userEvent.setup()
    const { onActionTargetChange } = renderMenuButtonTarget('')
    await user.click(await pagePicker())
    await user.click(await screen.findByRole('option', { name: /Реферальная программа/ }))
    expect(onActionTargetChange).toHaveBeenLastCalledWith('/referrals')
  })

  it('shows a saved page by its name, with no box to type in', async () => {
    renderMenuButtonTarget('/referrals')
    expect(await pagePicker()).toHaveTextContent('Реферальная программа')
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('opens what was typed before — a page the cabinet does not have, a t.me link — in the box, untouched', async () => {
    for (const saved of ['/subscribe', 'https://t.me/demo_bot/app?startapp=referrals']) {
      const { unmount } = renderWithProviders(
        <ActionFields
          idPrefix="invite"
          actionType="WEBAPP"
          actionTarget={saved}
          onActionTypeChange={vi.fn()}
          onActionTargetChange={vi.fn()}
        />,
      )
      expect(await pagePicker()).toHaveTextContent('Свой путь…')
      expect(screen.getByRole('textbox')).toHaveValue(saved)
      unmount()
    }
  })

  it('«Свой путь…» opens the box for a page with parameters', async () => {
    const user = userEvent.setup()
    const { onActionTargetChange } = renderMenuButtonTarget('')
    await user.click(await pagePicker())
    await user.click(await screen.findByRole('option', { name: 'Свой путь…' }))
    await user.type(screen.getByRole('textbox'), '/')
    expect(onActionTargetChange).toHaveBeenLastCalledWith('/')
  })

  it('reads the list from the map already in the cache, and is the old box when that map has none', () => {
    // Seeded, not fetched: both pages hosting these forms hold the map, and a
    // tab left open across the upgrade holds one without the list.
    for (const [cached, picker] of [
      [payload(SCREENS), true],
      [payload(undefined), false],
    ] as const) {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
      client.setQueryData(botMapApi.BOT_MAP_QUERY_KEY, cached)
      const { unmount } = render(
        <I18nextProvider i18n={i18n}>
          <QueryClientProvider client={client}>
            <ActionFields
              idPrefix="invite"
              actionType="WEBAPP"
              actionTarget="/referrals"
              onActionTypeChange={vi.fn()}
              onActionTargetChange={vi.fn()}
            />
          </QueryClientProvider>
        </I18nextProvider>,
      )
      const combobox = screen.queryByRole('combobox', { name: 'Цель действия' })
      if (picker) {
        expect(combobox).toHaveTextContent('Реферальная программа')
      } else {
        expect(combobox).toBeNull()
        expect(screen.getByRole('textbox')).toHaveValue('/referrals')
      }
      unmount()
    }
    expect(fetchBotMap).not.toHaveBeenCalled()
  })
})

const NOTIFICATION: NotificationMapNode = {
  id: 'notif:trial_ended',
  kind: 'notification',
  title: 'Пробный период закончился',
  group: 'notification:other',
  templateId: 'tpl-trial-ended',
  type: 'trial_ended',
  category: 'other',
  titleRu: 'Пробный период закончился',
  titleEn: null,
  bodyRu: 'Оформите подписку',
  bodyEn: null,
  bannerUrl: null,
  buttons: [{ labelRu: 'Оформить', labelEn: null, kind: 'webApp', target: '/subscribe', row: 0 }],
  isActive: true,
}

describe('a notification’s «Mini App» button', () => {
  it('saves the page picked from the list — a button that pointed at `/subscribe` now opens «Тарифы»', async () => {
    const user = userEvent.setup()
    renderWithProviders(<NotificationEditor node={NOTIFICATION} />)
    const picker = await screen.findByRole('combobox', { name: 'Экран мини-приложения' })
    expect(picker).toHaveTextContent('Свой путь…')
    await user.click(picker)
    await user.click(await screen.findByRole('option', { name: /Тарифы/ }))
    await user.click(screen.getByRole('button', { name: /Сохранить шаблон/ }))
    await waitFor(() => expect(patchNotificationTemplate).toHaveBeenCalled())
    const [templateId, patch] = patchNotificationTemplate.mock.calls[0]
    expect(templateId).toBe('tpl-trial-ended')
    expect(patch.buttons?.[0]).toMatchObject({ kind: 'webApp', target: '/plans' })
  })
})
