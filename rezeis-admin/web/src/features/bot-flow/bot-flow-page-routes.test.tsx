/**
 * The canvas page hands the main-menu node what decides a button's road
 * besides the button: the flow's screens, the Mini App's pages
 * (`/admin/bot-map` `miniAppScreens`) and the bot's «Username поддержки»
 * (`bot.support_username`) — the context «Список» routes with on the server
 * (`test/bot-map-route-parity.spec.ts`). Without the screens a button whose ID
 * is a shortId reads dead; without the pages a page the Mini App does not have
 * reads as one it does; without the username a support button that can only
 * open the help screen reads as a chat.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'

import { api } from '@/lib/api'
import { i18n, loadFeatureBundle } from '@/i18n/i18n'
import { emojiStudioPayload, packsPayload } from '@/features/custom-emoji/emoji-catalog.fixtures'
import { renderWithProviders } from '@/test/test-utils'
import type { BotButton } from '@/features/bot-config/bot-config-api'

import BotFlowPage from './bot-flow-page'
import type { BotFlow } from './types'

vi.mock('@xyflow/react', async (importOriginal) => {
  const React = await import('react')
  return {
    ...(await importOriginal<typeof import('@xyflow/react')>()),
    Handle: () => React.createElement('span', { 'data-testid': 'flow-handle' }),
  }
})

/**
 * The canvas, reduced to the one node under test, drawn by its real component,
 * and the arrows leaving it, listed as `edge id → target`.
 */
vi.mock('./components/FlowCanvas', async () => {
  const React = await import('react')
  const { REPLY_KEYBOARD_NODE_ID, ReplyKeyboardNode } = await import('./components/ReplyKeyboardNode')
  return {
    FlowCanvas: ({
      nodes,
      edges,
    }: {
      readonly nodes: ReadonlyArray<{ readonly id: string; readonly data: unknown }>
      readonly edges: ReadonlyArray<{ readonly id: string; readonly source: string; readonly target: string }>
    }) => {
      const menu = nodes.find((node) => node.id === REPLY_KEYBOARD_NODE_ID)
      if (menu === undefined) return null
      const props = { id: menu.id, data: menu.data, selected: false } as unknown as Parameters<typeof ReplyKeyboardNode>[0]
      const arrows = edges
        .filter((edge) => edge.source === REPLY_KEYBOARD_NODE_ID)
        .map((edge) => React.createElement('li', { key: edge.id }, `${edge.id} → ${edge.target}`))
      return React.createElement(
        'div',
        null,
        React.createElement(ReplyKeyboardNode, props),
        React.createElement('ul', { 'aria-label': 'menu arrows' }, arrows),
      )
    },
  }
})

// What the route loads with the page: part of these words live in it.
beforeAll(async () => {
  await loadFeatureBundle('botMap')
})

afterEach(() => {
  vi.restoreAllMocks()
})

function menuButton(buttonId: string, label: string, overrides: Partial<BotButton>): BotButton {
  return {
    id: `row-${buttonId}`,
    buttonId,
    label,
    style: 'DEFAULT',
    iconCustomEmojiId: null,
    visible: true,
    onePerRow: true,
    orderIndex: 0,
    actionType: 'CALLBACK',
    actionTarget: null,
    createdAt: '2026-09-23T00:00:00.000Z',
    updatedAt: '2026-09-23T00:00:00.000Z',
    ...overrides,
  }
}

function screenOf(id: string, shortId: string, name: string, isRoot: boolean): BotFlow['screens'][number] {
  return {
    id,
    shortId,
    flowId: 'flow-1',
    name,
    textRu: '',
    textEn: '',
    parseMode: 'HTML',
    mediaType: null,
    mediaFileId: null,
    mediaUrl: null,
    positionX: 0,
    positionY: 0,
    isRoot,
    buttons: [],
  }
}

const FLOW: BotFlow = {
  id: 'flow-1',
  name: 'Main Flow',
  version: 1,
  status: 'PUBLISHED',
  layoutData: null,
  publishedAt: null,
  screens: [
    screenOf('screen-start', 'sc_start', 'start', true),
    screenOf('screen-promo', 'sc_promo', 'promo', false),
    screenOf('screen-help', 'sc_help', 'help', false),
  ],
}

const BUTTONS: BotButton[] = [
  menuButton('sc_promo', 'Акция', { orderIndex: 0 }),
  menuButton('promo_page', 'Промо', { actionType: 'WEBAPP', actionTarget: '/promoo', orderIndex: 1 }),
  menuButton('plans', 'Тарифы', { actionType: 'WEBAPP', actionTarget: '/plans', orderIndex: 2 }),
  menuButton('support', 'Поддержка', { actionType: 'SUPPORT_URL', orderIndex: 3 }),
]

function page(route: string) {
  return { route, nameRu: route, nameEn: route, descriptionRu: '', descriptionEn: '' }
}

function mockApi(texts: ReadonlyArray<{ key: string; value: string }> = []): void {
  vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    if (path === '/admin/bot-flows/draft/Main%20Flow') return { data: FLOW }
    if (path === '/admin/bot-config/buttons') return { data: BUTTONS }
    if (path === '/admin/bot-config/texts') return { data: texts }
    if (path === '/admin/bot-map') {
      return {
        data: {
          nodes: [],
          edges: [],
          miniAppScreens: [page('/dashboard'), page('/plans')],
          meta: { flowStatus: 'PUBLISHED', composedAt: '' },
        },
      }
    }
    if (path === '/admin/custom-emoji/packs') return packsPayload([])
    if (path === '/admin/bot-config/emoji-studio') return emojiStudioPayload()
    return { data: [] }
  })
}

const under = (label: string) => screen.getByText(label).closest('[data-menu-button]') as HTMLElement

describe('the main-menu node on the canvas page', () => {
  it('routes with the flow’s screens and the Mini App’s pages', async () => {
    mockApi()
    renderWithProviders(<BotFlowPage />)

    await screen.findByText(i18n.t('botFlow.replyTargets.missingPage', { path: '/promoo' }))
    expect(under('Акция').textContent).toContain(i18n.t('botFlow.replyTargets.screen', { name: 'promo' }))
    expect(under('Промо').querySelector('[data-broken]')).not.toBeNull()
    expect(under('Тарифы').textContent).toContain(i18n.t('botFlow.replyTargets.miniApp', { path: '/plans' }))
  })

  it('routes a support button with the bot’s own «Username поддержки»', async () => {
    // A numeric id: reiwa opens no chat and sends `help` instead.
    mockApi([{ key: 'bot.support_username', value: '123456789' }])
    renderWithProviders(<BotFlowPage />)

    await screen.findByText(i18n.t('botFlow.replyTargets.screen', { name: 'help' }))
    expect(under('Поддержка').textContent).toContain(i18n.t('botFlow.replyTargets.screen', { name: 'help' }))
    // Not «a chat, or the help screen»: the panel knows there is no chat.
    expect(under('Поддержка').textContent).not.toContain(i18n.t('botFlow.replyTargets.support'))
    expect(await screen.findByText('reply-edge-row-support → screen-help')).toBeInTheDocument()
  })

  it('draws no arrow from a support button that opens a chat', async () => {
    mockApi([{ key: 'bot.support_username', value: '@support_team' }])
    renderWithProviders(<BotFlowPage />)

    await screen.findByText(i18n.t('botFlow.replyTargets.support'))
    // The flow is drawn: «Акция» has its arrow — and the support button none.
    expect(await screen.findByText('reply-edge-row-sc_promo → screen-promo')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText(/^reply-edge-row-support/)).toBeNull())
  })
})
