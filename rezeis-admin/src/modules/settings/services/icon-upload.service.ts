import { promises as fs } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';

export interface IconUploadedInterface {
  /** Public URL relative to the admin host (`/uploads/icons/<file>`). */
  readonly url: string;
  /** Original file name as supplied by the client (best-effort sanitised). */
  readonly originalName: string;
  /** MIME type detected by multer. */
  readonly mimeType: string;
  /** Stored size in bytes (after SVG sanitisation, if applied). */
  readonly size: number;
}

interface PersistInput {
  readonly buffer: Buffer;
  readonly originalName: string;
  readonly mimeType: string;
}

// Icons are tiny; 2MB is generous and keeps a careless 4K PNG from landing
// in the library. SVG is allowed but sanitised (see `sanitiseSvg`).
const MAX_FILE_SIZE = 2 * 1024 * 1024;
const ALLOWED_TYPES = new Set([
  'image/svg+xml',
  'image/png',
  'image/webp',
]);

const EXT_BY_MIME: Record<string, string> = {
  'image/svg+xml': '.svg',
  'image/png': '.png',
  'image/webp': '.webp',
};

/**
 * IconUploadService
 * ─────────────────
 * Persists operator-uploaded custom icons on the admin host's local
 * filesystem and returns a public URL the panel + reiwa can render directly.
 *
 * Storage layout: `<dataRoot>/uploads/icons/<random>.<ext>` where `<dataRoot>`
 * defaults to `./data` and is overridable via `ICON_UPLOADS_DIR` (mounted as a
 * docker volume in production). Served by `main.ts`'s static handler under
 * `/uploads`.
 *
 * Security: SVG uploads are sanitised before they hit disk — `<script>`,
 * `on*` event handlers, `javascript:` URLs and `<foreignObject>` are stripped.
 * The `/uploads` path is unauthenticated, so an un-sanitised SVG opened
 * directly would run in the admin origin; the strip closes that hole while
 * keeping legitimate vector icons usable.
 */
@Injectable()
export class IconUploadService implements OnModuleInit {
  private readonly logger = new Logger(IconUploadService.name);
  private uploadsDir!: string;

  public async onModuleInit(): Promise<void> {
    this.uploadsDir = this.resolveUploadsDir();
    await fs.mkdir(this.uploadsDir, { recursive: true });
    this.logger.log(`Custom icon uploads stored in ${this.uploadsDir}`);
  }

  public async persist(input: PersistInput): Promise<IconUploadedInterface> {
    if (!ALLOWED_TYPES.has(input.mimeType)) {
      throw new BadRequestException(
        `Unsupported file type: ${input.mimeType}. Allowed: svg, png, webp.`,
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

    let buffer = input.buffer;
    if (input.mimeType === 'image/svg+xml') {
      buffer = Buffer.from(sanitiseSvg(input.buffer.toString('utf8')), 'utf8');
      if (buffer.length === 0) {
        throw new BadRequestException('SVG is empty after sanitisation');
      }
    }

    const ext = EXT_BY_MIME[input.mimeType] ?? extname(input.originalName) ?? '.bin';
    const fileName = `${randomBytes(16).toString('hex')}${ext}`;
    const fullPath = join(this.uploadsDir, fileName);
    await fs.writeFile(fullPath, buffer, { mode: 0o644 });
    return {
      url: `/uploads/icons/${fileName}`,
      originalName: sanitiseName(input.originalName),
      mimeType: input.mimeType,
      size: buffer.length,
    };
  }

  /**
   * Removes a previously stored icon file. Best-effort: a missing file
   * resolves silently (the catalog entry may have been removed first).
   * Guards against path traversal by accepting only the bare filename.
   */
  public async remove(url: string): Promise<void> {
    const match = /\/uploads\/icons\/([A-Za-z0-9._-]+)$/.exec(url);
    if (!match) return;
    const fileName = match[1];
    // Defence-in-depth: reject anything that isn't a flat filename.
    if (fileName.includes('/') || fileName.includes('\\') || fileName.includes('..')) {
      return;
    }
    await fs.rm(join(this.uploadsDir, fileName), { force: true }).catch(() => undefined);
  }

  private resolveUploadsDir(): string {
    const fromEnv = process.env.ICON_UPLOADS_DIR;
    if (fromEnv && fromEnv.trim().length > 0) {
      return resolve(fromEnv);
    }
    return resolve(process.cwd(), 'data', 'uploads', 'icons');
  }
}

export const ICON_MAX_FILE_SIZE = MAX_FILE_SIZE;

function sanitiseName(name: string): string {
  return name.replace(/[\r\n\t]/g, ' ').trim().slice(0, 200);
}

/**
 * Strips active content from an SVG string. Conservative regex-based pass —
 * we don't need to keep dynamic SVGs, only static icon glyphs, so anything
 * scriptable is removed wholesale:
 *   - `<script>...</script>` blocks
 *   - `<foreignObject>` (can embed arbitrary HTML)
 *   - `on*="..."` / `on*='...'` event-handler attributes
 *   - `javascript:` URLs inside href/xlink:href
 */
function sanitiseSvg(svg: string): string {
  return svg
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '')
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
    .replace(/(href|xlink:href)\s*=\s*"\s*javascript:[^"]*"/gi, '$1=""')
    .replace(/(href|xlink:href)\s*=\s*'\s*javascript:[^']*'/gi, "$1=''")
    .trim();
}
