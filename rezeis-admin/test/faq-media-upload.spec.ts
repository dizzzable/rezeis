import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { FaqMediaUploadService } from '../src/modules/faq/services/faq-media-upload.service';

describe('FaqMediaUploadService', () => {
  let dir: string;
  let service: FaqMediaUploadService;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'faq-media-upload-'));
    process.env.FAQ_UPLOADS_DIR = dir;
    service = new FaqMediaUploadService();
    await service.onModuleInit();
  });

  afterEach(async () => {
    delete process.env.FAQ_UPLOADS_DIR;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('rejects SVG uploads with a security-focused message', async () => {
    await assert.rejects(
      () =>
        service.persist({
          buffer: Buffer.from('<svg><script>alert(1)</script></svg>'),
          originalName: 'faq.svg',
          mimeType: 'image/svg+xml',
        }),
      (error: unknown) =>
        error instanceof Error &&
        error.message ===
          'SVG-файлы запрещены по соображениям безопасности. Пожалуйста, используйте PNG, JPEG или WebP.',
    );
  });

  it('persists a safe raster image', async () => {
    const uploaded = await service.persist({
      buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      originalName: 'faq.png',
      mimeType: 'image/png',
    });

    assert.match(uploaded.url, /^\/uploads\/faq\/[a-f0-9]{32}\.png$/);
    assert.equal(uploaded.mediaType, 'image');
    assert.deepEqual(
      await fs.readFile(join(dir, uploaded.url.split('/').pop() as string)),
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );
  });
});
