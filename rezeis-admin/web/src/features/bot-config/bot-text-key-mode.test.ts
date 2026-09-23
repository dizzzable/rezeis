/**
 * The keys reiwa sends as plain text, pinned one by one: a key that drops out
 * of `PLAIN_TEXT_KEYS` goes back to text mode, where its pack emoji is drawn
 * as the animated picture the reader never receives. And the captions reiwa
 * reads from keys without the `_button` suffix, pinned the same way: one that
 * drops out of `BUTTON_CAPTION_KEYS` is drawn as body copy, its leading token
 * inline instead of as the button's icon.
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
    // The support chat's pre-fill (`supportPrefill`), and `/paysupport`'s.
    'help.contact_prefill',
    'paysupport.prefill',
    // Toasts and alerts sent as nothing else (`menu.ts`, `quest-channel.ts`).
    'channel.verified',
    'quests.channel.not_subscribed',
    'quests.channel.verified',
    // A refused Stars checkout's `error_message` (`payments.ts`).
    'payments.stars.unknown_invoice',
    'payments.stars.already_handled',
    'payments.stars.unavailable',
    // AI support's Markdown messages (`ai-support.ts`).
    'ai_support.unavailable',
    'ai_support.intro',
    'ai_support.exited',
    // The `/` command list (`slash-commands.ts`).
    'commands.start.description',
    'commands.help.description',
    'commands.lang.description',
    'commands.rules.description',
    'commands.paysupport.description',
    // The bot's profile and the menu button (`apply-bot-settings.ts`).
    'bot.profile.name',
    'bot.profile.description',
    'bot.profile.short_description',
    'bot.menu_button_text',
    'menu_button.cabinet',
  ])('%s travels as plain text', (key) => {
    expect(botTextKeyMode(key)).toBe('plain')
  })

  it('leaves the neighbours as they were: the share button a caption, the hub copy', () => {
    expect(botTextKeyMode('invite.share_button')).toBe('buttonLabel')
    expect(botTextKeyMode('help.contact_button')).toBe('buttonLabel')
    expect(botTextKeyMode('referral.hub.title')).toBe('text')
  })
})

describe('botTextKeyMode — captions without the `_button` suffix', () => {
  it.each([
    // The way back on every screen (`renderSystemButton`).
    'back_to_menu',
    // The referral and partner hubs (`hubButton`, `invite.ts`).
    'referral.hub.open_cabinet',
    'referral.hub.open_exchange',
    'partner.hub.open_cabinet',
    // The language picker (`localeButton`, `lang.ts`).
    'lang.ru',
    'lang.en',
    // «Открыть приложение» after a payment (`inlineButton`, `start.ts`).
    'payment_return.open_app',
    // The password-reset link's button (`inlineButton`, `password-reset.ts`).
    'password_reset.button',
    // The trial button (`resolveTrialButton`, `trial-button.ts`).
    'menu.btn_trial_free',
    'menu.btn_trial_paid',
    // The operator's startup and credits cards (`cardButton`, `startup-notice.ts`).
    'bot_event.close',
    'bot_event.credits.github',
    'bot_event.credits.telegram',
    'bot_event.credits.support',
  ])('%s is a caption', (key) => {
    expect(botTextKeyMode(key)).toBe('buttonLabel')
  })
})

describe('botTextKeyMode — a key reiwa sends both as a message and as a toast', () => {
  // The message is the one place its pack emoji animates, so the field draws
  // what the message draws.
  it.each([
    'channel.not_subscribed',
    'access_mode.restricted',
    'access_mode.reg_blocked_new',
    'access_mode.invited_no_code',
    'quests.channel.retry',
    'quests.channel.link_first',
  ])('%s stays text', (key) => {
    expect(botTextKeyMode(key)).toBe('text')
  })
})
