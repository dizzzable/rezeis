/**
 * Which renderer a bot-config text KEY feeds.
 * ───────────────────────────────────────────
 * A stored bot text is drawn one of three ways, and the difference is not in
 * the string — it is in the key that names it:
 *
 *   • ordinary copy goes through reiwa's `renderBotCopy`, where a message may
 *     carry `custom_emoji` entities, so a pack entry with an id really does
 *     arrive as the animated emoji;
 *   • a few keys are read back as INLINE-BUTTON CAPTIONS and go through
 *     `renderButtonLabel` (reiwa `src/infrastructure/bot-config/emoji-utils.ts`
 *     :356-402), where a caption carries no entities at all: a LEADING token is
 *     cut out of the caption and shipped as `icon_custom_emoji_id`, and every
 *     other token collapses to its carrier glyph;
 *   • a few keys travel as PLAIN TEXT — a link's `?text=`, the inline answer
 *     behind the cabinet's «Поделиться», a toast, the `/` command list, the
 *     bot's profile — with no entities and no icon, so every token collapses to
 *     its carrier glyph whatever the owner's Premium (`PLAIN_TEXT_KEYS` below,
 *     each with its callsite).
 *
 * The "Тексты бота" tab edits ANY key — its key field is free text, validated
 * only against `/^[a-z0-9._-]+$/i` — so it cannot be told which of the two it is
 * holding. It has to work it out from the key, and it was not: every field there
 * asked for `mode: 'text'`, so a caption key was drawn with its leading token
 * inline and its other tokens as pack pictures, neither of which is what the
 * button ships. The same key opened through the bot-flow screen inspector
 * (`TextKeyEditor layout="buttonLabel"`) was drawn correctly, so one stored
 * string had two different renderings in one panel.
 *
 * WHY THE ANSWER IS A CONVENTION *AND* A LIST, NOT EITHER ALONE
 *
 * reiwa names caption keys `<screen>.<action>_button`, and that convention is
 * worth honouring directly: it is the only part of this rule that keeps working
 * when reiwa adds a caption key, which it does without asking the panel. A list
 * on its own would silently go stale and start drawing new captions as body
 * copy — the very defect this file exists to close.
 *
 * But the convention is not total. reiwa reads captions from keys that do not
 * carry the suffix, and they are enumerated in `BUTTON_CAPTION_KEYS` below, each
 * with the callsite that proves it. A suffix rule alone would draw those as body
 * copy, which is exactly as wrong as the bug being fixed.
 *
 * The suffix was checked in the other direction too, since a convention that
 * over-fires would be the more expensive mistake here. Every `_button` key in
 * reiwa's packs was traced (again on 23.09.2026): nine are captions, and the
 * remaining three — `subscribe.channel_button`, `subscribe.check_button`,
 * `plans.open_app_button` — are dead aliases that no code path reads at all, so
 * no rendering of them is observable. The suffix has no false positive to trade
 * against its reach.
 *
 * WHY THIS ERRS TOWARD `text`
 *
 * The two mistakes are not symmetric in cost, but neither is free, so the
 * default is the one that adds nothing:
 *
 *   • guessing `buttonLabel` for ordinary copy REMOVES a leading token from the
 *     rendered body and relabels it "button icon — not part of the caption".
 *     The operator is shown a caption they do not have, and an emoji that will
 *     in fact appear in the message goes missing from the preview of it;
 *   • guessing `text` for a caption draws tokens richer than they ship — the
 *     failure that was already there.
 *
 * The first invents a UI element out of nothing and is unrecognisable as an
 * error; the second overstates a token, which the per-token tooltips still
 * describe honestly. So an unrecognised key stays `text`, and a key only earns
 * `buttonLabel` on positive evidence: reiwa's own suffix, reiwa's own override
 * namespace, or a callsite recorded below.
 *
 * WHAT THIS DELIBERATELY DOES NOT MODEL
 *
 * A key reiwa sends BOTH ways — a message on one path, a toast or an alert on
 * another: `channel.not_subscribed`, `access_mode.restricted`,
 * `access_mode.reg_blocked_new`, `access_mode.invited_no_code`,
 * `quests.channel.retry`, `quests.channel.link_first`. One field can draw one
 * answer, and it stays `text`: the message is the one place such a pack emoji
 * animates, and the toast shows the same text with glyphs.
 *
 * A third state used to exist in reiwa and neither mode described it: captions
 * built by handing `translator.t(...)` straight to `kb.url(...)` /
 * `kb.text(...)`, which shipped the shortcode VERBATIM — `lang.ru`, `lang.en`,
 * `bot_event.close`, `payment_return.open_app`, and `help.contact_button` on
 * `/help` and the error keyboard among them. Since 23.09.2026 every one of them
 * goes through a button renderer (`localeButton`, `cardButton`, `inlineButton`,
 * `renderSystemButton`), and so does every text reiwa's bot sends — the ones
 * without the suffix are listed below. A key found reaching Telegram raw is a
 * reiwa defect to fix there, not a mode to model here.
 */
import type { EmojiFieldMode } from '@/features/custom-emoji/emoji-field-render'

/**
 * Captions reiwa reads from keys that do NOT end in `_button`, each with the
 * callsite that renders it through `renderButtonLabel` / `renderSystemButton`.
 * Additions belong here only with a callsite to point at.
 */
const BUTTON_CAPTION_KEYS: ReadonlySet<string> = new Set([
  // `renderSystemButton(backLabel, 'back', …)` on every screen that offers a
  // way back — reiwa `bot/pages/{dynamic-screen,help,help-callback,invite,
  // rules,paysupport}.ts`, all reading `translator.t('back_to_menu', lang)`.
  'back_to_menu',
  // `hubButton(...)` — reiwa `bot/pages/invite.ts`.
  'referral.hub.open_cabinet',
  'referral.hub.open_exchange',
  'partner.hub.open_cabinet',
  // The language picker's two buttons — `localeButton(...)`, reiwa
  // `bot/pages/lang.ts`.
  'lang.ru',
  'lang.en',
  // «Открыть приложение» under the payment-return acknowledgement —
  // `inlineButton(...)`, reiwa `bot/pages/start.ts`.
  'payment_return.open_app',
  // The password-reset link's button — `inlineButton(...)`, reiwa
  // `bot/pages/password-reset.ts`. Its key ends in `.button`, not `_button`.
  'password_reset.button',
  // The trial button at the top of the main menu — `renderButtonLabel` in
  // `resolveTrialButton`, reiwa `bot/widgets/trial-button.ts`.
  'menu.btn_trial_free',
  'menu.btn_trial_paid',
  // The operator's startup and credits cards — `cardButton(...)`, reiwa
  // `bot/lib/startup-notice.ts`.
  'bot_event.close',
  'bot_event.credits.github',
  'bot_event.credits.telegram',
  'bot_event.credits.support',
])

/**
 * Keys reiwa sends as plain text — `renderBotCopy(…, false).text` or `plainCopy`
 * (reiwa `bot/widgets/operator-copy.ts`), no entities — each with its callsite.
 * A pack emoji in them arrives as its glyph even for a Premium owner, so drawing
 * the pack picture promises the operator an emoji the reader never sees.
 */
const PLAIN_TEXT_KEYS: ReadonlySet<string> = new Set([
  // The `text` of Telegram's share link — `shareText`, reiwa
  // `bot/pages/invite.ts`.
  'invite.share_prompt',
  'invite.share_web_line',
  // The inline answer behind the cabinet's «Поделиться» — `plain(...)`, reiwa
  // `bot/pages/inline-share.ts`: the result's title and description, the
  // message, the URL button under it and the composer's start button.
  'inline.share.title',
  'inline.share.description',
  'inline.share.message',
  'inline.share.title_plain',
  'inline.share.description_plain',
  'inline.share.message_plain',
  'inline.share.open',
  'inline.share.start',
  // The `?text=` a support chat opens with — `supportPrefill`, reiwa
  // `bot/widgets/main-keyboard.ts`.
  'help.contact_prefill',
  // The same for `/paysupport`'s support chat — reiwa `bot/pages/paysupport.ts`.
  'paysupport.prefill',
  // Toasts and alerts on a pressed button, sent as nothing else — reiwa
  // `bot/pages/menu.ts` («Я подписался» passed) and `bot/pages/quest-channel.ts`.
  'channel.verified',
  'quests.channel.not_subscribed',
  'quests.channel.verified',
  // A refused Stars checkout's `error_message`, which Telegram shows as plain
  // text — reiwa `bot/pages/payments.ts`.
  'payments.stars.unknown_invoice',
  'payments.stars.already_handled',
  'payments.stars.unavailable',
  // AI support's three messages sent with `parse_mode: 'Markdown'`, which takes
  // no entities and has no custom-emoji syntax — reiwa `bot/pages/ai-support.ts`.
  'ai_support.unavailable',
  'ai_support.intro',
  'ai_support.exited',
  // The `/` command list — `slashCommands`, reiwa `bot/lib/slash-commands.ts`
  // (`setMyCommands`).
  'commands.start.description',
  'commands.help.description',
  'commands.lang.description',
  'commands.rules.description',
  'commands.paysupport.description',
  // The bot's profile and the button beside the message input, which the bot
  // card saves as `bot.*` rows this tab lists too — `applyBotSettings`, reiwa
  // `bot/lib/apply-bot-settings.ts` (`setMyName`, `setMyDescription`,
  // `setMyShortDescription`, `setChatMenuButton`).
  'bot.profile.name',
  'bot.profile.description',
  'bot.profile.short_description',
  'bot.menu_button_text',
  'menu_button.cabinet',
])

/**
 * reiwa's naming convention for a caption key. Matched as a suffix so a caption
 * key added upstream is drawn correctly without a panel release.
 */
const BUTTON_CAPTION_SUFFIX = '_button'

/**
 * The operator's per-button caption overrides: `button.<id>` and
 * `button.<id>.<lang>`, resolved by `Translator.resolveButtonLabel` (reiwa
 * `src/infrastructure/i18n/translator/translator.ts:121-129`). Everything in
 * this namespace is a caption by construction, whatever its tail looks like.
 */
const BUTTON_OVERRIDE_PREFIX = 'button.'

/**
 * How the field editing `key` should draw its value.
 *
 * Case is folded because the key field accepts either (`/^[a-z0-9._-]+$/i`)
 * while every key reiwa actually reads is lowercase, so a capitalised variant is
 * a typo of a known key rather than a different key.
 */
export function botTextKeyMode(key: string): EmojiFieldMode {
  const normalized = key.trim().toLowerCase()
  if (normalized.length === 0) return 'text'
  if (PLAIN_TEXT_KEYS.has(normalized)) return 'plain'
  if (normalized.startsWith(BUTTON_OVERRIDE_PREFIX)) return 'buttonLabel'
  if (normalized.endsWith(BUTTON_CAPTION_SUFFIX)) return 'buttonLabel'
  return BUTTON_CAPTION_KEYS.has(normalized) ? 'buttonLabel' : 'text'
}
