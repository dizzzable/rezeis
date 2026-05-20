import { promises as fs } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';

export interface FaqUploadedMediaInterface {
  /** Public URL relative to the admin host (`/uploads/faq/<file>`). */
  readonly url: string;
  /** Original file name as supplied by the client (best-effort sanitised). */
  readonly originalName: string;
  /** MIME type detected by multer. */
  readonly mimeType: string;
  /** `image` or `video`. */
  readonly mediaType: 'image' | 'video';
  /** Stored size in bytes. */
  readonly size: number;
}

interface PersistInput {
  readonly buffer: Buffer;
  readonly originalName: string;
  readonly mimeType: string;
}

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB
const ALLOWED_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/avif',
  'image/svg+xml',
]);
const ALLOWED_VIDEO_TYPES = new Set([
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/ogg',
]);

const EXT_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/avif': '.avif',
  'image/svg+xml': '.svg',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  'video/ogg': '.ogv',
};

/**
 * FaqMediaUploadService
 * ─────────────────────
 * Persists FAQ attachments (images + videos) on the admin host's local
 * filesystem and returns a public URL the frontend can render directly.
 *
 * Storage layout: `<dataRoot>/uploads/faq/<cuid>.<ext>` where
 * `<dataRoot>` defaults to `./data` and is overridable through
 * `FAQ_UPLOADS_DIR` (mounted as a docker volume in production).
 *
 * Files are not enumerated, listed, or otherwise touched by the admin
 * SPA — only `mediaUrls[]` on `FaqItem` references them. When a FAQ
 * entry is deleted, attached files become orphaned; that's acceptable
 * given the small data volume and the simplicity of the model.
 */
@Injectable()
export class FaqMediaUploadService implements OnModuleInit {
  private readonly logger = new Logger(FaqMediaUploadService.name);
  private uploadsDir!: string;

  public async onModuleInit(): Promise<void> {
    this.uploadsDir = this.resolveUploadsDir();
    await fs.mkdir(this.uploadsDir, { recursive: true });
    this.logger.log(`FAQ uploads stored in ${this.uploadsDir}`);
  }

  public getUploadsDir(): string {
    return this.uploadsDir;
  }

  public async persist(input: PersistInput): Promise<FaqUploadedMediaInterface> {
    const mediaType = inferMediaType(input.mimeType);
    if (mediaType === null) {
      throw new BadRequestException(
        `Unsupported file type: ${input.mimeType}. Allowed: image (png, jpeg, webp, gif, avif, svg) or video (mp4, webm, mov, ogv).`,
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
    const ext = EXT_BY_MIME[input.mimeType] ?? extname(input.originalName) ?? '.bin';
    const fileName = `${createId()}${ext}`;
    const fullPath = join(this.uploadsDir, fileName);
    await fs.writeFile(fullPath, input.buffer, { mode: 0o644 });
    return {
      url: `/uploads/faq/${fileName}`,
      originalName: sanitiseName(input.originalName),
      mimeType: input.mimeType,
      mediaType,
      size: input.buffer.length,
    };
  }

  private resolveUploadsDir(): string {
    const fromEnv = process.env.FAQ_UPLOADS_DIR;
    if (fromEnv && fromEnv.trim().length > 0) {
      return resolve(fromEnv);
    }
    return resolve(process.cwd(), 'data', 'uploads', 'faq');
  }
}

export const FAQ_MEDIA_MAX_FILE_SIZE = MAX_FILE_SIZE;
export const FAQ_MEDIA_ALLOWED_IMAGE_TYPES = ALLOWED_IMAGE_TYPES;
export const FAQ_MEDIA_ALLOWED_VIDEO_TYPES = ALLOWED_VIDEO_TYPES;

function inferMediaType(mime: string): 'image' | 'video' | null {
  if (ALLOWED_IMAGE_TYPES.has(mime)) return 'image';
  if (ALLOWED_VIDEO_TYPES.has(mime)) return 'video';
  return null;
}

function sanitiseName(name: string): string {
  return name.replace(/[\r\n\t]/g, ' ').trim().slice(0, 200);
}

function createId(): string {
  // Collision-safe enough for human-scale FAQ media volume; we write
  // exactly one row per upload and the files are stable.
  return randomBytes(16).toString('hex');
}
