/**
 * The keys reiwa sends as plain text, pinned one by one: a key that drops out
 * of `PLAIN_TEXT_KEYS` goes back to text mode, where its pack emoji is drawn
 * as the animated picture the reader never receives.
 */
import { describe, expect, it } from 'vitest'

import { botTextKeyMode } from './bot-text-key-mode'

describe('botTextKeyMode — plain text', () => {
  it.each([
    // Telegram's share link (reiwa `bot/pages/invite.ts`).
    'invite.share_prompt',
    'invite.share_web_line',
    // The inline answer behind the cabinet's «Поделиться» (`inline-share.ts`).
    'inline.share.title',
    'inline.share.description',
    'inline.share.message',
    'inline.share.title_plain',
    'inline.share.description_plain',
    'inline.share.message_plain',
    'inline.share.open',
    'inline.share.start',
    // The support chat's pre-fill (`supportPrefill`).
    'help.contact_prefill',
  ])('%s travels as plain text', (key) => {
    expect(botTextKeyMode(key)).toBe('plain')
  })

  it('leaves the neighbours as they were: the share button a caption, the hub copy', () => {
    expect(botTextKeyMode('invite.share_button')).toBe('buttonLabel')
    expect(botTextKeyMode('help.contact_button')).toBe('buttonLabel')
    expect(botTextKeyMode('referral.hub.title')).toBe('text')
  })
})
