import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createReadStream, promises as fsp } from 'node:fs';
import * as zlib from 'node:zlib';

/**
 * Proof that a `.sql.gz` archive was produced by THIS deployment.
 *
 * Why it exists
 * ─────────────
 * `runRestore` pipes the decompressed archive straight into
 * `psql --single-transaction` as the application's database role. Whatever SQL
 * the file contains, runs — including `INSERT INTO admin_users (… role='DEV' …)`,
 * `DELETE FROM admin_audit_log` or `UPDATE admin_ip_allowlist SET is_active=false`.
 * Before this, the only thing standing between an uploaded file and that pipe
 * was a two-byte gzip magic check, and the `checksum` column was computed FROM
 * the uploaded file, so it attested to nothing.
 *
 * The stamp
 * ─────────
 * After a dump completes, a second GZIP MEMBER is appended to the file:
 *
 *     \n-- rezeis-backup-provenance v1 <sha256-of-everything-before> <hmac>\n
 *
 * A `.gz` file may be a concatenation of members and `gunzip` joins their
 * output, so the stamp costs one append of ~190 bytes — no rewrite of a
 * gigabyte — and `psql` reads it as a trailing SQL comment. It survives the
 * Telegram round trip because it lives INSIDE the file the operator downloads.
 *
 * `<sha256-of-everything-before>` covers the compressed dump bytes, so
 * verification is a single hash pass over the file rather than a full
 * decompression: fast enough to run inline on the HTTP request that starts a
 * restore, and again in the worker before the pipe opens.
 *
 * What it does and does not prove
 * ───────────────────────────────
 * Verified means: this deployment's crypt key signed this exact content. It
 * does NOT mean the archive is recent, or that restoring it is a good idea.
 * Splicing a valid stamp onto other SQL fails the content hash; appending SQL
 * after the stamp fails the trailer parse; editing the dump fails both.
 *
 * An archive from ANOTHER deployment can never verify — that is the point, and
 * it is also why refusing a foreign archive outright would break server
 * migration. The caller decides what an unverified archive costs; this module
 * only answers the question.
 */

/** Comment prefix the trailer line always starts with. Also its SQL disguise. */
export const PROVENANCE_MARKER = '-- rezeis-backup-provenance';

/** Bumped only for an incompatible trailer format. Verification pins it. */
const PROVENANCE_VERSION = 'v1';

/**
 * How far back from EOF the trailer member is looked for.
 *
 * The stamped member is ~190 bytes. 4 KiB leaves room for a future longer
 * trailer while keeping the scan (and the number of `gunzipSync` attempts on
 * false `1f 8b` matches inside compressed data) bounded and cheap.
 */
const TRAILER_SCAN_BYTES = 4096;

const HEX64 = /^[0-9a-f]{64}$/;

/** Why an archive is not provably ours. Recorded in audit metadata verbatim. */
export type ForeignArchiveReason =
  /** `REZEIS_CRYPT_KEY` is unset, so nothing can be signed or verified here. */
  | 'no_crypt_key'
  /** No trailer at all — a foreign archive, or one taken before stamping existed. */
  | 'unstamped'
  /** A trailer is there but does not parse, or carries trailing bytes. */
  | 'malformed_stamp'
  /** A trailer from a format this build does not know how to check. */
  | 'unsupported_stamp_version'
  /** Signed by a different key: another deployment, or a rotated key. */
  | 'signature_mismatch'
  /** Valid signature, wrong content — the archive was edited after stamping. */
  | 'content_mismatch'
  /** The file could not be read or is not a gzip stream. */
  | 'unreadable';

export type ArchiveProvenance =
  | { readonly status: 'native'; readonly payloadSha256: string }
  | { readonly status: 'foreign'; readonly reason: ForeignArchiveReason };

/**
 * HMAC key for the stamp.
 *
 * Every other cipher in this tree derives from the master key through SHA-256
 * with a domain separator (`ai-secret-cipher.ts`, `payment-gateway-secret-cipher.ts`,
 * `secret-cipher.ts`); this follows the same rule so a stamp can never be
 * confused with, or replayed against, any other use of the same master key.
 */
export function deriveProvenanceKey(cryptKey: string): Buffer {
  return createHash('sha256').update(`rezeis-admin:backup-provenance:${cryptKey}`).digest();
}

function signBody(body: string, cryptKey: string): string {
  return createHmac('sha256', deriveProvenanceKey(cryptKey)).update(body).digest('hex');
}

/** The gzip member appended to a freshly-written dump. */
export function buildProvenanceTrailer(payloadSha256: string, cryptKey: string): Buffer {
  const body = `${PROVENANCE_MARKER} ${PROVENANCE_VERSION} ${payloadSha256}`;
  return zlib.gzipSync(Buffer.from(`\n${body} ${signBody(body, cryptKey)}\n`, 'utf8'));
}

/** Both sides are fixed-width lowercase hex, so length is not a secret. */
function hexEquals(left: string, right: string): boolean {
  if (!HEX64.test(left) || !HEX64.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

interface ParsedTrailer {
  readonly declaredSha256: string;
  readonly mac: string;
}

/**
 * Read a decompressed trailer member back into its two fields.
 *
 * Rejects anything after the line, which is what stops the obvious splice:
 * take a genuine archive, append `DROP TABLE …` behind the stamp, and hope the
 * parser reads only as far as it recognises.
 */
function parseTrailer(text: string): ParsedTrailer | null {
  const line = text.trim();
  if (line.includes('\n') || line.includes('\r')) return null;
  const parts = line.split(' ');
  // `-- rezeis-backup-provenance` is itself two tokens.
  if (parts.length !== 5) return null;
  if (`${parts[0]} ${parts[1]}` !== PROVENANCE_MARKER) return null;
  if (parts[2] !== PROVENANCE_VERSION) return null;
  const declaredSha256 = parts[3] ?? '';
  const mac = parts[4] ?? '';
  if (!HEX64.test(declaredSha256) || !HEX64.test(mac)) return null;
  return { declaredSha256, mac };
}

interface LocatedTrailer {
  /** Byte offset in the FILE where the trailer member starts. */
  readonly offset: number;
  readonly parsed: ParsedTrailer;
}

/**
 * Find the trailer member by scanning the file's tail backwards for a gzip
 * header and trying to decompress from there.
 *
 * Not by fixed length: the compressed size of a fixed-length input is stable
 * for one zlib build but is not a format guarantee, and an archive stamped by
 * one release must stay verifiable by the next. A stray `1f 8b 08` inside
 * compressed data either fails to decompress or fails to parse, so a false
 * match costs a `gunzipSync` on a few hundred bytes and nothing else.
 */
async function locateTrailer(filePath: string): Promise<LocatedTrailer | null> {
  const handle = await fsp.open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(TRAILER_SCAN_BYTES, size);
    if (length <= 0) return null;
    const start = size - length;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);

    for (let index = length - 3; index >= 0; index -= 1) {
      if (buffer[index] !== 0x1f || buffer[index + 1] !== 0x8b || buffer[index + 2] !== 0x08) {
        continue;
      }
      let text: string;
      try {
        text = zlib.gunzipSync(buffer.subarray(index)).toString('utf8');
      } catch {
        continue;
      }
      const parsed = parseTrailer(text);
      if (parsed === null) continue;
      return { offset: start + index, parsed };
    }
    return null;
  } finally {
    await handle.close();
  }
}

/** SHA-256 over `[0, byteLength)` of a file, streamed. */
async function sha256OfPrefix(filePath: string, byteLength: number): Promise<string> {
  if (byteLength <= 0) return createHash('sha256').digest('hex');
  return new Promise<string>((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath, { start: 0, end: byteLength - 1 });
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Answer whether this deployment produced `filePath`.
 *
 * Never throws: an unreadable or non-gzip file is `foreign`, because "we cannot
 * tell" and "it is not ours" must lead to the same, cautious place.
 */
export async function readArchiveProvenance(
  filePath: string,
  cryptKey: string,
): Promise<ArchiveProvenance> {
  if (cryptKey.length === 0) {
    return { status: 'foreign', reason: 'no_crypt_key' };
  }
  let located: LocatedTrailer | null;
  try {
    located = await locateTrailer(filePath);
  } catch {
    return { status: 'foreign', reason: 'unreadable' };
  }
  if (located === null) {
    return { status: 'foreign', reason: 'unstamped' };
  }

  const body = `${PROVENANCE_MARKER} ${PROVENANCE_VERSION} ${located.parsed.declaredSha256}`;
  if (!hexEquals(located.parsed.mac, signBody(body, cryptKey))) {
    return { status: 'foreign', reason: 'signature_mismatch' };
  }

  let actual: string;
  try {
    actual = await sha256OfPrefix(filePath, located.offset);
  } catch {
    return { status: 'foreign', reason: 'unreadable' };
  }
  if (!hexEquals(located.parsed.declaredSha256, actual)) {
    return { status: 'foreign', reason: 'content_mismatch' };
  }
  return { status: 'native', payloadSha256: actual };
}

/** Operator-facing explanation of why an archive could not be verified. */
export function describeForeignReason(reason: ForeignArchiveReason): string {
  switch (reason) {
    case 'no_crypt_key':
      return 'this deployment has no REZEIS_CRYPT_KEY, so no archive can be verified';
    case 'unstamped':
      return 'the archive carries no provenance stamp (another deployment, or taken before stamping existed)';
    case 'malformed_stamp':
      return 'the provenance stamp is malformed';
    case 'unsupported_stamp_version':
      return 'the provenance stamp uses a format this build does not know';
    case 'signature_mismatch':
      return 'the provenance stamp was signed by a different key';
    case 'content_mismatch':
      return 'the archive was modified after it was stamped';
    case 'unreadable':
      return 'the archive could not be read as a gzip stream';
    default: {
      const exhaustive: never = reason;
      return String(exhaustive);
    }
  }
}
