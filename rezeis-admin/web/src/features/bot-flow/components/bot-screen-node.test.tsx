/**
 * A screen block on the canvas of «Карта бота», with the buttons reiwa adds
 * at runtime drawn under the operator's own.
 *
 * A system button the bot shows only sometimes carries that condition on the
 * block itself: the canvas is where an operator reads the bot at a glance,
 * and a chip without it reads as a button every customer gets.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'

import { api } from '@/lib/api'
import { i18n, loadFeatureBundle } from '@/i18n/i18n'
import { emojiStudioPayload, packsPayload } from '@/features/custom-emoji/emoji-catalog.fixtures'
import { renderWithProviders } from '@/test/test-utils'

import { BotScreenNode } from './BotScreenNode'
import { computeSystemButtons } from '../utils'
import type { BotScreenNodeData } from '../types'

vi.mock('@xyflow/react', async () => {
  const React = await import('react')
  return {
    Handle: () => React.createElement('span', { 'data-testid': 'flow-handle' }),
    Position: { Bottom: 'bottom', Left: 'left', Right: 'right', Top: 'top' },
  }
})

// What the route loads with the page: part of these words live in it.
beforeAll(async () => {
  await loadFeatureBundle('botMap')
})

afterEach(() => {
  vi.restoreAllMocks()
})

function renderNode(data: BotScreenNodeData): void {
  vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    if (path === '/admin/custom-emoji/packs') return packsPayload([])
    if (path === '/admin/bot-config/emoji-studio') return emojiStudioPayload()
    return { data: [] }
  })
  const props = { id: 'screen-1', data, selected: false } as unknown as Parameters<typeof BotScreenNode>[0]
  renderWithProviders(<BotScreenNode {...props} />)
}

function inviteNode(): BotScreenNodeData {
  const screenRow = { name: 'invite', isRoot: false, buttons: [] } as unknown as Parameters<
    typeof computeSystemButtons
  >[0]
  return {
    shortId: 'sc_invite',
    name: 'invite',
    textRu: 'Приглашайте друзей',
    textEn: '',
    parseMode: 'HTML',
    mediaType: null,
    mediaUrl: null,
    isRoot: false,
    buttons: [],
    systemButtons: computeSystemButtons(screenRow),
  }
}

describe('a system button chip on the canvas', () => {
  it('draws the invite hub’s cabinet buttons', () => {
    renderNode(inviteNode())

    expect(screen.getByText('👤 Open in cabinet')).toBeInTheDocument()
    expect(screen.getByText('🤝 Partner cabinet')).toBeInTheDocument()
    expect(screen.getByText('💱 Exchange points')).toBeInTheDocument()
  })

  it('carries its condition under the caption, and only a conditional one does', () => {
    renderNode(inviteNode())

    const partner = screen.getByText('🤝 Partner cabinet').closest('[data-system-button]') as HTMLElement
    expect(within(partner).getByText(i18n.t('botFlow.systemButtons.conditions.partnerCabinet'))).toBeInTheDocument()
    const share = screen.getByText('📤 Share on Telegram').closest('[data-system-button]') as HTMLElement
    expect(share.querySelector('[data-condition]')).toBeNull()
  })
})
