/**
 * The «Поделиться» texts on «Карта бота» (owner's question, 23.09.2026: «the
 * text people send from the bot — can it be changed in the map?»).
 *
 * Two share paths, both on the invite screen: the bot's own button (Telegram's
 * share sheet — `invite.share_prompt` + `invite.share_web_line`), and the
 * cabinet's referral page, which goes through the bot's inline mode
 * (`inline.share.*`, reiwa `src/bot/pages/inline-share.ts`). The second set was
 * editable nowhere but by typing its key into «Тексты бота». And among
 * twenty-nine keys named only by key, the owner could not find the first — so
 * the share texts carry a caption saying what the customer receives.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'

import { api } from '@/lib/api'
import { i18n } from '@/i18n/i18n'
import { emojiStudioPayload, packsPayload } from '@/features/custom-emoji/emoji-catalog.fixtures'
import { renderWithProviders } from '@/test/test-utils'

import { SystemScreenTexts } from './SystemScreenTexts'

const INLINE_SHARE_KEYS = [
  'inline.share.message',
  'inline.share.title',
  'inline.share.description',
  'inline.share.open',
  'inline.share.message_plain',
  'inline.share.title_plain',
  'inline.share.description_plain',
  'inline.share.start',
] as const

function mockTextsApi(): void {
  vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    if (path === '/admin/custom-emoji/packs') return packsPayload([])
    if (path === '/admin/bot-config/emoji-studio') return emojiStudioPayload()
    return { data: [] }
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('«Поделиться» texts on the invite screen', () => {
  it('lists the texts the cabinet’s «Поделиться» sends, so they can be edited here', async () => {
    mockTextsApi()
    renderWithProviders(<SystemScreenTexts screenName="invite" />)

    for (const key of INLINE_SHARE_KEYS) {
      expect(await screen.findByText(key)).toBeInTheDocument()
    }
  })

  it('names the bot’s share texts by what the friend receives, not only by key', async () => {
    mockTextsApi()
    renderWithProviders(<SystemScreenTexts screenName="invite" />)

    expect(
      await screen.findByText(i18n.t('botFlow.screenTexts.captions.sharePrompt')),
    ).toBeInTheDocument()
    expect(screen.getByText('invite.share_prompt')).toBeInTheDocument()
    expect(screen.getByText(i18n.t('botFlow.screenTexts.captions.inlineMessage'))).toBeInTheDocument()
  })

  it('shows the website line’s {{link}} as written, the token the operator must keep', async () => {
    mockTextsApi()
    renderWithProviders(<SystemScreenTexts screenName="invite" />)

    const caption = await screen.findByText(/\{\{link\}\}/)
    expect(caption.textContent).toBe(
      i18n.t('botFlow.screenTexts.captions.shareWebLine', { token: '{{link}}' }),
    )
  })

  it('leaves a key without a caption named by its key alone', async () => {
    mockTextsApi()
    renderWithProviders(<SystemScreenTexts screenName="rules" />)

    expect(await screen.findByText('rules.intro')).toBeInTheDocument()
    expect(screen.queryByText(/«Поделиться»|«Share»/)).toBeNull()
  })
})
