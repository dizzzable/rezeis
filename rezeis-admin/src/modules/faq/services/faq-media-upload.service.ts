import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';

export interface FaqUploadedMediaInterface {
  /** Public URL relative to the admin host (`/uploads/faq/<file>`). */
  readonly url: string;
  /** Original file name as supplied by the client (best-effort sanitised). */
  readonly originalName: string;
  /** MIME type verified from the file signature. */
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
]);
const ALLOWED_VIDEO_TYPES = new Set(['video/mp4', 'video/webm', 'video/quicktime', 'video/ogg']);

const EXT_BY_MIME = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/avif': '.avif',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  'video/ogg': '.ogv',
} as const;

type SupportedMediaMime = keyof typeof EXT_BY_MIME;

/**
 * FaqMediaUploadService
 * ─────────────────────
 * Persists FAQ attachments (images + videos) on the admin host's local
 * filesystem and returns a public URL the frontend can render directly.
 *
 * Storage layout: `<ADMIN_UPLOADS_DIR>/faq/<random>.<ext>`. The complete FAQ
 * directory can be overridden through `FAQ_UPLOADS_DIR` (mounted as a Docker
 * volume in production).
 *
 * Files are not enumerated or listed by the admin SPA: only `mediaUrls[]` on
 * `FaqItem` references them. The FAQ service reaps local files after their last
 * database reference is removed.
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
    // FAQ uploads are served from the admin origin; SVG can execute script
    // when opened as a document, so reject it to prevent stored XSS.
    if (input.mimeType === 'image/svg+xml') {
      try {
        // Strict decoding + check for <script> tag (case-insensitive)
        const content = input.buffer.toString('utf8');
        if (/<\/?script/i.test(content)) {
          throw new Error('SVG contains script tag');
        }
      } catch {
        throw new BadRequestException(
          'SVG-файлы запрещены по соображениям безопасности. Пожалуйста, используйте PNG, JPEG или WebP.',
        );
      }
      throw new BadRequestException(
        'SVG-файлы запрещены по соображениям безопасности. Пожалуйста, используйте PNG, JPEG или WebP.',
      );
    }

    const mediaType = inferMediaType(input.mimeType);
    if (mediaType === null) {
      throw new BadRequestException(
        `Unsupported file type: ${input.mimeType}. Allowed: image (png, jpeg, webp, gif, avif) or video (mp4, webm, mov, ogv).`,
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

    const detectedMimeType = detectMediaMimeType(input.buffer);
    if (detectedMimeType === null) {
      throw new BadRequestException(
        'File content does not match a supported image or video format',
      );
    }
    if (detectedMimeType !== input.mimeType) {
      throw new BadRequestException(
        `File content type (${detectedMimeType}) does not match declared MIME type (${input.mimeType})`,
      );
    }

    const ext = EXT_BY_MIME[detectedMimeType];
    const fileName = `${createId()}${ext}`;
    const fullPath = join(this.uploadsDir, fileName);
    await fs.writeFile(fullPath, input.buffer, { mode: 0o644 });
    return {
      url: `/uploads/faq/${fileName}`,
      originalName: sanitiseName(input.originalName),
      mimeType: detectedMimeType,
      mediaType,
      size: input.buffer.length,
    };
  }

  /** True only for a file managed by this service; external URLs are ignored. */
  public isManagedUrl(url: string): boolean {
    return extractManagedFileName(url) !== null;
  }

  /** Best-effort unlink constrained to the FAQ upload directory. */
  public async remove(url: string): Promise<void> {
    const fileName = extractManagedFileName(url);
    if (fileName === null) return;

    try {
      await fs.rm(join(this.uploadsDir, fileName), { force: true });
    } catch (error: unknown) {
      this.logger.warn(
        `Failed to remove FAQ media ${fileName}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private resolveUploadsDir(): string {
    const fromEnv = process.env.FAQ_UPLOADS_DIR;
    if (fromEnv && fromEnv.trim().length > 0) {
      return resolve(fromEnv);
    }

    const adminUploadsDir = process.env.ADMIN_UPLOADS_DIR;
    if (adminUploadsDir && adminUploadsDir.trim().length > 0) {
      return resolve(adminUploadsDir, 'faq');
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
  return name
    .replace(/[\r\n\t]/g, ' ')
    .trim()
    .slice(0, 200);
}

function createId(): string {
  // Collision-safe enough for human-scale FAQ media volume; we write
  // exactly one row per upload and the files are stable.
  return randomBytes(16).toString('hex');
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);
const WEBM_SIGNATURE = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
const MP4_BRANDS = new Set([
  'isom',
  'iso2',
  'iso3',
  'iso4',
  'iso5',
  'iso6',
  'mp41',
  'mp42',
  'avc1',
  'dash',
  'M4V ',
  'M4VP',
  'F4V ',
]);

/** Detect the supported format from the file header instead of trusting Multer. */
function detectMediaMimeType(buffer: Buffer): SupportedMediaMime | null {
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

  const isoBmffMimeType = detectIsoBmffMimeType(buffer);
  if (isoBmffMimeType !== null) return isoBmffMimeType;

  if (
    startsWith(buffer, WEBM_SIGNATURE) &&
    buffer.subarray(0, Math.min(buffer.length, 4_096)).includes(Buffer.from('webm'))
  ) {
    return 'video/webm';
  }

  if (
    buffer.length >= 4 &&
    buffer.subarray(0, 4).toString('ascii') === 'OggS' &&
    buffer.subarray(0, Math.min(buffer.length, 65_536)).includes(Buffer.from('theora'))
  ) {
    return 'video/ogg';
  }

  return null;
}

function detectIsoBmffMimeType(buffer: Buffer): SupportedMediaMime | null {
  if (buffer.length < 16 || buffer.subarray(4, 8).toString('ascii') !== 'ftyp') {
    return null;
  }

  const declaredBoxSize = buffer.readUInt32BE(0);
  if (declaredBoxSize < 16) return null;
  const boxEnd = Math.min(buffer.length, declaredBoxSize);
  if (boxEnd < 16) return null;

  const brands = new Set<string>([buffer.subarray(8, 12).toString('ascii')]);
  for (let offset = 16; offset + 4 <= boxEnd; offset += 4) {
    brands.add(buffer.subarray(offset, offset + 4).toString('ascii'));
  }

  if (brands.has('avif') || brands.has('avis')) return 'image/avif';
  if (brands.has('qt  ')) return 'video/quicktime';
  if ([...brands].some((brand) => MP4_BRANDS.has(brand))) return 'video/mp4';
  return null;
}

function startsWith(buffer: Buffer, signature: Buffer): boolean {
  return (
    buffer.length >= signature.length && buffer.subarray(0, signature.length).equals(signature)
  );
}

function extractManagedFileName(url: string): string | null {
  const match = /^\/uploads\/faq\/([A-Za-z0-9][A-Za-z0-9._-]{0,254})$/.exec(url);
  return match?.[1] ?? null;
}
