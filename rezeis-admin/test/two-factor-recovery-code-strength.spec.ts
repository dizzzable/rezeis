/**
 * 2FA recovery codes were 40 bits behind an unsalted, single-round SHA-256.
 *
 * Both halves mattered and they multiplied. Unsalted means one precomputed
 * table serves every operator in every installation at once — there is nothing
 * account-specific forcing an attacker to start over. 40 bits behind a single
 * SHA-256 means the whole keyspace is 2^40 digests; this machine does ~4.3e8
 * SHA-256/s in a single-threaded JS loop, so a commodity GPU walks the space in
 * minutes. And a recovery code is a COMPLETE second factor: `verifyForLogin()`
 * takes one anywhere a TOTP is taken, including `POST /admin/2fa/disable`,
 * which then deletes the second factor outright.
 *
 * The properties asserted here, and what breaks without each:
 *
 *   - 80 bits of entropy, pinned. Lowering the constant is a failing test
 *     rather than a silent regression; nothing named the old 40 anywhere.
 *   - The salt is REAL and MIXED IN — proved by re-deriving the stored hash
 *     both with the stored salt and without it, not by looking for a salt-shaped
 *     field. A salt that is stored but not fed to the KDF looks identical from
 *     the outside and defends nothing.
 *   - A fresh salt per generation, so two sets never share derivation work.
 *   - The stored value is NOT `sha256(code)`. This is the one assertion that
 *     directly names the defect being fixed.
 *   - Codes already in operators' hands STILL WORK. Recovery codes are
 *     single-use, so there is no successful-verification moment at which an old
 *     one can be re-hashed — the choice is honour them or lock people out, and
 *     this file pins the choice that was made.
 *   - Comparison goes through `timingSafeEqual`, not `Array.indexOf`.
 */

import 'reflect-metadata';

import assert from 'node:assert/strict';
import { createHash, scrypt } from 'node:crypto';
import { describe, it } from 'node:test';

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { TwoFactorVerifyDto } from '../src/modules/two-factor/dto/two-factor.dto';
import { TwoFactorService } from '../src/modules/two-factor/services/two-factor.service';
import {
  RECOVERY_CODE_COUNT,
  RECOVERY_CODE_ENTROPY_BITS,
  RECOVERY_CODE_LENGTH,
  RECOVERY_KDF_PARAMETERS,
  countLegacyRecoveryEntries,
  generateRecoveryCodeSet,
  normalizeRecoveryCode,
  verifyRecoveryCode,
} from '../src/modules/two-factor/utils/recovery-code';
import { encryptTotpSecret } from '../src/modules/two-factor/utils/secret-cipher';

// Patched below to observe the comparison primitive. A namespace import may be
// compiled to a COPY under `esModuleInterop`; this is the object the code calls.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const nodeCrypto: typeof import('node:crypto') = require('node:crypto');

const CRYPT_KEY = 'a'.repeat(64);
const SECRET = 'JBSWY3DPEHPK3PXP';

interface ParsedEntry {
  readonly cost: number;
  readonly blockSize: number;
  readonly parallelization: number;
  readonly salt: Buffer;
  readonly hash: Buffer;
}

function parseEntry(entry: string): ParsedEntry {
  const parts = entry.split('$');
  assert.equal(parts.length, 6, `stored entry is not the parameterised format: ${entry}`);
  assert.equal(parts[0], 'scrypt');
  return {
    cost: Number(parts[1]),
    blockSize: Number(parts[2]),
    parallelization: Number(parts[3]),
    salt: Buffer.from(parts[4], 'hex'),
    hash: Buffer.from(parts[5], 'hex'),
  };
}

function derive(code: string, salt: Buffer, parsed: ParsedEntry): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(
      code,
      salt,
      parsed.hash.length,
      {
        N: parsed.cost,
        r: parsed.blockSize,
        p: parsed.parallelization,
        maxmem: 128 * parsed.cost * parsed.blockSize + 1_048_576,
      },
      (error, key) => (error ? reject(error) : resolve(key)),
    ),
  );
}

describe('recovery codes carry enough entropy to survive a database dump', () => {
  it('mints 80 bits per code, in a shape an operator can transcribe', async () => {
    const set = await generateRecoveryCodeSet();

    assert.equal(RECOVERY_CODE_ENTROPY_BITS, 80, 'the entropy of a recovery code was lowered');
    assert.equal(set.codes.length, RECOVERY_CODE_COUNT);
    for (const code of set.codes) {
      const normalized = normalizeRecoveryCode(code);
      assert.equal(
        normalized.length,
        RECOVERY_CODE_LENGTH,
        `${code} does not normalise to ${RECOVERY_CODE_LENGTH} characters`,
      );
      assert.match(normalized, /^[A-Z2-7]{16}$/, `${code} is not RFC 4648 Base32`);
      // 16 Base32 characters is exactly 80 bits, and 80 / log2(32) = 16.
      assert.equal(normalized.length * 5, RECOVERY_CODE_ENTROPY_BITS);
    }
  });

  it('produces a code the wire will actually accept', async () => {
    // The boundary, not the constant. `TwoFactorVerifyDto` caps `code` at 20
    // characters and the panel's inputs cap at 20 too, so a longer code would
    // be minted, printed, and then rejected by validation before any verifier
    // saw it — a 2FA lockout that no unit test of the generator would notice.
    const set = await generateRecoveryCodeSet();

    for (const code of set.codes) {
      const errors = await validate(plainToInstance(TwoFactorVerifyDto, { code }));
      assert.deepEqual(
        errors.map((error) => error.property),
        [],
        `the DTO rejects a code this codebase mints: ${code} (${code.length} chars)`,
      );
    }
  });

  it('mints ten distinct codes', async () => {
    const set = await generateRecoveryCodeSet();

    assert.equal(new Set(set.codes).size, RECOVERY_CODE_COUNT);
    assert.equal(new Set(set.stored).size, RECOVERY_CODE_COUNT);
  });
});

describe('recovery codes are salted, and the salt reaches the KDF', () => {
  it('reproduces the stored hash only WITH the stored salt', async () => {
    // The decisive shape. A salt that is generated and stored but never fed to
    // the derivation is indistinguishable from a real one by inspection, and
    // defends nothing — the same code would still hash to the same value for
    // every operator. So: derive with the salt (must match) and derive without
    // it (must not).
    const set = await generateRecoveryCodeSet();
    const parsed = parseEntry(set.stored[0]);
    const code = normalizeRecoveryCode(set.codes[0]);

    const withSalt = await derive(code, parsed.salt, parsed);
    const withoutSalt = await derive(code, Buffer.alloc(0), parsed);

    assert.equal(
      withSalt.toString('hex'),
      parsed.hash.toString('hex'),
      'the stored hash is not a derivation of the code under the stored salt',
    );
    assert.notEqual(
      withoutSalt.toString('hex'),
      parsed.hash.toString('hex'),
      'the salt does not change the derived key — it is not reaching the KDF',
    );
  });

  it('draws a fresh salt for every generation', async () => {
    // Two operators, or one operator regenerating, must not share derivation
    // work. A constant salt passes the test above and fails this one.
    const first = await generateRecoveryCodeSet();
    const second = await generateRecoveryCodeSet();

    const firstSalt = parseEntry(first.stored[0]).salt.toString('hex');
    const secondSalt = parseEntry(second.stored[0]).salt.toString('hex');

    assert.notEqual(firstSalt, secondSalt, 'the salt is the same across generations');
    assert.equal(Buffer.from(firstSalt, 'hex').length, 16, 'the salt is not 128 bits');
  });

  it('shares one salt across a set, so a login costs ONE derivation', async () => {
    // Deliberate, and the reason the KDF can be memory-hard at all on a login
    // path: a per-code salt would force `RECOVERY_CODE_COUNT` derivations per
    // guess, turning one HTTP request into ten scrypt runs and saturating the
    // four-thread libuv pool. See `utils/recovery-code.ts` for what the shared
    // salt costs (a factor of ten off a 2^80 search) and what it does not.
    const set = await generateRecoveryCodeSet();

    const salts = new Set(set.stored.map((entry) => parseEntry(entry).salt.toString('hex')));

    assert.equal(salts.size, 1, 'a set no longer shares one salt — verification cost is now O(n)');
  });

  it('does not store the fast digest it replaced', async () => {
    // Names the defect. `sha256(code)` in any casing must not be what is stored.
    const set = await generateRecoveryCodeSet();

    for (let index = 0; index < set.codes.length; index += 1) {
      const normalized = normalizeRecoveryCode(set.codes[index]);
      const entry = set.stored[index];
      for (const candidate of [normalized, normalized.toLowerCase(), set.codes[index]]) {
        const digest = createHash('sha256').update(candidate).digest('hex');
        assert.notEqual(entry, digest, 'a recovery code is still stored as unsalted SHA-256');
        assert.equal(entry.includes(digest), false, 'the stored entry contains a bare SHA-256');
      }
    }
  });

  it('uses a memory-hard KDF, not a digest, and records what it used', async () => {
    const set = await generateRecoveryCodeSet();
    const parsed = parseEntry(set.stored[0]);

    assert.equal(parsed.cost, RECOVERY_KDF_PARAMETERS.cost);
    assert.equal(parsed.cost, 32_768, 'the recovery-code scrypt cost moved');
    assert.equal(parsed.blockSize, 8);
    assert.equal(parsed.parallelization, 1);
    assert.equal(parsed.hash.length, 32);
  });

  it('verifies an entry at the cost written INSIDE it, not the current one', async () => {
    // The reason a recovery entry carries `N/r/p` at all. Recovery codes are
    // single-use, so there is no verify-then-upgrade moment for them: a set
    // minted under one cost has to keep verifying under that cost until the
    // operator regenerates. Raising `RECOVERY_KDF_PARAMETERS` with this
    // untested would silently invalidate every unused code in the estate — the
    // same lockout the password path was fixed for, one column over.
    const code = 'ABCD-EFGH-JKLM-NPQR';
    const salt = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
    const olderCost = { cost: 8_192, blockSize: 8, parallelization: 1 };
    const derived = await new Promise<Buffer>((resolve, reject) =>
      scrypt(
        normalizeRecoveryCode(code),
        salt,
        32,
        {
          N: olderCost.cost,
          r: olderCost.blockSize,
          p: olderCost.parallelization,
          maxmem: 128 * olderCost.cost * olderCost.blockSize + 1_048_576,
        },
        (error, key) => (error ? reject(error) : resolve(key)),
      ),
    );
    const entry = [
      'scrypt',
      String(olderCost.cost),
      String(olderCost.blockSize),
      String(olderCost.parallelization),
      salt.toString('hex'),
      derived.toString('hex'),
    ].join('$');

    assert.notEqual(olderCost.cost, RECOVERY_KDF_PARAMETERS.cost, 'the fixture is not a DIFFERENT cost');
    assert.equal(
      (await verifyRecoveryCode(code, [entry])).index,
      0,
      'an entry stored at another cost no longer verifies — a cost change is now a lockout',
    );
    assert.equal((await verifyRecoveryCode('ZZZZ-ZZZZ-ZZZZ-ZZZZ', [entry])).index, -1);
  });

  it('verifies a code against its own set and no other', async () => {
    const first = await generateRecoveryCodeSet();
    const second = await generateRecoveryCodeSet();

    assert.equal((await verifyRecoveryCode(first.codes[3], [...first.stored])).index, 3);
    assert.equal((await verifyRecoveryCode(first.codes[3], [...second.stored])).index, -1);
  });

  it('accepts the display form, pasted whitespace, and lower case alike', async () => {
    const set = await generateRecoveryCodeSet();
    const code = set.codes[5];

    for (const typed of [code, code.toLowerCase(), ` ${code} `, code.replace(/-/g, ''), code.replace(/-/g, ' ')]) {
      assert.equal(
        (await verifyRecoveryCode(typed, [...set.stored])).index,
        5,
        `the verifier refused a legitimate transcription: "${typed}"`,
      );
    }
  });

  it('compares with a constant-time primitive, not Array.indexOf', async () => {
    // The old implementation was `admin.totpRecoveryCodes.indexOf(hash)` — an
    // ordinary string comparison that returns at the first differing byte.
    const set = await generateRecoveryCodeSet();
    const real = nodeCrypto.timingSafeEqual;
    let calls = 0;
    nodeCrypto.timingSafeEqual = ((a: Buffer, b: Buffer) => {
      calls += 1;
      return real(a, b);
    }) as typeof nodeCrypto.timingSafeEqual;

    let matched: number;
    try {
      matched = (await verifyRecoveryCode(set.codes[0], [...set.stored])).index;
    } finally {
      nodeCrypto.timingSafeEqual = real;
    }

    assert.equal(matched, 0);
    assert.equal(
      calls,
      RECOVERY_CODE_COUNT,
      'the match did not go through timingSafeEqual once per remaining code — ' +
        'either the primitive changed or the scan short-circuits on a hit',
    );
  });
});

describe('codes already in operators hands', () => {
  it('still verifies a 40-bit unsalted SHA-256 code, and consumes it', async () => {
    // The operator-facing decision, pinned. A recovery code is single-use, so
    // there is no moment at which an old one can be verified AND kept — the
    // entry that verifies is the entry that is deleted. Honouring them is
    // therefore permanent until the operator regenerates, and the alternative
    // is locking out the one person recovery codes exist for: someone who has
    // lost their authenticator and is holding a printed code.
    const legacyCode = 'a1b2c3d4e5';
    const legacyEntry = createHash('sha256').update(legacyCode).digest('hex');
    const harness = buildTwoFactorHarness([legacyEntry, 'ffee0011223344556677889900aabbccddeeff00112233445566778899aabbcc']);

    assert.equal(await harness.service.verifyForLogin('admin-1', legacyCode), true);
    assert.deepEqual(
      harness.updates,
      [{ totpRecoveryCodes: ['ffee0011223344556677889900aabbccddeeff00112233445566778899aabbcc'] }],
      'the consumed legacy code was not removed from the stored set',
    );
  });

  it('reports how many remaining codes are still the weak kind', async () => {
    // The choice above is deliberate but must not be invisible. This is what
    // tells an operator that regenerating actually changes something.
    const legacy = createHash('sha256').update('a1b2c3d4e5').digest('hex');
    const modern = (await generateRecoveryCodeSet()).stored[0];

    assert.equal(countLegacyRecoveryEntries([legacy, legacy, modern]), 2);
    assert.equal(countLegacyRecoveryEntries([modern, modern]), 0);
    assert.equal(countLegacyRecoveryEntries([]), 0);
  });

  it('surfaces the legacy count on the status the panel reads', async () => {
    const legacy = createHash('sha256').update('a1b2c3d4e5').digest('hex');
    const harness = buildTwoFactorHarness([legacy, legacy]);

    const status = await harness.service.getStatus('admin-1');

    assert.equal(status.recoveryCodesRemaining, 2);
    assert.equal(status.recoveryCodesLegacy, 2);
  });

  it('refuses a wrong code of either vintage without touching the stored set', async () => {
    const set = await generateRecoveryCodeSet();
    const harness = buildTwoFactorHarness([...set.stored]);

    for (const wrong of ['0000000000', 'AAAABBBBCCCCDDDD', 'not-a-code', '', '   ']) {
      assert.equal(
        await harness.service.verifyForLogin('admin-1', wrong),
        false,
        `accepted a wrong code: "${wrong}"`,
      );
    }
    assert.deepEqual(harness.updates, [], 'a rejected code still wrote to the database');
  });

  it('consumes a modern code exactly once', async () => {
    // NIST SP 800-63B rev 4 s3.1.2.2: "A secret from a look-up secret
    // authenticator SHALL be used successfully only once."
    const set = await generateRecoveryCodeSet();
    const remaining = [...set.stored];
    const harness = buildTwoFactorHarness(remaining, { persist: true });

    assert.equal(await harness.service.verifyForLogin('admin-1', set.codes[4]), true);
    assert.equal(
      await harness.service.verifyForLogin('admin-1', set.codes[4]),
      false,
      'the same recovery code authenticated twice',
    );
    assert.equal(harness.stored.length, RECOVERY_CODE_COUNT - 1);
  });
});

interface TwoFactorHarness {
  readonly service: TwoFactorService;
  readonly updates: Array<Record<string, unknown>>;
  readonly stored: string[];
}

function buildTwoFactorHarness(
  recoveryCodes: readonly string[],
  options: { readonly persist?: boolean } = {},
): TwoFactorHarness {
  const updates: Array<Record<string, unknown>> = [];
  const stored: string[] = [...recoveryCodes];
  const prismaService = {
    adminUser: {
      findUnique: async () => ({
        totpEnabled: true,
        totpSecretEncrypted: encryptTotpSecret(SECRET, CRYPT_KEY),
        totpRecoveryCodes: [...stored],
      }),
      findUniqueOrThrow: async () => ({
        totpEnabled: true,
        totpEnrolledAt: new Date('2026-01-01T00:00:00.000Z'),
        totpRecoveryCodes: [...stored],
      }),
      update: async (args: { data: Record<string, unknown> }) => {
        updates.push(args.data);
        if (options.persist) {
          stored.splice(0, stored.length, ...(args.data['totpRecoveryCodes'] as string[]));
        }
        return args.data;
      },
    },
    adminAuditLog: { create: async () => undefined },
  } as unknown as PrismaService;
  const service = new TwoFactorService(prismaService, { cryptKey: CRYPT_KEY } as never);
  return { service, updates, stored };
}
