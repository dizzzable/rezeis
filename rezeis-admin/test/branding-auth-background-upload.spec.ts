import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { BrandingAssetUploadService } from '../src/modules/settings/services/branding-asset-upload.service';
import { readReplacedAuthBackgroundUrl } from '../src/modules/settings/services/settings.service';

/** The 8-byte PNG signature, then filler — enough for the content sniff. */
function png(bytes = 64): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(bytes),
  ]);
}

/** JPEG starts with FF D8 FF; the panel's photo picker sends exactly this. */
function jpeg(bytes = 64): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(bytes)]);
}

/** An MP4 carries its `ftyp` box at offset 4, as every real clip does. */
function mp4(bytes = 64): Buffer {
  return Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from('ftypisom', 'ascii'),
    Buffer.alloc(bytes),
  ]);
}

/** WebM/Matroska: the EBML magic. */
function webm(bytes = 64): Buffer {
  return Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(bytes)]);
}

describe('BrandingAssetUploadService — entry-screen background', () => {
  let dir: string;
  let service: BrandingAssetUploadService;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'branding-authbg-'));
    process.env.BRANDING_UPLOADS_DIR = dir;
    service = new BrandingAssetUploadService();
    await service.onModuleInit();
  });

  afterEach(async () => {
    delete process.env.BRANDING_UPLOADS_DIR;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('accepts the operator’s own JPEG photo — the format that used to answer 400', async () => {
    const out = await service.persistAuthBackground({
      buffer: jpeg(),
      originalName: 'testphoto1.jpg',
      mimeType: 'image/jpeg',
    });
    assert.equal(out.kind, 'image');
    assert.match(out.url, /^\/uploads\/branding\/[a-f0-9]{32}\.jpg$/);
    assert.equal(out.mimeType, 'image/jpeg');
  });

  it('stores a JPEG as a brand logo too (previously png/webp/svg only)', async () => {
    const out = await service.persist({
      buffer: jpeg(),
      originalName: 'logo.jpg',
      mimeType: 'image/jpeg',
    });
    assert.match(out.url, /\.jpg$/);
  });

  it('stores an MP4 clip as a VIDEO and names the kind from the bytes', async () => {
    const out = await service.persistAuthBackground({
      buffer: mp4(),
      originalName: 'Digital_Grapes.mp4',
      mimeType: 'video/mp4',
    });
    assert.equal(out.kind, 'video');
    assert.match(out.url, /^\/uploads\/branding\/[a-f0-9]{32}\.mp4$/);
    assert.equal(out.mimeType, 'video/mp4');
    assert.ok((await fs.stat(join(dir, out.url.split('/').pop() as string))).size > 0);
  });

  it('stores a WebM clip as a video', async () => {
    const out = await service.persistAuthBackground({
      buffer: webm(),
      originalName: 'bg.webm',
      mimeType: 'video/webm',
    });
    assert.equal(out.kind, 'video');
    assert.match(out.url, /\.webm$/);
  });

  it('refuses video bytes declared as an image (the "видео, а грузит фото" shape)', async () => {
    await assert.rejects(
      () =>
        service.persistAuthBackground({
          buffer: mp4(),
          originalName: 'clip.mp4',
          mimeType: 'image/png',
        }),
      /must be MP4 or WebM/,
    );
    assert.deepEqual(await fs.readdir(dir), [], 'a refused upload must leave nothing on disk');
  });

  it('refuses a clip whose container disagrees with the declared type', async () => {
    await assert.rejects(
      () =>
        service.persistAuthBackground({
          buffer: mp4(),
          originalName: 'clip.mp4',
          mimeType: 'video/webm',
        }),
      /does not match declared MIME type/,
    );
  });

  it('refuses an image over the slot’s 8 MB ceiling', async () => {
    await assert.rejects(
      () =>
        service.persistAuthBackground({
          buffer: png(8 * 1024 * 1024),
          originalName: 'huge.png',
          mimeType: 'image/png',
        }),
      /Image exceeds 8 MB limit/,
    );
  });

  it('keeps video out of the image slot’s ceilings: a 10 MB clip passes', async () => {
    const out = await service.persistAuthBackground({
      buffer: mp4(10 * 1024 * 1024),
      originalName: 'ten.mp4',
      mimeType: 'video/mp4',
    });
    assert.equal(out.kind, 'video');
  });

  it('remove() deletes the stored file and is silent when it is already gone', async () => {
    const out = await service.persistAuthBackground({
      buffer: mp4(),
      originalName: 'clip.mp4',
      mimeType: 'video/mp4',
    });
    const name = out.url.split('/').pop() as string;
    assert.equal((await fs.readdir(dir)).length, 1);
    await service.remove(out.url);
    assert.deepEqual(await fs.readdir(dir), []);
    await service.remove(out.url);
  });

  describe('sweeping abandoned uploads', () => {
    const OLD = Date.now() - 48 * 60 * 60 * 1000;

    async function store(name: string): Promise<string> {
      const out = await service.persistAuthBackground({
        buffer: mp4(),
        originalName: name,
        mimeType: 'video/mp4',
      });
      const full = join(dir, out.url.split('/').pop() as string);
      await fs.utimes(full, new Date(OLD), new Date(OLD));
      return out.url;
    }

    it('removes an old file no settings row names', async () => {
      const url = await store('abandoned.mp4');
      const removed = await service.removeUnreferenced({ referenced: JSON.stringify({}) });
      assert.equal(removed, 1);
      assert.deepEqual(await fs.readdir(dir), [], `expected ${url} to be swept`);
    });

    it('keeps a file the row still points at, however old', async () => {
      const url = await store('live.mp4');
      const removed = await service.removeUnreferenced({
        referenced: JSON.stringify({ brandingSettings: { authBackground: { kind: 'video', url } } }),
      });
      assert.equal(removed, 0);
      assert.equal((await fs.readdir(dir)).length, 1);
    });

    it('keeps a FRESH file — another tab may be about to save it', async () => {
      const out = await service.persistAuthBackground({
        buffer: mp4(),
        originalName: 'fresh.mp4',
        mimeType: 'video/mp4',
      });
      const removed = await service.removeUnreferenced({ referenced: JSON.stringify({}) });
      assert.equal(removed, 0);
      assert.equal((await fs.readdir(dir)).length, 1, `expected ${out.url} to survive`);
    });

    it('keeps a file younger than the age floor but sweeps the old one beside it', async () => {
      const old = await store('old.mp4');
      const fresh = await service.persistAuthBackground({
        buffer: mp4(),
        originalName: 'new.mp4',
        mimeType: 'video/mp4',
      });
      const removed = await service.removeUnreferenced({ referenced: JSON.stringify({}) });
      assert.equal(removed, 1);
      const left = await fs.readdir(dir);
      assert.deepEqual(
        left,
        [fresh.url.split('/').pop() as string],
        `expected only the fresh file to remain, swept ${old}`,
      );
    });
  });
});

describe('readReplacedAuthBackgroundUrl', () => {
  // The helper decides what leaves the server when a background is replaced or
  // cleared. Each case below is one way an operator can edit the slot.

  it('names the old upload when the background is cleared', () => {
    assert.equal(
      readReplacedAuthBackgroundUrl({
        previousRaw: { authBackground: { kind: 'video', url: '/uploads/branding/abc.mp4' } },
        mergedRaw: { authBackground: { kind: 'none', url: null } },
      }),
      '/uploads/branding/abc.mp4',
    );
  });

  it('names the old upload when a different file replaces it', () => {
    assert.equal(
      readReplacedAuthBackgroundUrl({
        previousRaw: { authBackground: { kind: 'image', url: '/uploads/branding/old.jpg' } },
        mergedRaw: { authBackground: { kind: 'image', url: '/uploads/branding/new.jpg' } },
      }),
      '/uploads/branding/old.jpg',
    );
  });

  it('keeps the file when the same address is saved again', () => {
    assert.equal(
      readReplacedAuthBackgroundUrl({
        previousRaw: { authBackground: { kind: 'image', url: '/uploads/branding/same.jpg' } },
        mergedRaw: { authBackground: { kind: 'image', url: '/uploads/branding/same.jpg' } },
      }),
      null,
    );
  });

  it('keeps a file another branding slot still points at', () => {
    assert.equal(
      readReplacedAuthBackgroundUrl({
        previousRaw: { authBackground: { kind: 'image', url: '/uploads/branding/shared.jpg' } },
        mergedRaw: {
          authBackground: { kind: 'none', url: null },
          logoUrl: '/uploads/branding/shared.jpg',
        },
      }),
      null,
    );
  });

  it('never names an external https address — only this panel’s uploads', () => {
    assert.equal(
      readReplacedAuthBackgroundUrl({
        previousRaw: {
          authBackground: { kind: 'video', url: 'https://cdn.example.com/clip.mp4' },
        },
        mergedRaw: { authBackground: { kind: 'none', url: null } },
      }),
      null,
    );
  });

  it('answers null for a row that never had a background', () => {
    assert.equal(
      readReplacedAuthBackgroundUrl({
        previousRaw: {},
        mergedRaw: { authBackground: { kind: 'image', url: '/uploads/branding/n.jpg' } },
      }),
      null,
    );
  });
});
