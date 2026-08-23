import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { BrandingAssetUploadService } from '../src/modules/settings/services/branding-asset-upload.service';
import {
  mergeBrandingSettings,
  readBrandingSettings,
} from '../src/modules/settings/utils/branding-settings.util';

describe('BrandingAssetUploadService', () => {
  let dir: string;
  let service: BrandingAssetUploadService;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'branding-asset-'));
    process.env.BRANDING_UPLOADS_DIR = dir;
    service = new BrandingAssetUploadService();
    await service.onModuleInit();
  });

  afterEach(async () => {
    delete process.env.BRANDING_UPLOADS_DIR;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('persists a PNG under /uploads/branding and returns a relative URL', async () => {
    // The FULL 8-byte PNG signature. The service now sniffs the content rather
    // than trusting the declared type, and a truncated 4-byte prefix is not a
    // PNG — it is the shape an attacker sends to smuggle other bytes past a
    // declared-MIME check. Do not shorten this fixture to make the test pass.
    const out = await service.persist({
      buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      originalName: 'logo.png',
      mimeType: 'image/png',
    });
    assert.match(out.url, /^\/uploads\/branding\/[a-f0-9]{32}\.png$/);
    const onDisk = await fs.readFile(join(dir, out.url.split('/').pop() as string));
    assert.equal(onDisk.length, 8);
  });

  it('rejects an unsupported file type', async () => {
    await assert.rejects(
      () => service.persist({ buffer: Buffer.from('x'), originalName: 'a.gif', mimeType: 'image/gif' }),
      /Unsupported file type/,
    );
  });

  it('rejects an empty file', async () => {
    await assert.rejects(
      () => service.persist({ buffer: Buffer.alloc(0), originalName: 'a.png', mimeType: 'image/png' }),
      /empty/,
    );
  });

  it('rejects a file over the 2 MB limit', async () => {
    await assert.rejects(
      () =>
        service.persist({
          buffer: Buffer.alloc(2 * 1024 * 1024 + 1),
          originalName: 'big.png',
          mimeType: 'image/png',
        }),
      /exceeds/,
    );
  });

  it('refuses an SVG carrying script rather than cleaning it', async () => {
    // This used to assert the opposite — that the script was STRIPPED and the
    // file stored. Cleaning was the defect: the strip was a six-regex pass with
    // at least four valid-XML bypasses (a self-closing `<script/>`, `<animate
    // attributeName="xlink:href">`, `<set attributeName="onload">`, and an
    // entity-obfuscated `javascript:`), and `/uploads` is served
    // unauthenticated in the admin origin. A file that needs cleaning is now
    // refused outright, so a gap in the list costs an upload rather than an
    // execution.
    const dirty = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect/></svg>';
    await assert.rejects(
      () =>
        service.persist({
          buffer: Buffer.from(dirty, 'utf8'),
          originalName: 'logo.svg',
          mimeType: 'image/svg+xml',
        }),
      /disallowed/i,
    );
    assert.deepEqual(await fs.readdir(dir), [], 'a refused SVG must leave nothing on disk');
  });

  it('still accepts a legitimate vector logo untouched', async () => {
    // The other half of the rule: strictness that rejects real logos would be
    // its own outage. Paths, shapes and a gradient reference must pass through
    // byte-for-byte.
    const clean =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
      '<defs><linearGradient id="g"><stop offset="0" stop-color="#22c55e"/></linearGradient></defs>' +
      '<path d="M16 3 4 12l12 17 12-17Z" fill="url(#g)"/></svg>';
    const out = await service.persist({
      buffer: Buffer.from(clean, 'utf8'),
      originalName: 'logo.svg',
      mimeType: 'image/svg+xml',
    });
    const stored = await fs.readFile(join(dir, out.url.split('/').pop() as string), 'utf8');
    assert.equal(stored, clean);
  });

  it('remove() ignores path-traversal filenames', async () => {
    // Should resolve silently without throwing or escaping the dir.
    await service.remove('/uploads/branding/../../etc/passwd');
    await service.remove('/uploads/branding/..%2f..');
    assert.ok(true);
  });
});

describe('branding settings merge — pwaIconUrl', () => {
  it('reads pwaIconUrl from the JSON blob (null when absent)', () => {
    assert.equal(readBrandingSettings({}).pwaIconUrl, null);
    assert.equal(
      readBrandingSettings({ pwaIconUrl: '/uploads/branding/abc.png' }).pwaIconUrl,
      '/uploads/branding/abc.png',
    );
  });

  it('preserves pwaIconUrl through a partial merge of an unrelated field', () => {
    const merged = mergeBrandingSettings({
      existing: { pwaIconUrl: '/uploads/branding/abc.png', brandName: 'Acme' },
      patch: { primary: '#ff0000' },
    });
    assert.equal(merged.pwaIconUrl, '/uploads/branding/abc.png');
    assert.equal(merged.primary, '#ff0000');
    assert.equal(merged.brandName, 'Acme');
  });
});
