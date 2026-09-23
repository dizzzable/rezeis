/**
 * The canvas page of «Карта бота» with what the bot builds by itself: its
 * screens that have no flow block, and the main menu's own additions. The
 * canvas is stubbed to a list of its nodes, so a test can pick one the way an
 * operator clicks it.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { api } from '@/lib/api'
import { i18n, loadFeatureBundle } from '@/i18n/i18n'
import { emojiStudioPayload, packsPayload } from '@/features/custom-emoji/emoji-catalog.fixtures'
import { renderWithProviders } from '@/test/test-utils'

import BotFlowPage from './bot-flow-page'
import { SYSTEM_SCREENS, systemScreenNodeId } from './system-screens'
import type { BotFlow } from './types'

vi.mock('./components/FlowCanvas', async () => {
  const React = await import('react')
  return {
    FlowCanvas: ({
      nodes,
      onNodeClick,
    }: {
      readonly nodes: ReadonlyArray<{ readonly id: string }>
      readonly onNodeClick: (id: string) => void
    }) =>
      React.createElement(
        'ul',
        { 'aria-label': 'canvas' },
        nodes.map((node) =>
          React.createElement(
            'li',
            { key: node.id },
            React.createElement('button', { type: 'button', onClick: () => onNodeClick(node.id) }, `node ${node.id}`),
          ),
        ),
      ),
  }
})

vi.mock('@/features/bot-config/reply-keyboard-editor-panel', async () => {
  const React = await import('react')
  return { ReplyKeyboardEditorPanel: () => React.createElement('p', null, 'menu buttons editor') }
})

// What the route loads with the page: part of these words live in it.
beforeAll(async () => {
  await loadFeatureBundle('botMap')
})

afterEach(() => {
  vi.restoreAllMocks()
})

function flowFixture(): BotFlow {
  return {
    id: 'flow-1',
    name: 'Main Flow',
    version: 1,
    status: 'DRAFT',
    layoutData: null,
    publishedAt: null,
    screens: [
      {
        id: 'screen-1',
        shortId: 'sc_start',
        flowId: 'flow-1',
        name: 'start',
        textRu: 'Привет',
        textEn: '',
        parseMode: 'HTML',
        mediaType: null,
        mediaFileId: null,
        mediaUrl: null,
        positionX: 0,
        positionY: 0,
        isRoot: true,
        buttons: [],
      },
    ],
  }
}

function mockApi() {
  vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    if (path === '/admin/bot-flows/draft/Main%20Flow') return { data: flowFixture() }
    if (path === '/admin/bot-map') {
      return { data: { nodes: [], edges: [], miniAppScreens: [], meta: { flowStatus: 'DRAFT', composedAt: '' } } }
    }
    if (path === '/admin/custom-emoji/packs') return packsPayload([])
    if (path === '/admin/bot-config/emoji-studio') return emojiStudioPayload()
    return { data: [] }
  })
  const put = vi.spyOn(api, 'put').mockResolvedValue({ data: {} })
  return { put }
}

describe('the bot’s screens without a block on the canvas page', () => {
  it('puts every one of them on the canvas', async () => {
    mockApi()
    renderWithProviders(<BotFlowPage />)

    for (const system of SYSTEM_SCREENS) {
      expect(await screen.findByRole('button', { name: `node ${systemScreenNodeId(system.id)}` })).toBeInTheDocument()
    }
  })

  it('opens the one the operator picks in the inspector, with the texts it sends', async () => {
    mockApi()
    const user = userEvent.setup()
    renderWithProviders(<BotFlowPage />)

    await user.click(await screen.findByRole('button', { name: `node ${systemScreenNodeId('lang')}` }))

    expect(screen.getByRole('heading', { name: i18n.t('botFlow.systemScreens.lang.title') })).toBeInTheDocument()
    expect(screen.getByText('lang.choose')).toBeInTheDocument()
  })

  it('lists them in the rail beside the canvas, and opens the one picked there', async () => {
    mockApi()
    const user = userEvent.setup()
    renderWithProviders(<BotFlowPage />)

    await user.click(await screen.findByRole('button', { name: i18n.t('botFlow.systemScreens.paysupport.title') }))

    expect(screen.getByRole('heading', { name: i18n.t('botFlow.systemScreens.paysupport.title') })).toBeInTheDocument()
    expect(screen.getByText('paysupport.body')).toBeInTheDocument()
  })

  it('keeps where the operator left them when the canvas is saved', async () => {
    const { put } = mockApi()
    const user = userEvent.setup()
    renderWithProviders(<BotFlowPage />)

    await screen.findByRole('button', { name: `node ${systemScreenNodeId('lang')}` })
    await user.click(screen.getByRole('button', { name: 'Save positions' }))

    await waitFor(() => expect(put).toHaveBeenCalledWith('/admin/bot-flows/flow-1/layout', expect.anything()))
    const layoutCall = put.mock.calls.find((call) => call[0] === '/admin/bot-flows/flow-1/layout')
    const saved = (layoutCall?.[1] as { layoutData: { mapNodePositions: Record<string, unknown> } }).layoutData
      .mapNodePositions
    for (const system of SYSTEM_SCREENS) {
      expect(saved).toHaveProperty([systemScreenNodeId(system.id)])
    }
  })
})

describe('the main menu on the canvas page', () => {
  it('shows what the bot adds to the menu under the menu’s own editor', async () => {
    mockApi()
    const user = userEvent.setup()
    renderWithProviders(<BotFlowPage />)

    await user.click(await screen.findByRole('button', { name: 'node __reply_keyboard__' }))

    expect(screen.getByText('menu buttons editor')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: i18n.t('botFlow.mainMenu.title') })).toBeInTheDocument()
  })
})
