import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';

export interface EmojiAssetStoredInterface {
  readonly url: string;
  readonly size: number;
}

export type EmojiAssetKind = 'png' | 'webp' | 'jpeg' | 'lottie' | 'webm';

const MAX_IMAGE_BYTES = 1 * 1024 * 1024; // static preview — generous for 100px glyphs
const MAX_LOTTIE_BYTES = 2 * 1024 * 1024; // un-gzipped Lottie JSON
const MAX_VIDEO_BYTES = 2 * 1024 * 1024; // VP9 .webm emoji (Telegram caps ~256 KB; margin for stickers)

const EXT_BY_KIND: Record<EmojiAssetKind, string> = {
  png: '.png',
  webp: '.webp',
  jpeg: '.jpg',
  lottie: '.json',
  webm: '.webm',
};

/**
 * EmojiAssetUploadService
 * ───────────────────────
 * Persists custom-emoji assets (static PNG/WebP + Lottie JSON) on the admin
 * host filesystem under `<dataRoot>/uploads/emoji/`, served at `/uploads/emoji/`.
 * Mirrors IconUploadService but allows Lottie JSON (animation) which the cabinet
 * feed plays via lottie-web. JSON is data (never executed in an <img>/lottie
 * context) so it needs no script sanitisation; we still validate it parses.
 */
@Injectable()
export class EmojiAssetUploadService implements OnModuleInit {
  private readonly logger = new Logger(EmojiAssetUploadService.name);
  private uploadsDir!: string;

  public async onModuleInit(): Promise<void> {
    this.uploadsDir = this.resolveUploadsDir();
    await fs.mkdir(this.uploadsDir, { recursive: true });
    this.logger.log(`Custom emoji assets stored in ${this.uploadsDir}`);
  }

  public async persist(input: {
    readonly buffer: Buffer;
    readonly kind: EmojiAssetKind;
  }): Promise<EmojiAssetStoredInterface> {
    if (input.buffer.length === 0) {
      throw new BadRequestException('Empty emoji asset');
    }
    const limit = input.kind === 'lottie' ? MAX_LOTTIE_BYTES : input.kind === 'webm' ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
    if (input.buffer.length > limit) {
      throw new BadRequestException(
        `Emoji asset exceeds ${Math.round(limit / 1024)} KB limit`,
      );
    }
    if (input.kind === 'lottie') {
      try {
        JSON.parse(input.buffer.toString('utf8'));
      } catch {
        throw new BadRequestException('Lottie asset is not valid JSON');
      }
    }
    const fileName = `${randomBytes(16).toString('hex')}${EXT_BY_KIND[input.kind]}`;
    await fs.writeFile(join(this.uploadsDir, fileName), input.buffer, { mode: 0o644 });
    return { url: `/uploads/emoji/${fileName}`, size: input.buffer.length };
  }

  /** Best-effort delete of a stored asset by its public URL. */
  public async remove(url: string | null | undefined): Promise<void> {
    if (!url) return;
    const match = /\/uploads\/emoji\/([A-Za-z0-9._-]+)$/.exec(url);
    if (!match) return;
    const fileName = match[1]!;
    if (fileName.includes('/') || fileName.includes('\\') || fileName.includes('..')) return;
    await fs.rm(join(this.uploadsDir, fileName), { force: true }).catch((): void => undefined);
  }

  private resolveUploadsDir(): string {
    const fromEnv = process.env.EMOJI_UPLOADS_DIR;
    if (fromEnv && fromEnv.trim().length > 0) {
      return resolve(fromEnv);
    }
    // Keep assets under the statically-served uploads root so `/uploads/emoji/*`
    // resolves (main.ts serves `ADMIN_UPLOADS_DIR` || `<cwd>/data/uploads`).
    const adminRoot = process.env.ADMIN_UPLOADS_DIR;
    if (adminRoot && adminRoot.trim().length > 0) {
      return resolve(adminRoot, 'emoji');
    }
    return resolve(process.cwd(), 'data', 'uploads', 'emoji');
  }
}
