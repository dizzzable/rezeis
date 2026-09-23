/**
 * A bot screen with no flow block, on the canvas and in the inspector of
 * «Карта бота» — the channel gate's prompt, the language picker, the error
 * message… Before, none of them was on the map: their captions and texts were
 * reachable only by typing a key into «Тексты».
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'

import { api } from '@/lib/api'
import { i18n, loadFeatureBundle } from '@/i18n/i18n'
import { emojiStudioPayload, packsPayload } from '@/features/custom-emoji/emoji-catalog.fixtures'
import { renderWithProviders } from '@/test/test-utils'

import { SYSTEM_SCREENS, type SystemScreen } from '../system-screens'
import { SystemScreenNode } from './SystemScreenNode'
import { SystemScreenPanel } from './SystemScreenPanel'

vi.mock('@xyflow/react', async () => {
  const React = await import('react')
  return {
    Handle: () => React.createElement('span', { 'data-testid': 'flow-handle' }),
    Position: { Bottom: 'bottom', Left: 'left', Right: 'right', Top: 'top' },
  }
})

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

function systemScreen(id: string): SystemScreen {
  const found = SYSTEM_SCREENS.find((candidate) => candidate.id === id)
  if (found === undefined) throw new Error(`no system screen ${id}`)
  return found
}

describe('the channel gate’s prompt in the inspector', () => {
  it('edits each button’s caption and says when the join button is there', async () => {
    mockTextsApi({ 'channel.join_button': 'Join caption', 'channel.check_button': 'Check caption' })
    renderWithProviders(<SystemScreenPanel screen={systemScreen('channelGate')} />)

    expect(screen.getByRole('heading', { name: i18n.t('botFlow.systemScreens.channelGate.title') })).toBeInTheDocument()
    const region = screen.getByRole('region', { name: 'System buttons' })
    const join = within(region).getByRole('group', { name: i18n.t('botFlow.systemScreens.buttons.channelJoin') })
    const check = within(region).getByRole('group', { name: i18n.t('botFlow.systemScreens.buttons.channelCheck') })
    expect(await within(join).findByDisplayValue('Join caption')).toBeInTheDocument()
    expect(await within(check).findByDisplayValue('Check caption')).toBeInTheDocument()
    expect(within(join).getByText(i18n.t('botFlow.systemButtons.conditions.channelJoin'))).toBeInTheDocument()
    // `inlineButton` reads no system icon slot: no picker to save a dead icon.
    expect(within(join).queryByRole('button', { name: 'Custom Emoji ID' })).toBeNull()
  })

  it('edits the texts it sends, each named by when it is sent', async () => {
    mockTextsApi({ 'channel.required': 'Subscribe first' })
    renderWithProviders(<SystemScreenPanel screen={systemScreen('channelGate')} />)

    expect(await screen.findByDisplayValue('Subscribe first')).toBeInTheDocument()
    for (const key of ['channel.required', 'channel.not_subscribed', 'channel.verified']) {
      expect(screen.getByText(key)).toBeInTheDocument()
    }
    expect(
      screen.getByText(i18n.t('botFlow.systemScreens.captions.channelNotSubscribed')),
    ).toBeInTheDocument()
  })
})

describe('/paysupport in the inspector', () => {
  it('offers the icon of the support button, which the bot renders as a system button', () => {
    mockTextsApi()
    renderWithProviders(<SystemScreenPanel screen={systemScreen('paysupport')} />)

    const contact = screen.getByRole('group', { name: i18n.t('botFlow.systemButtons.help.contact') })
    expect(within(contact).getByRole('button', { name: 'Custom Emoji ID' })).toBeInTheDocument()
  })
})

describe('the short answers in the inspector', () => {
  it('lists every text, with no empty button section', () => {
    mockTextsApi()
    renderWithProviders(<SystemScreenPanel screen={systemScreen('serviceReplies')} />)

    expect(screen.queryByRole('region', { name: 'System buttons' })).toBeNull()
    for (const text of systemScreen('serviceReplies').texts) {
      expect(screen.getByText(text.key)).toBeInTheDocument()
    }
  })
})

describe('a bot screen with no block on the canvas', () => {
  it('shows its title, how one gets there, its buttons and when they show', () => {
    const props = { id: 'system:channelGate', data: { screenId: 'channelGate' }, selected: false } as unknown as Parameters<
      typeof SystemScreenNode
    >[0]
    renderWithProviders(<SystemScreenNode {...props} />)

    expect(screen.getByText(i18n.t('botFlow.systemScreens.channelGate.title'))).toBeInTheDocument()
    expect(screen.getByText(i18n.t('botFlow.systemScreens.channelGate.trigger'))).toBeInTheDocument()
    const join = screen
      .getByText(i18n.t('botFlow.systemScreens.buttons.channelJoin'))
      .closest('[data-system-button]') as HTMLElement
    expect(within(join).getByText(i18n.t('botFlow.systemButtons.conditions.channelJoin'))).toBeInTheDocument()
    expect(screen.getByText(i18n.t('botFlow.systemScreens.textsCount', { count: 3 }))).toBeInTheDocument()
  })
})
