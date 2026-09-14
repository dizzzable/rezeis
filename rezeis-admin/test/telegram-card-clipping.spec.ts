import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { clipHtmlCard } from '../src/common/services/system-events.service';

/**
 * The card that was refused rather than shortened.
 *
 * Telegram takes 4096 characters of message and 1024 of DOCUMENT CAPTION, and
 * the same card is used for both. Nothing trimmed it, so a long card came back
 * as `400 Bad Request: message caption is too long` — and on the relay route
 * that refusal is terminal on the first attempt, i.e. the error report an
 * operator most needs is the one that never arrives.
 *
 * Reachable without anything exotic: an error relayed from the cabinet carries
 * up to 2000 characters of message and the card frame is roughly 500.
 *
 * Cutting is not enough on its own. Telegram parses the body as HTML, so a cut
 * through `<blockquote>` or through `&amp;` trades "too long" for "malformed",
 * which is the same outcome by another name. These cases are mostly about that.
 */

const LIMIT = 1024;

describe('a card too long for its channel', () => {
  it('leaves a card that already fits completely alone', () => {
    const card = '<b>Событие</b>\n<blockquote>всё хорошо</blockquote>';
    assert.equal(clipHtmlCard(card, LIMIT), card);
  });

  it('brings an over-long card inside the limit', () => {
    const card = `<b>Заголовок</b>\n${'строка отчёта\n'.repeat(400)}`;
    const clipped = clipHtmlCard(card, LIMIT);
    assert.ok(clipped.length <= LIMIT, `${clipped.length} > ${LIMIT}`);
  });

  it('says that it cut, instead of ending early in silence', () => {
    // A shortened card that does not admit it reads as a complete one, and an
    // operator draws conclusions from where it stops.
    const clipped = clipHtmlCard(`<b>H</b>\n${'x'.repeat(4000)}`, LIMIT);
    assert.ok(clipped.endsWith('…'), clipped.slice(-40));
  });

  it('closes a block it cut the end off, so the markup still parses', () => {
    // THE POINT. `<blockquote>` opens on one line and closes many lines later;
    // dropping the tail strands the opening tag, and Telegram rejects the whole
    // message for that exactly as readily as for length.
    const card = `<b>Заголовок</b>\n<blockquote>${'подробность\n'.repeat(300)}</blockquote>`;
    const clipped = clipHtmlCard(card, LIMIT);

    assert.ok(clipped.length <= LIMIT);
    assert.equal(countOf(clipped, '<blockquote>'), countOf(clipped, '</blockquote>'));
    assert.equal(countOf(clipped, '<b>'), countOf(clipped, '</b>'));
  });

  it('closes several open tags innermost first', () => {
    const card = `<blockquote><b><code>${'y'.repeat(3000)}`;
    const clipped = clipHtmlCard(card, LIMIT);

    assert.ok(clipped.length <= LIMIT);
    assert.ok(
      clipped.includes('</code></b></blockquote>'),
      `nesting order is wrong: ${clipped.slice(-60)}`,
    );
  });

  it('does not cut an HTML entity in half', () => {
    // `escapeHtml` turns one `&` into five characters. Half of `&amp;` is not
    // an entity, and Telegram refuses the body over it.
    const card = '&amp;'.repeat(1000);
    const clipped = clipHtmlCard(card, LIMIT);

    assert.ok(clipped.length <= LIMIT);
    // The marker is a newline plus an ellipsis, so strip both before counting.
    const withoutMarker = clipped.slice(0, clipped.length - 2);
    assert.equal(withoutMarker.length % 5, 0, `entity split: ${withoutMarker.slice(-8)}`);
  });

  it('cuts on a line boundary when it can', () => {
    const card = `${'первая строка\n'.repeat(200)}`;
    const clipped = clipHtmlCard(card, LIMIT);

    assert.ok(clipped.length <= LIMIT);
    // Everything before the marker is whole lines: no half-word at the end.
    const body = clipped.slice(0, clipped.lastIndexOf('…'));
    assert.ok(
      body.split('\n').every((line) => line === '' || line === 'первая строка'),
      body.slice(-40),
    );
  });

  it('still fits when a single line is longer than the whole budget', () => {
    // Nothing to keep whole, so the head of the line is taken instead — the one
    // case where a line boundary cannot be honoured.
    const clipped = clipHtmlCard('z'.repeat(5000), LIMIT);
    assert.ok(clipped.length <= LIMIT);
    assert.ok(clipped.endsWith('…'));
  });

  it('keeps the long line in the MIDDLE, instead of dropping it and the rest', () => {
    // THE defect the first version had, and the one none of the cases above
    // could see. A real card opens with a short hashtag line and carries the
    // error message as ONE long line after it — so "stop at the first line that
    // does not fit" threw away the message and everything under it, and came
    // back 386 characters short of the budget. Every assertion above passed on
    // that result, which is why this fixture is shaped like a real card.
    const card =
      '#EventError\n<b>Ошибка</b>\n<blockquote>💬 Сообщение: ' + 'x'.repeat(2000) + '</blockquote>';

    const clipped = clipHtmlCard(card, LIMIT);

    assert.ok(clipped.length <= LIMIT);
    assert.ok(clipped.includes('Сообщение'), 'the message line was dropped whole');
    assert.ok(clipped.includes('xxxxxxxxxx'), 'the message text itself was dropped');
    assert.ok(clipped.length > LIMIT - 50, 'used only ' + clipped.length + ' of ' + LIMIT);
  });

  it('does not cut an emoji in half', () => {
    // These cards are full of emoji and `slice` counts UTF-16 code units, so an
    // odd offset splits a surrogate pair and Telegram refuses the whole body.
    const clipped = clipHtmlCard('#E\n' + 'a'.repeat(1015) + '🎯'.repeat(500), LIMIT);

    assert.ok(clipped.length <= LIMIT);
    assert.equal(hasLoneSurrogate(clipped), false, JSON.stringify(clipped.slice(-8)));
  });

  it('does not cut a tag in half', () => {
    // `<cod` is not markup, and `closersFor` cannot even see it to balance it.
    const clipped = clipHtmlCard('#E\n' + 'a'.repeat(1015) + '<code>секрет</code>', LIMIT);

    assert.ok(clipped.length <= LIMIT);
    const body = clipped.slice(0, clipped.length - 2);
    assert.equal(/<[a-z]*$/.test(body), false, body.slice(-16));
  });

  it('does not mistake an ampersand in prose for an entity', () => {
    // `AT&T` is not an entity. Backing off to before it with no lower bound
    // clipped a five-thousand-character card down to the two letters `AT`.
    const clipped = clipHtmlCard('#E\nAT&T ' + 'x'.repeat(5000), LIMIT);

    assert.ok(clipped.length > LIMIT - 50, 'used only ' + clipped.length + ' of ' + LIMIT);
  });
});

/**
 * Links
 * ═════
 * A card carries `<a href="…">` for a receipt, a checkout, a panel profile —
 * and a tag like that is as long as its URL. The cut looked for an open `<`
 * only in the last sixteen characters and balanced only four tag names, so a
 * cut inside a long URL kept `<a href="https://recei` and a cut inside the
 * link's text kept `<a href="…">Че` with no `</a>`. Either way Telegram
 * refuses the whole card, and a card that grows longer is exactly the one
 * that gets cut.
 */
describe('a card cut near a link', () => {
  const url = `https://receipt.example/r?${'item=1&amp;'.repeat(60)}end=1`;

  it('does not cut inside a long href that straddles the limit', () => {
    const before = '#E\n<blockquote>💰 Платёж: ' + 'a'.repeat(LIMIT - 200);
    const card = `${before}<a href="${url}">Чек</a></blockquote>`;
    // The fixture must really put the attribute across the limit.
    const hrefStart = card.indexOf('href="');
    assert.ok(hrefStart < LIMIT && hrefStart + url.length > LIMIT, 'the href does not straddle the limit');

    const clipped = clipHtmlCard(card, LIMIT);

    assert.ok(clipped.length <= LIMIT, `${clipped.length} > ${LIMIT}`);
    assertWellFormed(clipped);
    assert.ok(!clipped.includes('href="https://receipt.example'), 'half a link survived');
    assert.ok(clipped.length > LIMIT - 400, 'used only ' + clipped.length + ' of ' + LIMIT);
  });

  it('closes a link whose text the cut went through', () => {
    const card = `#E\n${'b'.repeat(LIMIT - 300)}<a href="https://panel.example/u/1">${'Открыть профиль '.repeat(40)}</a>`;

    const clipped = clipHtmlCard(card, LIMIT);

    assert.ok(clipped.length <= LIMIT, `${clipped.length} > ${LIMIT}`);
    assert.ok(clipped.includes('<a href="https://panel.example/u/1">'), 'the fixture never reached the link');
    assertWellFormed(clipped);
  });

  it('closes a link and the quote around it innermost first', () => {
    const link = '<a href="https://panel.example/u/1">';
    const card = `#E\n<blockquote><b>${'c'.repeat(500)}${link}${'текст ссылки '.repeat(80)}</a></b></blockquote>`;

    const clipped = clipHtmlCard(card, LIMIT);

    assert.ok(clipped.length <= LIMIT, `${clipped.length} > ${LIMIT}`);
    assert.ok(clipped.includes(link), 'the fixture never reached the link text');
    assert.ok(clipped.includes('</a></b></blockquote>'), `wrong closers: ${clipped.slice(-40)}`);
    assertWellFormed(clipped);
  });
});

/**
 * Markup Telegram's HTML parser accepts, as far as a clipped card can break
 * it: every `<` opens a whole tag, every entity is whole, and every tag that
 * opens is closed in reverse order. The trailing `…` marker is stripped first.
 */
function assertWellFormed(clipped: string): void {
  const body = clipped.endsWith('\n…') ? clipped.slice(0, -2) : clipped;
  const stack: string[] = [];
  let index = 0;
  while (index < body.length) {
    const char = body[index];
    if (char === '<') {
      const close = body.indexOf('>', index);
      assert.ok(close !== -1, `a tag is cut in half: ${JSON.stringify(body.slice(index, index + 40))}`);
      const tag = body.slice(index, close + 1);
      const match = /^<(\/?)([a-z][a-z0-9-]*)(\s[^>]*)?>$/i.exec(tag);
      assert.ok(match !== null, `not a tag: ${tag}`);
      if (match[3] !== undefined) {
        // An attribute value must be a whole quoted string.
        assert.match(match[3], /^(\s+[a-z-]+="[^"]*")+$/i, `broken attribute in ${tag}`);
      }
      const name = match[2]!.toLowerCase();
      if (match[1] === '/') {
        assert.equal(stack.pop(), name, `</${name}> closes something else in ${JSON.stringify(body.slice(-80))}`);
      } else {
        stack.push(name);
      }
      index = close + 1;
      continue;
    }
    if (char === '&') {
      assert.match(body.slice(index, index + 8), /^&(amp|lt|gt|quot);/, `a broken entity at ${index}`);
    }
    index += 1;
  }
  assert.deepStrictEqual(stack, [], `left open: ${stack.join(', ')}`);
}

function countOf(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

/**
 * Half of a surrogate pair left on its own — i.e. an emoji cut in two.
 *
 * Spelled out rather than `String.prototype.isWellFormed`, which needs the
 * es2024 lib this project does not target.
 */
function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const isHigh = code >= 0xd800 && code <= 0xdbff;
    const isLow = code >= 0xdc00 && code <= 0xdfff;
    if (!isHigh && !isLow) continue;
    if (isLow) return true; // a low half with no high before it
    const next = value.charCodeAt(index + 1);
    if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
    index += 1;
  }
  return false;
}
