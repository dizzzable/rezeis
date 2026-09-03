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

/** Elements an icon is built from. Everything else is dropped whole. */
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
  'defs',
  'title',
  'desc',
  'linearGradient',
  'radialGradient',
  'stop',
  'clipPath',
  'mask',
  'use',
]);

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
  'gradientunits',
  'gradienttransform',
  'clip-path',
  'clip-rule',
  'mask',
  'id',
  'class',
  'aria-hidden',
  'role',
  'focusable',
  'href',
  'xlink:href',
]);

/**
 * Values that may not appear in an attribute.
 *
 * `href` is allowed on `<use>` because an icon legitimately references its own
 * `<defs>` — but only as a same-document fragment. Anything with a scheme is a
 * request to somewhere else, and an icon has no business making one.
 */
const SCHEME_LIKE = /^[a-z][a-z0-9+.-]*:/i;

export interface SanitizeIconResult {
  readonly markup: string;
  /** What was thrown away, for telling the operator rather than silently fixing it. */
  readonly removed: readonly string[];
}

export class InvalidIconError extends Error {}

const MAX_INPUT_BYTES = 64 * 1024;
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
export function sanitizeIconMarkup(input: string): SanitizeIconResult {
  const source = input.trim();
  if (source.length === 0) throw new InvalidIconError('The icon is empty');
  if (Buffer.byteLength(source, 'utf8') > MAX_INPUT_BYTES) {
    throw new InvalidIconError('The icon is too large to be an icon');
  }
  if (!/^<svg[\s>]/i.test(source)) {
    throw new InvalidIconError('An icon must start with an <svg> element');
  }

  const removed = new Set<string>();
  const out: string[] = [];
  const open: string[] = [];
  let nodes = 0;
  let i = 0;

  while (i < source.length) {
    const lt = source.indexOf('<', i);
    if (lt === -1) {
      appendText(out, source.slice(i));
      break;
    }
    appendText(out, source.slice(i, lt));

    // Comments, CDATA, doctypes and processing instructions carry nothing an
    // icon needs and are the usual smuggling wrappers. Dropped, not parsed.
    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt + 4);
      if (end === -1) throw new InvalidIconError('The icon has an unterminated comment');
      removed.add('comment');
      i = end + 3;
      continue;
    }
    if (source.startsWith('<!', lt) || source.startsWith('<?', lt)) {
      const end = source.indexOf('>', lt);
      if (end === -1) throw new InvalidIconError('The icon has an unterminated declaration');
      removed.add('declaration');
      i = end + 1;
      continue;
    }

    const gt = findTagEnd(source, lt);
    if (gt === -1) throw new InvalidIconError('The icon has an unterminated tag');
    const raw = source.slice(lt + 1, gt);
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
      out.push(`</${closing}>`);
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

    const attrs = sanitizeAttributes(body.slice(nameMatch[0].length), removed);
    out.push(`<${canonical}${attrs}${selfClosing ? '/>' : '>'}`);
    if (!selfClosing) open.push(canonical);
  }

  if (open.length > 0) throw new InvalidIconError(`The icon never closes <${open[open.length - 1]}>`);

  const markup = out.join('').trim();
  if (!markup.startsWith('<svg')) throw new InvalidIconError('Nothing usable was left after cleaning');
  // An `<svg></svg>` passes every check above and draws nothing. Saving it
  // gives the operator a library entry that renders as a blank square, and the
  // blankness is indistinguishable from a styling problem — so the refusal
  // happens here, while the paste is still on screen.
  if (!DRAWING_ELEMENTS.some((el) => markup.includes(`<${el}`))) {
    throw new InvalidIconError('Nothing was left to draw after cleaning');
  }
  return { markup, removed: [...removed].sort() };
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

/** Elements that actually put ink on the canvas. */
const DRAWING_ELEMENTS = ['path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon', 'use'];

const ENTITY = /&(?:[a-zA-Z][a-zA-Z0-9]{1,30}|#\d{1,7}|#x[0-9a-fA-F]{1,6});/;

function appendText(out: string[], text: string): void {
  if (text.trim().length === 0) return;
  // `<` and `>` always go; `&` only when it is not already opening an entity —
  // escaping it unconditionally turns `&lt;` into a visible `&lt;` and mangles
  // every title that was correctly escaped by whoever produced the icon.
  out.push(
    text.replace(/[<>&]/g, (ch, at: number) => {
      if (ch === '<') return '&lt;';
      if (ch === '>') return '&gt;';
      return ENTITY.test(text.slice(at)) && text.slice(at).indexOf('&') === 0 ? '&' : '&amp;';
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

function sanitizeAttributes(source: string, removed: Set<string>): string {
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
    // A fragment reference is the only outward-looking value an icon needs.
    if ((lower === 'href' || lower === 'xlink:href') && !value.startsWith('#')) {
      removed.add('@href');
      continue;
    }
    // `xmlns` is a namespace declaration, not a request: its value is a URL by
    // definition and nothing dereferences it. Excluding it from the scheme
    // guard is the difference between keeping an icon and silently stripping
    // the one attribute every pasted icon carries.
    const isNamespace = lower === 'xmlns' || lower.startsWith('xmlns:');
    if (!isNamespace && (SCHEME_LIKE.test(value.trim()) || /url\s*\(/i.test(value))) {
      removed.add(`@${lower}`);
      continue;
    }
    kept.push(` ${lower === 'viewbox' ? 'viewBox' : name}="${escapeAttribute(value)}"`);
  }
  return kept.join('');
}

function escapeAttribute(value: string): string {
  return value.replace(/[&<>"]/g, (ch) =>
    ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : '&quot;',
  );
}
