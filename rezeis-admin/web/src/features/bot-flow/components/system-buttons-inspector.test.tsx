/**
 * «Системные кнопки» in the screen inspector of «Карта бота».
 *
 * The inspector and the canvas each kept their own copy of the buttons reiwa
 * adds to a built-in screen, and the copies were missing buttons the bot
 * shows: the invite hub's cabinet buttons (reiwa `src/bot/pages/invite.ts`,
 * `hubButton(...)`), and the «◀️ В меню» the bot appends to a screen the
 * operator built without buttons (`dynamic-screen.ts`) — drawn on the canvas,
 * absent from the inspector, so its caption and icon could not be set there.
 * Owner's rule, 23.09.2026: what the map does not show, nobody can configure.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'

import { api } from '@/lib/api'
import { i18n, loadFeatureBundle } from '@/i18n/i18n'
import { emojiStudioPayload, packsPayload } from '@/features/custom-emoji/emoji-catalog.fixtures'
import { renderWithProviders } from '@/test/test-utils'

import { ScreenEditorPanel } from './ScreenEditorPanel'
import { computeSystemButtons } from '../utils'
import type { BotFlowScreen } from '../types'

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

function flowScreen(overrides: Partial<BotFlowScreen> = {}): BotFlowScreen {
  return {
    id: 'screen-1',
    shortId: 'sc_invite',
    flowId: 'flow-1',
    name: 'invite',
    textRu: 'Приглашайте друзей: {{link}}',
    textEn: '',
    parseMode: 'HTML',
    mediaType: null,
    mediaFileId: null,
    mediaUrl: null,
    positionX: 0,
    positionY: 0,
    isRoot: false,
    buttons: [],
    ...overrides,
  }
}

const systemButtonsRegion = () => screen.getByRole('region', { name: 'System buttons' })

describe('the invite screen’s system buttons in the inspector', () => {
  it('lists the cabinet buttons of both hubs, each editing the key the bot reads its caption from', async () => {
    mockTextsApi({
      'referral.hub.open_cabinet': 'Cabinet caption',
      'referral.hub.open_exchange': 'Exchange caption',
      'partner.hub.open_cabinet': 'Partner caption',
    })
    renderWithProviders(<ScreenEditorPanel screen={flowScreen()} flowName="Main Flow" />)

    const region = systemButtonsRegion()
    const cabinet = within(region).getByRole('group', { name: '👤 Open in cabinet' })
    const exchange = within(region).getByRole('group', { name: '💱 Exchange points' })
    const partner = within(region).getByRole('group', { name: '🤝 Partner cabinet' })
    expect(await within(cabinet).findByDisplayValue('Cabinet caption')).toBeInTheDocument()
    expect(await within(exchange).findByDisplayValue('Exchange caption')).toBeInTheDocument()
    expect(await within(partner).findByDisplayValue('Partner caption')).toBeInTheDocument()
    // No `bot.sysbtn_icon.*` slot is read for these three — a picker would
    // save an icon the bot never shows.
    for (const card of [cabinet, exchange, partner]) {
      expect(within(card).queryByRole('button', { name: 'Custom Emoji ID' })).toBeNull()
    }
    // …while a button the bot renders through `renderSystemButton` keeps its picker.
    const share = within(region).getByRole('group', { name: '📤 Share on Telegram' })
    expect(within(share).getByRole('button', { name: 'Custom Emoji ID' })).toBeInTheDocument()
  })

  it('says when each conditional button is there', () => {
    mockTextsApi()
    renderWithProviders(<ScreenEditorPanel screen={flowScreen()} flowName="Main Flow" />)

    const region = systemButtonsRegion()
    const partner = within(region).getByRole('group', { name: '🤝 Partner cabinet' })
    expect(within(partner).getByText(i18n.t('botFlow.systemButtons.conditions.partnerCabinet'))).toBeInTheDocument()
    const copyWeb = within(region).getByRole('group', { name: '🌐 Copy the website link' })
    expect(within(copyWeb).getByText(i18n.t('botFlow.systemButtons.conditions.webLink'))).toBeInTheDocument()
    // An unconditional button says nothing of the kind.
    const share = within(region).getByRole('group', { name: '📤 Share on Telegram' })
    expect(share.querySelector('[data-condition]')).toBeNull()
  })
})

describe('the back button of a screen the operator built', () => {
  it('is listed while the screen has no buttons, with its caption, its icon and when it goes away', async () => {
    mockTextsApi({ back_to_menu: 'Back caption' })
    renderWithProviders(
      <ScreenEditorPanel screen={flowScreen({ name: 'promo', shortId: 'sc_promo' })} flowName="Main Flow" />,
    )

    const back = within(systemButtonsRegion()).getByRole('group', { name: '◀️ Back to menu' })
    expect(await within(back).findByDisplayValue('Back caption')).toBeInTheDocument()
    expect(within(back).getByRole('button', { name: 'Custom Emoji ID' })).toBeInTheDocument()
    expect(within(back).getByText(i18n.t('botFlow.systemButtons.conditions.autoBack'))).toBeInTheDocument()
  })
})

describe('the inspector and the canvas show one list', () => {
  it.each(['invite', 'rules', 'help', 'promo'])('%s: the same buttons, in the same order', (name) => {
    mockTextsApi()
    const subject = flowScreen({ name, shortId: `sc_${name}` })
    renderWithProviders(<ScreenEditorPanel screen={subject} flowName="Main Flow" />)

    const inspector = within(systemButtonsRegion())
      .getAllByRole('group')
      .map((group) => group.getAttribute('aria-label'))
    const canvas = computeSystemButtons(subject).map((button) => i18n.t(button.labelKey))
    expect(inspector).toEqual(canvas)
  })
})
