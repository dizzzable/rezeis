/**
 * Bot texts Telegram takes only up to a length of its own, below the 8000
 * characters a text may have otherwise.
 *
 * «Меню обновилось» (`menu.updated`) is the toast reiwa answers an old button
 * with (`showMainMenu`, reiwa `src/bot/pages/start.ts`). A toast is the text of
 * `answerCallbackQuery`, which Telegram takes at 0-200 characters and refuses
 * past that. Before 25.09.2026 a longer text made the whole answer fail and
 * the old button got no menu at all; reiwa now cuts the toast to fit, but the
 * operator should see the limit where the text is written instead of finding
 * a cut sentence in the bot (review R2a-08).
 *
 * Telegram counts characters as code points (TDLib `utf8_length`): an emoji is
 * one or two, never the two UTF-16 units `String.length` counts for most. The
 * server refuses the same (`bot-texts.service.ts`).
 */
const MAX_CHARS_BY_KEY: ReadonlyMap<string, number> = new Map([['menu.updated', 200]])

/** The most characters `key` may hold, or `undefined` when only the general limit applies. */
export function botTextMaxChars(key: string): number | undefined {
  return MAX_CHARS_BY_KEY.get(key.trim().toLowerCase())
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
