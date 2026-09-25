/**
 * Bot texts Telegram takes only up to a length of its own, below the 8000
 * characters a text may have otherwise: every text reiwa shows as the answer
 * to a pressed button.
 *
 * A toast or an alert over the chat is the text of `answerCallbackQuery`,
 * which Telegram takes at 0-200 characters and refuses past that. «Меню
 * обновилось» (`menu.updated`, the toast reiwa answers an old button with) was
 * the first found: before 25.09.2026 a longer text made the whole answer fail
 * and the old button got no menu at all (review R2a-08). reiwa now cuts every
 * such text to fit, but the operator should see the limit where the text is
 * written instead of finding a cut sentence in the bot — for every key the bot
 * answers a button with (FX5b), not only that one.
 *
 * Some of them are ALSO sent as an ordinary message (`alsoMessage`), which
 * alone could be far longer; the field says why they are held to 200 too.
 *
 * Telegram counts characters as code points (TDLib `utf8_length`): an emoji is
 * one or two, never the two UTF-16 units `String.length` counts for most. The
 * server refuses the same (`bot-texts.service.ts`, its list in
 * `src/modules/bot-config/utils/callback-answer-texts.util.ts` — pinned to
 * this one by `bot-text-limits.parity.test.ts`, and both to reiwa's call sites
 * by `callback-answer-keys.reiwa.parity.test.ts`).
 */
const BUTTON_ANSWER_MAX_CHARS = 200

export interface ButtonAnswerText {
  readonly key: string
  /** reiwa also sends this key as an ordinary message. */
  readonly alsoMessage: boolean
}

/** Every text reiwa shows as the answer to a pressed button (as of 25.09.2026). */
export const BUTTON_ANSWER_TEXTS: readonly ButtonAnswerText[] = [
  // The toast over the main menu for a button the bot no longer knows.
  { key: 'menu.updated', alsoMessage: false },
  // Alerts under the access mode; the `/start` refusal messages too.
  { key: 'access_mode.restricted', alsoMessage: true },
  { key: 'access_mode.reg_blocked_new', alsoMessage: true },
  { key: 'access_mode.invited_no_code', alsoMessage: true },
  // The channel gate's toast; the not-subscribed notice message too.
  { key: 'channel.not_subscribed', alsoMessage: true },
  // «Я подписался» passed.
  { key: 'channel.verified', alsoMessage: false },
  // The quest's check button; `retry` and `link_first` are sent as messages too.
  { key: 'quests.channel.retry', alsoMessage: true },
  { key: 'quests.channel.link_first', alsoMessage: true },
  { key: 'quests.channel.not_subscribed', alsoMessage: false },
  { key: 'quests.channel.verified', alsoMessage: false },
]

const BY_KEY: ReadonlyMap<string, ButtonAnswerText> = new Map(BUTTON_ANSWER_TEXTS.map((entry) => [entry.key, entry]))

function entryOf(key: string): ButtonAnswerText | undefined {
  return BY_KEY.get(key.trim().toLowerCase())
}

/** The most characters `key` may hold, or `undefined` when only the general limit applies. */
export function botTextMaxChars(key: string): number | undefined {
  return entryOf(key) === undefined ? undefined : BUTTON_ANSWER_MAX_CHARS
}

/** Whether `key` is held to a pop-up's length although the bot also sends it as a message. */
export function botTextAlsoMessage(key: string): boolean {
  return entryOf(key)?.alsoMessage === true
}

/** Characters as Telegram counts them: code points. */
export function telegramCharCount(text: string): number {
  let count = 0
  for (const _codePoint of text) count += 1
  return count
}

/** How far `value` is over the limit of `key` — `null` when it fits or `key` has none. */
export function botTextOverLimit(
  key: string,
  value: string,
): { readonly max: number; readonly count: number } | null {
  const max = botTextMaxChars(key)
  if (max === undefined) return null
  const count = telegramCharCount(value)
  return count > max ? { max, count } : null
}
