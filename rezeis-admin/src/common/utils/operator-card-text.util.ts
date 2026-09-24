/**
 * A subscriber's own words inside Telegram HTML the panel writes — shown as
 * they were typed.
 *
 * The operator's cards (system events, the error card, the operator's copy of
 * a notification) and the notifications themselves are Telegram HTML built from
 * a template and the event's values. Before Telegram sees it, the text goes
 * through a pass that resolves the OPERATOR's emoji tokens in it, across the
 * whole of it: `:slug:` becomes a pack emoji, `{{KEY}}` a bot-emoji slot and an
 * unknown key `•` (the bot's `renderNotifyBody` on `/notify-dev`,
 * `/notify-broadcast`, `/notify` and the document captions; the panel's own
 * `CustomEmojiService.substituteTelegramHtml` on notifications). The template
 * may carry such tokens — the operator wrote it with an emoji picker. A value
 * the SUBSCRIBER typed went through the same pass: a ticket subject «ключ
 * {{SUB_ID}} не работает» reached the operator as «ключ • не работает», and a
 * Telegram name `:fire:` as 🔥.
 *
 * Only the operator's template resolves tokens. A subscriber's text goes in
 * through this: escaped for HTML like any value, and with the three characters
 * a token is made of written as numeric character references — `:` as `&#58;`,
 * `{` as `&#123;`, `}` as `&#125;`. No token pattern matches them, the bot's
 * nor the panel's, and Telegram's HTML parser, which supports every numeric
 * reference, shows the characters as typed; so does an e-mail client for the
 * letter made from the same HTML. Nothing changes on the bot's side, so it
 * holds in front of every cabinet, older ones included.
 *
 * For Telegram HTML only: plain text (a toast, the cabinet's feed, a web push)
 * would show the references themselves.
 */
export function literalCardText(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/:/g, '&#58;')
    .replace(/\{/g, '&#123;')
    .replace(/\}/g, '&#125;');
}

/** WORD JOINER: no width, no break, nothing shown. */
const WORD_JOINER = String.fromCharCode(0x2060);

/**
 * `literalCardText` for PLAIN text — the subscriber's own cabinet feed, web
 * push, the text part of a letter — where there are no character references.
 *
 * Two passes read `:slug:` there. The panel's own (`substituteFallbacks`, the
 * plain copy of a notification) is kept off a subscriber's values by filling
 * them in after it (`renderFromTemplate`). The other is the cabinet's feed: it
 * draws `:slug:` as the operator's emoji over the whole row it shows (reiwa
 * `web/src/components/ui/emoji-text.tsx`, `EmojiText`), a subscriber's name
 * `:fire:` in it included. A WORD JOINER on each side of every `:` breaks the
 * token for that pass too and shows nothing, so the name reads as typed.
 * `{` and `}` need nothing: no plain-text reader fills placeholders after the
 * panel has.
 */
export function literalPlainText(value: unknown): string {
  return String(value).replace(/:/g, `${WORD_JOINER}:${WORD_JOINER}`);
}
