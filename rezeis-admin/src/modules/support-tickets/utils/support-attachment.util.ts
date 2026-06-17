/**
 * Support attachment validation (pure, no DI)
 * ───────────────────────────────────────────
 * Hardening for the unauthenticated upload surface (Correctness Property 7):
 *   - MIME allow-list (png / jpeg / webp / pdf) — never trust the declared type.
 *   - Magic-byte sniff — the decoded bytes must match the allow-listed type.
 *   - Size cap (default 10 MB, env-overridable).
 *   - Display name sanitized; the on-disk name is a CUID + canonical ext
 *     so a caller can never influence the storage path (no traversal).
 */
import * as path from 'node:path';

export interface AllowedType {
  /** Canonical MIME type stored in the DB and returned on download. */
  readonly mime: string;
  /** Canonical file extension (no dot) used for the on-disk name. */
  readonly ext: string;
}

export interface ValidatedUpload {
  readonly buffer: Buffer;
  readonly type: AllowedType;
  readonly sizeBytes: number;
  /** Sanitized original name for display (never used for the disk path). */
  readonly displayName: string;
}

export type AttachmentRejectReason =
  | 'empty'
  | 'too-large'
  | 'bad-encoding'
  | 'type-not-allowed'
  | 'content-mismatch';

export class AttachmentValidationError extends Error {
  public constructor(public readonly reason: AttachmentRejectReason) {
    super(`attachment rejected: ${reason}`);
    this.name = 'AttachmentValidationError';
  }
}

const PNG = { mime: 'image/png', ext: 'png' } as const;
const JPEG = { mime: 'image/jpeg', ext: 'jpg' } as const;
const WEBP = { mime: 'image/webp', ext: 'webp' } as const;
const PDF = { mime: 'application/pdf', ext: 'pdf' } as const;

const ALLOWED: ReadonlyArray<AllowedType> = [PNG, JPEG, WEBP, PDF];

const DEFAULT_MAX_MB = 10;

/** Per-attachment byte cap from `SUPPORT_ATTACHMENT_MAX_MB` (default 10). */
export function maxAttachmentBytes(): number {
  const raw = Number.parseInt(process.env.SUPPORT_ATTACHMENT_MAX_MB ?? '', 10);
  const mb = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_MB;
  return mb * 1024 * 1024;
}

/** Max attachments per message from `SUPPORT_ATTACHMENT_MAX_PER_MSG` (default 5). */
export function maxAttachmentsPerMessage(): number {
  const raw = Number.parseInt(process.env.SUPPORT_ATTACHMENT_MAX_PER_MSG ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 5;
}

/** Resolve the attachment base dir (env override → `data/support-attachments`). */
export function resolveAttachmentsDir(): string {
  const override = (process.env.SUPPORT_ATTACHMENTS_DIR ?? '').trim();
  if (override.length > 0) return override;
  return path.join(process.cwd(), 'data', 'support-attachments');
}

/**
 * Decode + validate a base64 upload. Throws `AttachmentValidationError`
 * with a stable reason on any failure; never persists or touches disk.
 */
export function validateUpload(input: {
  readonly dataBase64: string;
  readonly filename: string;
  readonly declaredMime?: string;
  /** Byte cap; defaults to the env-derived limit when omitted. */
  readonly maxBytes?: number;
}): ValidatedUpload {
  const raw = typeof input.dataBase64 === 'string' ? input.dataBase64.trim() : '';
  if (raw.length === 0) throw new AttachmentValidationError('empty');

  const buffer = decodeBase64(raw);
  const cap = input.maxBytes !== undefined && input.maxBytes > 0 ? input.maxBytes : maxAttachmentBytes();
  if (buffer.length === 0) throw new AttachmentValidationError('bad-encoding');
  if (buffer.length > cap) throw new AttachmentValidationError('too-large');

  // The declared MIME is advisory only; the sniffed type is authoritative.
  const sniffed = sniffType(buffer);
  if (sniffed === null) throw new AttachmentValidationError('content-mismatch');

  // If the caller declared a type, it must agree with the allow-list family.
  if (input.declaredMime && normalizeMime(input.declaredMime) !== sniffed.mime) {
    throw new AttachmentValidationError('type-not-allowed');
  }

  return {
    buffer,
    type: sniffed,
    sizeBytes: buffer.length,
    displayName: sanitizeDisplayName(input.filename, sniffed.ext),
  };
}

/** The on-disk file name: `<cuid>.<ext>` — no caller bytes, no separators. */
export function buildStoredName(id: string, ext: string): string {
  const safeId = id.replace(/[^a-zA-Z0-9]/g, '');
  const safeExt = ext.replace(/[^a-z0-9]/g, '');
  return `${safeId}.${safeExt}`;
}

// ── internals ────────────────────────────────────────────────────────────────

function decodeBase64(raw: string): Buffer {
  // Accept optional data-URI prefix ("data:image/png;base64,....").
  const comma = raw.indexOf(',');
  const payload = raw.startsWith('data:') && comma !== -1 ? raw.slice(comma + 1) : raw;
  try {
    return Buffer.from(payload, 'base64');
  } catch {
    return Buffer.alloc(0);
  }
}

function normalizeMime(mime: string): string {
  return mime.split(';')[0]?.trim().toLowerCase() ?? '';
}

/** Identify an allow-listed type from leading magic bytes, or `null`. */
function sniffType(buf: Buffer): AllowedType | null {
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return PNG;
  }
  // JPEG: FF D8 FF
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return JPEG;
  }
  // WEBP: "RIFF"...."WEBP"
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return WEBP;
  }
  // PDF: "%PDF-"
  if (
    buf.length >= 5 &&
    buf[0] === 0x25 &&
    buf[1] === 0x50 &&
    buf[2] === 0x44 &&
    buf[3] === 0x46 &&
    buf[4] === 0x2d
  ) {
    return PDF;
  }
  return null;
}

function sanitizeDisplayName(name: string, fallbackExt: string): string {
  const base = (typeof name === 'string' ? name : '').replace(/[\\/]/g, '').trim();
  const cleaned = base.replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 120);
  if (cleaned.length === 0) return `attachment.${fallbackExt}`;
  return cleaned;
}

/** Exposed for tests: the canonical allow-list. */
export function allowedTypes(): ReadonlyArray<AllowedType> {
  return ALLOWED;
}
