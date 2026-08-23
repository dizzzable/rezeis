import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';

export interface IconUploadedInterface {
  /** Public URL relative to the admin host (`/uploads/icons/<file>`). */
  readonly url: string;
  /** Original file name as supplied by the client (best-effort sanitised). */
  readonly originalName: string;
  /** MIME type verified from the file content (never the client's claim). */
  readonly mimeType: string;
  /** Stored size in bytes (after SVG validation, if applied). */
  readonly size: number;
}

interface PersistInput {
  readonly buffer: Buffer;
  readonly originalName: string;
  readonly mimeType: string;
}

// Icons are tiny; 2MB is generous and keeps a careless 4K PNG from landing
// in the library. SVG is allowed but validated (see `assertSafeSvg`).
const MAX_FILE_SIZE = 2 * 1024 * 1024;
const ALLOWED_TYPES = new Set([
  'image/svg+xml',
  'image/png',
  'image/webp',
]);

const EXT_BY_MIME: Record<string, string> = {
  'image/svg+xml': '.svg',
  'image/png': '.png',
  'image/webp': '.webp',
};

/**
 * IconUploadService
 * ─────────────────
 * Persists operator-uploaded custom icons on the admin host's local
 * filesystem and returns a public URL the panel + reiwa can render directly.
 *
 * Storage layout: `<dataRoot>/uploads/icons/<random>.<ext>` where `<dataRoot>`
 * defaults to `./data` and is overridable via `ICON_UPLOADS_DIR` (mounted as a
 * docker volume in production). Served by `main.ts`'s static handler under
 * `/uploads`.
 *
 * Security. `/uploads` is served by `express.static` OUTSIDE every Nest guard,
 * so anything written here is reachable unauthenticated, and a top-level
 * navigation to it runs in the admin origin — where the admin JWT lives. reiwa
 * proxies the same directories onto the subscriber-facing origin, so a file
 * accepted here is served from two origins. Three rules follow:
 *
 *   1. SVG is VALIDATED-AND-REJECTED, never "cleaned". `assertSafeSvg` is now
 *      the ONE implementation — `QuestIconService` calls it instead of keeping
 *      a copy of the list. The six-regex strip it replaced was bypassable by
 *      four valid-XML payloads (self-closing `<script xlink:href="data:…"/>`,
 *      `<animate attributeName="xlink:href" values="javascript:…">`, `<set
 *      attributeName="onload">`, entity-obfuscated `&#106;avascript:`); the
 *      reject-LIST that replaced it was in turn bypassable by a namespace
 *      prefix (`<ns0:script>` is `SVGScriptElement` and contains no `<script`).
 *      All of them are literal cases in
 *      `test/upload-svg-mime-hardening.spec.ts`.
 *   2. The stored extension comes from the SNIFFED type, never from
 *      `input.mimeType`, which is the client's multipart `Content-Type` and is
 *      freely spoofable. Declared and sniffed types must agree.
 *   3. A SECOND, independent layer that does not depend on this list being
 *      complete: `main.ts` serves `/uploads` with `Content-Security-Policy:
 *      default-src 'none'; sandbox` and `Content-Disposition: attachment` for
 *      markup extensions. A future gap in the list then costs an upload, not
 *      an execution. The app-wide helmet CSP does not help here — it is
 *      `reportOnly` in production and `false` everywhere else.
 */
@Injectable()
export class IconUploadService implements OnModuleInit {
  private readonly logger = new Logger(IconUploadService.name);
  private uploadsDir!: string;

  public async onModuleInit(): Promise<void> {
    this.uploadsDir = this.resolveUploadsDir();
    await fs.mkdir(this.uploadsDir, { recursive: true });
    this.logger.log(`Custom icon uploads stored in ${this.uploadsDir}`);
  }

  public async persist(input: PersistInput): Promise<IconUploadedInterface> {
    if (!ALLOWED_TYPES.has(input.mimeType)) {
      throw new BadRequestException(
        `Unsupported file type: ${input.mimeType}. Allowed: svg, png, webp.`,
      );
    }
    if (input.buffer.length === 0) {
      throw new BadRequestException('Uploaded file is empty');
    }
    if (input.buffer.length > MAX_FILE_SIZE) {
      throw new BadRequestException(
        `File exceeds ${Math.round(MAX_FILE_SIZE / 1024 / 1024)} MB limit`,
      );
    }

    const verified = verifyImageContent(input.buffer, input.mimeType, ALLOWED_TYPES);
    const ext = EXT_BY_MIME[verified.mimeType];
    const fileName = `${randomBytes(16).toString('hex')}${ext}`;
    const fullPath = join(this.uploadsDir, fileName);
    await fs.writeFile(fullPath, verified.buffer, { mode: 0o644 });
    return {
      url: `/uploads/icons/${fileName}`,
      originalName: sanitiseName(input.originalName),
      mimeType: verified.mimeType,
      size: verified.buffer.length,
    };
  }

  /**
   * Removes a previously stored icon file. Best-effort: a missing file
   * resolves silently (the catalog entry may have been removed first).
   * Guards against path traversal by accepting only the bare filename.
   */
  public async remove(url: string): Promise<void> {
    const match = /\/uploads\/icons\/([A-Za-z0-9._-]+)$/.exec(url);
    if (!match) return;
    const fileName = match[1];
    // Defence-in-depth: reject anything that isn't a flat filename.
    if (fileName.includes('/') || fileName.includes('\\') || fileName.includes('..')) {
      return;
    }
    await fs.rm(join(this.uploadsDir, fileName), { force: true }).catch((): void => undefined);
  }

  private resolveUploadsDir(): string {
    const fromEnv = process.env.ICON_UPLOADS_DIR;
    if (fromEnv && fromEnv.trim().length > 0) {
      return resolve(fromEnv);
    }
    return resolve(process.cwd(), 'data', 'uploads', 'icons');
  }
}

export const ICON_MAX_FILE_SIZE = MAX_FILE_SIZE;

function sanitiseName(name: string): string {
  return name.replace(/[\r\n\t]/g, ' ').trim().slice(0, 200);
}

// ───────────────────────────────────────────────────────────────────────────
// Shared upload hardening
//
// `assertSafeSvg`, `detectRasterImageMimeType` and `verifyImageContent` are
// consumed by `BrandingAssetUploadService`, `BotBannerUploadService` and
// `QuestIconService`. `QuestIconService` used to carry a byte-for-byte COPY of
// the reject-list with a comment promising the two "cannot drift into different
// verdicts on the same file". They did not drift apart — they drifted into the
// SAME hole (the namespace-prefix bypass below) and had to be fixed twice. It
// now calls this function, so there is one implementation and one verdict.
// `FaqMediaUploadService` still carries its own copy; it does not accept SVG,
// so it is not on this path, but it is the next one to fold in.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Size ceiling for SVG, separate from the slot's own `MAX_FILE_SIZE`.
 *
 * This used to be 100 KB while the icon and branding slots advertised 2 MB, so
 * a legitimate multi-path brand mark was refused by a limit the operator was
 * never shown. SVG still gets a tighter ceiling than a raster file of the same
 * slot — it is markup that is parsed, and the panel inlines it into its own
 * DOM, where megabytes of path nodes cost the main thread rather than the
 * decoder — but the number is now stated in the rejection message instead of
 * differing silently from the advertised one. Callers with their own, smaller
 * transport limit (quests caps its multipart at 100 KB) pass `maxBytes`.
 */
export const SVG_MAX_BYTES = 512 * 1024;

/**
 * Element LOCAL NAMES that may not appear anywhere in an uploaded SVG.
 *
 * WHY LOCAL NAMES AND NOT `'<script'`
 * ───────────────────────────────────
 * The previous list matched the literal string `<script`. In XML the namespace
 * prefix is NOT part of the element name: `<ns0:script>` bound to the SVG
 * namespace is the same `SVGScriptElement` and executes, while the string
 * `<script` never occurs in the file. `<svg:script>`, `<SVG:script>` and
 * `<a:script xmlns:a="http://www.w3.org/2000/svg">` all did the same, as did a
 * prefixed `<p:foreignObject>` wrapping a prefixed `<h:iframe>`. Every one of
 * those was accepted, written byte-for-byte to `/uploads`, and executed in the
 * admin origin. `FORBIDDEN_ELEMENT_PATTERN` therefore matches `<`, an optional
 * `prefix:`, then the local name.
 *
 * The policy is still VALIDATE-AND-REJECT, never "clean": an icon or logo needs
 * shapes, paths and gradients, so anything carrying active content or an
 * external reference is refused whole. A strip pass removes only the shapes its
 * author thought of and silently keeps the rest — which is exactly how the four
 * payloads in `test/upload-svg-mime-hardening.spec.ts` used to get through.
 */
const FORBIDDEN_SVG_ELEMENTS: readonly string[] = [
  // Script carriers. `handler` is SVG Tiny's event-handler element and was
  // accepted by the old list outright — it is not spelled `script`.
  'script',
  'handler',
  // HTML re-entry.
  'foreignobject',
  'iframe',
  'embed',
  'object',
  'frame',
  'frameset',
  'html',
  'body',
  'head',
  'link',
  'meta',
  'base',
  'form',
  'input',
  'button',
  'textarea',
  'select',
  'audio',
  'video',
  'source',
  'track',
  // External / same-doc resource pulls. Not needed for a flat icon.
  'use',
  'image',
  'feimage',
  'cursor',
  // Declarative animation: `<set attributeName="onload">` installs a handler,
  // `<animate attributeName="xlink:href">` rewrites a URL to `javascript:`.
  // Each SMIL sibling is listed in full: a local-name match is anchored, so
  // `animate` no longer covers `animateTransform` the way a substring did.
  'animate',
  'animatetransform',
  'animatemotion',
  'animatecolor',
  'discard',
  'set',
  // Stylesheets. Deliberately NOT relaxed for Illustrator's "Internal CSS"
  // export — see `assertSafeSvg`'s rejection message.
  'style',
  'font-face',
  'font-face-src',
  'font-face-uri',
];

const FORBIDDEN_ELEMENT_PATTERN = buildForbiddenElementPattern(FORBIDDEN_SVG_ELEMENTS);

function buildForbiddenElementPattern(names: readonly string[]): RegExp {
  const alternatives = [...names]
    // Longest first so `font-face-uri` is tried before `font-face`; the
    // trailing name-character guard would otherwise reject the longer form
    // only by backtracking, which is easy to break by reordering the list.
    .sort((left, right) => right.length - left.length)
    .map((name) => name.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&'))
    .join('|');
  // `<` + optional `/` for the closing form + optional `prefix:` + local name,
  // followed by anything that cannot continue a name (so `<setup>` is fine).
  return new RegExp(`<\\s*/?\\s*(?:[a-z0-9_.-]+:)?(?:${alternatives})(?![a-z0-9_.-])`, 'i');
}

/**
 * Declarations that may not appear at all. A DOCTYPE carrying an internal
 * subset is the XXE surface; a plain external-identifier DOCTYPE is stripped
 * instead (see `stripProlog`), because Illustrator emits one and it does not
 * survive to disk.
 */
const FORBIDDEN_SVG_DECLARATIONS: readonly string[] = [
  '<!entity',
  '<!element',
  '<!notation',
  '<!attlist',
];

/**
 * Keyword substrings checked against BOTH the raw markup and its
 * character-reference-decoded form. See `assertSafeSvg` for why the element
 * checks above are deliberately NOT run against the decoded form.
 */
const FORBIDDEN_SVG_KEYWORDS: readonly string[] = [
  'javascript:',
  'vbscript:',
  'livescript:',
  'data:', // data: URIs anywhere
  'expression(',
  '@import',
  '@font-face',
];

/** Attribute-shaped rejections, also applied to the decoded form. */
const FORBIDDEN_SVG_PATTERNS: readonly RegExp[] = [
  // Inline event handlers, including attribute/quote-adjacent (`<rect/onload=`)
  // and namespace-prefixed forms.
  /[\s/"'](?:[a-z0-9_.-]+:)?on[a-z0-9_-]+\s*=/i,
  /url\(\s*(?!#)/i, // CSS url() that is not a local #fragment
];

/** `href` / `xlink:href` / any-prefix `href`, with its value captured. */
const HREF_ATTRIBUTE_SOURCE =
  '(?<![\\w-])(?:[a-z0-9_.-]+:)?href\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]*))';

/**
 * Whether any `href` in `text` points at something other than a local
 * `#fragment`.
 *
 * The pattern this replaces was `/(?:xlink:)?href\s*=\s*["']?\s*(?!#)/i`, whose
 * comment said "any href not a local #fragment" and which in fact rejected
 * EVERY href, `href="#g"` included: the quote is optional, so the engine
 * backtracks it to zero width and the lookahead then inspects the `"` rather
 * than the `#`. That is what refused `<textPath xlink:href="#curve">` and
 * `<a href="#frag">` — both ordinary design-tool output. Values are extracted
 * and compared instead of being described by a lookahead.
 */
function hasNonLocalHref(text: string): boolean {
  const pattern = new RegExp(HREF_ATTRIBUTE_SOURCE, 'gi');
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    const value = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (!value.startsWith('#')) {
      return true;
    }
  }
  return false;
}

/**
 * Decode numeric character references (and `&amp;`, so double-encoding does not
 * hide one) so the keyword checks see what the browser will see.
 *
 * The old rule was blunter: reject any `&#…;` anywhere. That refused `&#169;`
 * in a copyright string — routine design-tool output — while the payload it was
 * aimed at (`xlink:href="&#106;avascript:…"`) is caught precisely by decoding.
 */
function decodeCharacterReferences(input: string): string {
  let out = input;
  // Bounded: each pass must shrink the string or we stop. Three is enough for
  // `&amp;amp;#106;`-style nesting and cannot loop.
  for (let pass = 0; pass < 3; pass += 1) {
    const next = out
      .replace(/&#x([0-9a-f]+);?/gi, (_match, hex: string) =>
        fromCodePoint(Number.parseInt(hex, 16)),
      )
      .replace(/&#(\d+);?/g, (_match, decimal: string) =>
        fromCodePoint(Number.parseInt(decimal, 10)),
      )
      .replace(/&amp;/gi, '&');
    if (next === out) {
      return out;
    }
    out = next;
  }
  return out;
}

function fromCodePoint(code: number): string {
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) {
    return '';
  }
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/**
 * Remove everything a well-formed SVG file may legally carry BEFORE its root
 * element: a BOM, whitespace, processing instructions (the XML declaration and
 * `<?xml-stylesheet?>`), comments (every design tool writes a generator
 * banner), and a DOCTYPE with NO internal subset.
 *
 * Stripping rather than tolerating matters: the return value of `assertSafeSvg`
 * is what reaches disk, so a stripped `<?xml-stylesheet href="…"?>` cannot be
 * served, and the "single <svg> element" check below still describes the exact
 * bytes that are stored.
 */
function stripProlog(input: string): string {
  let out = input;
  for (let guard = 0; guard < 64; guard += 1) {
    const before = out;
    out = out.replace(/^[\s\uFEFF]+/, '');
    out = out.replace(/^<\?[\s\S]*?\?>/, '');
    out = out.replace(/^<!--[\s\S]*?-->/, '');
    // `[^<>[\]]*` refuses an internal subset, so `<!DOCTYPE svg [<!ENTITY …>]>`
    // is NOT stripped here — it survives to the `<!doctype` rejection.
    out = out.replace(/^<!DOCTYPE[^<>[\]]*>/i, '');
    if (out === before) {
      return out;
    }
  }
  return out;
}

/**
 * Remove trailing whitespace, comments and processing instructions after
 * `</svg>` (Illustrator and Inkscape both emit a trailing comment or newline).
 *
 * Written with `lastIndexOf` rather than a `/<!--[\s\S]*?-->$/` regex for two
 * reasons: an anchored lazy match would swallow an INNER comment plus
 * everything after it (turning a legitimate file with both an inner and a
 * trailing comment into a rejection), and the "no `-->` inside" form of that
 * regex backtracks quadratically on a file full of `<!--`.
 */
function stripEpilog(input: string): string {
  let out = input;
  for (let guard = 0; guard < 64; guard += 1) {
    const trimmed = out.replace(/[\s\uFEFF]+$/, '');
    if (trimmed.endsWith('-->')) {
      const start = trimmed.lastIndexOf('<!--', trimmed.length - 3);
      if (start >= 0 && !trimmed.slice(start + 4, trimmed.length - 3).includes('-->')) {
        out = trimmed.slice(0, start);
        continue;
      }
    }
    if (trimmed.endsWith('?>')) {
      const start = trimmed.lastIndexOf('<?', trimmed.length - 2);
      if (start >= 0 && !trimmed.slice(start + 2, trimmed.length - 2).includes('?>')) {
        out = trimmed.slice(0, start);
        continue;
      }
    }
    return trimmed;
  }
  return out.replace(/[\s\uFEFF]+$/, '');
}

/**
 * Validate a raw SVG string and return it (trimmed) when safe; throw
 * `BadRequestException` otherwise. Pure and exported so it is unit-testable in
 * isolation and so every SVG-accepting upload slot reaches one verdict.
 *
 * `raw` is `unknown` on purpose. It used to be `string` with a
 * `typeof raw !== 'string'` guard underneath — a branch the compiler could
 * prove unreachable, so it was dead code that read like a safety net. The
 * callers include `QuestIconService`, which is handed a value that came off the
 * wire, so the guard is worth keeping; making the parameter honest is what
 * makes it reachable.
 *
 * `maxBytes` lets a slot with a smaller transport limit keep the two numbers
 * equal instead of rejecting at a size the operator was never told about.
 */
export function assertSafeSvg(raw: unknown, maxBytes: number = SVG_MAX_BYTES): string {
  if (typeof raw !== 'string') {
    throw new BadRequestException('Icon must be an SVG string');
  }
  const trimmed = stripEpilog(stripProlog(raw));
  if (trimmed.length === 0) {
    throw new BadRequestException('Empty SVG');
  }
  if (Buffer.byteLength(trimmed, 'utf8') > maxBytes) {
    throw new BadRequestException(
      `SVG too large (max ${Math.round(maxBytes / 1024)} KB). SVG is markup and is parsed`
        + ' and inlined by the panel, so it has a tighter limit than a raster file.',
    );
  }
  const lower = trimmed.toLowerCase();
  // Two statements, not `!startsWith || !endsWith`. As one condition the two
  // halves were never both exercised — a review mutation to `&&` survived the
  // whole suite — and the operator got the same message for two different
  // problems.
  if (!/^<svg[\s>]/.test(lower)) {
    throw new BadRequestException(
      'File must be a single <svg> element: nothing may precede the root <svg>',
    );
  }
  if (!/<\/svg>$/.test(lower)) {
    throw new BadRequestException(
      'File must be a single <svg> element: nothing may follow the closing </svg>',
    );
  }

  // Element checks run against the RAW markup only. A character reference can
  // never produce an element: `&#60;script&#62;` is text to every XML and HTML
  // parser, so decoding first and then looking for `<script` would reject a
  // file that carries escaped markup in a <text> node and buy nothing.
  const elementMatch = FORBIDDEN_ELEMENT_PATTERN.exec(trimmed);
  if (elementMatch !== null) {
    const matched = elementMatch[0].toLowerCase();
    // Report the name from the constant list, never the caller's bytes.
    const localName = FORBIDDEN_SVG_ELEMENTS.find((name) => matched.endsWith(name)) ?? 'element';
    const advice = localName === 'style'
      ? ' Re-export with "Presentation Attributes" instead of "Internal CSS":'
        + ' a <style> block in an inlined SVG is page-wide CSS.'
      : ' A namespace prefix does not make it safe.';
    throw new BadRequestException(
      `SVG contains a disallowed element: <${localName}>.${advice}`,
    );
  }
  for (const token of FORBIDDEN_SVG_DECLARATIONS) {
    if (lower.includes(token)) {
      throw new BadRequestException(`SVG contains a disallowed declaration: ${token}`);
    }
  }
  // `stripProlog` removes a DOCTYPE without an internal subset, so anything
  // still here has a `[`, a `<`, or a `>` in it.
  if (lower.includes('<!doctype')) {
    throw new BadRequestException(
      'SVG contains a disallowed DOCTYPE (internal subsets are an XXE surface)',
    );
  }

  // Keyword, event-handler and href checks run against the raw markup AND its
  // decoded form, which is what closes `&#106;avascript:` and `&#111;nload=`
  // without having to refuse `&#169;`.
  for (const text of [trimmed, decodeCharacterReferences(trimmed)]) {
    const haystack = text.toLowerCase();
    for (const keyword of FORBIDDEN_SVG_KEYWORDS) {
      if (haystack.includes(keyword)) {
        throw new BadRequestException('SVG contains a disallowed attribute or reference');
      }
    }
    for (const pattern of FORBIDDEN_SVG_PATTERNS) {
      if (pattern.test(text)) {
        throw new BadRequestException('SVG contains a disallowed attribute or reference');
      }
    }
    if (hasNonLocalHref(text)) {
      throw new BadRequestException('SVG contains a disallowed attribute or reference');
    }
  }
  return trimmed;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);

export type RasterImageMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

/**
 * Detect a raster image format from its file signature instead of trusting the
 * multipart `Content-Type`, which the client writes and can set to anything.
 * Mirrors `FaqMediaUploadService`'s `detectMediaMimeType` and
 * `support-attachment.util`, both of which sniff and then require agreement.
 */
export function detectRasterImageMimeType(buffer: Buffer): RasterImageMime | null {
  if (startsWith(buffer, PNG_SIGNATURE)) return 'image/png';
  if (startsWith(buffer, JPEG_SIGNATURE)) return 'image/jpeg';

  const gifHeader = buffer.subarray(0, 6).toString('ascii');
  if (gifHeader === 'GIF87a' || gifHeader === 'GIF89a') return 'image/gif';

  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }

  return null;
}

/**
 * Decode SVG bytes to text, honouring a UTF-16 byte-order mark.
 *
 * `buffer.toString('utf8')` on a UTF-16 file yields NUL-interleaved mojibake
 * that fails the `^<svg` test, so an operator whose editor saved as UTF-16 (the
 * Windows "Unicode" default in several tools) was told their logo "must be a
 * single <svg> element". Re-encoding to UTF-8 on the way out also means the
 * stored file is the one encoding the checks ran against.
 */
export function decodeSvgText(buffer: Buffer): string {
  if (buffer.length >= 2 && buffer.length % 2 === 0) {
    if (buffer[0] === 0xff && buffer[1] === 0xfe) {
      return buffer.subarray(2).toString('utf16le');
    }
    if (buffer[0] === 0xfe && buffer[1] === 0xff) {
      return Buffer.from(buffer.subarray(2)).swap16().toString('utf16le');
    }
  }
  return buffer.toString('utf8');
}

/**
 * The single content gate every image upload slot goes through.
 *
 * Raster types: sniff the signature, require the sniffed type to be one the
 * slot ACCEPTS and to AGREE with the declared one, then hand the caller the
 * SNIFFED type so the stored extension is derived from content rather than from
 * the client's claim. The allowlist check comes before the agreement check on
 * purpose: with the two the other way round, `allowedTypes.has(detected)` could
 * never be false (agreement had already forced `detected === declaredMimeType`,
 * which every caller checks itself) and it was dead code. Ordered this way a
 * GIF uploaded to the icon slot as `image/png` is refused as "unsupported
 * image/gif" — which is the actual problem — instead of as a type mismatch.
 *
 * `image/svg+xml`: SVG has no magic bytes, so there is nothing to sniff — its
 * structure IS its signature. `assertSafeSvg` requires the payload to be a
 * single well-formed `<svg>…</svg>` element carrying none of the forbidden
 * constructs, which is a strictly stronger check than a 4-byte prefix. The
 * agreement property still holds in both directions: a file that is really a
 * PNG/GIF/JPEG/WEBP fails the `^<svg` test, and a file that is really an SVG
 * matches no raster signature. The returned buffer is the validated markup
 * (BOM, prolog and epilog removed, re-encoded UTF-8), so the exact bytes that
 * reach disk are the bytes that were validated.
 */
export function verifyImageContent(
  buffer: Buffer,
  declaredMimeType: string,
  allowedTypes: ReadonlySet<string>,
): { readonly buffer: Buffer; readonly mimeType: string } {
  if (declaredMimeType === 'image/svg+xml') {
    const svg = assertSafeSvg(decodeSvgText(buffer));
    return { buffer: Buffer.from(svg, 'utf8'), mimeType: 'image/svg+xml' };
  }

  const detected = detectRasterImageMimeType(buffer);
  if (detected === null) {
    throw new BadRequestException('File content does not match a supported image format');
  }
  if (!allowedTypes.has(detected)) {
    throw new BadRequestException(`Unsupported file type: ${detected}`);
  }
  if (detected !== declaredMimeType) {
    throw new BadRequestException(
      `File content type (${detected}) does not match declared MIME type (${declaredMimeType})`,
    );
  }
  return { buffer, mimeType: detected };
}

function startsWith(buffer: Buffer, signature: Buffer): boolean {
  return (
    buffer.length >= signature.length && buffer.subarray(0, signature.length).equals(signature)
  );
}
