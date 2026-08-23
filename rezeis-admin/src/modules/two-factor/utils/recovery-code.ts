import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

import { base32Encode } from './base32';

/**
 * Recovery codes for admin 2FA — minting, storage encoding, and verification.
 *
 * WHAT WAS WRONG
 *
 * Both halves of the credential were weak, and they multiplied.
 *
 *   1. The code was `randomBytes(5).toString('hex')` — 40 bits.
 *   2. The stored value was `sha256(code)`, unsalted and single-round.
 *
 * Unsalted means ONE precomputed table covers every operator in every
 * deployment at once; there is nothing account-specific to force an attacker to
 * start over. Single-round SHA-256 over a 40-bit space is the other half: the
 * whole space is 2^40 digests, and this machine does ~4.3 x 10^8 SHA-256/s in a
 * single-threaded JS loop (measured: 1000 digests in 2.3 ms), so a commodity GPU
 * finishes the entire keyspace in minutes. A database dump therefore yielded
 * every operator's recovery codes, and a recovery code is a COMPLETE second
 * factor: `verifyForLogin()` accepts one anywhere a TOTP is accepted, including
 * `POST /admin/2fa/disable`, which then deletes the second factor outright.
 *
 * WHAT IT IS NOW
 *
 *   - 80 bits of entropy from `randomBytes(10)`, rendered as 16 RFC 4648
 *     Base32 characters and displayed in four dash-separated groups
 *     (`ABCD-EFGH-JKLM-NPQR`, 19 characters).
 *   - Stored as `scrypt$<N>$<r>$<p>$<saltHex>$<hashHex>` — salted, memory-hard,
 *     and carrying the parameters it was derived with, so raising the cost
 *     later cannot invalidate codes already in circulation.
 *   - Compared with `timingSafeEqual` over derived keys, with no early exit.
 *
 * NIST SP 800-63B rev 4 s3.1.2 (read 2026-08-22; the page is dated
 * 2025-08-26) is the governing text. It requires look-up secrets to be "at
 * least six decimal digits (or equivalent) in length"; that those below the
 * minimum security strength — "112 bits as of the date of this publication" —
 * "SHALL be stored in a salted and hashed form using a suitable password
 * hashing scheme"; that "the salt value SHALL be at least 32 bits in length";
 * that "both the salt value and the resulting hash SHALL be stored for each
 * look-up secret"; that a verifier "SHALL implement a rate-limiting mechanism";
 * and that a secret "SHALL be used successfully only once". 80 bits sits below
 * the 112-bit line, so the salted-and-hashed clause applies and is what this
 * file implements. Single use is `TwoFactorService`'s job (the matched entry is
 * removed); rate limiting is the `@Throttle` ceilings on every route that
 * accepts a code, plus `LoginGuardService` on the sign-in path.
 *
 * WHY THE KDF IS CHEAPER THAN THE ONE GUARDING PASSWORDS, and how the salt is
 * scoped — the two questions are the same question.
 *
 * A recovery code is checked on a LOGIN path, so its cost is paid by every
 * honest sign-in that uses one. The naive salting scheme — a fresh salt per
 * code — makes that cost `RECOVERY_CODE_COUNT` derivations per attempt, because
 * a candidate has to be re-derived under each stored salt before it can be
 * compared. At ten codes that is ten times the work of a password check for one
 * guess, which is not a defense; it is an amplifier that lets one HTTP request
 * occupy the entire libuv threadpool.
 *
 * So the salt is per GENERATION, not per code: the whole set is minted with one
 * random 128-bit salt, and a candidate is derived exactly ONCE per attempt no
 * matter how many codes remain. Each stored entry still carries that salt
 * verbatim, which is what NIST's "stored for each look-up secret" asks for, and
 * a fresh salt is drawn every time the set is replaced. What a shared salt
 * costs is precise and small: someone holding the database can attack one
 * operator's ten codes with a single derivation stream instead of ten, a factor
 * of ten off a 2^80 search — 2^76 scrypt invocations, which is not an attack.
 * What salting actually buys is untouched: no precomputed table survives, and
 * no work carries from one operator to the next.
 *
 * With one derivation per attempt the cost can then be chosen on its merits.
 * N=2^15, r=8, p=1 is 50 ms and 32 MiB measured on Node v24.15.0 — deliberately
 * below the password parameters (192 ms, 64 MiB), because the input is 80 bits
 * from a CSPRNG rather than something a human chose. KDF cost buys guessing
 * resistance for LOW-entropy inputs; at 80 bits an offline attacker needs 2^79
 * derivations on average, and that is already out of reach at one round of a
 * fast digest. The memory-hardness here is defence in depth for the codes that
 * are NOT 80 bits — the 40-bit ones still in operators' hands, and any future
 * hand that lowers `RECOVERY_CODE_BYTES`.
 */

/** Codes minted per set. Ten is what operators have always been handed. */
export const RECOVERY_CODE_COUNT: number = 10;

/**
 * Entropy per code. Pinned by `test/two-factor-recovery-code-strength.spec.ts`
 * so lowering it is a failing test rather than a silent regression — the
 * previous value was 40 bits and nothing anywhere said so.
 */
export const RECOVERY_CODE_ENTROPY_BITS: number = 80;

/** 80 bits / 8. Base32 renders these 10 bytes as exactly 16 characters. */
export const RECOVERY_CODE_BYTES: number = RECOVERY_CODE_ENTROPY_BITS / 8;

/** Characters in a normalised code — `ceil(80 / 5)`. */
export const RECOVERY_CODE_LENGTH: number = 16;

/**
 * 128 bits. NIST's floor is 32; there is no reason to sit on it, and a longer
 * salt costs nothing but stored bytes in a `TEXT[]`.
 */
export const RECOVERY_SALT_BYTES: number = 16;

/** Derived key length. 256 bits — the comparison target, not a secret store. */
export const RECOVERY_KEY_LENGTH: number = 32;

/** See the header for why these are below the password parameters. */
export const RECOVERY_KDF_PARAMETERS: RecoveryKdfParametersInterface = {
  cost: 32_768, // N = 2^15
  blockSize: 8, // r
  parallelization: 1, // p
};

const ENTRY_PREFIX: string = 'scrypt';
const ENTRY_DELIMITER: string = '$';
const ENTRY_PART_COUNT: number = 6;
const LEGACY_ENTRY_PATTERN: RegExp = /^[0-9a-f]{64}$/i;
const LEGACY_CODE_PATTERN: RegExp = /^[0-9a-f]{10}$/i;
const CODE_PATTERN: RegExp = /^[A-Z2-7]{16}$/;
const DISPLAY_GROUP_SIZE: number = 4;

/** Mirrors the password hasher's bounds, and for the same reason. */
const MIN_COST: number = 1_024;
const MAX_COST: number = 1_048_576;
const MAX_BLOCK_SIZE: number = 32;
const MAX_PARALLELIZATION: number = 16;

export interface RecoveryKdfParametersInterface {
  readonly cost: number;
  readonly blockSize: number;
  readonly parallelization: number;
}

export interface RecoveryCodeSetInterface {
  /** Shown to the operator exactly once, dash-grouped for transcription. */
  readonly codes: readonly string[];
  /** What goes into `AdminUser.totpRecoveryCodes`, index-aligned with `codes`. */
  readonly stored: readonly string[];
}

export interface RecoveryCodeMatchInterface {
  /** Index into the stored array, or `-1` when nothing matched. */
  readonly index: number;
  /** `true` when the entry that matched was an unsalted SHA-256 leftover. */
  readonly legacy: boolean;
}

/**
 * Mints a fresh set. One salt for the set — see the header.
 *
 * Derivation is SEQUENTIAL on purpose. Ten `scrypt` calls issued together
 * would saturate the four-thread libuv pool and hold 4 x 32 MiB while doing it,
 * stalling every other async filesystem and DNS operation in the process. This
 * runs on enrolment and regeneration only, where 500 ms of wall time is
 * invisible and a stalled threadpool would not be.
 */
export async function generateRecoveryCodeSet(): Promise<RecoveryCodeSetInterface> {
  const saltBuffer: Buffer = randomBytes(RECOVERY_SALT_BYTES);
  const codes: string[] = [];
  const stored: string[] = [];
  for (let index = 0; index < RECOVERY_CODE_COUNT; index += 1) {
    const normalized: string = base32Encode(randomBytes(RECOVERY_CODE_BYTES));
    const derived: Buffer = await deriveRecoveryKey(
      normalized,
      saltBuffer,
      RECOVERY_KDF_PARAMETERS,
    );
    codes.push(toDisplayForm(normalized));
    stored.push(encodeEntry(RECOVERY_KDF_PARAMETERS, saltBuffer, derived));
  }
  return { codes, stored };
}

/**
 * Strips the cosmetics an operator will inevitably reintroduce — the display
 * dashes, pasted spaces, lower case — and leaves the exact string the stored
 * hash was derived over.
 */
export function normalizeRecoveryCode(raw: string): string {
  return raw.replace(/[\s-]+/g, '').toUpperCase();
}

/** `true` for an entry still stored as the old unsalted SHA-256 digest. */
export function isLegacyRecoveryEntry(entry: string): boolean {
  return LEGACY_ENTRY_PATTERN.test(entry);
}

/** How many of a stored set are still unsalted SHA-256. */
export function countLegacyRecoveryEntries(entries: readonly string[]): number {
  return entries.filter(isLegacyRecoveryEntry).length;
}

/**
 * Finds the stored entry a candidate matches, or `-1`.
 *
 * Constant-time in the part that matters: every comparison is `timingSafeEqual`
 * over equal-length buffers, and the loop does NOT stop at the first match, so
 * the number of comparisons depends on how many codes remain and never on which
 * one was right. The old implementation was `Array.indexOf(sha256(code))` — an
 * ordinary string comparison that returned as soon as two digests diverged.
 *
 * Which branch runs is decided by the shape of the CANDIDATE, never by what the
 * account holds, so nothing here is an oracle for whether an account has been
 * migrated. A modern-shaped candidate against a set with no modern entries
 * still performs one derivation, against a throwaway salt, so that case cannot
 * be told from a wrong guess by how long it took.
 */
export async function verifyRecoveryCode(
  candidateRaw: string,
  storedEntries: readonly string[],
): Promise<RecoveryCodeMatchInterface> {
  const normalized: string = normalizeRecoveryCode(candidateRaw);

  if (LEGACY_CODE_PATTERN.test(normalized)) {
    return matchLegacy(normalized, storedEntries);
  }
  if (CODE_PATTERN.test(normalized)) {
    return matchModern(normalized, storedEntries);
  }
  // Neither shape. No derivation is spent on a string that could not have been
  // issued — a code is 16 Base32 characters or a 10-character legacy hex one.
  return { index: -1, legacy: false };
}

/**
 * The unsalted SHA-256 path, kept alive on purpose.
 *
 * Recovery codes are SINGLE-USE, which is what makes the usual "upgrade the
 * stored hash on a successful verification" trick unavailable here: the entry
 * that verifies is the entry that gets deleted, so there is never a moment
 * where we hold the plain text of a code that must survive. The choice is
 * therefore binary — keep honouring 40-bit codes, or invalidate them and force
 * every operator to regenerate.
 *
 * They are honoured. Regenerating requires presenting a valid factor, and an
 * operator who still has their authenticator can do that in one click; the only
 * person harmed by hard invalidation is the operator who has LOST their
 * authenticator and is holding a printed code, which is the precise situation
 * recovery codes exist for. Locking that person out to close a database-dump
 * hole trades a certain, immediate lockout for a conditional one.
 *
 * The consequence is real and is not hidden: `getStatus()` reports
 * `recoveryCodesLegacy`, and consuming one writes a warning and an audit row.
 */
function matchLegacy(
  normalizedCandidate: string,
  storedEntries: readonly string[],
): RecoveryCodeMatchInterface {
  const digest: Buffer = createHash('sha256')
    .update(normalizedCandidate.toLowerCase())
    .digest();
  let index: number = -1;
  for (let position = 0; position < storedEntries.length; position += 1) {
    const entry: string = storedEntries[position];
    if (!isLegacyRecoveryEntry(entry)) {
      continue;
    }
    const stored: Buffer = Buffer.from(entry.toLowerCase(), 'hex');
    if (stored.length === digest.length && timingSafeEqual(digest, stored)) {
      index = position;
      // No `break`. See the function docblock above this one.
    }
  }
  return { index, legacy: index !== -1 };
}

async function matchModern(
  normalizedCandidate: string,
  storedEntries: readonly string[],
): Promise<RecoveryCodeMatchInterface> {
  const parsed: Array<{ readonly position: number; readonly entry: ParsedRecoveryEntry }> = [];
  for (let position = 0; position < storedEntries.length; position += 1) {
    const entry: ParsedRecoveryEntry | null = parseEntry(storedEntries[position]);
    if (entry) {
      parsed.push({ position, entry });
    }
  }

  if (parsed.length === 0) {
    // Uniform cost — see the `verifyRecoveryCode` docblock.
    await deriveRecoveryKey(
      normalizedCandidate,
      randomBytes(RECOVERY_SALT_BYTES),
      RECOVERY_KDF_PARAMETERS,
    );
    return { index: -1, legacy: false };
  }

  // Group by the exact derivation a candidate would need. A set is always
  // written whole, so in practice this is one group and one `scrypt` call; the
  // grouping exists so that a set somehow holding two generations still
  // verifies both instead of silently rejecting the older half.
  const derivations = new Map<string, Buffer>();
  let index: number = -1;
  for (const { position, entry } of parsed) {
    const groupKey: string = derivationKey(entry);
    let derived: Buffer | undefined = derivations.get(groupKey);
    if (!derived) {
      if (derivations.size >= RECOVERY_CODE_COUNT) {
        // A stored array is at most `RECOVERY_CODE_COUNT` entries, so this is
        // unreachable through any code path that writes one. It bounds the
        // work a hand-edited row can demand of a login request.
        continue;
      }
      try {
        derived = await deriveRecoveryKey(normalizedCandidate, entry.saltBuffer, entry.parameters);
      } catch {
        // OpenSSL refused parameters that passed `parseEntry`. Treat the entry
        // as unmatched rather than failing the whole verification.
        continue;
      }
      derivations.set(groupKey, derived);
    }
    if (derived.length === entry.hashBuffer.length && timingSafeEqual(derived, entry.hashBuffer)) {
      index = position;
      // No `break`. See the `verifyRecoveryCode` docblock.
    }
  }
  return { index, legacy: false };
}

function toDisplayForm(normalized: string): string {
  const groups: string[] = [];
  for (let offset = 0; offset < normalized.length; offset += DISPLAY_GROUP_SIZE) {
    groups.push(normalized.slice(offset, offset + DISPLAY_GROUP_SIZE));
  }
  return groups.join('-');
}

function encodeEntry(
  parameters: RecoveryKdfParametersInterface,
  saltBuffer: Buffer,
  derived: Buffer,
): string {
  return [
    ENTRY_PREFIX,
    String(parameters.cost),
    String(parameters.blockSize),
    String(parameters.parallelization),
    saltBuffer.toString('hex'),
    derived.toString('hex'),
  ].join(ENTRY_DELIMITER);
}

interface ParsedRecoveryEntry {
  readonly parameters: RecoveryKdfParametersInterface;
  readonly saltBuffer: Buffer;
  readonly hashBuffer: Buffer;
}

function derivationKey(entry: ParsedRecoveryEntry): string {
  return [
    entry.parameters.cost,
    entry.parameters.blockSize,
    entry.parameters.parallelization,
    entry.saltBuffer.toString('hex'),
  ].join(':');
}

function parseEntry(entry: string): ParsedRecoveryEntry | null {
  const parts: string[] = entry.split(ENTRY_DELIMITER);
  if (parts.length !== ENTRY_PART_COUNT || parts[0] !== ENTRY_PREFIX) {
    return null;
  }
  const parameters: RecoveryKdfParametersInterface | null = parseParameters(
    parts[1],
    parts[2],
    parts[3],
  );
  if (!parameters) {
    return null;
  }
  if (!isHexValue(parts[4]) || !isHexValue(parts[5])) {
    return null;
  }
  const saltBuffer: Buffer = Buffer.from(parts[4], 'hex');
  const hashBuffer: Buffer = Buffer.from(parts[5], 'hex');
  if (saltBuffer.length < 4 || hashBuffer.length === 0) {
    // NIST's floor is 32 bits of salt; an entry claiming less is corrupt.
    return null;
  }
  return { parameters, saltBuffer, hashBuffer };
}

function parseParameters(
  costRaw: string,
  blockSizeRaw: string,
  parallelizationRaw: string,
): RecoveryKdfParametersInterface | null {
  const cost: number = toPositiveInteger(costRaw);
  const blockSize: number = toPositiveInteger(blockSizeRaw);
  const parallelization: number = toPositiveInteger(parallelizationRaw);
  if (cost < MIN_COST || cost > MAX_COST || (cost & (cost - 1)) !== 0) {
    return null;
  }
  if (blockSize < 1 || blockSize > MAX_BLOCK_SIZE) {
    return null;
  }
  if (parallelization < 1 || parallelization > MAX_PARALLELIZATION) {
    return null;
  }
  return { cost, blockSize, parallelization };
}

function toPositiveInteger(value: string): number {
  if (!/^[1-9][0-9]{0,9}$/.test(value)) {
    return 0;
  }
  return Number.parseInt(value, 10);
}

function isHexValue(value: string): boolean {
  if (value.length === 0 || value.length % 2 !== 0) {
    return false;
  }
  return /^[0-9a-f]+$/i.test(value);
}

async function deriveRecoveryKey(
  normalizedCode: string,
  saltBuffer: Buffer,
  parameters: RecoveryKdfParametersInterface,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject): void => {
    // `maxmem` is mandatory above N=2^15 — Node's default ceiling is 32 MiB and
    // it refuses larger parameters with a synchronous RangeError. Passing it
    // here keeps a future cost increase a configuration change rather than an
    // outage. The Promise executor converts that synchronous throw to a
    // rejection.
    const options = {
      N: parameters.cost,
      r: parameters.blockSize,
      p: parameters.parallelization,
      maxmem: 128 * parameters.cost * parameters.blockSize + 1_048_576,
    };
    scrypt(normalizedCode, saltBuffer, RECOVERY_KEY_LENGTH, options, (error, derivedKey) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(derivedKey as Buffer);
    });
  });
}
