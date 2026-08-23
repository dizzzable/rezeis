/**
 * Raising the scrypt cost upgrades NOBODY on its own.
 *
 * Because a hash is verified with the parameters stored inside it, an operator
 * whose row was written at N=2^14 keeps signing in at N=2^14 forever — the
 * change is inert for exactly the long-lived accounts it was meant to protect,
 * and nothing anywhere would report that. OWASP's Password Storage Cheat Sheet
 * names the missing half: "wait until the user next authenticates, then re-hash
 * their password with the new work factor."
 *
 * So these cases drive the REAL `AdminAuthService.loginAdmin()` with the REAL
 * `PasswordHashService` and a recording Prisma, and assert on what reached the
 * database — the row, its shape, and the columns that must NOT have moved.
 * `test/admin-auth.service.spec.ts` cannot cover this: its password hasher is a
 * fake that answers a constant, so the upgrade branch there is decided by the
 * fixture rather than by the code.
 */

import 'reflect-metadata';

import assert from 'node:assert/strict';
import { randomBytes, scrypt } from 'node:crypto';
import { describe, it } from 'node:test';

import { UserRole } from '@prisma/client';

import { AdminAuthService } from '../src/modules/auth/services/admin-auth.service';
import { PasswordHashService } from '../src/modules/auth/services/password-hash.service';

const PASSWORD = 'the-operators-actual-password';
const REQUEST_METADATA = {
  requestId: 'request-1',
  remoteAddress: '203.0.113.10',
  userAgent: 'unit-test',
} as const;

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
  readonly service: AdminAuthService;
  readonly updateManyCalls: UpdateManyCall[];
  /** The row the recording Prisma pretends to hold, mutated by `updateMany`. */
  readonly row: { passwordHash: string };
}

function buildHarness(storedPasswordHash: string, options: { readonly rowChangedMidLogin?: string } = {}): Harness {
  const updateManyCalls: UpdateManyCall[] = [];
  const row = { passwordHash: storedPasswordHash };
  const profile = {
    id: 'admin-1',
    login: 'operator',
    loginNormalized: 'operator',
    email: 'operator@example.com',
    name: 'Operator',
    role: UserRole.ADMIN,
    isActive: true,
    tokenVersion: 2,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    lastLoginAt: null,
    lastLoginIp: null,
    rbacRoleId: null,
    mustChangePassword: false,
  };
  const prismaService = {
    adminUser: {
      findUnique: async () => ({ ...profile, passwordHash: storedPasswordHash }),
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
    },
    adminAuditLog: { create: async () => undefined },
    $transaction: async (
      callback: (client: unknown) => Promise<unknown>,
    ): Promise<unknown> => {
      if (options.rowChangedMidLogin !== undefined) {
        // Someone changed the password in another session between the
        // verification and the upgrade. This is the window the conditional
        // write exists for.
        row.passwordHash = options.rowChangedMidLogin;
      }
      return callback({
        adminUser: { update: async () => profile },
        adminAuditLog: { create: async () => undefined },
      });
    },
  };
  const service = new AdminAuthService(
    {
      jwtSecret: 'secret',
      jwtExpiresIn: '12h',
      cryptKey: 'crypt-key',
      internalSharedSecret: '',
      internalSignatureMode: 'off',
    } as never,
    { signAsync: async () => 'signed-token' } as never,
    new PasswordHashService(),
    prismaService as never,
  );
  return { service, updateManyCalls, row };
}

describe('a correct sign-in upgrades a password stored below the current cost', () => {
  it('rewrites a pre-parameter hash into the current format, and it still verifies', async () => {
    const stored = await legacyHash(PASSWORD);
    const harness = buildHarness(stored);

    await harness.service.loginAdmin({
      login: 'operator',
      password: PASSWORD,
      requestMetadata: REQUEST_METADATA,
    });

    assert.equal(harness.updateManyCalls.length, 1, 'the login did not re-hash the stored password');
    const written = String(harness.updateManyCalls[0].data['passwordHash']);
    assert.notEqual(written, stored, 'the row was rewritten with the same value');
    assert.equal(written.split('$').length, 6, `not the parameterised format: ${written}`);
    assert.equal(written.split('$')[1], '65536', 'the upgrade did not land at the current cost');
    // The point of the exercise: the operator must be able to sign in again.
    assert.equal(
      await new PasswordHashService().verifyPassword({
        plainTextPassword: PASSWORD,
        passwordHash: written,
      }),
      true,
      'the upgraded hash does not verify the password it was derived from',
    );
  });

  it('touches only passwordHash — not passwordChangedAt, not tokenVersion', async () => {
    // Bumping `tokenVersion` here would invalidate the JWT this very request is
    // about to issue, and `passwordChangedAt` would tell an operator their
    // password changed when it did not. Both are one careless line away.
    const harness = buildHarness(await legacyHash(PASSWORD));

    await harness.service.loginAdmin({
      login: 'operator',
      password: PASSWORD,
      requestMetadata: REQUEST_METADATA,
    });

    assert.deepEqual(
      Object.keys(harness.updateManyCalls[0].data),
      ['passwordHash'],
      'the re-hash wrote columns other than the hash',
    );
  });

  it('writes nothing when the hash is already at the current work factor', async () => {
    const stored = await new PasswordHashService().hashPassword({
      plainTextPassword: PASSWORD,
      audience: 'admin',
    });
    const harness = buildHarness(stored);

    await harness.service.loginAdmin({
      login: 'operator',
      password: PASSWORD,
      requestMetadata: REQUEST_METADATA,
    });

    assert.deepEqual(harness.updateManyCalls, [], 'a current-cost hash was rewritten anyway');
  });

  it('does not clobber a password changed in another session mid-login', async () => {
    // Verify reads the OLD hash; the operator then changes their password
    // elsewhere; the upgrade fires. An unconditional write would re-derive the
    // OLD password over the new hash and silently restore a revoked credential.
    const stored = await legacyHash(PASSWORD);
    const replacement = await new PasswordHashService().hashPassword({
      plainTextPassword: 'the-brand-new-password',
      audience: 'admin',
    });
    const harness = buildHarness(stored, { rowChangedMidLogin: replacement });

    await harness.service.loginAdmin({
      login: 'operator',
      password: PASSWORD,
      requestMetadata: REQUEST_METADATA,
    });

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
      'the password the operator just set no longer works',
    );
  });

  it('still signs the operator in when the upgrade write fails', async () => {
    // The operator authenticated correctly. A database hiccup while
    // opportunistically improving storage is not their problem.
    const harness = buildHarness(await legacyHash(PASSWORD));
    const prisma = (harness.service as unknown as { prismaService: { adminUser: Record<string, unknown> } })
      .prismaService;
    prisma.adminUser['updateMany'] = async () => {
      throw new Error('connection reset');
    };

    const result = await harness.service.loginAdmin({
      login: 'operator',
      password: PASSWORD,
      requestMetadata: REQUEST_METADATA,
    });

    assert.equal(result.accessToken, 'signed-token');
  });
});
