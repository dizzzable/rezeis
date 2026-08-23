/**
 * The scrypt cost was raised from Node's defaults (N=2^14, r=8, p=1) to the
 * OWASP row `N=2^16, r=8, p=2`. On its own that is a lockout: every hash in the
 * database was derived at the old cost, and re-deriving a correct password at
 * the new one produces a different key, so the first deploy would reject every
 * operator's password at once.
 *
 * The fix is that a hash now carries the parameters it was derived with, and
 * verification uses THOSE. This file is the guard on that sentence. The case
 * that matters most is `an operator whose hash predates the format still signs
 * in` — if it ever goes green while the code ignores stored parameters, the
 * next deploy locks out every admin in every installation.
 *
 * The legacy fixtures here are NOT produced by calling the service. They are
 * built by hand with `scrypt()` at Node's documented defaults, which is
 * literally what the old three-line implementation did, so they are the same
 * bytes a real row from before this change holds. A fixture produced by today's
 * code could not prove anything about yesterday's.
 */

import assert from 'node:assert/strict';
import { randomBytes, scrypt } from 'node:crypto';
import { describe, it } from 'node:test';

import { PasswordHashService } from '../src/modules/auth/services/password-hash.service';

// `require`, not a namespace import: under `esModuleInterop` a namespace import
// may be compiled to a COPY of the module's properties, and patching a copy
// patches nothing the service can see. This is the same object it calls into.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const nodeCrypto: typeof import('node:crypto') = require('node:crypto');

const PASSWORD = 'correct horse battery staple';

/** Node's scrypt defaults — what produced every three-part hash in the wild. */
const LEGACY = { N: 16_384, r: 8, p: 1 } as const;
/**
 * What this codebase mints for ADMIN credentials today. Pinned below, not
 * merely referenced.
 *
 * There is a second, lighter row for SUBSCRIBER credentials — the two are
 * different points on OWASP's list of settings it calls equivalent in defence.
 * It, and the rule that verification never consults EITHER of them, are pinned
 * in `test/password-hash-audiences.spec.ts`. Everything in this file is about
 * the admin row and the legacy rows already in the database.
 */
const CURRENT = { N: 65_536, r: 8, p: 2 } as const;

function derive(
  password: string,
  salt: Buffer,
  parameters: { readonly N: number; readonly r: number; readonly p: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      64,
      { ...parameters, maxmem: 128 * parameters.N * parameters.r + 1_048_576 },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

/** A row exactly as the pre-change implementation wrote it. */
async function legacyHashOf(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await derive(password, salt, LEGACY);
  return ['scrypt', salt.toString('hex'), derived.toString('hex')].join('$');
}

describe('scrypt parameters travel with the hash', () => {
  it('still verifies a hash minted before the format carried parameters', async () => {
    // The deploy-day question, asked directly. Everything else in this file is
    // detail; this is the one that ends careers.
    const service = new PasswordHashService();
    const legacy = await legacyHashOf(PASSWORD);

    assert.match(legacy, /^scrypt\$[0-9a-f]+\$[0-9a-f]+$/, 'fixture is not the legacy shape');
    assert.equal(
      await service.verifyPassword({ plainTextPassword: PASSWORD, passwordHash: legacy }),
      true,
      'an operator whose password predates this change can no longer sign in',
    );
    assert.equal(
      await service.verifyPassword({ plainTextPassword: 'wrong', passwordHash: legacy }),
      false,
    );
  });

  it('derives a legacy hash with the OLD parameters, not the current ones', async () => {
    // The sharper version of the same claim. A three-part hash whose digest was
    // produced at the CURRENT cost must NOT verify: the legacy shape means
    // "N=2^14", and honouring that is the whole mechanism. If verification
    // quietly used the current parameters for everything, this passes — and
    // then the real legacy rows above stop working.
    const service = new PasswordHashService();
    const salt = randomBytes(16);
    const derivedAtCurrentCost = await derive(PASSWORD, salt, CURRENT);
    const mislabelled = ['scrypt', salt.toString('hex'), derivedAtCurrentCost.toString('hex')].join(
      '$',
    );

    assert.equal(
      await service.verifyPassword({ plainTextPassword: PASSWORD, passwordHash: mislabelled }),
      false,
      'the stored parameters are being ignored in favour of the current ones',
    );
  });

  it('verifies a six-part hash with the parameters written inside it', async () => {
    // The mirror image: a hash that says N=2^14 in its own parameter block is
    // derived at N=2^14 even though the service mints N=2^16 today.
    const service = new PasswordHashService();
    const salt = randomBytes(16);
    const derived = await derive(PASSWORD, salt, LEGACY);
    const explicit = [
      'scrypt',
      String(LEGACY.N),
      String(LEGACY.r),
      String(LEGACY.p),
      salt.toString('hex'),
      derived.toString('hex'),
    ].join('$');

    assert.equal(
      await service.verifyPassword({ plainTextPassword: PASSWORD, passwordHash: explicit }),
      true,
    );
  });

  it('mints at the OWASP row this codebase committed to', async () => {
    // Pins the constants at the boundary they leave through — the stored
    // string — rather than by importing them, so the number in the database is
    // what is asserted. OWASP Password Storage Cheat Sheet, read 2026-08-22:
    // `N=2^16 (64 MiB), r=8, p=2` is one of five settings it calls equivalent.
    const service = new PasswordHashService();

    const stored = await service.hashPassword({ plainTextPassword: PASSWORD, audience: 'admin' });

    const parts = stored.split('$');
    assert.equal(parts.length, 6, `expected a six-part hash, got: ${stored}`);
    assert.equal(parts[0], 'scrypt');
    assert.equal(parts[1], String(CURRENT.N), 'scrypt cost parameter N moved');
    assert.equal(parts[2], String(CURRENT.r), 'scrypt block size r moved');
    assert.equal(parts[3], String(CURRENT.p), 'scrypt parallelization p moved');
    assert.equal(Buffer.from(parts[4], 'hex').length, 16, 'salt is no longer 128 bits');
    assert.equal(Buffer.from(parts[5], 'hex').length, 64, 'derived key is no longer 512 bits');
    assert.equal(
      await service.verifyPassword({ plainTextPassword: PASSWORD, passwordHash: stored }),
      true,
    );
  });

  it('is above the cost it replaced — 2^16 x 2 is eight times 2^14 x 1', async () => {
    // Names the size of the increase, not just that a number changed. The
    // finding was "roughly 8x below current OWASP guidance"; this is the 8x.
    const service = new PasswordHashService();

    const parts = (
      await service.hashPassword({ plainTextPassword: PASSWORD, audience: 'admin' })
    ).split('$');
    const work = Number(parts[1]) * Number(parts[2]) * Number(parts[3]);
    const legacyWork = LEGACY.N * LEGACY.r * LEGACY.p;

    assert.equal(work / legacyWork, 8, 'the new work factor is not 8x the old one');
  });

  it('compares with a constant-time primitive, not ===', async () => {
    // A digest comparison that short-circuits on the first differing byte
    // leaks how much of a guess was right. The assertion is that the real
    // `timingSafeEqual` is the thing that decided, observed by intercepting it
    // on the module object the service calls into.
    const service = new PasswordHashService();
    const stored = await service.hashPassword({ plainTextPassword: PASSWORD, audience: 'admin' });
    const real = nodeCrypto.timingSafeEqual;
    const seen: Array<{ readonly a: number; readonly b: number }> = [];
    nodeCrypto.timingSafeEqual = ((a: Buffer, b: Buffer) => {
      seen.push({ a: a.length, b: b.length });
      return real(a, b);
    }) as typeof nodeCrypto.timingSafeEqual;

    try {
      assert.equal(
        await service.verifyPassword({ plainTextPassword: PASSWORD, passwordHash: stored }),
        true,
      );
    } finally {
      nodeCrypto.timingSafeEqual = real;
    }

    assert.deepEqual(
      seen,
      [{ a: 64, b: 64 }],
      'the successful verification did not go through timingSafeEqual',
    );
  });
});

describe('needsRehash decides who gets upgraded', () => {
  it('says yes to a hash minted before the format carried parameters', async () => {
    // Without this the cost increase is inert for every account that never
    // changes its password — which is every long-lived operator account.
    const service = new PasswordHashService();

    assert.equal(service.needsRehash(await legacyHashOf(PASSWORD), 'admin'), true);
  });

  it('says no to a hash already at the current work factor', async () => {
    const service = new PasswordHashService();

    assert.equal(
      service.needsRehash(
        await service.hashPassword({ plainTextPassword: PASSWORD, audience: 'admin' }),
        'admin',
      ),
      false,
    );
  });

  it('never downgrades a hash minted above the current work factor', async () => {
    // Rolling the constants back — or picking a lighter OWASP row — must not
    // turn this into a machine that rewrites strong hashes as weaker ones.
    const service = new PasswordHashService();
    const salt = randomBytes(16);
    const stronger = [
      'scrypt',
      String(131_072), // N = 2^17
      '8',
      '2',
      salt.toString('hex'),
      (await derive(PASSWORD, salt, { N: 131_072, r: 8, p: 2 })).toString('hex'),
    ].join('$');

    assert.equal(service.needsRehash(stronger, 'admin'), false);
  });

  it('says no to a hash it cannot parse, so nothing overwrites an unverifiable row', () => {
    const service = new PasswordHashService();

    for (const passwordHash of ['', 'plain', '$2b$10$bcrypt', 'scrypt$zz$zz']) {
      assert.equal(service.needsRehash(passwordHash, 'admin'), false, `not parseable: ${passwordHash}`);
    }
  });
});

describe('parameters read out of a stored hash are bounded', () => {
  it('refuses a cost that would ask scrypt for a terabyte', async () => {
    // `128 * N * r` is an allocation, and these digits come out of a database
    // column. A row claiming N=2^30 must be an unparseable hash, not a 137 GiB
    // request on the login path.
    const service = new PasswordHashService();
    const salt = randomBytes(16).toString('hex');
    const digest = randomBytes(64).toString('hex');

    for (const cost of ['1073741824', '99999999', '512']) {
      assert.equal(
        await service.verifyPassword({
          plainTextPassword: PASSWORD,
          passwordHash: ['scrypt', cost, '8', '2', salt, digest].join('$'),
        }),
        false,
        `cost ${cost} was accepted`,
      );
    }
  });

  it('refuses a cost that is not a power of two, and absurd r / p', async () => {
    const service = new PasswordHashService();
    const salt = randomBytes(16).toString('hex');
    const digest = randomBytes(64).toString('hex');

    for (const [cost, blockSize, parallelization] of [
      ['65535', '8', '2'],
      ['65536', '0', '2'],
      ['65536', '64', '2'],
      ['65536', '8', '0'],
      ['65536', '8', '17'],
      ['65536', '8', '-1'],
      ['0x10000', '8', '2'],
    ]) {
      assert.equal(
        await service.verifyPassword({
          plainTextPassword: PASSWORD,
          passwordHash: ['scrypt', cost, blockSize, parallelization, salt, digest].join('$'),
        }),
        false,
        `${cost}/${blockSize}/${parallelization} was accepted`,
      );
    }
  });

  it('still rejects malformed and foreign hashes rather than throwing', async () => {
    const service = new PasswordHashService();

    for (const passwordHash of [
      '$2b$10$legacy-bcrypt-hash',
      'scrypt$not-hex$not-hex',
      'scrypt$00$00',
      'scrypt$65536$8$2$aa$bb',
      'plain-password',
      '',
    ]) {
      assert.equal(
        await service.verifyPassword({ plainTextPassword: PASSWORD, passwordHash }),
        false,
        `Expected ${passwordHash} to be rejected`,
      );
    }
  });
});
