/**
 * «Список» shows what «Схема» shows of the things the bot builds by itself.
 *
 * The list tab named the menu node by the server's «Reply-клавиатура», said
 * «Системные кнопки бота (добавляются автоматически)» on three screens and
 * nothing on the rest, and had none of the bot's screens with no flow block.
 * It now reads the canvas's own catalog: `computeSystemButtons` /
 * `systemButtonsFor`, `MAIN_MENU_CHIPS`, `SYSTEM_SCREENS` — through
 * `withBuiltInNodes` and `systemButtonsOfNode`, not a third copy.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { api } from '@/lib/api'
import { i18n, loadFeatureBundle } from '@/i18n/i18n'
import { emojiStudioPayload, packsPayload } from '@/features/custom-emoji/emoji-catalog.fixtures'
import { SYSTEM_SCREENS, systemScreenNodeId } from '@/features/bot-flow/system-screens'
import { computeSystemButtons } from '@/features/bot-flow/utils'
import { renderWithProviders } from '@/test/test-utils'

import type { BotMapNode, BotMapPayload, GraphScreenMapNode, ReplyKeyboardMapNode } from '../types'
import { withBuiltInNodes } from '../utils/built-in-nodes'
import { filterNodesByQuery } from '../utils/filter-nodes-by-query'
import { BotMapShell } from './BotMapShell'
import { InspectorRouter } from './inspector/InspectorRouter'
import { ListView } from './ListView'
import { NodeRail } from './NodeRail'

vi.mock('@/features/bot-flow/bot-flow-page', async () => {
  const React = await import('react')
  return { default: () => React.createElement('p', null, 'canvas') }
})

beforeAll(async () => {
  await loadFeatureBundle('botMap')
})

afterEach(() => {
  vi.restoreAllMocks()
  try {
    localStorage.clear()
  } catch {
    /* no storage */
  }
})

function mockApi(): void {
  vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    if (path === '/admin/custom-emoji/packs') return packsPayload([])
    if (path === '/admin/bot-config/emoji-studio') return emojiStudioPayload()
    return { data: [] }
  })
}

const t = (key: string) => String(i18n.t(key))

function graphScreen(name: string, overrides: Partial<GraphScreenMapNode> = {}): GraphScreenMapNode {
  return {
    id: `screen-${name}`,
    kind: 'graph-screen',
    title: name,
    group: 'graph',
    status: 'PUBLISHED',
    shortId: `sc_${name}`,
    isRoot: false,
    textRu: '',
    textEn: '',
    buttonCount: 0,
    bannerUrl: null,
    ...overrides,
  }
}

/** What an older panel sends: the menu under its old name. */
const MENU: ReplyKeyboardMapNode = {
  id: '__reply_keyboard__',
  kind: 'reply-keyboard',
  title: 'Reply-клавиатура',
  group: 'reply',
  buttons: [],
}

function payloadOf(nodes: BotMapNode[]): BotMapPayload {
  return { nodes, edges: [], meta: { flowStatus: 'PUBLISHED', composedAt: '2026-09-23T00:00:00.000Z' } }
}

describe('the main menu on «Список»', () => {
  it('is «Main menu» in the rail, whatever the payload calls it', () => {
    renderWithProviders(
      <NodeRail
        nodes={withBuiltInNodes([MENU], t)}
        selectedId={null}
        onSelect={() => undefined}
        query=""
        onQueryChange={() => undefined}
      />,
    )

    expect(screen.getByRole('button', { name: 'Main menu' })).toBeInTheDocument()
    expect(screen.queryByText('Reply-клавиатура')).toBeNull()
  })

  it('is found by that name', () => {
    const found = filterNodesByQuery(withBuiltInNodes([MENU], t), 'main menu')
    expect(found.map((node) => node.id)).toEqual(['__reply_keyboard__'])
  })

  it('shows the trial button the bot puts on top, and when', () => {
    const nodes = withBuiltInNodes([MENU], t)
    renderWithProviders(
      <ListView payload={payloadOf([MENU])} visibleNodes={nodes.slice(0, 1)} selectedId={null} onSelect={() => undefined} />,
    )

    const trial = screen.getByText(t('botFlow.systemButtons.mainMenu.trial')).closest('[data-system-button]') as HTMLElement
    expect(within(trial).getByText(t('botFlow.systemButtons.conditions.trial'))).toBeInTheDocument()
  })

  it('opens with what the bot adds to it, under the buttons’ own editor', () => {
    mockApi()
    renderWithProviders(<InspectorRouter node={withBuiltInNodes([MENU], t)[0]} />)

    expect(screen.getByRole('heading', { name: 'Main menu' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: t('botFlow.mainMenu.title') })).toBeInTheDocument()
  })
})

describe('a built-in screen on «Список»', () => {
  it('lists the buttons the bot adds, as the canvas does, with their conditions', () => {
    const invite = graphScreen('invite')
    renderWithProviders(
      <ListView payload={payloadOf([invite])} visibleNodes={[invite]} selectedId={null} onSelect={() => undefined} />,
    )

    const listed = [...document.querySelectorAll('[data-system-button]')].map(
      (item) => item.querySelector('span')?.textContent,
    )
    const canvas = computeSystemButtons({ name: 'invite', isRoot: false, buttons: [] } as never).map((b) => t(b.labelKey))
    expect(listed).toEqual(canvas)
    const partner = screen.getByText('🤝 Partner cabinet').closest('[data-system-button]') as HTMLElement
    expect(within(partner).getByText(t('botFlow.systemButtons.conditions.partnerCabinet'))).toBeInTheDocument()
  })

  it('shows the back button the bot adds to a screen the operator left without buttons', () => {
    const promo = graphScreen('promo')
    renderWithProviders(
      <ListView payload={payloadOf([promo])} visibleNodes={[promo]} selectedId={null} onSelect={() => undefined} />,
    )

    const back = screen.getByText('◀️ Back to menu').closest('[data-system-button]') as HTMLElement
    expect(within(back).getByText(t('botFlow.systemButtons.conditions.autoBack'))).toBeInTheDocument()
    expect(screen.queryByText(t('botMapPage.badges.noButtons'))).toBeNull()
  })

  it('opens with its system buttons and texts to edit, as on «Схема»', () => {
    mockApi()
    renderWithProviders(<InspectorRouter node={graphScreen('invite')} />)

    const region = screen.getByRole('region', { name: 'System buttons' })
    expect(within(region).getByRole('group', { name: '👤 Open in cabinet' })).toBeInTheDocument()
    expect(screen.getByText('referral.disabled')).toBeInTheDocument()
  })
})

describe('the bot’s screens without a block on «Список»', () => {
  it('are in the rail, under a group of their own', () => {
    renderWithProviders(
      <NodeRail
        nodes={withBuiltInNodes([], t)}
        selectedId={null}
        onSelect={() => undefined}
        query=""
        onQueryChange={() => undefined}
      />,
    )

    expect(screen.getByText(t('botMapPage.rail.groups.system'))).toBeInTheDocument()
    for (const system of SYSTEM_SCREENS) {
      expect(screen.getByRole('button', { name: t(system.titleKey) })).toBeInTheDocument()
    }
  })

  it('are found by a key they send', () => {
    const found = filterNodesByQuery(withBuiltInNodes([], t), 'channel.required')
    expect(found.map((node) => node.id)).toEqual([systemScreenNodeId('channelGate')])
  })

  it('are found by the key of a button caption too', () => {
    // A BUTTON's key, which no screen lists among its texts.
    const found = filterNodesByQuery(withBuiltInNodes([], t), 'ai_support.exit_button')
    expect(found.map((node) => node.id)).toEqual([systemScreenNodeId('aiSupport')])
  })

  it('show their buttons on the list, with when the bot shows them', () => {
    const nodes = withBuiltInNodes([], t)
    const gate = nodes.find((node) => node.id === systemScreenNodeId('channelGate')) as BotMapNode
    renderWithProviders(
      <ListView payload={payloadOf([])} visibleNodes={[gate]} selectedId={null} onSelect={() => undefined} />,
    )

    expect(screen.getByText(t('botFlow.systemScreens.channelGate.trigger'))).toBeInTheDocument()
    const join = screen.getByText(t('botFlow.systemScreens.buttons.channelJoin')).closest('[data-system-button]') as HTMLElement
    expect(within(join).getByText(t('botFlow.systemButtons.conditions.channelJoin'))).toBeInTheDocument()
  })

  it('open in the inspector picked from the rail, and stay picked', async () => {
    mockApi()
    const user = userEvent.setup()
    renderWithProviders(<BotMapShell payload={payloadOf([MENU])} isFetching={false} onRefresh={() => undefined} />)

    const rail = screen.getAllByRole('button', { name: t('botFlow.systemScreens.lang.title') })[0]
    await user.click(rail)

    expect(await screen.findByRole('heading', { name: t('botFlow.systemScreens.lang.title') })).toBeInTheDocument()
    expect(screen.getByText('lang.choose')).toBeInTheDocument()
  })
})
