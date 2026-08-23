/**
 * THE SECOND SUBSCRIBER DOOR ALSO UPGRADES A PASSWORD STORED BELOW THE COST.
 *
 * `test/password-hash-upgrade-on-login.spec.ts` proves the opportunistic
 * re-hash for operators and
 * `test/web-auth-password-hash-upgrade-on-login.spec.ts` proves it for
 * subscribers arriving through `WebAuthService.login`. Neither says anything
 * about `InternalUserService.signInLinkedWebAccount`, which verifies the SAME
 * `WebAccount.passwordHash` over the internal API and, until this file existed,
 * verified it and walked away. Every account whose only sign-in path is that
 * route stayed at Node's default work factor forever — the exact inertness the
 * parameterised hash format was introduced to remove, and invisible because the
 * constants, the service and the sibling wirings were all correct.
 *
 * So these cases drive the REAL `InternalUserService.signInLinkedWebAccount`
 * with the REAL `PasswordHashService` and a recording Prisma, and assert on
 * what reached the database: the row, the parameter block inside it, the
 * AUDIENCE the service asked about, and the columns that must NOT have moved.
 * `test/internal-user-linked-web-account-sign-in.spec.ts` cannot cover this —
 * its hasher is a fake whose `needsRehash` is pinned, so the upgrade branch
 * there is decided by the fixture rather than by the code.
 *
 * The legacy fixtures are NOT produced by calling the service. They are built
 * by hand with `scrypt()` at Node's documented defaults, which is literally
 * what the old implementation did, so they are the same bytes a real
 * `web_accounts.password_hash` from before the change holds.
 */

import 'reflect-metadata';

import assert from 'node:assert/strict';
import { randomBytes, scrypt } from 'node:crypto';
import { describe, it } from 'node:test';

import { UserRole } from '@prisma/client';

import { PasswordHashService } from '../src/modules/auth/services/password-hash.service';
import { InternalUserService } from '../src/modules/internal-user/services/internal-user.service';

const PASSWORD = 'the-linked-accounts-actual-password';
const LOGIN = 'linked_subscriber';

/**
 * What SUBSCRIBER credentials are minted at, and what ADMIN ones are minted at.
 * Both pinned rather than imported: the point of the assertions below is that
 * this door picked the subscriber row, and importing the constant it is being
 * measured against would agree with any future edit to either.
 */
const SUBSCRIBER_ROW = { N: 16_384, r: 8, p: 5 } as const;
const ADMIN_ROW = { N: 65_536, r: 8, p: 2 } as const;

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
  readonly service: InternalUserService;
  readonly updateManyCalls: UpdateManyCall[];
  /** The row the recording Prisma pretends to hold, mutated by `updateMany`. */
  readonly row: { passwordHash: string };
  /** Every audience the service asked `hashPassword` for, in call order. */
  readonly hashAudiences: string[];
  /** Every audience the service asked `needsRehash` about, in call order. */
  readonly needsRehashAudiences: string[];
  readonly prisma: { webAccount: Record<string, unknown>; user: Record<string, unknown> };
}

function webAccountRecord(passwordHash: string): Record<string, unknown> {
  return {
    id: 'web-account-1',
    userId: 'user-1',
    login: LOGIN,
    loginNormalized: LOGIN,
    email: 'linked@example.com',
    emailNormalized: 'linked@example.com',
    emailVerifiedAt: new Date('2026-04-18T10:00:00.000Z'),
    passwordHash,
    requiresPasswordChange: false,
    temporaryPasswordExpiresAt: null,
    tokenVersion: 0,
    linkPromptSnoozeUntil: null,
    credentialsBootstrappedAt: new Date('2026-04-18T09:00:00.000Z'),
    createdAt: new Date('2026-04-18T08:00:00.000Z'),
    updatedAt: new Date('2026-04-18T10:00:00.000Z'),
  };
}

function userRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'user-1',
    telegramId: BigInt('777000'),
    username: 'tester',
    name: 'Rezeis User',
    email: 'linked@example.com',
    role: UserRole.USER,
    language: 'EN',
    personalDiscount: 0,
    purchaseDiscount: 0,
    points: 0,
    maxSubscriptions: 1,
    isBlocked: false,
    isBotBlocked: false,
    isRulesAccepted: true,
    onboardingCompletedAt: null,
    lastSeenAt: null,
    createdAt: new Date('2026-04-18T08:00:00.000Z'),
    updatedAt: new Date('2026-04-18T10:00:00.000Z'),
    webAccount: webAccountRecord('irrelevant-for-the-session-payload'),
    ...overrides,
  };
}

function buildHarness(
  storedPasswordHash: string,
  options: {
    readonly rowChangedMidSignIn?: string;
    readonly user?: Record<string, unknown>;
  } = {},
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
      if (options.rowChangedMidSignIn !== undefined) {
        row.passwordHash = options.rowChangedMidSignIn;
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
      findUnique: async () => webAccountRecord(storedPasswordHash),
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
        throw new Error('sign-in must not take the unconditional update path');
      },
    },
    user: {
      findUnique: async () => options.user ?? userRecord(),
    },
  };

  // `signInLinkedWebAccount` reads nothing but Prisma and the hasher. The
  // remaining constructor dependencies are deliberately absent so that a future
  // edit which reaches for one from this path fails loudly instead of silently.
  const service = new InternalUserService(
    prisma as never,
    passwordHashService as never,
    null as never,
  );
  return { service, updateManyCalls, row, hashAudiences, needsRehashAudiences, prisma };
}

describe('a correct linked-web-account sign-in upgrades a password stored below the current cost', () => {
  it('rewrites a pre-parameter hash into the subscriber parameter block, and it still verifies', async () => {
    const stored = await legacyHash(PASSWORD);
    const harness = buildHarness(stored);

    const session = await harness.service.signInLinkedWebAccount({
      login: LOGIN,
      password: PASSWORD,
    });

    assert.equal(session.id, 'user-1', 'the sign-in itself did not succeed');
    assert.equal(
      harness.updateManyCalls.length,
      1,
      'the linked-account sign-in did not re-hash the stored password',
    );
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

  it('mints at the SUBSCRIBER cost — the audience follows the credential, not the caller', async () => {
    // This door is reached over the INTERNAL ADMIN API, and the credential it
    // verifies is a `WebAccount` row — the same row `setWebAccountPassword` in
    // this very service mints at `audience: 'subscriber'`. Picking `'admin'`
    // because of the caller is not correctable later: `needsRehash` compares
    // total work and only ever moves a hash UP, so an admin-strength row
    // written here is never brought back down and every future sign-in through
    // either subscriber door pays for it.
    const harness = buildHarness(await legacyHash(PASSWORD));

    await harness.service.signInLinkedWebAccount({ login: LOGIN, password: PASSWORD });

    assert.deepEqual(harness.needsRehashAudiences, ['subscriber']);
    assert.deepEqual(harness.hashAudiences, ['subscriber']);
    const parts = String(harness.updateManyCalls[0].data['passwordHash']).split('$');
    assert.equal(
      Number(parts[1]),
      SUBSCRIBER_ROW.N,
      'the row was not minted at the subscriber work factor',
    );
    assert.notEqual(
      Number(parts[1]),
      ADMIN_ROW.N,
      'a subscriber credential was minted at the ADMIN work factor',
    );
    assert.equal(Number(parts[3]), SUBSCRIBER_ROW.p);
    assert.notEqual(Number(parts[3]), ADMIN_ROW.p);
  });

  it('touches only passwordHash — not requiresPasswordChange, not the temp-password expiry', async () => {
    // Clearing `requiresPasswordChange` here would walk a user straight out of
    // a forced reset they never completed, and clearing
    // `temporaryPasswordExpiresAt` would make an operator-issued temporary
    // password permanent. Both are one careless line away.
    const harness = buildHarness(await legacyHash(PASSWORD));

    await harness.service.signInLinkedWebAccount({ login: LOGIN, password: PASSWORD });

    assert.deepEqual(
      Object.keys(harness.updateManyCalls[0].data),
      ['passwordHash'],
      'the re-hash wrote columns other than the hash',
    );
    assert.deepEqual(
      Object.keys(harness.updateManyCalls[0].where).sort(),
      ['id', 'passwordHash'],
      'the re-hash was not scoped to the row whose hash was just verified',
    );
  });

  it('writes nothing when the hash is already at the subscriber work factor', async () => {
    // The rewrite loop, caught at the integration level: if this ever goes red,
    // every linked-account sign-in is doing an extra scrypt derivation and an
    // extra database write, forever, and nothing else would say so.
    const stored = await new PasswordHashService().hashPassword({
      plainTextPassword: PASSWORD,
      audience: 'subscriber',
    });
    const harness = buildHarness(stored);

    await harness.service.signInLinkedWebAccount({ login: LOGIN, password: PASSWORD });

    assert.deepEqual(
      harness.updateManyCalls,
      [],
      'a current-cost subscriber hash was rewritten anyway',
    );
    assert.deepEqual(
      harness.hashAudiences,
      [],
      'the sign-in derived a hash it had no reason to derive',
    );
  });

  it('does not weaken an admin-strength hash that reached a subscriber row', async () => {
    const stored = await new PasswordHashService().hashPassword({
      plainTextPassword: PASSWORD,
      audience: 'admin',
    });
    const harness = buildHarness(stored);

    await harness.service.signInLinkedWebAccount({ login: LOGIN, password: PASSWORD });

    assert.deepEqual(harness.updateManyCalls, [], 'a stronger hash was rewritten as a weaker one');
  });

  it('does not clobber a password changed in another session mid-sign-in', async () => {
    // Verify reads the OLD hash; the subscriber changes their password
    // elsewhere — or an operator issues a temporary one — and then the upgrade
    // fires. An unconditional write would re-derive the OLD password over the
    // new hash and silently restore a revoked credential.
    const stored = await legacyHash(PASSWORD);
    const replacement = await new PasswordHashService().hashPassword({
      plainTextPassword: 'the-brand-new-password',
      audience: 'subscriber',
    });
    const harness = buildHarness(stored, { rowChangedMidSignIn: replacement });

    await harness.service.signInLinkedWebAccount({ login: LOGIN, password: PASSWORD });

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
      harness.service.signInLinkedWebAccount({ login: LOGIN, password: 'not-the-password' }),
      /Invalid login or password/,
    );

    assert.deepEqual(harness.updateManyCalls, [], 'a failed sign-in wrote to the password hash');
    assert.deepEqual(harness.hashAudiences, [], 'a failed sign-in derived a replacement hash');
  });

  it('never re-hashes for a BLOCKED user whose password was correct', async () => {
    // The sibling admin path puts the upgrade behind the whole login, second
    // factor included. Here the last gate is the block: a correct password on a
    // blocked account is still a refused sign-in, and a refused sign-in must
    // not touch the credential row.
    const harness = buildHarness(await legacyHash(PASSWORD), {
      user: userRecord({ isBlocked: true }),
    });

    await assert.rejects(
      harness.service.signInLinkedWebAccount({ login: LOGIN, password: PASSWORD }),
      /User is blocked/,
    );

    assert.deepEqual(harness.updateManyCalls, [], 'a refused sign-in wrote to the password hash');
    assert.deepEqual(harness.hashAudiences, [], 'a refused sign-in derived a replacement hash');
  });

  it('still signs the subscriber in when the upgrade write fails', async () => {
    // The subscriber authenticated correctly. A database hiccup while
    // opportunistically improving storage is not their problem.
    const harness = buildHarness(await legacyHash(PASSWORD));
    harness.prisma.webAccount['updateMany'] = async () => {
      throw new Error('connection reset');
    };

    const session = await harness.service.signInLinkedWebAccount({
      login: LOGIN,
      password: PASSWORD,
    });

    assert.equal(session.id, 'user-1');
    assert.equal(session.isBlocked, false);
  });
});
