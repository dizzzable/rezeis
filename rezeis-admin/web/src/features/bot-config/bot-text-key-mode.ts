/**
 * Which renderer a bot-config text KEY feeds.
 * ───────────────────────────────────────────
 * A stored bot text is drawn one of two ways, and the difference is not in the
 * string — it is in the key that names it:
 *
 *   • ordinary copy goes through reiwa's `renderBotCopy`, where a message may
 *     carry `custom_emoji` entities, so a pack entry with an id really does
 *     arrive as the animated emoji;
 *   • a few keys are read back as INLINE-BUTTON CAPTIONS and go through
 *     `renderButtonLabel` (reiwa `src/infrastructure/bot-config/emoji-utils.ts`
 *     :356-402), where a caption carries no entities at all: a LEADING token is
 *     cut out of the caption and shipped as `icon_custom_emoji_id`, and every
 *     other token collapses to its carrier glyph.
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
 * But the convention is not total. reiwa reads four captions from keys that do
 * not carry the suffix, and they are enumerated in `BUTTON_CAPTION_KEYS` below,
 * each with the callsite that proves it. A suffix rule alone would draw those
 * four as body copy, which is exactly as wrong as the bug being fixed.
 *
 * The suffix was checked in the other direction too, since a convention that
 * over-fires would be the more expensive mistake here. Every `_button` key in
 * reiwa's packs was traced: seven are captions, and the remaining three —
 * `subscribe.channel_button`, `subscribe.check_button`, `plans.open_app_button`
 * — are dead aliases that no code path reads at all, so no rendering of them is
 * observable. The suffix has no false positive to trade against its reach.
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
 * A third state exists in reiwa and neither mode describes it. Some captions are
 * built by handing `translator.t(...)` straight to `kb.url(...)` / `kb.text(...)`
 * without passing through `renderButtonLabel` at all — `lang.ru`, `lang.en`,
 * `bot_event.close`, `payment_return.open_app`, and the `/help` and error-
 * keyboard paths for `help.contact_button` among them. Those ship the shortcode
 * VERBATIM: no promotion, no glyph substitution, so the user reads `:slug:`.
 *
 * That is a reiwa defect rather than a panel one, and modelling it here would
 * mean this file claiming to know which of reiwa's callsites renders a key —
 * knowledge that goes stale silently and invisibly. `buttonLabel` remains the
 * closer of the two answers for such a key (a caption cannot carry an entity
 * either way), so `help.contact_button` still resolves correctly by suffix; the
 * keys that reach no renderer at all simply fall to `text`.
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
  // rules}.ts`, all reading `translator.t('back_to_menu', lang)`.
  'back_to_menu',
  // `hubButton(...)` — reiwa `bot/pages/invite.ts:255,256,335`.
  'referral.hub.open_cabinet',
  'referral.hub.open_exchange',
  'partner.hub.open_cabinet',
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
  if (normalized.startsWith(BUTTON_OVERRIDE_PREFIX)) return 'buttonLabel'
  if (normalized.endsWith(BUTTON_CAPTION_SUFFIX)) return 'buttonLabel'
  return BUTTON_CAPTION_KEYS.has(normalized) ? 'buttonLabel' : 'text'
}
