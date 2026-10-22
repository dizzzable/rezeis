import { BadRequestException } from '@nestjs/common';

/**
 * How a payment gateway looks to the customer in the cabinet's payment step —
 * the operator's own words and icon in place of the provider's.
 *
 * Operators asked for it (22.10.2026): customers meet «Platega», «Wata»,
 * «RollyPay» with «RUB» under each, cannot tell which one takes a card or SBP,
 * and are afraid to press any of them. So each gateway may carry:
 *
 *   - `displayName` — «Карта или СБП» instead of «Wata»;
 *   - `displayDescription` — a line or three under it, instead of the currency
 *     code: «Любая карта РФ или QR-код СБП»;
 *   - `displayIconSvg` — the operator's SVG instead of the provider's logo.
 *
 * Every one is optional; empty means the provider's own. The panel's operator
 * screens keep the provider's name — the operator configures Wata, not «Карта».
 *
 * ── The icon is an image, never markup ──────────────────────────────────────
 *
 * The cabinet renders the SVG only as an `<img>` source (a `data:` URL). An
 * SVG loaded as an image runs no script, fetches nothing and cannot be reached
 * by the page's DOM — that, not this file, is what makes an operator's SVG safe
 * to show a customer. This file is the second wall: whatever a browser would
 * do with an SVG elsewhere — open it as a document from a copied link, inline
 * it into a page one day — a stored icon carries no script, no event handler,
 * no external reference and no entity declarations. Refused, never quietly
 * stripped: an operator whose file loses half its content on save would see an
 * icon that is not the one they uploaded and never know why.
 */

/** Code points, not UTF-16 units: «Карта 💳» is eight, not nine. */
export const GATEWAY_DISPLAY_NAME_MAX = 40;
export const GATEWAY_DISPLAY_DESCRIPTION_MAX = 160;
export const GATEWAY_DISPLAY_DESCRIPTION_MAX_LINES = 3;
/** Bytes of UTF-8. A clean icon is a few kilobytes; the gateway list carries it inline. */
export const GATEWAY_ICON_SVG_MAX_BYTES = 32 * 1024;

export const GATEWAY_PRESENTATION_REFUSAL_CODES = {
  nameInvalid: 'PAYMENT_GATEWAY_DISPLAY_NAME_INVALID',
  descriptionInvalid: 'PAYMENT_GATEWAY_DISPLAY_DESCRIPTION_INVALID',
  iconInvalid: 'PAYMENT_GATEWAY_ICON_INVALID',
  iconTooLarge: 'PAYMENT_GATEWAY_ICON_TOO_LARGE',
  iconUnsafe: 'PAYMENT_GATEWAY_ICON_UNSAFE',
} as const;

function refuse(code: string): BadRequestException {
  return new BadRequestException({ code, message: code });
}

function codePoints(value: string): number {
  return [...value].length;
}

/**
 * C0 and C1 controls, and the invisible marks that reorder text (the bidi
 * controls: overrides, isolates, the directional marks). Zero-width joiners are
 * not among them — they build emoji. A name that renders differently from what
 * the operator typed is not a name. Matched line by line: a line break is a
 * control too, and the line under the name may have three.
 */
const HIDDEN_CHARACTERS = /[\p{Cc}\p{Bidi_Control}]/u;

/**
 * The customer-facing name: one line, trimmed, inner runs of white space made
 * one space. `null` — and an empty string — mean the provider's own name.
 */
export function normalizeGatewayDisplayName(raw: unknown): string | null {
  if (raw === null) return null;
  if (typeof raw !== 'string') throw refuse(GATEWAY_PRESENTATION_REFUSAL_CODES.nameInvalid);
  const name = raw.replace(/\s+/gu, ' ').trim();
  if (name === '') return null;
  if (HIDDEN_CHARACTERS.test(name) || codePoints(name) > GATEWAY_DISPLAY_NAME_MAX) {
    throw refuse(GATEWAY_PRESENTATION_REFUSAL_CODES.nameInvalid);
  }
  return name;
}

/**
 * The line under the name: up to three lines, each trimmed, blank lines dropped.
 * `null` — and an empty string — mean the currency code, as before.
 */
export function normalizeGatewayDisplayDescription(raw: unknown): string | null {
  if (raw === null) return null;
  if (typeof raw !== 'string') throw refuse(GATEWAY_PRESENTATION_REFUSAL_CODES.descriptionInvalid);
  const lines = raw
    .split(/\r\n|\r|\n/u)
    .map((line) => line.replace(/[^\S\n]+/gu, ' ').trim())
    .filter((line) => line !== '');
  if (lines.length === 0) return null;
  const description = lines.join('\n');
  if (
    lines.length > GATEWAY_DISPLAY_DESCRIPTION_MAX_LINES ||
    lines.some((line) => HIDDEN_CHARACTERS.test(line)) ||
    codePoints(description) > GATEWAY_DISPLAY_DESCRIPTION_MAX
  ) {
    throw refuse(GATEWAY_PRESENTATION_REFUSAL_CODES.descriptionInvalid);
  }
  return description;
}

/**
 * What an icon may not carry anywhere in it. Matched on the whole text, so a
 * `<script>` inside CDATA or a comment-split tag name is refused too (comments
 * are removed before this runs).
 */
const UNSAFE_SVG: readonly RegExp[] = [
  // Elements that run code or embed another document.
  /<\s*(?:script|foreignObject|iframe|embed|object|audio|video|handler|listener)\b/i,
  // Any `on…=` attribute: onload, onclick, onbegin…
  /[\s"'/]on[a-z]+\s*=/i,
  // An animation that rewrites a link or a handler after the checks below.
  /attributeName\s*=\s*["']\s*(?:xlink:)?(?:href|src|on[a-z]+)\b/i,
  // Script and data-document URLs, however they are spelled into an attribute.
  /(?:java|vb)script\s*:/i,
  /data\s*:\s*(?:text|application)\//i,
  // Entities and processing instructions past the prolog (`xml-stylesheet`).
  /<!ENTITY/i,
  /<\?/,
  /@import/i,
];

/**
 * A reference may stay inside the icon (`#gradient`) or carry an embedded
 * raster (`data:image/png;base64,…`). Anything else is a fetch from somewhere
 * — nothing an `<img>` would make, and nothing an icon needs.
 */
function referencesAreLocal(svg: string): boolean {
  const attributeRefs = svg.matchAll(/\b(?:xlink:)?(?:href|src)\s*=\s*(["'])([\s\S]*?)\1/gi);
  for (const match of attributeRefs) {
    const value = match[2]!.trim();
    if (!value.startsWith('#') && !/^data:image\/(?:png|jpe?g|gif|webp);/i.test(value)) return false;
  }
  const cssRefs = svg.matchAll(/url\(\s*(["']?)([\s\S]*?)\1\s*\)/gi);
  for (const match of cssRefs) {
    if (!match[2]!.trim().startsWith('#')) return false;
  }
  return true;
}

/** A plain number of user units, as `width` and `height` are written by every editor. */
function userUnits(value: string | undefined): number | null {
  if (value === undefined) return null;
  const match = /^\s*(\d+(?:\.\d+)?)\s*(?:px)?\s*$/i.exec(value);
  if (match === null) return null;
  const units = Number(match[1]);
  return units > 0 ? units : null;
}

function rootAttribute(rootTag: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i').exec(rootTag);
  return match === null ? undefined : match[2];
}

/**
 * The operator's SVG, ready to be shown as an image: the prolog an editor
 * writes (XML declaration, comments, a DOCTYPE without an internal subset)
 * removed, the SVG namespace added where it is missing — without it a browser
 * will not render the file as an image at all — and a `viewBox` derived from
 * `width` and `height` where there is none, so the icon scales to its box
 * instead of being cut. `null` — and an empty string — mean the provider's logo.
 */
export function normalizeGatewayIconSvg(raw: unknown): string | null {
  if (raw === null) return null;
  if (typeof raw !== 'string') throw refuse(GATEWAY_PRESENTATION_REFUSAL_CODES.iconInvalid);
  let svg = raw.replace(/^\uFEFF/u, '').trim();
  if (svg === '') return null;
  if (Buffer.byteLength(svg, 'utf8') > GATEWAY_ICON_SVG_MAX_BYTES) {
    throw refuse(GATEWAY_PRESENTATION_REFUSAL_CODES.iconTooLarge);
  }
  // The XML declaration only — `<?xml-stylesheet` is an instruction, refused below.
  svg = svg.replace(/^<\?xml\s[\s\S]*?\?>/i, '').trim();
  svg = svg.replace(/<!--[\s\S]*?-->/g, '');
  // An internal subset is where entities live; a plain DOCTYPE is editor noise.
  if (/<!DOCTYPE[^>]*\[/i.test(svg)) throw refuse(GATEWAY_PRESENTATION_REFUSAL_CODES.iconUnsafe);
  svg = svg.replace(/<!DOCTYPE[^>]*>/gi, '').trim();

  const root = /^<svg\b[^>]*>/.exec(svg);
  if (root === null || !/<\/svg>$/.test(svg)) throw refuse(GATEWAY_PRESENTATION_REFUSAL_CODES.iconInvalid);
  if (UNSAFE_SVG.some((pattern) => pattern.test(svg)) || !referencesAreLocal(svg)) {
    throw refuse(GATEWAY_PRESENTATION_REFUSAL_CODES.iconUnsafe);
  }

  let rootTag = root[0];
  const additions: string[] = [];
  if (rootAttribute(rootTag, 'xmlns') === undefined) additions.push('xmlns="http://www.w3.org/2000/svg"');
  if (rootAttribute(rootTag, 'viewBox') === undefined) {
    const width = userUnits(rootAttribute(rootTag, 'width'));
    const height = userUnits(rootAttribute(rootTag, 'height'));
    if (width !== null && height !== null) additions.push(`viewBox="0 0 ${width} ${height}"`);
  }
  if (additions.length > 0) {
    rootTag = `<svg ${additions.join(' ')}${rootTag.slice('<svg'.length)}`;
    svg = rootTag + svg.slice(root[0].length);
  }
  return svg;
}
