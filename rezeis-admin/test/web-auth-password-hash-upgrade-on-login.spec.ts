/**
 * A SUBSCRIBER SIGN-IN UPGRADES A PASSWORD STORED BELOW THE SUBSCRIBER COST.
 *
 * The sibling file `test/password-hash-upgrade-on-login.spec.ts` proves this
 * for operators. It was, for a while, the only place it was true: the cost
 * increase was wired into the admin login path alone, so every subscriber row
 * kept verifying at Node's defaults forever and the hardening was inert for the
 * population holding nearly all of the accounts. Nothing reported that. The
 * constants were right, the service was right, and the branch was simply never
 * reached from the customer-facing path.
 *
 * So these cases drive the REAL `WebAuthService.login()` with the REAL
 * `PasswordHashService` and a recording Prisma, and assert on what reached the
 * database — the row, the parameter block inside it, the audience the service
 * asked about, and the columns that must NOT have moved.
 * `test/web-auth.service.spec.ts` cannot cover this: its hasher is a fake that
 * answers `hashed:<password>`, so the upgrade branch there is decided by the
 * fixture rather than by the code.
 *
 * The legacy fixtures are NOT produced by calling the service. They are built
 * by hand with `scrypt()` at Node's documented defaults, which is literally
 * what the old implementation did, so they are the same bytes a real
 * `web_accounts.password_hash` from before this change holds.
 */

import assert from 'node:assert/strict';
import { randomBytes, scrypt } from 'node:crypto';
import { describe, it } from 'node:test';

import { PasswordHashService } from '../src/modules/auth/services/password-hash.service';
import { WebAuthService } from '../src/modules/web-auth/services/web-auth.service';

const PASSWORD = 'the-subscribers-actual-password';
const LOGIN = 'subscriber';
/** What subscriber credentials are minted at. Pinned, not imported. */
const SUBSCRIBER_ROW = { N: 16_384, r: 8, p: 5 } as const;

/** A row exactly as the pre-change implementation wrote it: Node's defaults. */
async function legacyHash(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await new Promise<Buffer>((resolve, reject) =>
    scrypt(password, salt, 64, { N: 16_384, r: 8, p: 1 }, (error, key) =>
      error ? reject(error) : resolve(key),
    ),
  );
  return ['scrypt', salt.toString('hex'), derived.toString('hex')].join('$');
}

interface UpdateManyCall {
  readonly where: Record<string, unknown>;
  readonly data: Record<string, unknown>;
}

interface Harness {
  readonly service: WebAuthService;
  readonly updateManyCalls: UpdateManyCall[];
  /** The row the recording Prisma pretends to hold, mutated by `updateMany`. */
  readonly row: { passwordHash: string };
  /** Every audience the service asked `hashPassword` for, in call order. */
  readonly hashAudiences: string[];
  /** Every audience the service asked `needsRehash` about, in call order. */
  readonly needsRehashAudiences: string[];
  readonly prisma: { webAccount: Record<string, unknown> };
}

function buildHarness(
  storedPasswordHash: string,
  options: { readonly rowChangedMidLogin?: string } = {},
): Harness {
  const updateManyCalls: UpdateManyCall[] = [];
  const hashAudiences: string[] = [];
  const needsRehashAudiences: string[] = [];
  const row = { passwordHash: storedPasswordHash };
  const real = new PasswordHashService();

  // A pass-through, not a fake: every decision is still the real service's.
  // The only thing added is the seam that lets a test change the stored row in
  // the window between "the password verified" and "the upgrade writes".
  const passwordHashService = {
    hashPassword: async (input: { plainTextPassword: string; audience: 'admin' | 'subscriber' }) => {
      hashAudiences.push(input.audience);
      if (options.rowChangedMidLogin !== undefined) {
        row.passwordHash = options.rowChangedMidLogin;
      }
      return real.hashPassword(input);
    },
    verifyPassword: (input: { plainTextPassword: string; passwordHash: string }) =>
      real.verifyPassword(input),
    needsRehash: (passwordHash: string, audience: 'admin' | 'subscriber') => {
      needsRehashAudiences.push(audience);
      return real.needsRehash(passwordHash, audience);
    },
  };

  const prisma = {
    webAccount: {
      findUnique: async () => ({
        id: 'web-account-1',
        userId: 'user-1',
        login: LOGIN,
        loginNormalized: LOGIN,
        passwordHash: storedPasswordHash,
        passwordBootstrapPending: false,
        requiresPasswordChange: false,
        temporaryPasswordExpiresAt: null,
        credentialsBootstrappedAt: new Date('2026-01-01T00:00:00.000Z'),
        emailVerifiedAt: new Date('2026-01-02T00:00:00.000Z'),
        user: { telegramId: BigInt(123456789) },
      }),
      updateMany: async (args: UpdateManyCall) => {
        updateManyCalls.push(args);
        // A conditional update is only meaningful if the fake enforces the
        // condition. `where.passwordHash` must still match what is stored, the
        // way Postgres would decide it.
        const expected = args.where['passwordHash'];
        if (typeof expected === 'string' && expected !== row.passwordHash) {
          return { count: 0 };
        }
        row.passwordHash = String(args.data['passwordHash']);
        return { count: 1 };
      },
      update: async () => {
        throw new Error('login must not take the unconditional update path');
      },
    },
  };

  // `login` reads nothing but Prisma and the hasher. The remaining constructor
  // dependencies are deliberately absent so that a future edit which reaches
  // for one from this path fails loudly instead of silently.
  const service = new WebAuthService(
    prisma as never,
    passwordHashService as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
  );
  return { service, updateManyCalls, row, hashAudiences, needsRehashAudiences, prisma };
}

describe('a correct subscriber sign-in upgrades a password stored below the current cost', () => {
  it('rewrites a pre-parameter hash into the subscriber parameter block, and it still verifies', async () => {
    const stored = await legacyHash(PASSWORD);
    const harness = buildHarness(stored);

    const result = await harness.service.login({ login: LOGIN, password: PASSWORD });

    assert.equal(result.userId, 'user-1', 'the sign-in itself did not succeed');
    assert.equal(harness.updateManyCalls.length, 1, 'the login did not re-hash the stored password');
    const written = String(harness.updateManyCalls[0].data['passwordHash']);
    assert.notEqual(written, stored, 'the row was rewritten with the same value');
    const parts = written.split('$');
    assert.equal(parts.length, 6, `not the parameterised format: ${written}`);
    assert.equal(Number(parts[1]), SUBSCRIBER_ROW.N, 'the upgrade did not land at the subscriber N');
    assert.equal(Number(parts[2]), SUBSCRIBER_ROW.r, 'the upgrade did not land at the subscriber r');
    assert.equal(Number(parts[3]), SUBSCRIBER_ROW.p, 'the upgrade did not land at the subscriber p');
    // The point of the exercise: the subscriber must be able to sign in again.
    assert.equal(
      await new PasswordHashService().verifyPassword({
        plainTextPassword: PASSWORD,
        passwordHash: written,
      }),
      true,
      'the upgraded hash does not verify the password it was derived from',
    );
  });

  it('asks about, and mints at, the SUBSCRIBER audience — never the admin one', async () => {
    // Asking `needsRehash` about the admin row would mark every freshly-written
    // subscriber hash stale and rewrite the row on every single sign-in;
    // minting at the admin row would put a customer-facing login on a 196 ms
    // derivation. Both are invisible in the row that gets written on the FIRST
    // upgrade, so the audiences are observed directly.
    const harness = buildHarness(await legacyHash(PASSWORD));

    await harness.service.login({ login: LOGIN, password: PASSWORD });

    assert.deepEqual(harness.needsRehashAudiences, ['subscriber']);
    assert.deepEqual(harness.hashAudiences, ['subscriber']);
  });

  it('touches only passwordHash — not requiresPasswordChange, not the temp-password expiry', async () => {
    // Clearing `requiresPasswordChange` here would walk a user straight out of
    // a forced reset they never completed, and clearing
    // `temporaryPasswordExpiresAt` would make an operator-issued temporary
    // password permanent. Both are one careless line away.
    const harness = buildHarness(await legacyHash(PASSWORD));

    await harness.service.login({ login: LOGIN, password: PASSWORD });

    assert.deepEqual(
      Object.keys(harness.updateManyCalls[0].data),
      ['passwordHash'],
      'the re-hash wrote columns other than the hash',
    );
  });

  it('writes nothing when the hash is already at the subscriber work factor', async () => {
    // The rewrite loop, caught at the integration level: if this ever goes red,
    // every subscriber sign-in is doing an extra scrypt derivation and an extra
    // database write, forever, and nothing else would say so.
    const stored = await new PasswordHashService().hashPassword({
      plainTextPassword: PASSWORD,
      audience: 'subscriber',
    });
    const harness = buildHarness(stored);

    await harness.service.login({ login: LOGIN, password: PASSWORD });

    assert.deepEqual(harness.updateManyCalls, [], 'a current-cost subscriber hash was rewritten anyway');
    assert.deepEqual(harness.hashAudiences, [], 'the login derived a hash it had no reason to derive');
  });

  it('does not weaken an admin-strength hash that reached a subscriber row', async () => {
    const stored = await new PasswordHashService().hashPassword({
      plainTextPassword: PASSWORD,
      audience: 'admin',
    });
    const harness = buildHarness(stored);

    await harness.service.login({ login: LOGIN, password: PASSWORD });

    assert.deepEqual(harness.updateManyCalls, [], 'a stronger hash was rewritten as a weaker one');
  });

  it('does not clobber a password changed in another session mid-login', async () => {
    // Verify reads the OLD hash; the subscriber changes their password
    // elsewhere — or an operator issues a temporary one — and then the upgrade
    // fires. An unconditional write would re-derive the OLD password over the
    // new hash and silently restore a revoked credential.
    const stored = await legacyHash(PASSWORD);
    const replacement = await new PasswordHashService().hashPassword({
      plainTextPassword: 'the-brand-new-password',
      audience: 'subscriber',
    });
    const harness = buildHarness(stored, { rowChangedMidLogin: replacement });

    await harness.service.login({ login: LOGIN, password: PASSWORD });

    assert.equal(harness.updateManyCalls.length, 1, 'the upgrade never ran');
    assert.equal(
      harness.updateManyCalls[0].where['passwordHash'],
      stored,
      'the write was not conditional on the hash that was verified',
    );
    assert.equal(harness.row.passwordHash, replacement, 'the newer password hash was overwritten');
    assert.equal(
      await new PasswordHashService().verifyPassword({
        plainTextPassword: 'the-brand-new-password',
        passwordHash: harness.row.passwordHash,
      }),
      true,
      'the password the subscriber just set no longer works',
    );
  });

  it('never re-hashes after a REJECTED sign-in', async () => {
    // The upgrade has to sit behind the verification, not beside it. A wrong
    // password that still rewrote the row would let anyone overwrite any
    // subscriber credential with a derivation of their own guess.
    const harness = buildHarness(await legacyHash(PASSWORD));

    await assert.rejects(
      harness.service.login({ login: LOGIN, password: 'not-the-password' }),
      /Invalid login or password/,
    );

    assert.deepEqual(harness.updateManyCalls, [], 'a failed sign-in wrote to the password hash');
    assert.deepEqual(harness.hashAudiences, [], 'a failed sign-in derived a replacement hash');
  });

  it('still signs the subscriber in when the upgrade write fails', async () => {
    // The subscriber authenticated correctly. A database hiccup while
    // opportunistically improving storage is not their problem.
    const harness = buildHarness(await legacyHash(PASSWORD));
    harness.prisma.webAccount['updateMany'] = async () => {
      throw new Error('connection reset');
    };

    const result = await harness.service.login({ login: LOGIN, password: PASSWORD });

    assert.deepEqual(result, {
      userId: 'user-1',
      requiresPasswordChange: false,
      telegramLinked: true,
      emailVerified: true,
    });
  });
});
