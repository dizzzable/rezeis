/**
 * Bot texts reiwa shows as the answer to a pressed button (pure, no DI)
 * ──────────────────────────────────────────────────────────────────────
 * A toast or an alert over the chat is the text of `answerCallbackQuery`, and
 * Telegram takes it at 0-200 characters, counted as code points (TDLib
 * `utf8_length`), and refuses the whole answer past that. reiwa now cuts such
 * a text to fit (`fitCallbackAnswer`, `src/bot/lib/callback-answer.ts`), and
 * the menu or page under it is drawn either way — but the operator should meet
 * the limit where the text is written, not a cut sentence in the bot. So the
 * panel refuses to save these keys past 200 (`bot-texts.service.ts`), and the
 * SPA counts under the field (`web/src/features/bot-config/bot-text-limits.ts`,
 * pinned to this list by its parity test, and to reiwa's call sites by
 * `callback-answer-keys.reiwa.parity.test.ts` when the sibling checkout is
 * there).
 *
 * `alsoMessage`: the same key is ALSO sent as an ordinary message — the SPA
 * says so, since a message alone could be far longer. Each entry names where
 * reiwa shows it (as of 25.09.2026).
 */
export const CALLBACK_ANSWER_MAX_CHARS = 200;

export interface CallbackAnswerText {
  readonly key: string;
  readonly alsoMessage: boolean;
}

export const CALLBACK_ANSWER_TEXTS: readonly CallbackAnswerText[] = [
  // Toast over the main menu for a button the bot no longer knows
  // (`stale-button.ts` → `showMainMenu`, `start.ts`).
  { key: 'menu.updated', alsoMessage: false },
  // Alert on «В меню», on a stale button and on «Я подписался» under
  // RESTRICTED (`start.ts`, `menu.ts`); the `/start` refusal message too.
  { key: 'access_mode.restricted', alsoMessage: true },
  // Alerts when a newcomer presses «Я подписался» under REG_BLOCKED / INVITED
  // (`menu.ts`); the `/start` refusal messages too.
  { key: 'access_mode.reg_blocked_new', alsoMessage: true },
  { key: 'access_mode.invited_no_code', alsoMessage: true },
  // Toast from the channel gate on any button and from «Я подписался»
  // (`middleware/channel-gate.ts`, `menu.ts`); the not-subscribed notice
  // message too (`channel-join-prompt.ts`).
  { key: 'channel.not_subscribed', alsoMessage: true },
  // Toast on «Я подписался» once the subscription is seen (`menu.ts`).
  { key: 'channel.verified', alsoMessage: false },
  // Alerts from the quest's check button (`quest-channel.ts`); `retry` is also
  // said on `/start quest_channel_<id>` (`start.ts`), `link_first` also sent
  // when the quest's target cannot be found (`menu.ts`).
  { key: 'quests.channel.retry', alsoMessage: true },
  { key: 'quests.channel.link_first', alsoMessage: true },
  { key: 'quests.channel.not_subscribed', alsoMessage: false },
  { key: 'quests.channel.verified', alsoMessage: false },
];

const BY_KEY: ReadonlyMap<string, CallbackAnswerText> = new Map(
  CALLBACK_ANSWER_TEXTS.map((entry) => [entry.key, entry]),
);

/** The entry of `key` (case and surrounding spaces ignored), or `undefined` when it is not a button answer. */
export function callbackAnswerTextOf(key: string): CallbackAnswerText | undefined {
  return BY_KEY.get(key.trim().toLowerCase());
}
