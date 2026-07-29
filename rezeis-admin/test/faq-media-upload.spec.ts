import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { BadRequestException } from '@nestjs/common';

import { FaqMediaUploadService } from '../src/modules/faq/services/faq-media-upload.service';

describe('FaqMediaUploadService', () => {
  let dir: string;
  let service: FaqMediaUploadService;
  let previousFaqUploadsDir: string | undefined;
  let previousAdminUploadsDir: string | undefined;

  beforeEach(async () => {
    previousFaqUploadsDir = process.env.FAQ_UPLOADS_DIR;
    previousAdminUploadsDir = process.env.ADMIN_UPLOADS_DIR;
    dir = await fs.mkdtemp(join(tmpdir(), 'faq-media-upload-'));
    process.env.FAQ_UPLOADS_DIR = dir;
    delete process.env.ADMIN_UPLOADS_DIR;
    service = new FaqMediaUploadService();
    await service.onModuleInit();
  });

  afterEach(async () => {
    restoreEnv('FAQ_UPLOADS_DIR', previousFaqUploadsDir);
    restoreEnv('ADMIN_UPLOADS_DIR', previousAdminUploadsDir);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('uses FAQ_UPLOADS_DIR as an exact override', () => {
    assert.equal(service.getUploadsDir(), resolve(dir));
  });

  it('defaults to the faq directory inside ADMIN_UPLOADS_DIR', async () => {
    delete process.env.FAQ_UPLOADS_DIR;
    process.env.ADMIN_UPLOADS_DIR = dir;

    const adminRootService = new FaqMediaUploadService();
    await adminRootService.onModuleInit();

    assert.equal(adminRootService.getUploadsDir(), resolve(dir, 'faq'));
    assert.equal((await fs.stat(join(dir, 'faq'))).isDirectory(), true);
  });

  it('rejects SVG uploads with a security-focused message', async () => {
    await assert.rejects(
      () =>
        service.persist({
          buffer: Buffer.from('<svg><script>alert(1)</script></svg>'),
          originalName: 'faq.svg',
          mimeType: 'image/svg+xml',
        }),
      BadRequestException,
    );
  });

  it('accepts every supported format when its magic bytes match the declared MIME', async () => {
    const fixtures = [
      { mimeType: 'image/png', extension: '.png', buffer: pngBuffer() },
      { mimeType: 'image/jpeg', extension: '.jpg', buffer: Buffer.from([0xff, 0xd8, 0xff]) },
      { mimeType: 'image/webp', extension: '.webp', buffer: Buffer.from('RIFF0000WEBP', 'ascii') },
      { mimeType: 'image/gif', extension: '.gif', buffer: Buffer.from('GIF89a', 'ascii') },
      { mimeType: 'image/avif', extension: '.avif', buffer: isoBmffBuffer('avif', ['mif1']) },
      {
        mimeType: 'video/mp4',
        extension: '.mp4',
        buffer: isoBmffBuffer('isom', ['iso2', 'mp41']),
      },
      {
        mimeType: 'video/webm',
        extension: '.webm',
        buffer: Buffer.concat([
          Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x82, 0x84]),
          Buffer.from('webm', 'ascii'),
        ]),
      },
      {
        mimeType: 'video/quicktime',
        extension: '.mov',
        buffer: isoBmffBuffer('qt  '),
      },
      {
        mimeType: 'video/ogg',
        extension: '.ogv',
        buffer: Buffer.concat([
          Buffer.from('OggS', 'ascii'),
          Buffer.alloc(24),
          Buffer.from('theora'),
        ]),
      },
    ] as const;

    for (const fixture of fixtures) {
      const uploaded = await service.persist({
        buffer: fixture.buffer,
        originalName: `guide${fixture.extension}`,
        mimeType: fixture.mimeType,
      });

      assert.match(uploaded.url, new RegExp(`^/uploads/faq/[a-f0-9]{32}\\${fixture.extension}$`));
      assert.equal(uploaded.mimeType, fixture.mimeType);
      assert.equal(uploaded.mediaType, fixture.mimeType.startsWith('image/') ? 'image' : 'video');
    }
  });

  it('rejects content whose magic bytes do not match the declared MIME type', async () => {
    await assert.rejects(
      () =>
        service.persist({
          buffer: pngBuffer(),
          originalName: 'spoofed.jpg',
          mimeType: 'image/jpeg',
        }),
      (error: unknown) =>
        error instanceof BadRequestException &&
        error.message.includes('does not match declared MIME type'),
    );
  });

  it('rejects fake files even when their declared MIME type is allowlisted', async () => {
    await assert.rejects(
      () =>
        service.persist({
          buffer: Buffer.from('<html>not an image</html>'),
          originalName: 'fake.png',
          mimeType: 'image/png',
        }),
      (error: unknown) =>
        error instanceof BadRequestException &&
        error.message.includes('does not match a supported'),
    );
  });

  it('removes only strict local FAQ URLs', async () => {
    const uploaded = await service.persist({
      buffer: pngBuffer(),
      originalName: 'faq.png',
      mimeType: 'image/png',
    });
    const uploadedPath = join(dir, uploaded.url.split('/').pop() as string);
    const sentinelPath = join(dir, 'sentinel.png');
    await fs.writeFile(sentinelPath, pngBuffer());

    await service.remove('https://cdn.example/faq.png');
    await service.remove('/uploads/faq/../sentinel.png');
    assert.equal((await fs.stat(sentinelPath)).isFile(), true);

    await service.remove(uploaded.url);
    await assert.rejects(fs.stat(uploadedPath), { code: 'ENOENT' });
  });
});

function pngBuffer(): Buffer {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
}

function isoBmffBuffer(majorBrand: string, compatibleBrands: readonly string[] = []): Buffer {
  const buffer = Buffer.alloc(16 + compatibleBrands.length * 4);
  buffer.writeUInt32BE(buffer.length, 0);
  buffer.write('ftyp', 4, 'ascii');
  buffer.write(majorBrand, 8, 'ascii');
  compatibleBrands.forEach((brand, index) => buffer.write(brand, 16 + index * 4, 'ascii'));
  return buffer;
}

function restoreEnv(
  name: 'FAQ_UPLOADS_DIR' | 'ADMIN_UPLOADS_DIR',
  value: string | undefined,
): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
