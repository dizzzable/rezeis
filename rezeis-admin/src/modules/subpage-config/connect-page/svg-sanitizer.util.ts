import { createHash } from 'node:crypto';

/**
 * svg-sanitizer.util
 * ──────────────────
 * Turns the SVG an operator pasted into markup the cabinet may put in a page.
 *
 * The workflow is the one the donor's editor established and operators already
 * know: open tabler.io/icons, press "Copy SVG", paste. That is a good workflow
 * and worth keeping — but it means arbitrary markup, authored in one image,
 * crosses into another image and is rendered as HTML in a signed-in customer's
 * browser. SVG is not a picture format in that position; it is a document
 * format that can carry `<script>`, `<foreignObject>` with arbitrary HTML,
 * event handlers on any element, and external references.
 *
 * The panel is the only place that can do this: it is the only place that sees
 * the write. Sanitizing in the cabinet instead would put the check downstream of
 * storage, which is exactly the arrangement that left v1's catalog unvalidated —
 * and it would have to be repeated in every future consumer.
 *
 * ── Allow-list, not deny-list ────────────────────────────────────────────────
 *
 * A deny-list of dangerous elements is a list of the attacks known on the day it
 * was written. What an icon actually needs is small and stable, so everything
 * outside it is dropped: unknown elements, unknown attributes, every `on*`
 * handler, and every attribute value that resolves to a scheme. An icon that
 * needed something outside this list is an icon that was doing something other
 * than being an icon.
 *
 * This is a sanitizer for TRUSTED-ISH INPUT — an authenticated operator with the
 * permission to edit this config. It is not a defence against a determined
 * attacker with write access to the panel, because that attacker already has
 * better options. It is a defence against a paste that carried more than the
 * person thought it did.
 */

/**
 * Elements an icon is built from. Everything else is dropped whole.
 *
 * `use`, `defs`, the gradients, `clipPath` and `mask` were here and are gone.
 * Two reasons, and the second is the reason the first mattered: every one of
 * them can only be reached through `url(#…)` or an `href` fragment, and `url(`
 * is stripped unconditionally — so they were already inert decoration. And
 * `use` is a billion-laughs vector: ten nested groups referencing each other
 * fit in 1.9 KB, pass every ceiling here, and expand to ten billion nodes in
 * the customer's browser. Keeping five dead elements to enable one live attack
 * is a poor trade.
 */
const ALLOWED_ELEMENTS = new Set([
  'svg',
  'g',
  'path',
  'circle',
  'ellipse',
  'rect',
  'line',
  'polyline',
  'polygon',
  'title',
  'desc',
  // ── Paint servers, admitted deliberately ──────────────────────────────────
  //
  // These were excluded on the reasoning quoted above: unreachable, because
  // `url(` was stripped unconditionally, therefore dead weight. That reasoning
  // was sound and it had a cost nobody had measured — most modern vendor marks
  // paint with `fill="url(#gradient)"`, so the official INCY icon came through
  // at 4476 bytes in, 1640 out, with `<defs>`, `clip-path` and EVERY fill
  // removed: a stack of black rectangles where a logo should be.
  //
  // They are admitted with the two things that made them unsafe now handled:
  // `url()` is allowed ONLY in the `url(#local-fragment)` form and only on the
  // three attributes that paint, and every `id` is rewritten per icon so two
  // logos on one page cannot share a gradient (see `idPrefix`).
  //
  // `use` stays out — it is the billion-laughs vector, and nothing about
  // gradients needs it. So do `pattern`, `mask` and `filter`: each can carry or
  // fetch an image, which is the one thing an icon must never do.
  'defs',
  'lineargradient',
  'radialgradient',
  'stop',
  'clippath',
]);

/**
 * Elements whose spelling the browser cares about.
 *
 * SVG is case-sensitive where HTML is not: `<lineargradient>` is not an
 * element, it is an unknown tag that paints nothing. The tokenizer lower-cases
 * for comparison, so the canonical spelling has to be restored on the way out.
 */
const ELEMENT_CASE: Readonly<Record<string, string>> = {
  lineargradient: 'linearGradient',
  radialgradient: 'radialGradient',
  clippath: 'clipPath',
};

/**
 * Attributes an icon is drawn with.
 *
 * `style` is deliberately absent: it is a second language inside an attribute,
 * with its own `url()` and its own escaping, and an icon does not need it.
 */
const ALLOWED_ATTRIBUTES = new Set([
  'viewbox',
  'xmlns',
  'xmlns:xlink',
  'width',
  'height',
  'fill',
  'fill-rule',
  'fill-opacity',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-dasharray',
  'stroke-opacity',
  'stroke-miterlimit',
  'opacity',
  'd',
  'points',
  'x',
  'y',
  'x1',
  'y1',
  'x2',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'transform',
  'offset',
  'stop-color',
  'stop-opacity',
  'clip-rule',
  'aria-hidden',
  'role',
  'focusable',
  // Paint-server plumbing. `id` is back, and it is only safe because every one
  // of them is rewritten per icon before it reaches the page — see `idPrefix`.
  'id',
  'clip-path',
  'clippathunits',
  'gradientunits',
  'gradienttransform',
  'spreadmethod',
  'fx',
  'fy',
]);

/**
 * Attributes whose spelling the browser cares about, same reason as elements.
 */
const ATTRIBUTE_CASE: Readonly<Record<string, string>> = {
  viewbox: 'viewBox',
  clippathunits: 'clipPathUnits',
  gradientunits: 'gradientUnits',
  gradienttransform: 'gradientTransform',
  spreadmethod: 'spreadMethod',
};

/** The only three attributes that may name a paint server. */
const PAINT_ATTRIBUTES = new Set(['fill', 'stroke', 'clip-path']);

/**
 * A reference to something defined inside THIS icon, and nothing else.
 *
 * `url(#a)` is a fragment: it resolves in the current document and fetches
 * nothing. `url(http…)`, `url(//…)`, `url(data:…)` all reach outward, and one
 * of them in a customer's page is a request that says which customer opened
 * which screen. The fragment itself is restricted to the characters an id may
 * hold, so nothing can be smuggled through the parentheses.
 */
const LOCAL_PAINT_REFERENCE = /^url\(\s*#([A-Za-z_][\w.:-]*)\s*\)$/;
const ID_VALUE = /^[A-Za-z_][\w.:-]*$/;

/**
 * Values that may not appear in an attribute.
 *
 * `id` and `class` were allowed and are not any more. Both are written verbatim
 * into a page this markup does not own: `class="fixed inset-0 z-50"` are real
 * utilities in the cabinet's stylesheet and lift the icon out of the flow over
 * everything else, and an `id` collides with the page's own — including with
 * the same icon drawn twice. `href` went with `use`.
 */
const SCHEME_LIKE = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Strip paint references whose definition did not survive the same pass.
 *
 * ── Why a dangling reference is worse than none ──────────────────────────────
 *
 * `fill="url(#gone)"` paints NOTHING — the shape is invisible rather than
 * black. And `clip-path="url(#gone)"` is worse still: an empty or missing clip
 * path clips its subject away entirely, so an icon that merely lost its colours
 * loses its whole drawing instead.
 *
 * That happens for real. A `<mask>` is still banned, and a vendor export that
 * defines its gradient inside one arrives here with the definition dropped and
 * the reference intact.
 *
 * Falling back to no attribute at all is the honest answer: the shape draws in
 * the inherited colour, which is the same place an icon with no fill lands, and
 * the operator is told through `removed` rather than shown a blank square.
 */
function dropDanglingReferences(markup: string, removed: Set<string>): string {
  const defined = new Set(
    Array.from(markup.matchAll(/\sid="([^"]+)"/g), (m) => m[1]),
  );
  return markup.replace(
    /\s(fill|stroke|clip-path)="url\(#([^)"]+)\)"/g,
    (whole, attribute: string, target: string) => {
      if (defined.has(target)) return whole;
      removed.add(`@${attribute}`);
      return '';
    },
  );
}

/**
 * `<?xml …?>`, `<!DOCTYPE …>` and comments, in any order, before the drawing.
 *
 * Repeated so an export carrying a prolog AND a comment AND a doctype — which
 * Illustrator produces by default — reaches the same place as a bare `<svg>`.
 */
const LEADING_PREAMBLE = /^(?:\s*(?:<\?[^>]*\?>|<!DOCTYPE[^>]*>|<!--[\s\S]*?-->))*\s*/i;

export interface SanitizeIconResult {
  readonly markup: string;
  /** What was thrown away, for telling the operator rather than silently fixing it. */
  readonly removed: readonly string[];
}

export class InvalidIconError extends Error {}

// Matches the schema's per-icon ceiling rather than doubling it: at 64 KB this
// never fired, because zod refused at 32 KB first.
const MAX_INPUT_BYTES = 32 * 1024;
const MAX_NODES = 2_000;

/**
 * Parse enough of the markup to rebuild it safely.
 *
 * A hand-rolled tokenizer rather than a DOM: the API runs on Node, has no DOM,
 * and pulling one in to read an icon would put a parser with its own quirks
 * between an operator's paste and a customer's screen. The tokenizer accepts a
 * strict subset — well-formed tags, quoted attributes — and refuses anything it
 * cannot read rather than guessing, because guessing is how a sanitizer and a
 * renderer come to disagree about what a string means.
 */
/**
 * A prefix that is unique to this DRAWING and stable across sanitizations.
 *
 * ── Why ids have to be rewritten at all ──────────────────────────────────────
 *
 * Every icon is injected into ONE page. Two exported vendor logos will both
 * contain `paint0_linear_11_16637` — the number comes from the design tool, not
 * from the brand — and `url(#paint0_linear_11_16637)` resolves to whichever
 * definition the browser met first. So the second logo silently wears the
 * first one's gradient. That is the reason `id` was banned outright, and it is
 * a real defect, not a theoretical one.
 *
 * Prefixing every id and every reference with a per-drawing string removes it:
 * two different drawings can no longer name the same thing, and the same
 * drawing used twice names it identically, which is correct.
 *
 * ── Why it has to be idempotent, and how ─────────────────────────────────────
 *
 * `connect-page-default.spec` asserts the shipped icons come out of this
 * byte-for-byte unchanged, and every save re-runs it over markup a previous
 * save produced. A prefix computed from the markup ITSELF cannot do that: the
 * first pass rewrites more than the ids, so the second pass hashes a different
 * string, mints a different prefix, and produces `iBBBB-iAAAA-g`.
 *
 * Two answers, in order:
 *
 *   1. The icon's own KEY, when the caller has it. That is the icon's identity
 *      — stable by definition, readable in the output, and the same for the
 *      same icon on every save.
 *   2. Failing that, the marker already in the markup. An id that reads
 *      `i0a1b2c3d-…` was scoped by a previous pass, so that pass's prefix is
 *      reused rather than a new one stacked on top.
 *
 * Only a first pass over an unkeyed, unscoped icon reaches the hash.
 */
const SCOPE_MARKER = /[\s"]id\s*=\s*"(i[0-9a-f]{8})-/i;

function idPrefixFor(source: string, scope: string | undefined): string {
  if (scope !== undefined && scope.trim().length > 0) {
    // A HASH of the key, not a cleaned-up copy of it. Slugifying collapsed
    // runs, mapped `_` onto `-` and trimmed the ends, so `clash_meta`,
    // `clash-meta` and `clash--meta` all became `iclash-meta` — three distinct
    // icons sharing one prefix, which is the gradient-collision this scoping
    // exists to prevent. A digest is injective enough and cannot be collapsed.
    return `i${createHash('sha1').update(scope.trim()).digest('hex').slice(0, 8)}`;
  }
  const existing = SCOPE_MARKER.exec(source);
  if (existing !== null) return existing[1];
  return `i${createHash('sha1').update(source).digest('hex').slice(0, 8)}`;
}

export function sanitizeIconMarkup(
  input: string,
  /**
   * The icon's key, when the caller knows it.
   *
   * Used to scope the ids inside this drawing so two icons on one page cannot
   * share a gradient. Optional because the sanitizer is also called on markup
   * that has no key yet; see `idPrefixFor` for what happens then.
   */
  scope?: string,
): SanitizeIconResult {
  const source = input.trim();
  if (source.length === 0) throw new InvalidIconError('The icon is empty');
  if (Buffer.byteLength(source, 'utf8') > MAX_INPUT_BYTES) {
    throw new InvalidIconError('The icon is too large to be an icon');
  }
  // Most `.svg` files on disk open with `<?xml …?>`, a doctype, or an editor's
  // generator comment. Refusing those told an operator their own export was
  // "not an SVG" — and the tokenizer below already drops all three, so the
  // refusal was about the FIRST byte and nothing else. Skipped here so the
  // check is about whether this is a drawing, not about how it was saved.
  const drawing = source.replace(LEADING_PREAMBLE, '');
  if (!/^<svg[\s>]/i.test(drawing)) {
    throw new InvalidIconError('An icon must start with an <svg> element');
  }

  const removed = new Set<string>();
  const idPrefix = idPrefixFor(drawing, scope);
  const out: string[] = [];
  const open: string[] = [];
  let nodes = 0;
  let i = 0;

  while (i < drawing.length) {
    const lt = drawing.indexOf('<', i);
    if (lt === -1) {
      appendText(out, drawing.slice(i));
      break;
    }
    appendText(out, drawing.slice(i, lt));

    // Comments, CDATA, doctypes and processing instructions carry nothing an
    // icon needs and are the usual smuggling wrappers. Dropped, not parsed.
    if (drawing.startsWith('<!--', lt)) {
      const end = drawing.indexOf('-->', lt + 4);
      if (end === -1) throw new InvalidIconError('The icon has an unterminated comment');
      removed.add('comment');
      i = end + 3;
      continue;
    }
    if (drawing.startsWith('<!', lt) || drawing.startsWith('<?', lt)) {
      const end = drawing.indexOf('>', lt);
      if (end === -1) throw new InvalidIconError('The icon has an unterminated declaration');
      removed.add('declaration');
      i = end + 1;
      continue;
    }

    const gt = findTagEnd(drawing, lt);
    if (gt === -1) throw new InvalidIconError('The icon has an unterminated tag');
    const raw = drawing.slice(lt + 1, gt);
    i = gt + 1;

    if (raw.startsWith('/')) {
      // Compared canonically, not lowercased: SVG has camel-cased elements
      // (`linearGradient`, `clipPath`) and lowercasing only the closing tag
      // makes every gradient look like mismatched markup.
      const closing = canonicalElement(raw.slice(1).trim());
      const expected = open[open.length - 1];
      if (expected === undefined) continue;
      if (closing === null || expected !== closing) {
        throw new InvalidIconError(`The icon closes <${raw.slice(1).trim()}> before <${expected}>`);
      }
      open.pop();
      out.push(`</${ELEMENT_CASE[closing] ?? closing}>`);
      continue;
    }

    if ((nodes += 1) > MAX_NODES) throw new InvalidIconError('The icon has too many elements');

    const selfClosing = raw.endsWith('/');
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const nameMatch = /^([a-zA-Z][a-zA-Z0-9:-]*)/.exec(body);
    if (nameMatch === null) throw new InvalidIconError('The icon has a tag without a name');
    const name = nameMatch[1];
    const lower = name.toLowerCase();

    const canonical = canonicalElement(name);
    if (canonical === null) {
      // Dropping the tag but keeping its children would surface the contents of
      // a `<script>` as text. The whole subtree goes.
      removed.add(`<${lower}>`);
      if (!selfClosing) i = skipSubtree(source, i, lower);
      continue;
    }

    const attrs = sanitizeAttributes(body.slice(nameMatch[0].length), removed, idPrefix);
    out.push(`<${ELEMENT_CASE[canonical] ?? canonical}${attrs}${selfClosing ? '/>' : '>'}`);
    if (!selfClosing) open.push(canonical);
  }

  if (open.length > 0) throw new InvalidIconError(`The icon never closes <${open[open.length - 1]}>`);

  const markup = out.join('').trim();
  if (!markup.startsWith('<svg')) throw new InvalidIconError('Nothing usable was left after cleaning');
  // An `<svg></svg>` passes every check above and draws nothing. Saving it
  // gives the operator a library entry that renders as a blank square, and the
  // blankness is indistinguishable from a styling problem — so the refusal
  // happens here, while the paste is still on screen.
  if (!DRAWS_SOMETHING.test(markup)) {
    throw new InvalidIconError('Nothing was left to draw after cleaning');
  }
  return { markup: dropDanglingReferences(markup, removed), removed: [...removed].sort() };
}

/**
 * The allowed spelling of an element name, or null when it is not allowed.
 *
 * SVG element names are case-sensitive and several are camel-cased, so a single
 * lowercase comparison rejects `linearGradient` and a single verbatim one
 * rejects `LINEARGRADIENT`. One function decides, and both the open and the
 * close path ask it — the alternative is two spellings of the same rule, which
 * is how the close path came to disagree with the open one.
 */
function canonicalElement(name: string): string | null {
  if (ALLOWED_ELEMENTS.has(name)) return name;
  const lower = name.toLowerCase();
  if (ALLOWED_ELEMENTS.has(lower)) return lower;
  for (const allowed of ALLOWED_ELEMENTS) {
    if (allowed.toLowerCase() === lower) return allowed;
  }
  return null;
}

/**
 * Elements that actually put ink on the canvas.
 *
 * Matched as whole tag names, not as substrings. `markup.includes('<line')` was
 * true for `<linearGradient` the moment gradients were allowed in, so a file
 * containing nothing but definitions passed the "something was left to draw"
 * refusal and stored as a blank icon. The controlling case is exact:
 * `<radialGradient>` alone was refused, `<linearGradient>` alone was not.
 *
 * `use` is in the list and is banned everywhere else, so it can never appear —
 * kept only so this list reads as "what ink looks like" rather than as a
 * carefully pruned subset.
 */
const DRAWING_ELEMENTS = ['path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon', 'use'];
// `String.raw`, because `\s` inside an ordinary template literal is a STRING
// escape and collapses to a bare `s` — the regex then read `[s/>]` and matched
// nothing, so every icon was refused as "nothing left to draw".
const DRAWS_SOMETHING = new RegExp(
  String.raw`<(?:${DRAWING_ELEMENTS.join('|')})[\s/>]`,
  'i',
);

// Anchored. Unanchored, `.test(text.slice(at))` copied the rest of the string
// and scanned all of it for every single `&` — quadratic, and one 32 KB icon of
// bare ampersands blocked the event loop for half a second. Two hundred of them
// in one request is a minute and a half of synchronous CPU, on an endpoint that
// does not even write.
const ENTITY = /^&(?:[a-zA-Z][a-zA-Z0-9]{1,30}|#\d{1,7}|#x[0-9a-fA-F]{1,6});/;

function appendText(out: string[], text: string): void {
  if (text.trim().length === 0) return;
  // `<` and `>` always go; `&` only when it is not already opening an entity —
  // escaping it unconditionally turns `&lt;` into a visible `&lt;` and mangles
  // every title that was correctly escaped by whoever produced the icon.
  out.push(
    text.replace(/[<>&]/g, (ch, at: number) => {
      if (ch === '<') return '&lt;';
      if (ch === '>') return '&gt;';
      return ENTITY.test(text.slice(at)) ? '&' : '&amp;';
    }),
  );
}

/** The `>` that ends a tag, skipping the ones inside quoted attribute values. */
function findTagEnd(source: string, from: number): number {
  let quote: string | null = null;
  for (let i = from + 1; i < source.length; i += 1) {
    const ch = source[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '>') return i;
  }
  return -1;
}

/** Everything up to the matching close tag, nesting included. */
function skipSubtree(source: string, from: number, name: string): number {
  let depth = 1;
  let i = from;
  const open = new RegExp(`<${name}(\\s|/|>)`, 'i');
  const close = new RegExp(`</${name}\\s*>`, 'i');
  while (i < source.length && depth > 0) {
    const next = source.indexOf('<', i);
    if (next === -1) return source.length;
    const end = findTagEnd(source, next);
    if (end === -1) return source.length;
    const tag = source.slice(next, end + 1);
    if (close.test(tag)) depth -= 1;
    else if (open.test(tag) && !tag.endsWith('/>')) depth += 1;
    i = end + 1;
  }
  return i;
}

const ATTRIBUTE = /([a-zA-Z_:][a-zA-Z0-9_:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;

function sanitizeAttributes(source: string, removed: Set<string>, idPrefix: string): string {
  const kept: string[] = [];
  ATTRIBUTE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTRIBUTE.exec(source)) !== null) {
    const name = match[1];
    const lower = name.toLowerCase();
    const value = match[3] ?? match[4] ?? '';

    if (lower.startsWith('on')) {
      removed.add('event handler');
      continue;
    }
    if (!ALLOWED_ATTRIBUTES.has(lower)) {
      removed.add(`@${lower}`);
      continue;
    }
    // `xmlns` is a namespace declaration, not a request: its value is a URL by
    // definition and nothing dereferences it. Excluding it from the scheme
    // guard is the difference between keeping an icon and silently stripping
    // the one attribute every pasted icon carries.
    const isNamespace = lower === 'xmlns' || lower.startsWith('xmlns:');
    const trimmed = value.trim();

    // An id, rewritten so it cannot collide with another icon's. Already-
    // prefixed ids are left alone, which is what makes a second pass a no-op.
    if (lower === 'id') {
      if (!ID_VALUE.test(trimmed)) {
        removed.add('@id');
        continue;
      }
      const scoped = trimmed.startsWith(`${idPrefix}-`) ? trimmed : `${idPrefix}-${trimmed}`;
      kept.push(` id="${escapeAttribute(scoped)}"`);
      continue;
    }

    // A paint server named by fragment. The same rewrite, so the reference and
    // the definition still point at each other after both were scoped.
    if (PAINT_ATTRIBUTES.has(lower)) {
      const reference = LOCAL_PAINT_REFERENCE.exec(trimmed);
      if (reference !== null) {
        const target = reference[1];
        const scoped = target.startsWith(`${idPrefix}-`) ? target : `${idPrefix}-${target}`;
        kept.push(` ${lower}="url(#${escapeAttribute(scoped)})"`);
        continue;
      }
      // Not a fragment: fall through to the guard below, which refuses every
      // other shape of `url(` — including the ones that reach the network.
    }

    if (!isNamespace && (SCHEME_LIKE.test(trimmed) || /url\s*\(/i.test(value))) {
      removed.add(`@${lower}`);
      continue;
    }
    kept.push(` ${ATTRIBUTE_CASE[lower] ?? name}="${escapeAttribute(value)}"`);
  }
  return kept.join('');
}

function escapeAttribute(value: string): string {
  return value.replace(/[&<>"]/g, (ch) =>
    ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : '&quot;',
  );
}
