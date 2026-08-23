import { Injectable } from '@nestjs/common';
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const HASH_KEY_LENGTH: number = 64;
const SALT_LENGTH: number = 16;
const HASH_DELIMITER: string = '$';
const HASH_PREFIX: string = 'scrypt';

export interface ScryptParametersInterface {
  readonly cost: number;
  readonly blockSize: number;
  readonly parallelization: number;
}

/**
 * Which population a credential belongs to.
 *
 * This is NOT cosmetic and it is NOT a table name. It selects the scrypt row a
 * NEW hash is minted at, and the row an existing hash is measured against by
 * `needsRehash()`. It is deliberately a required argument at every mint site:
 * the alternative — a default — is a silent classification, and the whole
 * reason two rows exist is that the choice has to be visible where it is made.
 *
 * Verification takes no audience. See `verifyPassword()`.
 */
export type PasswordAudienceType = 'admin' | 'subscriber';

/**
 * The scrypt work factors NEW hashes are minted with.
 *
 * OWASP's Password Storage Cheat Sheet (read 2026-08-22; the source file's last
 * revision on GitHub is 2026-06-24) lists five scrypt settings it calls
 * equivalent — "a similar minimal level of defense, with the main trade-off
 * between parallelism and RAM usage":
 *
 *     N=2^17 r=8 p=1  (128 MiB)      N=2^14 r=8 p=5  (16 MiB)
 *     N=2^16 r=8 p=2  ( 64 MiB)      N=2^13 r=8 p=10 ( 8 MiB)
 *     N=2^15 r=8 p=3  ( 32 MiB)
 *
 * This file used to pass NONE of them: it called `scrypt()` with no options at
 * all, taking Node's defaults of N=2^14, r=8, p=1 — a fifth of the CPU work of
 * the weakest row above and an eighth of the memory of the strongest.
 *
 * Measured here, on Node v24.15.0 / AMD Ryzen 7 7700, medians of 41 interleaved
 * samples per row (serial), plus the wall time of four simultaneous derivations
 * — four being the size of the default libuv threadpool, i.e. the most scrypt
 * calls this process can have in flight at once:
 *
 *     row              scratch/hash   median   peak@4   4-concurrent wall
 *     2^17 r8 p1          128 MiB     209.5ms   512 MiB     241.9 ms
 *     2^16 r8 p2           64 MiB     195.9ms   256 MiB     214.9 ms
 *     2^15 r8 p3           32 MiB     141.7ms   128 MiB     162.3 ms
 *     2^14 r8 p5           16 MiB     114.2ms    64 MiB     129.2 ms
 *     2^13 r8 p10           8 MiB     109.8ms    32 MiB     125.9 ms
 *     Node default          16 MiB      25.2ms    64 MiB      30.5 ms
 *
 * TWO ROWS, NOT ONE — and why they must not be "harmonised".
 *
 * The two constants below are not a leftover from a half-finished migration.
 * They serve different populations with different traffic shapes, and the
 * cheat sheet's own framing is what permits the split: it calls these settings
 * EQUIVALENT in defence, trading parallelism against RAM. Picking a different
 * row is therefore not picking a weaker password hash; it is picking a
 * different point on a curve of equal defence.
 *
 *   - ADMIN_PARAMETERS is `N=2^16, r=8, p=2`. There are a handful of operator
 *     accounts and they sign in rarely, so 195.9 ms of latency costs nothing
 *     anyone will notice, and a compromised operator credential is the worst
 *     outcome in the system.
 *
 *   - SUBSCRIBER_PARAMETERS is `N=2^14, r=8, p=5`. Subscriber sign-in is the
 *     customer-facing path and holds nearly all of the accounts, so throughput
 *     is the constraint. 114.2 ms against 195.9 ms is a 1.7x improvement per
 *     hash, and because scrypt runs on the libuv threadpool the ceiling moves
 *     from 18.6 to 31.0 sign-ins per second.
 *
 * WHY 2^14 r8 p5 AND NOT ITS NEIGHBOURS. `2^15 r8 p3` costs 24% more latency
 * (141.7 vs 114.2 ms) and twice the scratch for identical stated defence.
 * `2^13 r8 p10` is the other direction and buys almost nothing: 109.8 vs
 * 114.2 ms is a 4% saving for a `p` of 10, two-thirds of the way to the
 * `MAX_PARALLELIZATION` ceiling a stored hash is allowed to claim.
 *
 * READ `SUBSCRIBER_PARAMETERS.cost` CAREFULLY BEFORE "FIXING" IT. Its N is
 * 16_384, the same number as `LEGACY_PARAMETERS.cost`, and it is meant to be.
 * The defence in that row comes from p=5 — five sequential passes over the
 * 16 MiB scratch — not from N. A subscriber hash is 5x the total work of a
 * legacy one, not equal to it; `needsRehash()` compares `N * r * p` precisely
 * so that this is decided by arithmetic and not by which number a reader's eye
 * lands on first.
 *
 * WHY NEITHER ROW IS THE FIRST ONE. The cheat sheet's prose names
 * `N=2^17, r=8, p=1` when it has to name one, and on CPU alone that is what we
 * would take. The blocker is memory, and it is not theoretical: scrypt
 * allocates `128 * N * r` bytes of scratch PER CONCURRENT HASH (measured — `p`
 * does not enter it), Node runs `crypto.scrypt` on the libuv threadpool, and
 * that pool is four threads unless `UV_THREADPOOL_SIZE` says otherwise. So the
 * ceiling on scratch memory is `4 * 128 * N * r`, reached by four simultaneous
 * sign-ins and nothing more exotic. The API container is capped at 1024 MiB
 * (`docker-compose.yml`, service `rezeis`). At N=2^17 that ceiling is 512 MiB
 * of scratch beside the V8 heap inside a 1 GiB box; at N=2^16 it is 256 MiB,
 * and a process serving mostly subscriber traffic sits at 64 MiB.
 *
 * A second, sharper reason to write the numbers down at all: Node's DEFAULT
 * `maxmem` is 32 MiB, so `scrypt()` REJECTS the top three of the five OWASP
 * rows with `ERR_CRYPTO_INVALID_SCRYPT_PARAMS` unless `maxmem` is passed
 * explicitly — measured here, `2^17 r8 p1`, `2^16 r8 p2` AND `2^15 r8 p3` all
 * throw. A change that raised only `N` would not have produced slower hashes —
 * it would have produced a login route that throws on every attempt.
 */
const ADMIN_PARAMETERS: ScryptParametersInterface = {
  cost: 65_536, // N = 2^16
  blockSize: 8, // r
  parallelization: 2, // p
};

/** See the block above ADMIN_PARAMETERS. N matching Node's default is deliberate. */
const SUBSCRIBER_PARAMETERS: ScryptParametersInterface = {
  cost: 16_384, // N = 2^14
  blockSize: 8, // r
  parallelization: 5, // p
};

const PARAMETERS_BY_AUDIENCE: Readonly<Record<PasswordAudienceType, ScryptParametersInterface>> = {
  admin: ADMIN_PARAMETERS,
  subscriber: SUBSCRIBER_PARAMETERS,
};

/**
 * What produced every three-part hash already in the database: `scrypt()` with
 * no options, i.e. Node's documented defaults. Hashes minted before the format
 * carried its parameters are verified with THESE, never with the current ones
 * — deriving an old hash with new parameters yields a different key, and that
 * is a lockout of every operator on the deploy that raises the cost.
 */
const LEGACY_PARAMETERS: ScryptParametersInterface = {
  cost: 16_384, // N = 2^14 — Node's default
  blockSize: 8,
  parallelization: 1,
};

/**
 * Bounds on parameters read back out of a stored hash.
 *
 * The numbers in a stored hash are attacker-controlled the moment anyone can
 * write the `password_hash` column, and `128 * N * r` is an allocation. A row
 * claiming `N=2^30` would ask scrypt for a terabyte on the next sign-in.
 * Out-of-range parameters make the hash unparseable, which `verifyPassword()`
 * already answers with `false` rather than an exception.
 */
const MIN_COST: number = 1_024; // 2^10
const MAX_COST: number = 1_048_576; // 2^20 — 1 GiB at r=8; refused above this
const MAX_BLOCK_SIZE: number = 32;
const MAX_PARALLELIZATION: number = 16;

interface HashPasswordInput {
  readonly plainTextPassword: string;
  /**
   * Which population this credential belongs to. Required — see
   * `PasswordAudienceType`. Choose by the ROW the hash will be written to and
   * the login path that will verify it, not by the name of the file you are
   * standing in: an admin endpoint that resets a subscriber's `WebAccount`
   * password is minting a SUBSCRIBER credential.
   */
  readonly audience: PasswordAudienceType;
}

interface VerifyPasswordInput {
  readonly plainTextPassword: string;
  readonly passwordHash: string;
}

/**
 * Hashes and verifies passwords with Node.js crypto primitives.
 *
 * STORED FORMAT, and why it changed
 *
 *   current   `scrypt$<N>$<r>$<p>$<saltHex>$<hashHex>`
 *   legacy    `scrypt$<saltHex>$<hashHex>`
 *
 * The old shape recorded a salt and nothing else, so the cost was implicit in
 * whatever the code happened to call `scrypt()` with on the day a hash was
 * verified. That coupling makes raising the cost a lockout: every existing hash
 * was derived at N=2^14, and re-deriving it at N=2^16 produces a different key,
 * so the first deploy would reject every correct password in the database.
 *
 * Carrying the parameters breaks the coupling. Verification uses the parameters
 * stored WITH each hash, so old hashes keep verifying indefinitely, and
 * `needsRehash()` lets a caller that has just seen a correct password in plain
 * text upgrade the row in place. That is the migration OWASP describes: "wait
 * until the user next authenticates, then re-hash their password with the new
 * work factor."
 *
 * It is also the single property that lets ADMIN and SUBSCRIBER credentials be
 * minted at different rows without splitting the verification path in two. A
 * hash proves its own cost. Nothing at verification time needs to know, or
 * could be told, which population a credential came from.
 *
 * The column is `TEXT` (`prisma/migrations/20260514120000_init/migration.sql`),
 * so the longer encoding needs no schema change; a six-part hash is ~177 chars.
 */
@Injectable()
export class PasswordHashService {
  /**
   * Hashes a plain text password with scrypt at the parameters for `audience`.
   */
  public async hashPassword(input: HashPasswordInput): Promise<string> {
    const parameters: ScryptParametersInterface = PARAMETERS_BY_AUDIENCE[input.audience];
    const saltBuffer: Buffer = randomBytes(SALT_LENGTH);
    const passwordBuffer: Buffer = await this.deriveKey({
      plainTextPassword: input.plainTextPassword,
      saltBuffer,
      parameters,
    });
    return [
      HASH_PREFIX,
      String(parameters.cost),
      String(parameters.blockSize),
      String(parameters.parallelization),
      saltBuffer.toString('hex'),
      passwordBuffer.toString('hex'),
    ].join(HASH_DELIMITER);
  }

  /**
   * Verifies a plain text password against a stored scrypt hash, using the
   * parameters recorded IN THAT HASH — never the current ones. A hash minted
   * before this file carried parameters is derived with `LEGACY_PARAMETERS`,
   * which is what actually produced it.
   *
   * Deliberately AUDIENCE-BLIND, and it takes no audience argument so that it
   * cannot accidentally become audience-aware. An admin hash and a subscriber
   * hash verify identically wherever either is presented, because the cost
   * comes out of the row. Reaching for a mint-time constant here — either of
   * them — is the lockout: every credential minted at the other row stops
   * verifying, and for subscribers that is every customer at once.
   */
  public async verifyPassword(input: VerifyPasswordInput): Promise<boolean> {
    const parsedHash: ParsedPasswordHash | null = parsePasswordHash(input.passwordHash);
    if (!parsedHash) {
      return false;
    }
    let derivedHash: Buffer;
    try {
      derivedHash = await this.deriveKey({
        plainTextPassword: input.plainTextPassword,
        saltBuffer: parsedHash.saltBuffer,
        parameters: parsedHash.parameters,
      });
    } catch {
      // Parameters that satisfied `parsePasswordHash` can still be refused by
      // OpenSSL. A wrong password and an underivable hash are the same answer
      // to the caller: no.
      return false;
    }
    if (derivedHash.length !== parsedHash.hashBuffer.length) {
      return false;
    }
    return timingSafeEqual(derivedHash, parsedHash.hashBuffer);
  }

  /**
   * `true` when the stored hash was minted below the work factor `audience`
   * mints at today and should be replaced.
   *
   * Call it only AFTER `verifyPassword()` returned `true` — that is the single
   * moment the plain text is in hand and re-hashing is possible. Callers that
   * skip it keep working; they just leave the row at its old cost forever,
   * which is why the sign-in paths wire it in.
   *
   * `audience` must be the SAME one the caller would mint at, and it is why
   * this takes an argument at all. Measured against the admin row, every
   * freshly-minted subscriber hash would report `true` — the subscriber row is
   * lighter — and every subscriber sign-in would re-derive and rewrite the row
   * it had just written, forever.
   *
   * The comparison is on TOTAL WORK (`N * r * p`), deliberately, so this can
   * never move a hash DOWN. Swapping one row for another of OWASP's
   * equivalents — `N=2^17, r=8, p=1` for `N=2^16, r=8, p=2` — leaves total work
   * unchanged and correctly re-hashes nobody; and an admin-strength hash that
   * somehow reached a subscriber path is left alone rather than weakened.
   */
  public needsRehash(passwordHash: string, audience: PasswordAudienceType): boolean {
    const parsedHash: ParsedPasswordHash | null = parsePasswordHash(passwordHash);
    if (!parsedHash) {
      // Unverifiable, so unreachable from a successful verification. Saying
      // "yes" here would invite a caller to overwrite a hash it never matched.
      return false;
    }
    if (parsedHash.saltBuffer.length < SALT_LENGTH) {
      return true;
    }
    return totalWork(parsedHash.parameters) < totalWork(PARAMETERS_BY_AUDIENCE[audience]);
  }

  private async deriveKey(input: DeriveKeyInput): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject): void => {
      // `maxmem` is NOT optional. Node defaults it to 32 MiB and refuses
      // anything larger with a synchronous RangeError, so every OWASP setting
      // from N=2^15 up is rejected without it. The Promise executor is what
      // turns that synchronous throw into a rejection.
      const scryptOptions = {
        N: input.parameters.cost,
        r: input.parameters.blockSize,
        p: input.parameters.parallelization,
        maxmem: requiredMemoryBytes(input.parameters),
      };
      scrypt(
        input.plainTextPassword,
        input.saltBuffer,
        HASH_KEY_LENGTH,
        scryptOptions,
        (error, derivedKey) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(derivedKey as Buffer);
        },
      );
    });
  }
}

interface DeriveKeyInput {
  readonly plainTextPassword: string;
  readonly saltBuffer: Buffer;
  readonly parameters: ScryptParametersInterface;
}

interface ParsedPasswordHash {
  readonly saltBuffer: Buffer;
  readonly hashBuffer: Buffer;
  readonly parameters: ScryptParametersInterface;
}

function totalWork(parameters: ScryptParametersInterface): number {
  return parameters.cost * parameters.blockSize * parameters.parallelization;
}

/**
 * Scratch memory scrypt needs, plus a megabyte of slack. Measured on Node
 * v24.15.0: the true floor is `128 * N * r` plus a few kilobytes, and `p` does
 * not enter it.
 */
function requiredMemoryBytes(parameters: ScryptParametersInterface): number {
  return 128 * parameters.cost * parameters.blockSize + 1_048_576;
}

function parsePasswordHash(passwordHash: string): ParsedPasswordHash | null {
  const parts: string[] = passwordHash.split(HASH_DELIMITER);
  const isLegacyShape: boolean = parts.length === 3;
  if (!isLegacyShape && parts.length !== 6) {
    return null;
  }
  if (parts[0] !== HASH_PREFIX) {
    return null;
  }
  const parameters: ScryptParametersInterface | null = isLegacyShape
    ? LEGACY_PARAMETERS
    : parseParameters(parts[1], parts[2], parts[3]);
  if (!parameters) {
    return null;
  }
  const saltHex: string = isLegacyShape ? parts[1] : parts[4];
  const hashHex: string = isLegacyShape ? parts[2] : parts[5];
  if (!isHexValue(saltHex) || !isHexValue(hashHex)) {
    return null;
  }
  const saltBuffer: Buffer = Buffer.from(saltHex, 'hex');
  const hashBuffer: Buffer = Buffer.from(hashHex, 'hex');
  if (saltBuffer.length === 0 || hashBuffer.length !== HASH_KEY_LENGTH) {
    return null;
  }
  return {
    saltBuffer,
    hashBuffer,
    parameters,
  };
}

function parseParameters(
  costRaw: string,
  blockSizeRaw: string,
  parallelizationRaw: string,
): ScryptParametersInterface | null {
  const cost: number = toPositiveInteger(costRaw);
  const blockSize: number = toPositiveInteger(blockSizeRaw);
  const parallelization: number = toPositiveInteger(parallelizationRaw);
  if (cost < MIN_COST || cost > MAX_COST) {
    return null;
  }
  // scrypt requires N to be a power of two; OpenSSL rejects anything else, and
  // a stored hash claiming otherwise is corrupt rather than merely unusual.
  if ((cost & (cost - 1)) !== 0) {
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
