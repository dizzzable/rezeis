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
});

function countOf(value: string, needle: string): number {
  return value.split(needle).length - 1;
}
