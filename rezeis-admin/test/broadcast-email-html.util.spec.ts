import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  renderBroadcastEmailHtml,
  renderBroadcastEmailText,
  renderOperatorHtml,
} from '../src/modules/broadcast/utils/broadcast-email-html.util';

/**
 * The email body of a broadcast.
 *
 * Two things are being held at once, and they pull against each other: the
 * operator's formatting has to survive into the inbox (it did not — that is the
 * reported defect), and nothing they can type may become markup the branded
 * wrapper did not intend. Escape-then-re-enable is what holds both, so the
 * tests below are mostly about what stays escaped.
 */

describe('operator formatting reaches the inbox', () => {
  it('keeps the tags the compose form promises', () => {
    // The placeholder in the composer says, verbatim: supports <b>, <i>, <a>.
    assert.equal(renderOperatorHtml('<b>bold</b>'), '<b>bold</b>');
    assert.equal(renderOperatorHtml('<i>italic</i>'), '<i>italic</i>');
    assert.equal(
      renderOperatorHtml('<a href="https://example.com">link</a>'),
      '<a href="https://example.com" target="_blank" rel="noopener noreferrer">link</a>',
    );
  });

  it('keeps the rest of the Telegram set', () => {
    for (const tag of ['strong', 'em', 'u', 's', 'del', 'code', 'pre', 'blockquote']) {
      assert.equal(renderOperatorHtml(`<${tag}>x</${tag}>`), `<${tag}>x</${tag}>`);
    }
  });

  it('turns newlines into breaks without eating the markup around them', () => {
    assert.equal(renderOperatorHtml('<b>a</b>\nb'), '<b>a</b><br>b');
  });

  it('unwraps a custom-emoji tag to the glyph it carries', () => {
    // Mail clients know nothing about `tg-emoji`; the fallback glyph is its text.
    assert.equal(renderOperatorHtml('<tg-emoji emoji-id="5368324170671202286">👍</tg-emoji>'), '👍');
  });
});

describe('nothing else becomes markup', () => {
  it('escapes a script tag instead of dropping or honouring it', () => {
    // Shown as text: ugly and safe. Stripping it silently would be a parser's
    // job, and a parser has to be right about every input.
    const out = renderOperatorHtml('<script>alert(1)</script>');
    assert.ok(!out.includes('<script'), 'a script tag reached the body');
    assert.match(out, /&lt;script&gt;/);
  });

  it('escapes an image, a style block and an event handler', () => {
    for (const raw of [
      '<img src=x onerror=alert(1)>',
      '<style>body{display:none}</style>',
      '<b onclick="steal()">x</b>',
    ]) {
      const out = renderOperatorHtml(raw);
      // The point is that nothing became LIVE markup. The characters may well
      // still be there — shown as text is the intended outcome — so the
      // assertion looks for an unescaped tag, not for the word.
      assert.ok(!/<(img|style)\b/i.test(out), `tag passed through: ${raw}`);
      assert.ok(!/<[a-z]+\s+[a-z-]+\s*=/i.test(out), `a live attribute survived: ${raw}`);
    }
  });

  it('refuses a javascript: href and leaves it as text', () => {
    const out = renderOperatorHtml('<a href="javascript:alert(1)">x</a>');
    assert.ok(!out.includes('<a href'), 'a javascript href became a link');
    assert.match(out, /&lt;a href/);
  });

  it('refuses a data: href', () => {
    const out = renderOperatorHtml('<a href="data:text/html,<script>alert(1)</script>">x</a>');
    assert.ok(!out.includes('<a href'), 'a data href became a link');
  });

  it('allows mailto, because a broadcast asking people to write in is ordinary', () => {
    assert.match(renderOperatorHtml('<a href="mailto:a@b.c">x</a>'), /^<a href="mailto:a@b\.c"/);
  });

  it('cannot be broken out of by a quote inside the href', () => {
    const out = renderOperatorHtml('<a href="https://a.example/&quot; onmouseover=&quot;x">y</a>');
    // A second attribute would need a real quote to close the href first. There
    // is none: whatever the operator typed stays inside the value.
    assert.ok(!/"\s+onmouseover/i.test(out), 'the href was closed and a handler added');
  });

  it('keeps an ampersand in a query string as an entity', () => {
    const out = renderOperatorHtml('<a href="https://a.example/?x=1&y=2">go</a>');
    assert.match(out, /href="https:\/\/a\.example\/\?x=1&amp;y=2"/);
  });
});

describe('the whole email body', () => {
  it('escapes the title with no exception, because it is plain text by contract', () => {
    const html = renderBroadcastEmailHtml('<b>Title</b>', 'body');
    assert.match(html, /&lt;b&gt;Title&lt;\/b&gt;/);
    assert.ok(!html.includes('<b>Title</b>'), 'the title was rendered as markup');
  });

  it('omits the heading entirely when there is no title', () => {
    assert.ok(!renderBroadcastEmailHtml(null, 'body').includes('<h2'));
    assert.ok(!renderBroadcastEmailHtml('   ', 'body').includes('<h2'));
  });

  it('renders the body through the same allowlist', () => {
    assert.match(renderBroadcastEmailHtml(null, '<b>x</b>'), /<b>x<\/b>/);
  });
});

describe('the plain-text alternative', () => {
  it('carries the words without the markup', () => {
    assert.equal(renderBroadcastEmailText('Hi', '<b>bold</b> and <i>italic</i>'), 'Hi\n\nbold and italic');
  });

  it('turns breaks and paragraphs back into newlines', () => {
    assert.equal(renderBroadcastEmailText(null, 'a<br>b'), 'a\nb');
    assert.equal(renderBroadcastEmailText(null, '<p>a</p><p>b</p>'), 'a\n\nb\n\n');
  });

  it('keeps the emoji a custom-emoji tag was standing in for', () => {
    assert.equal(renderBroadcastEmailText(null, '<tg-emoji emoji-id="1">👍</tg-emoji>'), '👍');
  });
});
