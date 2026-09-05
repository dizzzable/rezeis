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
