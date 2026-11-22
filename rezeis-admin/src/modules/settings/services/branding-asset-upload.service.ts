import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { QR_LOGO_SVG_MAX_BYTES } from '../utils/branding-qr-style.util';
import { verifyImageContent } from './icon-upload.service';

export interface BrandingAssetUploadedInterface {
  /** Public URL relative to the admin host (`/uploads/branding/<file>`). */
  readonly url: string;
  /** Original file name as supplied by the client (best-effort sanitised). */
  readonly originalName: string;
  /** MIME type verified from the file content (never the client's claim). */
  readonly mimeType: string;
  /** Stored size in bytes (after SVG validation, if applied). */
  readonly size: number;
}

/**
 * An entry-screen background upload, whose slot decides the KIND as well as
 * the file: the panel asks for the media, and the answer says which mode the
 * `authBackground` block should hold.
 */
export interface BrandingAuthBackgroundUploadedInterface extends BrandingAssetUploadedInterface {
  readonly kind: 'image' | 'video';
}

/**
 * What an upload is for, when that changes what it may be.
 *
 *   - `asset` — the header logo, the PWA icon, card artwork: the slots' own
 *     ceilings, 2 MB for a raster file and `SVG_MAX_BYTES` (512 KB) for SVG.
 *   - `qr-logo` — a logo for the middle of the subscriber's QR codes. The
 *     cabinet inlines an SVG logo whole into every code and loads NO logo from
 *     an SVG over `QR_LOGO_SVG_MAX_BYTES` (96 KB) — silently, the code simply
 *     appears without it — so that is this purpose's SVG ceiling, refused here
 *     where the operator is told. Rasters keep the 2 MB: the cabinet redraws
 *     them to 256 px before they go anywhere.
 *
 * Every other rule — the types, the sniffing, the SVG reject-list — is the
 * same for both, through the same `verifyImageContent`.
 */
export type BrandingAssetPurpose = 'asset' | 'qr-logo';

interface PersistInput {
  readonly buffer: Buffer;
  readonly originalName: string;
  readonly mimeType: string;
  /** `asset` when absent. */
  readonly purpose?: BrandingAssetPurpose;
}

// Branding assets (header logo / square PWA icon) are small; 2 MB is generous.
// PNG/WEBP for the install icon, SVG allowed for the header logo (validated).
// JPEG is accepted too because operators arrive with photos: a `.jpg` was
// refused as an unsupported type while the panel's picker offered it.
const MAX_FILE_SIZE = 2 * 1024 * 1024;
const ALLOWED_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']);

const EXT_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
};

/**
 * The entry-screen background slot's own ceilings. A wallpaper is a real
 * photograph (a phone camera writes 3–6 MB), and a background video is a video
 * — the operator's own 40 MB clip has to fit. The multer interceptor is sized
 * for the larger of the two; the per-kind ceiling is enforced here, where the
 * sniffed kind is known.
 */
const AUTH_BACKGROUND_IMAGE_MAX_FILE_SIZE = 8 * 1024 * 1024;
const AUTH_BACKGROUND_VIDEO_MAX_FILE_SIZE = 128 * 1024 * 1024;

/** The widest thing this slot accepts, for the interceptor's own limit. */
export const BRANDING_AUTH_BACKGROUND_MAX_UPLOAD_BYTES = AUTH_BACKGROUND_VIDEO_MAX_FILE_SIZE;

/**
 * How old an unreferenced upload must be before a save may sweep it. A day is
 * far longer than any operator's window between picking a file and pressing
 * «Сохранить», and short enough that an abandoned 40 MB clip does not cost disk
 * for a week.
 */
export const BRANDING_UPLOAD_ABANDONED_AFTER_MS = 24 * 60 * 60 * 1000;

/** What the cabinet's relay can serve; the panel's DTO matches these. */
const AUTH_BACKGROUND_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const AUTH_BACKGROUND_VIDEO_TYPES = new Set(['video/mp4', 'video/webm']);

const AUTH_BACKGROUND_VIDEO_EXT_BY_MIME: Record<string, string> = {
  'video/mp4': '.mp4',
  'video/webm': '.webm',
};

/** MP4 carries its `ftyp` box at offset 4; WebM starts with the EBML magic. */
function detectVideoMimeType(buffer: Buffer): 'video/mp4' | 'video/webm' | null {
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp') {
    return 'video/mp4';
  }
  if (
    buffer.length >= 4 &&
    buffer[0] === 0x1a &&
    buffer[1] === 0x45 &&
    buffer[2] === 0xdf &&
    buffer[3] === 0xa3
  ) {
    return 'video/webm';
  }
  return null;
}


/**
 * BrandingAssetUploadService
 * ──────────────────────────
 * Persists operator-uploaded branding assets (the header logo and the square
 * PWA install icon) on the admin host's local filesystem and returns a public
 * URL stored in `Settings.brandingSettings` (`logoUrl` / `pwaIconUrl`).
 *
 * Storage layout: `<dataRoot>/uploads/branding/<random>.<ext>` where
 * `<dataRoot>` defaults to `./data/uploads/branding` and is overridable via
 * `BRANDING_UPLOADS_DIR` (mounted as a docker volume in production). Served by
 * `main.ts`'s static handler under `/uploads`, and proxied + disk-cached by the
 * reiwa edge so the icon survives an admin outage.
 *
 * Security mirrors `IconUploadService` exactly — same `verifyImageContent`
 * gate, same reject-list for SVG, same rule that the stored extension comes
 * from the sniffed type and not from the client's declared one. `/uploads` is
 * unauthenticated and outside every Nest guard, so an SVG that survives this
 * check would execute in the admin origin when opened as a document. A
 * legitimate vector logo (paths, shapes, gradients, `fill="url(#id)"`) passes
 * untouched; one carrying script, an external reference, or an entity-encoded
 * URL is refused rather than partially cleaned.
 */
@Injectable()
export class BrandingAssetUploadService implements OnModuleInit {
  private readonly logger = new Logger(BrandingAssetUploadService.name);
  private uploadsDir!: string;

  public async onModuleInit(): Promise<void> {
    this.uploadsDir = this.resolveUploadsDir();
    await fs.mkdir(this.uploadsDir, { recursive: true });
    this.logger.log(`Branding asset uploads stored in ${this.uploadsDir}`);
  }

  public async persist(input: PersistInput): Promise<BrandingAssetUploadedInterface> {
    if (!ALLOWED_TYPES.has(input.mimeType)) {
      throw new BadRequestException(
        `Unsupported file type: ${input.mimeType}. Allowed: png, jpg, webp, svg.`,
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

    const verified = verifyImageContent(input.buffer, input.mimeType, ALLOWED_TYPES, {
      svgMaxBytes: input.purpose === 'qr-logo' ? QR_LOGO_SVG_MAX_BYTES : undefined,
    });
    const ext = EXT_BY_MIME[verified.mimeType];
    const url = await this.write(this.uploadsDir, ext, verified.buffer);
    return {
      url,
      originalName: sanitiseName(input.originalName),
      mimeType: verified.mimeType,
      size: verified.buffer.length,
    };
  }

  /**
   * Stores an entry-screen background — a photograph or a video — and answers
   * which mode the `authBackground` block must hold.
   *
   * The kind comes from the BYTES, never from the client's `Content-Type` or
   * from the picker the panel drew: a `.mp4` declared `image/png` is refused as
   * a video, and the stored extension follows the sniffed type. Both media are
   * served by the reiwa relay from this same tree, so the file lands next to
   * the logos with a name of its own.
   */
  public async persistAuthBackground(
    input: PersistInput,
  ): Promise<BrandingAuthBackgroundUploadedInterface> {
    if (input.buffer.length === 0) {
      throw new BadRequestException('Uploaded file is empty');
    }

    const videoMimeType = detectVideoMimeType(input.buffer);
    if (videoMimeType !== null) {
      if (!AUTH_BACKGROUND_VIDEO_TYPES.has(input.mimeType)) {
        throw new BadRequestException(
          `Unsupported file type: ${input.mimeType}. A video background must be MP4 or WebM.`,
        );
      }
      if (input.buffer.length > AUTH_BACKGROUND_VIDEO_MAX_FILE_SIZE) {
        throw new BadRequestException(
          `Video exceeds ${Math.round(AUTH_BACKGROUND_VIDEO_MAX_FILE_SIZE / 1024 / 1024)} MB limit`,
        );
      }
      if (videoMimeType !== input.mimeType) {
        throw new BadRequestException(
          `File content type (${videoMimeType}) does not match declared MIME type (${input.mimeType})`,
        );
      }
      const ext = AUTH_BACKGROUND_VIDEO_EXT_BY_MIME[videoMimeType];
      const url = await this.write(this.uploadsDir, ext, input.buffer);
      return {
        url,
        kind: 'video',
        originalName: sanitiseName(input.originalName),
        mimeType: videoMimeType,
        size: input.buffer.length,
      };
    }

    if (input.buffer.length > AUTH_BACKGROUND_IMAGE_MAX_FILE_SIZE) {
      throw new BadRequestException(
        `Image exceeds ${Math.round(AUTH_BACKGROUND_IMAGE_MAX_FILE_SIZE / 1024 / 1024)} MB limit`,
      );
    }
    const verified = verifyImageContent(
      input.buffer,
      input.mimeType,
      AUTH_BACKGROUND_IMAGE_TYPES,
    );
    const ext = EXT_BY_MIME[verified.mimeType];
    const url = await this.write(this.uploadsDir, ext, verified.buffer);
    return {
      url,
      kind: 'image',
      originalName: sanitiseName(input.originalName),
      mimeType: verified.mimeType,
      size: verified.buffer.length,
    };
  }

  /** One naming+write rule for every file this service stores. */
  private async write(dir: string, ext: string, buffer: Buffer): Promise<string> {
    const fileName = `${randomBytes(16).toString('hex')}${ext}`;
    await fs.writeFile(join(dir, fileName), buffer, { mode: 0o644 });
    return `/uploads/branding/${fileName}`;
  }

  /**
   * Removes a previously stored branding asset. Best-effort: a missing file
   * resolves silently. Guards against path traversal by accepting only the
   * bare filename.
   */
  public async remove(url: string): Promise<void> {
    const match = /\/uploads\/branding\/([A-Za-z0-9._-]+)$/.exec(url);
    if (!match) return;
    const fileName = match[1];
    if (fileName.includes('/') || fileName.includes('\\') || fileName.includes('..')) {
      return;
    }
    await fs.rm(join(this.uploadsDir, fileName), { force: true }).catch((): void => undefined);
  }

  /**
   * Sweeps files nobody points at any more: an upload abandoned mid-flow (the
   * operator picked a video, saw the preview, closed the tab) leaves bytes on
   * the disk that no settings row will ever name again.
   *
   * `referenced` is the whole serialised settings row — every slot that can
   * name a branding upload lives there, so a filename absent from it is not
   * used. The age floor is what makes this safe rather than clever: a file
   * younger than `minAgeMs` may be exactly what another tab is about to save,
   * and deleting it would break a background the operator believes they staged.
   * Answers how many files were removed.
   */
  public async removeUnreferenced(input: {
    readonly referenced: string;
    readonly minAgeMs?: number;
    readonly now?: number;
  }): Promise<number> {
    const minAgeMs = input.minAgeMs ?? BRANDING_UPLOAD_ABANDONED_AFTER_MS;
    const now = input.now ?? Date.now();
    let names: string[];
    try {
      names = await fs.readdir(this.uploadsDir);
    } catch {
      return 0;
    }
    let removed = 0;
    for (const name of names) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.includes('..')) continue;
      if (input.referenced.includes(`/uploads/branding/${name}`)) continue;
      const fullPath = join(this.uploadsDir, name);
      try {
        const stat = await fs.stat(fullPath);
        if (!stat.isFile() || now - stat.mtimeMs < minAgeMs) continue;
        await fs.rm(fullPath, { force: true });
        removed += 1;
      } catch {
        // Gone already, or not ours to remove: the next save looks again.
      }
    }
    return removed;
  }

  private resolveUploadsDir(): string {
    const fromEnv = process.env.BRANDING_UPLOADS_DIR;
    if (fromEnv && fromEnv.trim().length > 0) {
      return resolve(fromEnv);
    }
    return resolve(process.cwd(), 'data', 'uploads', 'branding');
  }
}

export const BRANDING_ASSET_MAX_FILE_SIZE = MAX_FILE_SIZE;

function sanitiseName(name: string): string {
  return name.replace(/[\r\n\t]/g, ' ').trim().slice(0, 200);
}
