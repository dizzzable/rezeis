import 'reflect-metadata';

import assert from 'node:assert/strict';
import { promises as fs, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import express from 'express';
import request from 'supertest';

import { applyUploadResponseHeaders, MARKUP_UPLOAD_EXTENSIONS } from '../src/main';

/**
 * The SECOND layer under the SVG validator.
 * ─────────────────────────────────────────
 * `/uploads` is `express.static`, mounted OUTSIDE `setGlobalPrefix('api')` and
 * therefore outside every Nest guard, interceptor and filter — nothing in the
 * request pipeline can attach a header to these responses except the static
 * handler's own `setHeaders`, which was not set. The app-wide helmet CSP is no
 * help either: `buildHelmetOptions` returns `reportOnly: true` in production
 * and `false` everywhere else, so it enforced nothing anywhere.
 *
 * That is why the namespace-prefix bypass in the validator was an EXECUTION
 * rather than a bad file on disk. With these headers a future gap in the
 * reject-list costs an upload, not an execution — and reiwa proxies the same
 * directories onto the subscriber-facing origin, so it covers two origins.
 *
 * The assertions go through real `express.static`, not a hand-rolled `res`
 * stub: the point of failure being guarded is the WIRING (a `setHeaders` that
 * is never passed, or passed with the wrong arity), and a stub proves nothing
 * about that.
 */

/**
 * THE POLICY, WRITTEN OUT.
 *
 * These are the ANSWER, not a derivation of either side. reiwa keeps its own
 * hand-copy of the same three header values and the same extension list
 * (`reiwa/src/api/lib/upload-relay-headers.ts`) and re-serves these exact
 * bytes onto the subscriber-facing origin, so the two enforce ONE policy from
 * TWO lists. Stating it here means a one-sided edit has something to disagree
 * with; asserting only that the code agrees with itself would be green on the
 * day both sides are wrong.
 */
const EXPECTED_MARKUP_EXTENSIONS = [
  '.svg',
  '.svgz',
  '.xml',
  '.xhtml',
  '.html',
  '.htm',
  '.xht',
] as const;

/** Uploads the panel renders inline. Not the complement of the list above —
 *  a closed set of what actually gets uploaded, so a markup extension quietly
 *  DROPPED from the policy shows up as a download that stopped happening. */
const EXPECTED_INLINE_EXTENSIONS = ['.png', '.webp', '.jpg', '.jpeg', '.json', '.mp4', '.gif'] as const;

const EXPECTED_CSP = "default-src 'none'; sandbox";
const EXPECTED_NOSNIFF = 'nosniff';
const EXPECTED_MARKUP_DISPOSITION = 'attachment';

const SVG_BODY =
  '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>';

describe('/uploads response headers', () => {
  let dir: string;
  let app: express.Express;

  before(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'uploads-headers-'));
    await fs.mkdir(join(dir, 'branding'), { recursive: true });
    await fs.writeFile(join(dir, 'branding', 'logo.svg'), SVG_BODY, 'utf8');
    await fs.writeFile(join(dir, 'branding', 'icon.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await fs.writeFile(join(dir, 'branding', 'page.html'), '<html></html>', 'utf8');
    // One probe per extension in both lists, so the sweeps below go through
    // real `express.static` rather than asking the helper about itself.
    await fs.mkdir(join(dir, 'sweep'), { recursive: true });
    for (const extension of [...EXPECTED_MARKUP_EXTENSIONS, ...EXPECTED_INLINE_EXTENSIONS]) {
      // `.json` is served as application/json and the test client parses it,
      // so the probe body has to be valid JSON rather than a marker word.
      const body = extension === '.json' ? '{}' : 'probe';
      await fs.writeFile(join(dir, 'sweep', `probe${extension}`), body, 'utf8');
    }
    app = express();
    app.use(
      '/uploads',
      express.static(dir, {
        maxAge: '1y',
        immutable: true,
        setHeaders: applyUploadResponseHeaders,
      }),
    );
  });

  after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('serves an uploaded .svg with an enforced default-src none CSP', async () => {
    const response = await request(app).get('/uploads/branding/logo.svg').expect(200);
    assert.equal(response.headers['content-security-policy'], "default-src 'none'; sandbox");
    // The enforcing header, not the reporting one helmet sets in production.
    assert.equal(response.headers['content-security-policy-report-only'], undefined);
  });

  it('serves an uploaded .svg as an attachment, so navigating to it cannot render it', async () => {
    const response = await request(app).get('/uploads/branding/logo.svg').expect(200);
    assert.equal(response.headers['content-disposition'], 'attachment');
  });

  it('serves .html under /uploads as an attachment too', async () => {
    const response = await request(app).get('/uploads/branding/page.html').expect(200);
    assert.equal(response.headers['content-disposition'], 'attachment');
    assert.equal(response.headers['content-security-policy'], "default-src 'none'; sandbox");
  });

  it('does not force a download for a raster upload, which the panel renders inline', async () => {
    const response = await request(app).get('/uploads/branding/icon.png').expect(200);
    assert.equal(response.headers['content-disposition'], undefined);
    // The CSP still applies — it costs nothing on a PNG and it is one fewer
    // decision for whoever adds the next upload slot.
    assert.equal(response.headers['content-security-policy'], "default-src 'none'; sandbox");
  });

  it('sets nosniff on every upload', async () => {
    for (const path of ['/uploads/branding/logo.svg', '/uploads/branding/icon.png']) {
      const response = await request(app).get(path).expect(200);
      assert.equal(response.headers['x-content-type-options'], 'nosniff');
    }
  });

  it('is actually wired into the static handler in main.ts', () => {
    // The function above can be perfect and still guard nothing if the options
    // object stops passing it. This is the one thing the express harness cannot
    // observe, because it builds its own app.
    const mainSource = readFileSync(join(__dirname, '..', 'src', 'main.ts'), 'utf8');
    const staticCall = /app\.useStaticAssets\(\s*uploadsRoot\s*,\s*\{[\s\S]*?\}\s*\)/.exec(
      mainSource,
    );
    assert.ok(staticCall !== null, 'main.ts no longer serves /uploads through useStaticAssets');
    assert.match(
      staticCall[0],
      /setHeaders:\s*applyUploadResponseHeaders/,
      '/uploads is served with no setHeaders — every response header on it is gone',
    );
  });
  /**
   * ── THE LIST ITSELF, NOT ONLY ITS EFFECT ───────────────────────────────────
   *
   * Every case above drives a file through the static handler, which closes the
   * REMOVAL direction: drop `.htm` from the policy and a probe stops being an
   * attachment. It cannot close the ADDITION direction — a new extension in
   * `MARKUP_UPLOAD_EXTENSIONS` forces a download for a file no case here asks
   * for, and everything stays green while reiwa, which mirrors this list by
   * hand, goes on serving that same upload inline. So the list is read from the
   * live export and compared against the answer written at the top of this file.
   *
   * The export is why this is exact. `main.ts` is already imported here — the
   * bootstrap sits behind `require.main === module`, so nothing stands up — and
   * an imported binding cannot drift from the value the process actually uses
   * the way a re-typed literal or a source-text regex can.
   */
  it('pins MARKUP_UPLOAD_EXTENSIONS itself, so an ADDED extension cannot pass unnoticed', () => {
    // The answer first, spelled out a second time on purpose: if someone edits
    // the constant at the top to match a changed policy, this line objects.
    assert.deepEqual(
      [...EXPECTED_MARKUP_EXTENSIONS],
      ['.svg', '.svgz', '.xml', '.xhtml', '.html', '.htm', '.xht'],
    );
    // Non-vacuity: an emptied list would satisfy a subset check and every
    // "renders inline" case in this file at the same time.
    assert.ok(
      MARKUP_UPLOAD_EXTENSIONS.length > 0,
      'MARKUP_UPLOAD_EXTENSIONS is empty — /uploads forces nothing to download',
    );
    // ...and only then, that the origin says the same thing. Order-sensitive
    // and complete in both directions: no extension added, none removed.
    assert.deepEqual([...MARKUP_UPLOAD_EXTENSIONS], [...EXPECTED_MARKUP_EXTENSIONS]);
  });

  it('forces a download for every markup extension in the policy', async () => {
    assert.ok(EXPECTED_MARKUP_EXTENSIONS.length > 0, 'nothing to sweep');
    for (const extension of EXPECTED_MARKUP_EXTENSIONS) {
      const response = await request(app).get(`/uploads/sweep/probe${extension}`).expect(200);
      assert.equal(
        response.headers['content-disposition'],
        EXPECTED_MARKUP_DISPOSITION,
        `${extension} is rendered in the admin origin instead of downloaded`,
      );
      assert.equal(response.headers['content-security-policy'], EXPECTED_CSP, extension);
      assert.equal(response.headers['x-content-type-options'], EXPECTED_NOSNIFF, extension);
    }
  });

  it('leaves every non-markup upload inline, still sandboxed', async () => {
    assert.ok(EXPECTED_INLINE_EXTENSIONS.length > 0, 'nothing to sweep');
    for (const extension of EXPECTED_INLINE_EXTENSIONS) {
      const response = await request(app).get(`/uploads/sweep/probe${extension}`).expect(200);
      assert.equal(
        response.headers['content-disposition'],
        undefined,
        `${extension} is forced to download — inline media in the panel is broken`,
      );
      // Anchor: the handler did run, so "no disposition" is a decision rather
      // than a `setHeaders` that was never called at all.
      assert.equal(response.headers['content-security-policy'], EXPECTED_CSP, extension);
    }
  });
});
