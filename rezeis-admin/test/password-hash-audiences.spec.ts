/**
 * TWO MINT-TIME PARAMETER SETS, ONE VERIFICATION PATH.
 *
 * `PasswordHashService` now mints at two different scrypt rows: a heavier one
 * for operator (ADMIN) credentials and a lighter one for subscriber
 * credentials. Both come off OWASP's list of settings it calls equivalent —
 * "a similar minimal level of defense, with the main trade-off between
 * parallelism and RAM usage" — so this is not "admins get a strong hash and
 * customers get a weak one". It is two points on a curve of equal defence,
 * picked for two different traffic shapes: a handful of operators signing in
 * rarely, against every customer of the platform signing in constantly.
 *
 * Three things can go wrong, and this file exists for all three.
 *
 * 1. THE LOCKOUT. Verification must read the parameters out of the row, never
 *    off a mint-time constant. The moment it consults either constant, every
 *    credential minted under the OTHER one stops verifying — and for the
 *    subscriber row that is every customer at once. `an admin hash and a
 *    subscriber hash both verify` is the case that would end a deploy.
 *
 * 2. THE REWRITE LOOP. `needsRehash` measures a stored hash against the row
 *    the CALLER would mint at. Asked about the admin row instead, every
 *    freshly-written subscriber hash reports "stale" and every subscriber
 *    sign-in re-derives and rewrites the row it just wrote — a scrypt
 *    derivation and a database write per login, forever, and no test that only
 *    checks a constant would notice.
 *
 * 3. THE HARMONISATION. Someone finds two constants that look like a
 *    half-finished migration and makes them one. `keeps the two sets different`
 *    is deliberately blunt about that.
 *
 * The rows are PINNED here as literals rather than imported from the service.
 * Importing the constant and asserting it equals itself is the "green test that
 * guards nothing" shape: it survives any change to the number. These numbers
 * are read back out of the string the database would hold.
 */

import assert from 'node:assert/strict';
import { randomBytes, scrypt } from 'node:crypto';
import { describe, it } from 'node:test';

import { PasswordHashService } from '../src/modules/auth/services/password-hash.service';

const PASSWORD = 'correct horse battery staple';

/** What operator credentials are minted at. 64 MiB of scratch, ~196 ms here. */
const ADMIN_ROW = { N: 65_536, r: 8, p: 2 } as const;
/**
 * What subscriber credentials are minted at. 16 MiB of scratch, ~114 ms here,
 * so 4 concurrent sign-ins peak at 64 MiB and the ceiling is ~31 logins/sec
 * against ~19 at the admin row.
 *
 * `N` is 16_384 — the SAME number as Node's default — and that is not an
 * oversight to be tidied. The defence in this row is p=5: five sequential
 * passes over the scratch, five times the total work of a legacy hash.
 */
const SUBSCRIBER_ROW = { N: 16_384, r: 8, p: 5 } as const;
/** Node's scrypt defaults — what produced every three-part hash in the wild. */
const LEGACY_ROW = { N: 16_384, r: 8, p: 1 } as const;
/**
 * Two more of OWASP's five equivalent rows, which this codebase mints at
 * NEITHER audience. A hash carrying one of these has to verify anyway; that is
 * the property, stated without reference to any constant in the service.
 */
const FOREIGN_ROWS = [
  { N: 32_768, r: 8, p: 3 },
  { N: 8_192, r: 8, p: 10 },
] as const;

interface ScryptRow {
  readonly N: number;
  readonly r: number;
  readonly p: number;
}

function derive(password: string, salt: Buffer, row: ScryptRow): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      64,
      { N: row.N, r: row.r, p: row.p, maxmem: 128 * row.N * row.r + 1_048_576 },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

/** A six-part hash built by hand at `row` — never by calling the service. */
async function hashAt(password: string, row: ScryptRow): Promise<string> {
  const salt = randomBytes(16);
  const derived = await derive(password, salt, row);
  return ['scrypt', String(row.N), String(row.r), String(row.p), salt.toString('hex'), derived.toString('hex')].join(
    '$',
  );
}

/** A row exactly as the pre-parameter implementation wrote it. */
async function legacyHashOf(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await derive(password, salt, LEGACY_ROW);
  return ['scrypt', salt.toString('hex'), derived.toString('hex')].join('$');
}

/** The parameter block as it sits in the stored string. */
function rowOf(passwordHash: string): ScryptRow {
  const parts = passwordHash.split('$');
  assert.equal(parts.length, 6, `not a parameterised hash: ${passwordHash}`);
  assert.equal(parts[0], 'scrypt');
  return { N: Number(parts[1]), r: Number(parts[2]), p: Number(parts[3]) };
}

const totalWork = (row: ScryptRow): number => row.N * row.r * row.p;

describe('the two mint-time parameter sets', () => {
  it('mints an ADMIN credential at N=2^16, r=8, p=2', async () => {
    const service = new PasswordHashService();

    const stored = await service.hashPassword({ plainTextPassword: PASSWORD, audience: 'admin' });

    assert.deepEqual(rowOf(stored), ADMIN_ROW, 'the admin scrypt row moved');
    assert.equal(Buffer.from(stored.split('$')[4], 'hex').length, 16, 'salt is no longer 128 bits');
    assert.equal(Buffer.from(stored.split('$')[5], 'hex').length, 64, 'key is no longer 512 bits');
  });

  it('mints a SUBSCRIBER credential at N=2^14, r=8, p=5', async () => {
    const service = new PasswordHashService();

    const stored = await service.hashPassword({
      plainTextPassword: PASSWORD,
      audience: 'subscriber',
    });

    assert.deepEqual(rowOf(stored), SUBSCRIBER_ROW, 'the subscriber scrypt row moved');
    assert.equal(Buffer.from(stored.split('$')[4], 'hex').length, 16, 'salt is no longer 128 bits');
    assert.equal(Buffer.from(stored.split('$')[5], 'hex').length, 64, 'key is no longer 512 bits');
  });

  it('keeps the two sets DIFFERENT, with the subscriber row the lighter one', async () => {
    // The failure mode this catches is a reader, not an attacker: two constants
    // that look like a half-finished migration get "harmonised" into one, and
    // subscriber sign-in silently costs 1.7x what it was tuned for — or, in the
    // other direction, operator credentials quietly drop to the customer row.
    const service = new PasswordHashService();

    const admin = rowOf(await service.hashPassword({ plainTextPassword: PASSWORD, audience: 'admin' }));
    const subscriber = rowOf(
      await service.hashPassword({ plainTextPassword: PASSWORD, audience: 'subscriber' }),
    );

    assert.notDeepEqual(admin, subscriber, 'the two audiences now mint identical hashes');
    assert.ok(
      totalWork(subscriber) < totalWork(admin),
      `subscriber work ${totalWork(subscriber)} is not below admin work ${totalWork(admin)}`,
    );
  });

  it('leaves a subscriber hash at five times the total work of the row it replaces', async () => {
    // Names the size of the increase rather than the fact that a number
    // changed. `N` is unchanged from Node's default here, so a test that only
    // looked at `N` would report no hardening at all for subscribers.
    const service = new PasswordHashService();

    const subscriber = rowOf(
      await service.hashPassword({ plainTextPassword: PASSWORD, audience: 'subscriber' }),
    );

    assert.equal(subscriber.N, LEGACY_ROW.N, 'the subscriber row no longer shares N with the legacy row');
    assert.equal(
      totalWork(subscriber) / totalWork(LEGACY_ROW),
      5,
      'a subscriber hash is not 5x the work of the Node-default hash it replaces',
    );
  });
});

describe('verification is audience-blind', () => {
  it('verifies a hash minted under the OTHER set — both directions', async () => {
    // THE LOCKOUT TEST. If `verifyPassword` ever derives with a mint-time
    // constant instead of the parameters in the row, exactly one of these two
    // assertions still passes and the other fails — whichever constant was
    // picked. Asserting both directions is what makes the mutation unsurvivable
    // rather than a coin flip.
    const service = new PasswordHashService();
    const adminHash = await service.hashPassword({ plainTextPassword: PASSWORD, audience: 'admin' });
    const subscriberHash = await service.hashPassword({
      plainTextPassword: PASSWORD,
      audience: 'subscriber',
    });

    assert.equal(
      await service.verifyPassword({ plainTextPassword: PASSWORD, passwordHash: adminHash }),
      true,
      'an ADMIN-minted hash no longer verifies — every operator is locked out',
    );
    assert.equal(
      await service.verifyPassword({ plainTextPassword: PASSWORD, passwordHash: subscriberHash }),
      true,
      'a SUBSCRIBER-minted hash no longer verifies — every customer is locked out',
    );
    assert.equal(
      await service.verifyPassword({ plainTextPassword: 'wrong', passwordHash: adminHash }),
      false,
    );
    assert.equal(
      await service.verifyPassword({ plainTextPassword: 'wrong', passwordHash: subscriberHash }),
      false,
    );
  });

  it('verifies hashes at OWASP rows this codebase mints at neither audience', async () => {
    // The sharper form of the same claim: the row decides, not a constant. A
    // hash at `2^15 r8 p3` was never minted here and never will be, and it
    // still has to verify — which is only true if the digits in the string are
    // what reach `scrypt`.
    const service = new PasswordHashService();

    for (const row of FOREIGN_ROWS) {
      const stored = await hashAt(PASSWORD, row);
      assert.equal(
        await service.verifyPassword({ plainTextPassword: PASSWORD, passwordHash: stored }),
        true,
        `a hash carrying N=${row.N} r=${row.r} p=${row.p} did not verify`,
      );
      assert.equal(
        await service.verifyPassword({ plainTextPassword: 'wrong', passwordHash: stored }),
        false,
      );
    }
  });

  it('still verifies a subscriber hash that predates the format carrying parameters', async () => {
    // Every subscriber row in the database today is this shape. The whole
    // upgrade is worthless if raising the cost stops them verifying first.
    const service = new PasswordHashService();
    const legacy = await legacyHashOf(PASSWORD);

    assert.match(legacy, /^scrypt\$[0-9a-f]+\$[0-9a-f]+$/, 'fixture is not the legacy shape');
    assert.equal(
      await service.verifyPassword({ plainTextPassword: PASSWORD, passwordHash: legacy }),
      true,
      'a subscriber whose password predates this change can no longer sign in',
    );
  });
});

describe('both parameter sets are actually usable', () => {
  it('mints and verifies at BOTH sets, which Node refuses without an explicit maxmem', async () => {
    // NOT "a constant equals a number". Node's default `maxmem` is 32 MiB and
    // `128 * N * r` for the admin row is 64 MiB, so dropping the explicit
    // `maxmem` does not make hashes cheaper — it makes `hashPassword` throw and
    // `verifyPassword` answer `false` to a correct password. This test derives
    // for real at both rows and requires the round trip to close.
    const service = new PasswordHashService();

    for (const audience of ['admin', 'subscriber'] as const) {
      const stored = await service.hashPassword({ plainTextPassword: PASSWORD, audience });
      assert.equal(
        await service.verifyPassword({ plainTextPassword: PASSWORD, passwordHash: stored }),
        true,
        `the ${audience} parameters could not complete a mint-and-verify round trip`,
      );
    }
  });

  it('documents which of the two rows Node itself would refuse', async () => {
    // Measured, not assumed, and the reason the explicit `maxmem` exists at
    // all. Only the admin row is above Node's ceiling, which is precisely why
    // the round trip above has to cover BOTH audiences: a subscriber-only
    // version of it would survive deleting `maxmem`.
    const refused = async (row: ScryptRow): Promise<string | null> => {
      try {
        await new Promise<Buffer>((resolve, reject) =>
          scrypt(PASSWORD, randomBytes(16), 64, { N: row.N, r: row.r, p: row.p }, (error, key) =>
            error ? reject(error) : resolve(key),
          ),
        );
        return null;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code ?? 'unknown';
      }
    };

    assert.equal(
      await refused(ADMIN_ROW),
      'ERR_CRYPTO_INVALID_SCRYPT_PARAMS',
      'the admin row no longer exceeds Node default maxmem — re-check the claim in the service',
    );
    assert.equal(await refused(SUBSCRIBER_ROW), null, 'the subscriber row unexpectedly needs maxmem');
  });
});

describe('needsRehash is asked about a specific audience', () => {
  it('leaves a freshly minted subscriber hash alone', async () => {
    // THE REWRITE-LOOP TEST. Measured against the admin row, a subscriber hash
    // is always "stale": 16_384*8*5 is below 65_536*8*2. Every subscriber
    // sign-in would then re-derive and rewrite the row it had just written.
    const service = new PasswordHashService();

    const stored = await service.hashPassword({
      plainTextPassword: PASSWORD,
      audience: 'subscriber',
    });

    assert.equal(
      service.needsRehash(stored, 'subscriber'),
      false,
      'a just-minted subscriber hash is reported stale — every login would rewrite it',
    );
  });

  it('leaves a freshly minted admin hash alone', async () => {
    const service = new PasswordHashService();

    const stored = await service.hashPassword({ plainTextPassword: PASSWORD, audience: 'admin' });

    assert.equal(service.needsRehash(stored, 'admin'), false);
  });

  it('upgrades a legacy subscriber hash on a subscriber path', async () => {
    // Without this the cost increase is inert for every subscriber who never
    // changes their password — which is nearly all of them.
    const service = new PasswordHashService();

    assert.equal(service.needsRehash(await legacyHashOf(PASSWORD), 'subscriber'), true);
  });

  it('never weakens an admin-strength hash presented on a subscriber path', async () => {
    // The comparison is on total work, so it can only ever move a hash UP. An
    // operator credential that somehow reached a subscriber code path is left
    // exactly as it is.
    const service = new PasswordHashService();

    const adminHash = await service.hashPassword({ plainTextPassword: PASSWORD, audience: 'admin' });

    assert.equal(service.needsRehash(adminHash, 'subscriber'), false);
  });

  it('reports a subscriber hash as below the admin bar', async () => {
    // Stated so the asymmetry is deliberate and visible rather than discovered.
    // No subscriber hash can reach an admin path — different tables — and if
    // one did, upgrading it is the safe direction.
    const service = new PasswordHashService();

    const subscriberHash = await service.hashPassword({
      plainTextPassword: PASSWORD,
      audience: 'subscriber',
    });

    assert.equal(service.needsRehash(subscriberHash, 'admin'), true);
  });

  it('does not churn a hash at a different OWASP row of equal work', async () => {
    // `2^13 r8 p10` is 655_360 units of work, exactly what the subscriber row
    // costs. Equal defence, so nothing to gain by rewriting it.
    const service = new PasswordHashService();

    const equalWork = await hashAt(PASSWORD, FOREIGN_ROWS[1]);

    assert.equal(totalWork(FOREIGN_ROWS[1]), totalWork(SUBSCRIBER_ROW), 'fixture is not equal work');
    assert.equal(service.needsRehash(equalWork, 'subscriber'), false);
  });

  it('says no to a hash it cannot parse, for either audience', () => {
    const service = new PasswordHashService();

    for (const passwordHash of ['', 'plain', '$2b$10$bcrypt', 'scrypt$zz$zz']) {
      assert.equal(service.needsRehash(passwordHash, 'admin'), false, `admin: ${passwordHash}`);
      assert.equal(
        service.needsRehash(passwordHash, 'subscriber'),
        false,
        `subscriber: ${passwordHash}`,
      );
    }
  });
});
