import 'reflect-metadata';

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { BotBannerUploadService } from '../src/modules/bot-config/services/bot-banner-upload.service';
import { QuestIconService } from '../src/modules/quests/services/quest-icon.service';
import { BrandingAssetUploadService } from '../src/modules/settings/services/branding-asset-upload.service';
import {
  IconUploadService,
  SVG_MAX_BYTES,
  assertSafeSvg,
  detectRasterImageMimeType,
  verifyImageContent,
} from '../src/modules/settings/services/icon-upload.service';

/**
 * The strip pass that guarded `/uploads/icons` and `/uploads/branding` before
 * this change, copied VERBATIM from both services. It is reproduced here (not
 * imported — it no longer exists) because the finding is a comparison: every
 * payload below is valid XML that survives this function unchanged and is
 * refused by `assertSafeSvg`. Without the old implementation in front of it,
 * the new one's rejections prove nothing about what was actually reachable.
 */
function legacySanitiseSvg(svg: string): string {
  return svg
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '')
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
    .replace(/(href|xlink:href)\s*=\s*"\s*javascript:[^"]*"/gi, '$1=""')
    .replace(/(href|xlink:href)\s*=\s*'\s*javascript:[^']*'/gi, "$1=''")
    .trim();
}

const SVG_NS = 'xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"';

/**
 * The four bypasses named in the finding. Each `marker` is the piece of active
 * content that must still be present after `legacySanitiseSvg` — i.e. the
 * thing that used to land on disk under the panel's own origin, served
 * unauthenticated by `express.static` at `/uploads/...`.
 */
const BYPASS_PAYLOADS: readonly { name: string; svg: string; marker: string }[] = [
  {
    name: 'self-closing <script xlink:href="data:text/javascript;base64,…"/>',
    svg:
      `<svg ${SVG_NS} width="16" height="16">` +
      '<script xlink:href="data:text/javascript;base64,YWxlcnQoZG9jdW1lbnQuZG9tYWluKQ=="/>' +
      '</svg>',
    // The strip regex needs a literal `</script>`; a self-closing tag has none.
    marker: '<script',
  },
  {
    name: '<animate> rewriting xlink:href to a javascript: URL',
    svg:
      `<svg ${SVG_NS} width="16" height="16">` +
      '<a><rect width="16" height="16"/>' +
      '<animate attributeName="xlink:href" values="javascript:alert(document.domain)" begin="0s"/>' +
      '</a></svg>',
    // `values=` is not `href=`, so none of the six regexes look at it.
    marker: 'javascript:alert(document.domain)',
  },
  {
    name: '<set attributeName="onload" to="…"/>',
    svg:
      `<svg ${SVG_NS} width="16" height="16">` +
      '<set attributeName="onload" to="alert(document.domain)"/>' +
      '</svg>',
    // `<set>` is not stripped and `on*=` never matches the attributeName form.
    marker: '<set attributeName="onload"',
  },
  {
    name: 'entity-obfuscated xlink:href="&#106;avascript:…"',
    svg:
      `<svg ${SVG_NS} width="16" height="16">` +
      '<a xlink:href="&#106;avascript:alert(document.domain)"><rect width="16" height="16"/></a>' +
      '</svg>',
    // The regex sees the entity; the XML parser decodes it to `j`.
    marker: '&#106;avascript:',
  },
];

/** A real vector logo: paths, a gradient, a title. Must keep working. */
const LEGITIMATE_LOGO_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">' +
  '<title>Acme</title>' +
  '<defs><linearGradient id="g"><stop offset="0" stop-color="#ff0000"/>' +
  '<stop offset="1" stop-color="#0000ff"/></linearGradient></defs>' +
  '<path d="M2 2h20v20H2z" fill="url(#g)"/>' +
  '<circle cx="12" cy="12" r="5" fill="#ffffff"/>' +
  '</svg>';

const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(24, 0x11),
]);
const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(24, 0x22)]);
const GIF_BYTES = Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.alloc(24, 0x33)]);
const WEBP_BYTES = Buffer.concat([
  Buffer.from('RIFF', 'ascii'),
  Buffer.from([0x20, 0x00, 0x00, 0x00]),
  Buffer.from('WEBP', 'ascii'),
  Buffer.alloc(24, 0x44),
]);

async function listDir(dir: string): Promise<readonly string[]> {
  return (await fs.readdir(dir)).sort();
}

// ── Finding 1 + 2: stored XSS via SVG on the icon and branding slots ────────

describe('assertSafeSvg — the four payloads the strip pass let through', () => {
  for (const payload of BYPASS_PAYLOADS) {
    it(`the OLD strip pass leaves it intact: ${payload.name}`, () => {
      const survived = legacySanitiseSvg(payload.svg);
      assert.ok(
        survived.includes(payload.marker),
        `expected the legacy sanitiser to leave ${payload.marker} in place, got: ${survived}`,
      );
    });

    it(`the NEW validator rejects it: ${payload.name}`, () => {
      assert.throws(() => assertSafeSvg(payload.svg), /disallowed|single <svg>/i);
    });
  }

  it('accepts a legitimate vector logo unchanged', () => {
    assert.equal(assertSafeSvg(LEGITIMATE_LOGO_SVG), LEGITIMATE_LOGO_SVG);
  });

  it('accepts a logo behind a BOM and an XML declaration, and returns it stripped', () => {
    const raw = `\uFEFF<?xml version="1.0" encoding="UTF-8"?>\n${LEGITIMATE_LOGO_SVG}`;
    assert.equal(assertSafeSvg(raw), LEGITIMATE_LOGO_SVG);
  });

  it('rejects markup that is not a single <svg> element', () => {
    assert.throws(
      () => assertSafeSvg('<html><body><svg xmlns="http://www.w3.org/2000/svg"></svg></body></html>'),
      /single <svg> element/,
    );
  });
});

describe('IconUploadService — SVG slot', () => {
  let dir: string;
  let service: IconUploadService;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'icon-upload-'));
    process.env.ICON_UPLOADS_DIR = dir;
    service = new IconUploadService();
    await service.onModuleInit();
  });

  afterEach(async () => {
    delete process.env.ICON_UPLOADS_DIR;
    await fs.rm(dir, { recursive: true, force: true });
  });

  for (const payload of BYPASS_PAYLOADS) {
    it(`refuses to persist: ${payload.name}`, async () => {
      await assert.rejects(
        () =>
          service.persist({
            buffer: Buffer.from(payload.svg, 'utf8'),
            originalName: 'icon.svg',
            mimeType: 'image/svg+xml',
          }),
        /disallowed|single <svg>/i,
      );
      // Nothing may reach the served directory, not even a cleaned copy.
      assert.deepEqual(await listDir(dir), []);
    });
  }

  it('persists a legitimate SVG and stores exactly the validated bytes', async () => {
    const out = await service.persist({
      buffer: Buffer.from(LEGITIMATE_LOGO_SVG, 'utf8'),
      originalName: 'logo.svg',
      mimeType: 'image/svg+xml',
    });
    assert.match(out.url, /^\/uploads\/icons\/[a-f0-9]{32}\.svg$/);
    const stored = await fs.readFile(join(dir, out.url.split('/').pop() as string), 'utf8');
    assert.equal(stored, LEGITIMATE_LOGO_SVG);
  });
});

describe('BrandingAssetUploadService — SVG slot', () => {
  let dir: string;
  let service: BrandingAssetUploadService;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'branding-upload-'));
    process.env.BRANDING_UPLOADS_DIR = dir;
    service = new BrandingAssetUploadService();
    await service.onModuleInit();
  });

  afterEach(async () => {
    delete process.env.BRANDING_UPLOADS_DIR;
    await fs.rm(dir, { recursive: true, force: true });
  });

  for (const payload of BYPASS_PAYLOADS) {
    it(`refuses to persist: ${payload.name}`, async () => {
      await assert.rejects(
        () =>
          service.persist({
            buffer: Buffer.from(payload.svg, 'utf8'),
            originalName: 'logo.svg',
            mimeType: 'image/svg+xml',
          }),
        /disallowed|single <svg>/i,
      );
      assert.deepEqual(await listDir(dir), []);
    });
  }

  it('still accepts the operator’s own brand logo', async () => {
    const out = await service.persist({
      buffer: Buffer.from(LEGITIMATE_LOGO_SVG, 'utf8'),
      originalName: 'brand.svg',
      mimeType: 'image/svg+xml',
    });
    assert.match(out.url, /^\/uploads\/branding\/[a-f0-9]{32}\.svg$/);
    const stored = await fs.readFile(join(dir, out.url.split('/').pop() as string), 'utf8');
    assert.equal(stored, LEGITIMATE_LOGO_SVG);
  });
});

// ── Finding 5: the declared MIME type is the client's, not the file's ───────

describe('detectRasterImageMimeType', () => {
  it('identifies each supported raster format from its signature', () => {
    assert.equal(detectRasterImageMimeType(PNG_BYTES), 'image/png');
    assert.equal(detectRasterImageMimeType(JPEG_BYTES), 'image/jpeg');
    assert.equal(detectRasterImageMimeType(GIF_BYTES), 'image/gif');
    assert.equal(detectRasterImageMimeType(WEBP_BYTES), 'image/webp');
  });

  it('returns null for markup, script and a truncated PNG signature', () => {
    assert.equal(detectRasterImageMimeType(Buffer.from('<html><script>x</script>', 'utf8')), null);
    assert.equal(detectRasterImageMimeType(Buffer.from(LEGITIMATE_LOGO_SVG, 'utf8')), null);
    assert.equal(detectRasterImageMimeType(Buffer.from([0x89, 0x50, 0x4e, 0x47])), null);
  });
});

describe('MIME sniffing on every image upload slot', () => {
  let iconDir: string;
  let brandingDir: string;
  let bannerDir: string;
  let iconService: IconUploadService;
  let brandingService: BrandingAssetUploadService;
  let bannerService: BotBannerUploadService;

  beforeEach(async () => {
    iconDir = await fs.mkdtemp(join(tmpdir(), 'icon-mime-'));
    brandingDir = await fs.mkdtemp(join(tmpdir(), 'branding-mime-'));
    bannerDir = await fs.mkdtemp(join(tmpdir(), 'banner-mime-'));
    process.env.ICON_UPLOADS_DIR = iconDir;
    process.env.BRANDING_UPLOADS_DIR = brandingDir;
    process.env.BOT_BANNER_UPLOADS_DIR = bannerDir;
    iconService = new IconUploadService();
    brandingService = new BrandingAssetUploadService();
    bannerService = new BotBannerUploadService();
    await iconService.onModuleInit();
    await brandingService.onModuleInit();
    await bannerService.onModuleInit();
  });

  afterEach(async () => {
    delete process.env.ICON_UPLOADS_DIR;
    delete process.env.BRANDING_UPLOADS_DIR;
    delete process.env.BOT_BANNER_UPLOADS_DIR;
    await fs.rm(iconDir, { recursive: true, force: true });
    await fs.rm(brandingDir, { recursive: true, force: true });
    await fs.rm(bannerDir, { recursive: true, force: true });
  });

  it('icons: an HTML document declared as image/png is refused', async () => {
    await assert.rejects(
      () =>
        iconService.persist({
          buffer: Buffer.from('<html><script>alert(document.domain)</script></html>', 'utf8'),
          originalName: 'icon.png',
          mimeType: 'image/png',
        }),
      /does not match a supported image format/,
    );
    assert.deepEqual(await listDir(iconDir), []);
  });

  it('icons: a real PNG declared as image/webp is refused (types must agree)', async () => {
    await assert.rejects(
      () =>
        iconService.persist({
          buffer: PNG_BYTES,
          originalName: 'icon.webp',
          mimeType: 'image/webp',
        }),
      /does not match declared MIME type/,
    );
    assert.deepEqual(await listDir(iconDir), []);
  });

  it('icons: a real PNG declared as image/png is stored with the sniffed extension', async () => {
    const out = await iconService.persist({
      buffer: PNG_BYTES,
      originalName: 'icon.png',
      mimeType: 'image/png',
    });
    assert.match(out.url, /^\/uploads\/icons\/[a-f0-9]{32}\.png$/);
    assert.equal(out.mimeType, 'image/png');
  });

  it('branding: an SVG payload declared as image/png is refused', async () => {
    await assert.rejects(
      () =>
        brandingService.persist({
          buffer: Buffer.from(BYPASS_PAYLOADS[0].svg, 'utf8'),
          originalName: 'logo.png',
          mimeType: 'image/png',
        }),
      /does not match a supported image format/,
    );
    assert.deepEqual(await listDir(brandingDir), []);
  });

  it('branding: a real WEBP declared as image/webp is stored', async () => {
    const out = await brandingService.persist({
      buffer: WEBP_BYTES,
      originalName: 'logo.webp',
      mimeType: 'image/webp',
    });
    assert.match(out.url, /^\/uploads\/branding\/[a-f0-9]{32}\.webp$/);
  });

  it('bot banner: arbitrary bytes declared as image/png are refused', async () => {
    await assert.rejects(
      () =>
        bannerService.persist({
          buffer: Buffer.from('MZ ', 'binary'),
          originalName: 'banner.png',
          mimeType: 'image/png',
        }),
      /does not match a supported image format/,
    );
    assert.deepEqual(await listDir(bannerDir), []);
  });

  it('bot banner: a real JPEG declared as image/gif is refused', async () => {
    await assert.rejects(
      () =>
        bannerService.persist({
          buffer: JPEG_BYTES,
          originalName: 'banner.gif',
          mimeType: 'image/gif',
        }),
      /does not match declared MIME type/,
    );
    assert.deepEqual(await listDir(bannerDir), []);
  });

  it('bot banner: a real GIF declared as image/gif is stored as .gif', async () => {
    const out = await bannerService.persist({
      buffer: GIF_BYTES,
      originalName: 'banner.gif',
      mimeType: 'image/gif',
    });
    assert.match(out.url, /^\/uploads\/bot-banners\/[a-f0-9]{32}\.gif$/);
    assert.equal(out.mimeType, 'image/gif');
  });

  it('bot banner: SVG is not on the allowlist at all', async () => {
    await assert.rejects(
      () =>
        bannerService.persist({
          buffer: Buffer.from(LEGITIMATE_LOGO_SVG, 'utf8'),
          originalName: 'banner.svg',
          mimeType: 'image/svg+xml',
        }),
      /Unsupported file type/,
    );
    assert.deepEqual(await listDir(bannerDir), []);
  });
});

// ── Finding 1 (second wave): the reject-list was bypassed by a namespace prefix

/**
 * The reject-list that guarded both SVG paths before this change, copied
 * VERBATIM from `icon-upload.service.ts` and `quest-icon.service.ts` (the two
 * carried identical copies). Reproduced here for the same reason as
 * `legacySanitiseSvg` above: the finding is a COMPARISON. Each payload below is
 * valid XML that this function ACCEPTS and that `assertSafeSvg` must refuse.
 * Without the old implementation in front of it, the new one's rejections say
 * nothing about what was reachable.
 */
const LEGACY_FORBIDDEN_SUBSTRINGS: readonly string[] = [
  '<script',
  '<foreignobject',
  '<iframe',
  '<embed',
  '<object',
  '<use',
  '<image',
  '<animate',
  '<set',
  '<style',
  '<!doctype',
  '<!entity',
  '<!element',
  'javascript:',
  'expression(',
  '@import',
  '@font-face',
];

const LEGACY_FORBIDDEN_PATTERNS: readonly RegExp[] = [
  /[\s/"']on[a-z0-9_-]+\s*=/i,
  /(?:xlink:)?href\s*=\s*["']?\s*(?!#)/i,
  /url\(\s*(?!#)/i,
  /data:/i,
  /&#x?[0-9a-f]+;?/i,
];

/** `true` when the OLD list let the payload through unchanged. */
function legacyRejectListAccepts(raw: string): boolean {
  const trimmed = raw.replace(/^﻿/, '').trim().replace(/^<\?xml[^>]*\?>\s*/i, '').trim();
  if (trimmed.length === 0) return false;
  if (Buffer.byteLength(trimmed, 'utf8') > 100 * 1024) return false;
  const lower = trimmed.toLowerCase();
  if (!/^<svg[\s>]/.test(lower) || !/<\/svg>\s*$/.test(lower)) return false;
  if (LEGACY_FORBIDDEN_SUBSTRINGS.some((token) => lower.includes(token))) return false;
  if (LEGACY_FORBIDDEN_PATTERNS.some((pattern) => pattern.test(trimmed))) return false;
  return true;
}

const SVG_NS_URI = 'http://www.w3.org/2000/svg';

/**
 * In XML the namespace PREFIX is not part of the element name. `<ns0:script>`
 * bound to the SVG namespace is the same `SVGScriptElement` and executes, and
 * the string `<script` never occurs in the file — so a reject-list matching the
 * literal tag saw nothing. Each of these was accepted by the real validator,
 * written byte-for-byte to `/uploads`, and executed in a browser served with
 * this app's headers.
 */
const PREFIXED_PAYLOADS: readonly { name: string; svg: string }[] = [
  {
    name: '<ns0:script> bound to the SVG namespace',
    svg:
      `<svg xmlns="${SVG_NS_URI}" xmlns:ns0="${SVG_NS_URI}">`
      + '<ns0:script>/* runs */</ns0:script><rect width="16" height="16"/></svg>',
  },
  {
    name: '<svg:script> using the conventional prefix',
    svg:
      `<svg xmlns:svg="${SVG_NS_URI}" xmlns="${SVG_NS_URI}">`
      + '<svg:script>/* runs */</svg:script><rect width="16" height="16"/></svg>',
  },
  {
    name: '<SVG:script> — prefix and local name in upper case',
    svg:
      `<svg xmlns:SVG="${SVG_NS_URI}" xmlns="${SVG_NS_URI}">`
      + '<SVG:script>/* runs */</SVG:script><rect width="16" height="16"/></svg>',
  },
  {
    name: '<a:script> under an arbitrary one-letter prefix',
    svg:
      `<svg xmlns="${SVG_NS_URI}" xmlns:a="${SVG_NS_URI}">`
      + '<a:script>/* runs */</a:script><rect width="16" height="16"/></svg>',
  },
  {
    name: 'prefixed <p:foreignObject> wrapping a prefixed <h:iframe>',
    svg:
      `<svg xmlns="${SVG_NS_URI}" xmlns:p="${SVG_NS_URI}" xmlns:h="http://www.w3.org/1999/xhtml">`
      + '<p:foreignObject width="16" height="16"><h:iframe/></p:foreignObject></svg>',
  },
  {
    name: '<handler> — SVG Tiny’s event-handler element, never spelled "script"',
    svg:
      `<svg xmlns="${SVG_NS_URI}" xmlns:ev="http://www.w3.org/2001/xml-events">`
      + '<handler ev:event="load">/* runs */</handler><rect width="16" height="16"/></svg>',
  },
  {
    name: 'prefixed <ns0:animateTransform>, which a `<animate` substring never covered',
    svg:
      `<svg xmlns="${SVG_NS_URI}" xmlns:ns0="${SVG_NS_URI}"><rect width="16" height="16">`
      + '<ns0:animateTransform attributeName="transform" type="rotate" values="0;360"/>'
      + '</rect></svg>',
  },
];

/**
 * Design-tool output that the previous wave's validator refused. A validator so
 * strict that an operator cannot upload their own logo is its own outage, so
 * each of these is a required ACCEPT, not a nice-to-have.
 */
const ILLUSTRATOR_SVG =
  '<?xml version="1.0" encoding="utf-8"?>\n'
  + '<!-- Generator: Adobe Illustrator 27.9.0, SVG Export Plug-In . SVG Version: 6.00 Build 0)  -->\n'
  + '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN"'
  + ' "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n'
  + '<svg version="1.1" id="Layer_1" xmlns="http://www.w3.org/2000/svg"'
  + ' xmlns:xlink="http://www.w3.org/1999/xlink" x="0px" y="0px" viewBox="0 0 100 100"'
  + ' xml:space="preserve">\n'
  + '<g id="mark"><path d="M10 10h80v80H10z" fill="#123456"/>'
  + '<circle cx="50" cy="50" r="20" fill="#ffffff"/></g>\n'
  + '<defs><path id="curve" d="M10 90 Q50 60 90 90"/></defs>\n'
  + '<text><textPath xlink:href="#curve">&#169; 2026 Acme &#8212; all rights reserved</textPath></text>\n'
  + '<a href="#mark"><rect x="0" y="0" width="4" height="4" fill="none"/></a>\n'
  + '</svg>\n'
  + '<!-- exported 2026-08-19 -->\n';

const INKSCAPE_OPTIMISED_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">'
  + '<defs><linearGradient id="lg" x1="0" x2="1"><stop offset="0" stop-color="#0af"/>'
  + '<stop offset="1" stop-color="#f0a"/></linearGradient>'
  + '<clipPath id="cp"><rect width="48" height="48" rx="8"/></clipPath></defs>'
  + '<metadata><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"'
  + ' xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Acme</dc:title></rdf:RDF></metadata>'
  + '<title>Acme</title><desc>brand mark</desc>'
  + '<g clip-path="url(#cp)"><rect width="48" height="48" fill="url(#lg)"/>'
  + '<path d="M12 30 24 12 36 30Z" fill="#fff" fill-opacity=".9"/></g></svg>';

describe('assertSafeSvg — the reject-list was bypassed by a namespace prefix', () => {
  for (const payload of PREFIXED_PAYLOADS) {
    it(`the OLD reject-list accepts it: ${payload.name}`, () => {
      assert.ok(
        legacyRejectListAccepts(payload.svg),
        'this payload must be one the previous list let through, or it proves nothing',
      );
    });

    it(`the NEW validator rejects it: ${payload.name}`, () => {
      assert.throws(() => assertSafeSvg(payload.svg), /disallowed|single <svg>/i);
    });

    it(`the quest path reaches the same verdict: ${payload.name}`, () => {
      // The two lists were "kept identical so the two paths cannot drift".
      // They drifted into the same hole and had to be fixed twice; there is one
      // implementation now, and this is what holds it to one.
      assert.throws(() => QuestIconService.sanitizeSvg(payload.svg), {
        name: 'BadRequestException',
      });
    });
  }

  it('names the element in the rejection instead of the caller’s bytes', () => {
    assert.throws(
      () => assertSafeSvg(PREFIXED_PAYLOADS[0].svg),
      /disallowed element: <script>/,
    );
  });
});

describe('assertSafeSvg — real design-tool output still uploads', () => {
  it('accepts Illustrator output: generator comment, DOCTYPE, entities, #fragment hrefs, trailing comment', () => {
    const out = assertSafeSvg(ILLUSTRATOR_SVG);
    assert.ok(out.startsWith('<svg version="1.1"'), `prolog not stripped: ${out.slice(0, 80)}`);
    assert.ok(out.endsWith('</svg>'), `epilog not stripped: ${out.slice(-80)}`);
    // The parts that used to be fatal must still be THERE, not silently cleaned.
    assert.ok(out.includes('xlink:href="#curve"'));
    assert.ok(out.includes('&#169;'));
    assert.ok(out.includes('<a href="#mark">'));
  });

  it('accepts Inkscape/Figma "Optimized SVG" output unchanged', () => {
    assert.equal(assertSafeSvg(INKSCAPE_OPTIMISED_SVG), INKSCAPE_OPTIMISED_SVG);
  });

  it('accepts a local #fragment href — the old pattern rejected EVERY href', () => {
    // `/(?:xlink:)?href\s*=\s*["']?\s*(?!#)/i` claimed to permit local
    // fragments and permitted none: the optional quote backtracks to zero
    // width, so the lookahead inspects the quote character.
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg"><defs><path id="p" d="M0 0h9"/></defs>'
      + '<a href="#p"><rect width="9" height="9"/></a></svg>';
    assert.equal(assertSafeSvg(svg), svg);
  });

  it('still rejects an href that is not a local fragment', () => {
    assert.throws(
      () =>
        assertSafeSvg(
          '<svg xmlns="http://www.w3.org/2000/svg"><a href="https://evil.test/x">'
          + '<rect width="9" height="9"/></a></svg>',
        ),
      /disallowed/,
    );
  });

  it('accepts a &#169; entity but still rejects an entity-obfuscated javascript: URL', () => {
    const copyright =
      '<svg xmlns="http://www.w3.org/2000/svg"><text>&#169;&#x2014;2026</text></svg>';
    assert.equal(assertSafeSvg(copyright), copyright);
    assert.throws(
      () =>
        assertSafeSvg(
          '<svg xmlns="http://www.w3.org/2000/svg"><a xlink:href="&#106;avascript:alert(1)">'
          + '<rect width="9" height="9"/></a></svg>',
        ),
      /disallowed/,
    );
  });

  it('rejects an entity-obfuscated event handler, which the raw scan alone would miss', () => {
    assert.throws(
      () =>
        assertSafeSvg(
          '<svg xmlns="http://www.w3.org/2000/svg"><rect &#111;nload="alert(1)"'
          + ' width="9" height="9"/></svg>',
        ),
      /disallowed/,
    );
  });

  it('keeps rejecting a DOCTYPE that carries an internal subset (XXE)', () => {
    assert.throws(
      () =>
        assertSafeSvg(
          '<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>'
          + '<svg xmlns="http://www.w3.org/2000/svg"><rect width="9" height="9"/></svg>',
        ),
      /disallowed|single <svg>/i,
    );
  });

  it('keeps rejecting Illustrator "Internal CSS" and says what to do about it', () => {
    // Deliberately NOT relaxed: a <style> block in an SVG the panel inlines is
    // page-wide CSS. Both Illustrator and Figma can export presentation
    // attributes instead, so the message names that.
    assert.throws(
      () =>
        assertSafeSvg(
          '<svg xmlns="http://www.w3.org/2000/svg"><style type="text/css">.st0{fill:#000}</style>'
          + '<rect class="st0" width="9" height="9"/></svg>',
        ),
      /Presentation Attributes/,
    );
  });

  it('strips a leading <?xml-stylesheet?> rather than storing it', () => {
    const out = assertSafeSvg(
      '<?xml-stylesheet type="text/css" href="theme.css"?>'
      + '<svg xmlns="http://www.w3.org/2000/svg"><rect width="9" height="9"/></svg>',
    );
    assert.ok(!out.includes('xml-stylesheet'));
    assert.ok(out.startsWith('<svg'));
  });

  it('keeps an inner comment when there is also a trailing one', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg"><!-- inner --><rect width="9" height="9"/></svg>';
    assert.equal(assertSafeSvg(`${svg}\n<!-- trailing -->`), svg);
  });
});

describe('assertSafeSvg — the single-<svg> check is two checks', () => {
  // `!startsWith || !endsWith` was one condition, and a review mutation to `&&`
  // survived the whole suite because no payload exercised exactly one half.
  it('rejects markup with something BEFORE the root <svg>', () => {
    assert.throws(
      () => assertSafeSvg('<div/><svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'),
      /nothing may precede/,
    );
  });

  it('rejects markup with something AFTER the closing </svg>', () => {
    assert.throws(
      () => assertSafeSvg('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg><div/>'),
      /nothing may follow/,
    );
  });
});

describe('assertSafeSvg — size ceiling', () => {
  it('accepts a 150 KB vector logo that the previous 100 KB cap refused', () => {
    const body = `<path d="${'M0 0'.repeat(30_000)}"/>`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg">${body}</svg>`;
    assert.ok(Buffer.byteLength(svg, 'utf8') > 100 * 1024);
    assert.equal(assertSafeSvg(svg), svg);
  });

  it('rejects an SVG past the stated ceiling, and states it', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg">'
      + `<path d="${'M0 0'.repeat(140_000)}"/>`
      + '</svg>';
    assert.ok(Buffer.byteLength(svg, 'utf8') > SVG_MAX_BYTES);
    assert.throws(() => assertSafeSvg(svg), /too large \(max 512 KB\)/);
  });

  it('lets a caller with a smaller transport limit state its own ceiling', () => {
    // Quests caps its multipart body at 100 KB, so its validator is told 100 KB
    // instead of silently rejecting somewhere else.
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg">'
      + `<path d="${'M0 0'.repeat(30_000)}"/>`
      + '</svg>';
    assert.equal(assertSafeSvg(svg), svg);
    assert.throws(() => assertSafeSvg(svg, 100 * 1024), /too large \(max 100 KB\)/);
  });
});

describe('verifyImageContent — the branches that used to be unreachable', () => {
  it('guards a non-string payload, which the `raw: string` signature made dead code', () => {
    assert.throws(() => assertSafeSvg(null), /must be an SVG string/);
    assert.throws(() => assertSafeSvg(Buffer.from('<svg/>')), /must be an SVG string/);
  });

  it('refuses content whose sniffed type the slot does not accept at all', () => {
    // `allowedTypes.has(detected)` sat AFTER the agreement check, where
    // `detected === declaredMimeType` had already been forced and every caller
    // had already checked the declared type — so it could never be false.
    // Ordered before it, a GIF uploaded to the icon slot names the real
    // problem instead of reporting a type mismatch.
    assert.throws(
      () => verifyImageContent(GIF_BYTES, 'image/png', new Set(['image/png', 'image/svg+xml'])),
      /Unsupported file type: image\/gif/,
    );
  });
});

describe('IconUploadService / BrandingAssetUploadService — the prefixed payloads on disk', () => {
  let iconDir: string;
  let brandingDir: string;
  let iconService: IconUploadService;
  let brandingService: BrandingAssetUploadService;

  beforeEach(async () => {
    iconDir = await fs.mkdtemp(join(tmpdir(), 'icon-prefix-'));
    brandingDir = await fs.mkdtemp(join(tmpdir(), 'branding-prefix-'));
    process.env.ICON_UPLOADS_DIR = iconDir;
    process.env.BRANDING_UPLOADS_DIR = brandingDir;
    iconService = new IconUploadService();
    brandingService = new BrandingAssetUploadService();
    await iconService.onModuleInit();
    await brandingService.onModuleInit();
  });

  afterEach(async () => {
    delete process.env.ICON_UPLOADS_DIR;
    delete process.env.BRANDING_UPLOADS_DIR;
    await fs.rm(iconDir, { recursive: true, force: true });
    await fs.rm(brandingDir, { recursive: true, force: true });
  });

  for (const payload of PREFIXED_PAYLOADS) {
    it(`nothing reaches /uploads: ${payload.name}`, async () => {
      for (const [service, dir] of [
        [iconService, iconDir],
        [brandingService, brandingDir],
      ] as const) {
        await assert.rejects(
          () =>
            service.persist({
              buffer: Buffer.from(payload.svg, 'utf8'),
              originalName: 'logo.svg',
              mimeType: 'image/svg+xml',
            }),
          /disallowed|single <svg>/i,
        );
        assert.deepEqual(await listDir(dir), []);
      }
    });
  }

  it('persists a UTF-16LE logo with a BOM, re-encoded as UTF-8', async () => {
    // `buffer.toString('utf8')` on a UTF-16 file produced mojibake that failed
    // the `^<svg` test, so the operator was told their logo "must be a single
    // <svg> element".
    const utf16 = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(INKSCAPE_OPTIMISED_SVG, 'utf16le'),
    ]);
    const out = await brandingService.persist({
      buffer: utf16,
      originalName: 'logo.svg',
      mimeType: 'image/svg+xml',
    });
    const stored = await fs.readFile(join(brandingDir, out.url.split('/').pop() as string));
    assert.equal(stored.toString('utf8'), INKSCAPE_OPTIMISED_SVG);
  });

  it('persists Illustrator output with the prolog and epilog stripped from disk', async () => {
    const out = await iconService.persist({
      buffer: Buffer.from(ILLUSTRATOR_SVG, 'utf8'),
      originalName: 'brand.svg',
      mimeType: 'image/svg+xml',
    });
    const stored = await fs.readFile(join(iconDir, out.url.split('/').pop() as string), 'utf8');
    assert.ok(stored.startsWith('<svg '));
    assert.ok(stored.endsWith('</svg>'));
    assert.ok(!stored.includes('<!DOCTYPE'));
    assert.ok(!stored.includes('Generator:'));
  });
});
