import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';

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

interface PersistInput {
  readonly buffer: Buffer;
  readonly originalName: string;
  readonly mimeType: string;
}

// Branding assets (header logo / square PWA icon) are small; 2 MB is generous.
// PNG/WEBP for the install icon, SVG allowed for the header logo (validated).
const MAX_FILE_SIZE = 2 * 1024 * 1024;
const ALLOWED_TYPES = new Set(['image/png', 'image/webp', 'image/svg+xml']);

const EXT_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
};

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
        `Unsupported file type: ${input.mimeType}. Allowed: png, webp, svg.`,
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
    const fileName = `${randomBytes(16).toString('hex')}${ext}`;
    const fullPath = join(this.uploadsDir, fileName);
    await fs.writeFile(fullPath, verified.buffer, { mode: 0o644 });
    return {
      url: `/uploads/branding/${fileName}`,
      originalName: sanitiseName(input.originalName),
      mimeType: verified.mimeType,
      size: verified.buffer.length,
    };
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
