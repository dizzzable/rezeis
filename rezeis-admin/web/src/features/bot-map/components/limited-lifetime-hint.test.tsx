/**
 * «Трафик исчерпан» on «Карта бота»: what the bot does for a subscription with
 * no end date (the owner, 24.09.2026). Such a subscription is never renewed, so
 * the bot turns the template's renewal buttons into «📦 Докупить трафик» on the
 * add-on page (rezeis `offerTrafficTopUpForLifetime`). The map draws that as
 * an arrow of its own (`BotMapComposerService`); the template's editor says it
 * in words, beside the buttons the operator edits, and only on that template.
 */
import { screen } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { i18n, i18nReady, loadFeatureBundle } from '@/i18n/i18n'
import { renderWithProviders } from '@/test/test-utils'

import * as botMapApi from '../bot-map-api'
import type { NotificationMapNode } from '../types'
import { NotificationEditor } from './inspector/NotificationEditor'

vi.mock('../bot-map-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../bot-map-api')>()),
  fetchBotMap: vi.fn(),
  patchNotificationTemplate: vi.fn(),
}))

const fetchBotMap = vi.mocked(botMapApi.fetchBotMap)

function notification(type: string): NotificationMapNode {
  return {
    id: `notif:${type}`,
    kind: 'notification',
    title: 'Подписка ограничена',
    group: 'notification:expires',
    templateId: `tpl-${type}`,
    type,
    category: 'expires',
    titleRu: 'Подписка ограничена',
    titleEn: null,
    bodyRu: 'Лимит трафика исчерпан',
    bodyEn: null,
    bannerUrl: null,
    buttons: [
      { labelRu: '🔄 Продлить подписку', labelEn: '🔄 Renew subscription', kind: 'webApp', target: '/renew', row: 0 },
      { labelRu: '🏠 Главное меню', labelEn: '🏠 Main menu', kind: 'callback', target: 'menu:main', row: 1 },
    ],
    isActive: true,
  }
}

beforeAll(async () => {
  await i18nReady
  // The bundle loads for the language set when it is asked for.
  await i18n.changeLanguage('ru')
  await loadFeatureBundle('botMap')
})

beforeEach(() => {
  fetchBotMap.mockReset()
  fetchBotMap.mockResolvedValue({ nodes: [], edges: [], meta: { flowStatus: 'NONE', composedAt: '2026-09-24T00:00:00.000Z' } })
})

describe('«Трафик исчерпан» in the template editor', () => {
  it('says where the renewal buttons lead a subscription with no end date', async () => {
    renderWithProviders(<NotificationEditor node={notification('limited')} />)

    const note = await screen.findByRole('note')
    expect(note).toHaveTextContent('«📦 Докупить трафик» → «Дополнения» (/addons)')
    expect(note).toHaveTextContent('«Продление подписки» (/renew)')
    // Only when there is something to buy (N1 gap 4), and what happens otherwise.
    expect(note).toHaveTextContent('если ей есть что там купить: докупку трафика или «Сброс трафика»')
    expect(note).toHaveTextContent('таких кнопок бот не показывает, а само уведомление приходит')
  })

  it('in English too', async () => {
    await i18n.changeLanguage('en')
    await loadFeatureBundle('botMap')
    try {
      renderWithProviders(<NotificationEditor node={notification('limited')} />)

      expect(await screen.findByRole('note')).toHaveTextContent('«📦 Buy more traffic» → «Add-ons» (/addons)')
    } finally {
      await i18n.changeLanguage('ru')
    }
  })

  it('says nothing of the kind on any other template, a renewal button and all', async () => {
    renderWithProviders(<NotificationEditor node={notification('expired')} />)

    await screen.findAllByRole('button', { name: /Сохранить шаблон/ })
    expect(screen.queryByText(/Докупить трафик/)).not.toBeInTheDocument()
  })
})
