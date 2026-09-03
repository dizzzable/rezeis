import { BadRequestException } from '@nestjs/common';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { extract, Headers } from 'tar-stream';

/**
 * Opening a donor's backup file, safely.
 *
 * Every importer receives the same thing — an operator's whole database, in
 * whatever shape the donor product chose to write it — and every importer has
 * to solve the same four problems before it can read a single row: is this
 * gzip, is it a tar, is any part of it big enough to exhaust the process, and
 * does any entry name try to escape the directory it claims to live in.
 *
 * That plumbing was written twice already (altshop and remnashop each carry
 * their own copy of it) and this file exists so it is not written a third
 * time. The limits and the path rules are security decisions; two copies of a
 * security decision is one copy too many, because only one of them gets fixed.
 *
 * What is deliberately NOT here: knowing which entry matters, or what the rows
 * mean. That is each importer's own business and differs per donor.
 *
 * ── Where the two copies disagreed ────────────────────────────────────────
 *
 * They were not identical, which is the whole argument for one of them. Each
 * disagreement is resolved toward the SAFER reading, never the more permissive
 * one:
 *
 *   • an empty upload — altshop's check let it through and it failed later on
 *     a JSON parse; remnashop refused it by name. Refused here.
 *   • a declared entry size — altshop demanded a safe integer, remnashop only
 *     a finite number. The safe integer wins.
 *   • a leading `./` on an entry name — altshop refused it, remnashop stripped
 *     it. Stripped here, and this is the one place the stricter reading LOST:
 *     `./name` is what GNU tar writes for an archive packed from `.`, refusing
 *     it fails on ordinary backups, and stripping relaxes no safety property —
 *     a null byte, a backslash, an absolute path, a `..` or an empty segment
 *     are all still refused.
 */

/** The file an operator uploads. */
export const MAX_INPUT_BYTES = 128 * 1024 * 1024;
/** A gzip bomb is a small file; the ceiling has to be on the OUTPUT. */
export const MAX_GZIP_OUTPUT_BYTES = 256 * 1024 * 1024;
export const MAX_ARCHIVE_ENTRY_BYTES = 256 * 1024 * 1024;
export const MAX_JSON_BYTES = 64 * 1024 * 1024;
export const MAX_SQL_BYTES = 256 * 1024 * 1024;

/**
 * Entry types a backup may legitimately contain. Anything else — a symlink, a
 * device node, a hard link — is refused rather than skipped: a backup has no
 * reason to carry one, and the reason to include one is never a good one.
 */
const ALLOWED_TAR_ENTRY_TYPES = new Set(['file', 'directory', 'pax-header', 'pax-global-header']);

/** Gzip magic: the first two bytes of every gzip stream. */
export function isGzipBuffer(buffer: Buffer): boolean {
  return buffer.length > 1 && buffer[0] === 0x1f && buffer[1] === 0x8b;
}

/** POSIX tar archives carry the "ustar" magic at byte offset 257. */
export function isTarBuffer(buffer: Buffer): boolean {
  return buffer.length > 262 && buffer.toString('ascii', 257, 262) === 'ustar';
}

/**
 * A tar without the magic — some writers omit it. Only ever used as a last
 * guess after every other reading has failed, never to choose a path.
 */
export function couldBeTarBuffer(buffer: Buffer): boolean {
  return buffer.length >= 512 && buffer.length % 512 === 0;
}

export function ensureBufferWithinLimit(buffer: Buffer, maxBytes: number, label: string): void {
  if (buffer.length === 0) {
    throw new BadRequestException(`${label} is empty`);
  }
  if (buffer.length > maxBytes) {
    throw new BadRequestException(`${label} exceeds ${formatBytes(maxBytes)}`);
  }
}

export async function gunzipBuffer(
  buffer: Buffer,
  maxBytes: number,
  label: string,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const readable = Readable.from([buffer]);
    const gunzip = createGunzip();
    const chunks: Buffer[] = [];
    let settled = false;
    let totalBytes = 0;

    const fail = (err: unknown): void => {
      if (settled) return;
      settled = true;
      const exception = toBadRequestException(err, `Failed to decompress ${label}`);
      readable.unpipe(gunzip);
      readable.destroy();
      gunzip.destroy();
      reject(exception);
    };

    gunzip.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      // Counted as it arrives, not at the end: the point of the ceiling is to
      // stop a small file from becoming a large one in memory.
      if (totalBytes > maxBytes) {
        fail(
          new BadRequestException(
            `${capitalize(label)} exceeds ${formatBytes(maxBytes)} after decompression`,
          ),
        );
        return;
      }
      chunks.push(chunk);
    });
    gunzip.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks, totalBytes));
    });
    gunzip.on('error', fail);
    readable.on('error', fail);
    readable.pipe(gunzip);
  });
}

export function readStreamToBuffer(
  stream: NodeJS.ReadableStream,
  maxBytes: number,
  label: string,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;
    let totalBytes = 0;

    const fail = (err: unknown): void => {
      if (settled) return;
      settled = true;
      const destroyable = stream as unknown as { destroy?: () => void };
      if (typeof destroyable.destroy === 'function') {
        destroyable.destroy();
      }
      reject(toBadRequestException(err, `Failed to read ${label}`));
    };

    stream.on('data', (chunk: Buffer | string) => {
      const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += bufferChunk.length;
      if (totalBytes > maxBytes) {
        fail(new BadRequestException(`${capitalize(label)} exceeds ${formatBytes(maxBytes)}`));
        return;
      }
      chunks.push(bufferChunk);
    });
    stream.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks, totalBytes));
    });
    stream.on('error', fail);
  });
}

/**
 * `size` is optional in the tar header, and an entry that does not declare one
 * is refused exactly like a malformed one — we will not read a payload whose
 * length cannot be bounded in advance.
 *
 * `isSafeInteger` rather than `isFinite`: a fractional size, or one past 2^53
 * where arithmetic on it stops being exact, is a header we do not understand,
 * and "we do not understand it" is not a reason to read it anyway.
 */
export function ensureArchiveEntrySize(name: string, size: number | undefined): void {
  if (size === undefined || !Number.isSafeInteger(size) || size < 0) {
    throw new BadRequestException(`Archive entry '${name}' has an invalid size`);
  }
  if (size > MAX_ARCHIVE_ENTRY_BYTES) {
    throw new BadRequestException(
      `Archive entry '${name}' exceeds ${formatBytes(MAX_ARCHIVE_ENTRY_BYTES)}`,
    );
  }
}

/**
 * Typed off the tar-stream header rather than a bare `string`: the library
 * reports `null` for an entry with no type byte, and that case must land on
 * the same "plain file" default as a missing one.
 */
export function normalizeTarEntryType(type: Headers['type']): 'file' | 'ignore' {
  const normalized = type ?? 'file';
  if (!ALLOWED_TAR_ENTRY_TYPES.has(normalized)) {
    throw new BadRequestException(`Unsafe entry type '${normalized}' is not allowed`);
  }
  return normalized === 'file' ? 'file' : 'ignore';
}

/**
 * The entry's name, or a refusal.
 *
 * Nothing here is extracted to disk, so this is not strictly a zip-slip guard
 * — but the name reaches log lines and error messages, and an absolute or
 * `..`-bearing path is a sign the archive was not written by the tool we think
 * wrote it. Refusing early is cheaper than deciding later which lie to trust.
 */
export function normalizeTarEntryName(name: string): string {
  if (typeof name !== 'string' || name.length === 0) {
    throw new BadRequestException('Archive entry has an empty name');
  }
  if (name.includes('\0')) {
    throw new BadRequestException('Archive entry name contains a null byte');
  }
  if (name.includes('\\')) {
    throw new BadRequestException(`Archive entry '${name}' uses an unsafe path separator`);
  }

  const trimmed = name.replace(/^(?:\.\/)+/, '').replace(/\/+$/, '');
  if (trimmed.length === 0 || trimmed.startsWith('/') || /^[A-Za-z]:/.test(trimmed)) {
    throw new BadRequestException(`Archive entry '${name}' has an unsafe path`);
  }

  const segments = trimmed.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new BadRequestException(`Archive entry '${name}' has an unsafe path`);
  }

  return trimmed;
}

/** One entry pulled out of an archive, with the name it had inside. */
export interface ArchivePayload<Kind extends string> {
  readonly kind: Kind;
  readonly name: string;
  readonly bytes: Buffer;
}

/**
 * Walk a decompressed tar and capture the ONE entry the caller cares about.
 *
 * `classify` returns a kind for an interesting entry and `null` for everything
 * else, so each importer decides what its donor's archive looks like without
 * re-implementing the walk. Two interesting entries is a refusal, not a race:
 * an archive with two databases in it is one we do not understand, and picking
 * either would be a guess about somebody's customers.
 */
export async function findArchivePayload<Kind extends string>(
  tarBuffer: Buffer,
  classify: (name: string) => Kind | null,
): Promise<ArchivePayload<Kind> | null> {
  return new Promise((resolve, reject) => {
    const readable = Readable.from([tarBuffer]);
    const extractor = extract();
    let settled = false;
    let payload: ArchivePayload<Kind> | null = null;

    const fail = (err: unknown): void => {
      if (settled) return;
      settled = true;
      const exception = toBadRequestException(err, 'Failed to parse backup contents');
      readable.unpipe(extractor);
      readable.destroy();
      extractor.destroy();
      reject(exception);
    };

    extractor.on('entry', (header: Headers, stream, next) => {
      let normalizedName: string;
      let type: 'file' | 'ignore';

      try {
        normalizedName = normalizeTarEntryName(header.name);
        type = normalizeTarEntryType(header.type);
        if (type === 'file') ensureArchiveEntrySize(normalizedName, header.size);
      } catch (err) {
        stream.resume();
        fail(err);
        return;
      }

      stream.on('error', fail);

      if (type !== 'file') {
        stream.resume();
        stream.on('end', next);
        return;
      }

      const kind = classify(normalizedName);
      if (kind === null) {
        stream.resume();
        stream.on('end', next);
        return;
      }

      if (payload !== null) {
        stream.resume();
        fail(
          new BadRequestException(
            `Archive contains duplicate database payloads ('${payload.name}' and '${normalizedName}')`,
          ),
        );
        return;
      }

      void readStreamToBuffer(stream, MAX_ARCHIVE_ENTRY_BYTES, `archive entry '${normalizedName}'`)
        .then((bytes) => {
          if (settled) return;
          payload = { kind, name: normalizedName, bytes };
          next();
        })
        .catch(fail);
    });

    extractor.on('finish', () => {
      if (settled) return;
      settled = true;
      resolve(payload);
    });

    extractor.on('error', fail);
    readable.on('error', fail);
    readable.pipe(extractor);
  });
}

export function formatBytes(bytes: number): string {
  const mebibytes = bytes / (1024 * 1024);
  return `${mebibytes.toFixed(Number.isInteger(mebibytes) ? 0 : 1)} MiB`;
}

export function capitalize(value: string): string {
  return value.length === 0 ? value : `${value[0].toUpperCase()}${value.slice(1)}`;
}

export function toBadRequestException(err: unknown, fallbackMessage: string): BadRequestException {
  if (err instanceof BadRequestException) return err;
  if (err instanceof Error && err.message.length > 0) {
    return new BadRequestException(`${fallbackMessage}: ${err.message}`);
  }
  return new BadRequestException(fallbackMessage);
}
