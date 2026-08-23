import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { verifyImageContent } from '../../settings/services/icon-upload.service';

export interface BotBannerUploadedInterface {
  /** Public URL relative to the admin host (`/uploads/bot-banners/<file>`). */
  readonly url: string;
  /** Original file name as supplied by the client (best-effort sanitised). */
  readonly originalName: string;
  /** MIME type verified from the file content (never the client's claim). */
  readonly mimeType: string;
  /** Stored size in bytes. */
  readonly size: number;
}

interface PersistInput {
  readonly buffer: Buffer;
  readonly originalName: string;
  readonly mimeType: string;
}

/**
 * Telegram caps photos at ~10MB; we accept up to 8MB to leave a
 * comfort margin for transcoding overhead. Anything bigger is almost
 * certainly an operator dropping a 4K screenshot — they should resize.
 */
const MAX_FILE_SIZE = 8 * 1024 * 1024;
const ALLOWED_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

const EXT_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

/**
 * BotBannerUploadService
 * ──────────────────────
 * Persists the welcome-screen banner image on the admin host's local
 * filesystem and returns a public URL reiwa-bot can fetch directly.
 *
 * Storage layout: `<dataRoot>/uploads/bot-banners/<random>.<ext>`
 * where `<dataRoot>` defaults to `./data` and is overridable via
 * `BOT_BANNER_UPLOADS_DIR` (mounted as a docker volume in production).
 *
 * Why local FS instead of S3 / blob: the admin already has a
 * mounted volume for FAQ uploads + admin assets, so adding banners
 * keeps the storage story uniform. When the operator uploads, we
 * write the file and the URL is stored in `BotText['bot.banner_url']`.
 * Reiwa fetches `https://<admin-host>/uploads/bot-banners/<file>`,
 * Telegram pulls the image from there, and the banner appears on
 * `/start`.
 *
 * Security: this directory is under the unauthenticated `/uploads` static
 * root, so the declared MIME type is never trusted — `verifyImageContent`
 * sniffs the file signature, requires it to agree with the declared type, and
 * the stored extension is derived from the SNIFFED type. Without that, an
 * operator could store arbitrary bytes (an HTML document, a script) under an
 * `.png` name. SVG is not in the allowlist here at all: Telegram cannot render
 * it as a photo, so accepting it would buy nothing and cost an active-content
 * surface.
 *
 * Files are never reaped — orphaned banners (operator uploads a new
 * one and overwrites the BotText URL) just sit on disk. Acceptable:
 * each banner is at most ~5MB and this is a once-in-a-while op.
 */
@Injectable()
export class BotBannerUploadService implements OnModuleInit {
  private readonly logger = new Logger(BotBannerUploadService.name);
  private uploadsDir!: string;

  public async onModuleInit(): Promise<void> {
    this.uploadsDir = this.resolveUploadsDir();
    await fs.mkdir(this.uploadsDir, { recursive: true });
    this.logger.log(`Bot banner uploads stored in ${this.uploadsDir}`);
  }

  public getUploadsDir(): string {
    return this.uploadsDir;
  }

  public async persist(input: PersistInput): Promise<BotBannerUploadedInterface> {
    if (!ALLOWED_TYPES.has(input.mimeType)) {
      throw new BadRequestException(
        `Unsupported file type: ${input.mimeType}. Allowed: png, jpeg, webp, gif.`,
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
    const fileName = `${createId()}${ext}`;
    const fullPath = join(this.uploadsDir, fileName);
    await fs.writeFile(fullPath, verified.buffer, { mode: 0o644 });
    return {
      url: `/uploads/bot-banners/${fileName}`,
      originalName: sanitiseName(input.originalName),
      mimeType: verified.mimeType,
      size: verified.buffer.length,
    };
  }

  private resolveUploadsDir(): string {
    const fromEnv = process.env.BOT_BANNER_UPLOADS_DIR;
    if (fromEnv && fromEnv.trim().length > 0) {
      return resolve(fromEnv);
    }
    return resolve(process.cwd(), 'data', 'uploads', 'bot-banners');
  }
}

export const BOT_BANNER_MAX_FILE_SIZE = MAX_FILE_SIZE;

function sanitiseName(name: string): string {
  return name.replace(/[\r\n\t]/g, ' ').trim().slice(0, 200);
}

function createId(): string {
  return randomBytes(16).toString('hex');
}
