import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { buildMenuInlineKeyboard } from '../src/modules/broadcast/utils/broadcast-menu-button.util';
import { buildPromoButton } from '../src/modules/broadcast/utils/broadcast-promo.util';

/**
 * What may and may not be put on the wire to api.telegram.org.
 *
 * ── The mistake this exists to stop ───────────────────────────────────────
 *
 * `buildPromoButton` looks like a Telegram inline button and is not one. It
 * returns a `NotifyButton` — `{ text, webAppPath }` — addressed to the reiwa
 * BOT, which joins `webAppPath` to a Mini App url the panel does not have and
 * renders the real `web_app` button. Telegram itself has never heard of
 * `webAppPath`.
 *
 * Fed into `reply_markup` it becomes a button with a label and no action, and
 * Telegram rejects the whole request with a 400 — once per recipient. An
 * attempt to "also give media broadcasts the promo button" did exactly that,
 * which would have turned a photo delivered without a button into a photo
 * delivered to nobody, plus a failed edit for every promo-tagged broadcast.
 *
 * No test in this repository inspected a Telegram request body, so it was
 * green everywhere. These do.
 *
 * ── The one keyboard that may go there ────────────────────────────────────
 *
 * «Кнопка «Меню» под постом» (15.10.2026) is a plain callback button,
 * `{ text, callback_data: 'menu:new' }` — Telegram's own shape, needing nothing
 * only the bot knows. It is the ONLY `reply_markup` a direct call may carry,
 * built by `buildMenuInlineKeyboard` and nothing else.
 */

const TELEGRAM_BUTTON_ACTIONS = [
  'url',
  'web_app',
  'callback_data',
  'login_url',
  'switch_inline_query',
  'switch_inline_query_current_chat',
  'copy_text',
  'pay',
] as const;

describe('the promo button is not a Telegram button', () => {
  it('carries no field Telegram would accept as an action', () => {
    const button = buildPromoButton('SALE30', 'Activate') as unknown as Record<string, unknown>;

    const actions = TELEGRAM_BUTTON_ACTIONS.filter((key) => button[key] !== undefined);
    assert.deepStrictEqual(
      actions,
      [],
      `it looks sendable to Telegram, which is exactly the trap: ${JSON.stringify(button)}`,
    );
    assert.equal(
      typeof button.webAppPath,
      'string',
      'the relay contract changed — re-read who is meant to resolve this button',
    );
  });
});

const readDeliverySource = (): string =>
  readFileSync(
    join(__dirname, '..', 'src', 'modules', 'broadcast', 'services', 'broadcast-delivery.service.ts'),
    'utf8',
  );

describe('the menu button is a Telegram button', () => {
  it('every button of its keyboard has exactly one action, and it is `menu:new`', () => {
    const keyboard = buildMenuInlineKeyboard();
    const buttons = keyboard.inline_keyboard.flat() as unknown as Array<Record<string, unknown>>;
    assert.equal(buttons.length, 1);
    for (const button of buttons) {
      const actions = TELEGRAM_BUTTON_ACTIONS.filter((key) => button[key] !== undefined);
      assert.deepStrictEqual(actions, ['callback_data']);
      assert.equal(button.callback_data, 'menu:new');
      assert.equal(typeof button.text, 'string');
    }
  });
});

describe('nothing in the delivery service hands the promo button to Telegram', () => {
  it('sends no reply_markup on a direct api.telegram.org call but the menu keyboard', () => {
    // Read as source rather than exercised, because the call sites are spread
    // across delivery, per-recipient edit and channel edit, and the defect is
    // the PRESENCE of a key — which no assertion about a return value can see.
    // A reintroduction of the promo button has to touch one of these strings.
    const source = readDeliverySource();

    // Strip comments: the file EXPLAINS this rule at length, and those mentions
    // are not code.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');

    const markupLines = code.split('\n').filter((line) => /reply_markup|replyMarkup/.test(line));
    assert.ok(markupLines.length > 0, 'the menu button reaches no direct call any more');
    for (const line of markupLines) {
      assert.ok(
        /reply_markup: input\.replyMarkup,/.test(line) ||
          /(reply_markup|replyMarkup): buildMenuInlineKeyboard\(\)/.test(line) ||
          /replyMarkup\?: ReturnType<typeof buildMenuInlineKeyboard>;/.test(line),
        `a direct Telegram call carries a keyboard the menu util did not build: ${line.trim()}`,
      );
      assert.equal(/promo/i.test(line), false, `the promo button is on its way to Telegram: ${line.trim()}`);
    }
  });

  it('still hands the button to the RELAY, which can resolve it', () => {
    // The negative control. Removing the button everywhere would pass the test
    // above and silently drop the feature from text broadcasts and the channel
    // post, where it does work.
    const source = readDeliverySource();

    assert.equal(
      /buttons: \[promoButton\]|buttons: promoButton/.test(source),
      true,
      'the promo button no longer reaches the channel post either',
    );
    assert.equal(
      /\.\.\.\(promoButton !== null \? \[promoButton\] : \[\]\)/.test(source),
      true,
      'the promo button no longer reaches the relay for a text post',
    );
  });
});
