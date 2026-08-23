/**
 * WHICH PARAMETER SET EACH MINT SITE USES.
 *
 * `PasswordHashService.hashPassword` takes a required `audience` because the
 * choice is not derivable from where you are standing. The trap is real and it
 * has a name in this repository: `admin-user-web.controller.ts` is an
 * ADMIN-only endpoint, on an admin controller, behind `@RequirePermission`, and
 * the credential it mints is a SUBSCRIBER'S — it writes
 * `web_accounts.password_hash` and the path that will verify it is
 * `WebAuthService.login`. Classify by the ROW and the LOGIN PATH, never by the
 * filename. The mirror-image trap is `admin-admins.controller.ts`, which sits
 * next to the users screens in the UI and mints operator credentials.
 *
 * Two layers here, because neither alone is enough:
 *
 *   - BEHAVIOURAL. Four real callers are driven with the real hasher and a
 *     recording Prisma, and the parameter block of the string that reached the
 *     database is read back. This is what makes "switch an admin site to the
 *     subscriber set" fail: nothing about the assertion goes through a
 *     constant the mutation could move with it.
 *
 *   - STRUCTURAL. Every `hashPassword(` call in `src/` is enumerated and its
 *     literal audience pinned, and the set of files allowed to contain one is
 *     pinned too. Driving all thirteen sites end to end would need most of a
 *     Nest container; this covers the ones the behavioural layer does not, and
 *     it fails loudly when a NEW mint site appears anywhere in the tree — which
 *     is the moment somebody has to make this decision again.
 */

import 'reflect-metadata';

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { UserRole } from '@prisma/client';

import { AdminAdminsController } from '../src/modules/rbac/controllers/admin-admins.controller';
import { AdminAuthService } from '../src/modules/auth/services/admin-auth.service';
import { AdminUserWebController } from '../src/modules/users/controllers/admin-user-web.controller';
import { PasswordHashService } from '../src/modules/auth/services/password-hash.service';
import { WebAuthService } from '../src/modules/web-auth/services/web-auth.service';

/** Pinned as literals: these are the numbers that land in the database. */
const ADMIN_ROW = { N: 65_536, r: 8, p: 2 } as const;
const SUBSCRIBER_ROW = { N: 16_384, r: 8, p: 5 } as const;

const REQUEST = { headers: {}, ip: null, socket: { remoteAddress: null } } as never;
const ACTOR = {
  id: 'admin-1',
  login: 'operator',
  email: null,
  name: 'Operator',
  role: UserRole.ADMIN,
  isActive: true,
  tokenVersion: 1,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  lastLoginAt: null,
  lastLoginIp: null,
  rbacRoleId: null,
  mustChangePassword: false,
};

interface Row {
  readonly N: number;
  readonly r: number;
  readonly p: number;
}

/** The parameter block as it sits in the string that reached the database. */
function rowOf(passwordHash: unknown): Row {
  assert.equal(typeof passwordHash, 'string', `no hash was written: ${String(passwordHash)}`);
  const parts = String(passwordHash).split('$');
  assert.equal(parts.length, 6, `not a parameterised hash: ${String(passwordHash)}`);
  assert.equal(parts[0], 'scrypt');
  return { N: Number(parts[1]), r: Number(parts[2]), p: Number(parts[3]) };
}

describe('ADMIN mint sites write the admin parameter block', () => {
  it('admin-admins.controller.ts `create` — an operator account', async () => {
    // Called out explicitly because the endpoint lives under the same admin API
    // as the subscriber-credential one below. It mints into `AdminUser`.
    const created: Array<Record<string, unknown>> = [];
    const prisma = {
      adminUser: {
        findUnique: async () => null,
        create: async ({ data }: { data: Record<string, unknown> }) => {
          created.push(data);
          return {
            id: 'created-1',
            login: String(data['login']),
            name: null,
            role: data['role'],
            isActive: true,
            rbacRoleId: null,
            mustChangePassword: false,
            totpEnabled: false,
            lastLoginAt: null,
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
            updatedAt: new Date('2026-01-01T00:00:00.000Z'),
            rbacRole: null,
          };
        },
      },
      adminAuditLog: { create: async () => null },
    };
    const controller = new AdminAdminsController(
      prisma as never,
      new PasswordHashService(),
      { getEffectivePermissionTokens: async () => new Set<string>() } as never,
    );

    await controller.create(
      { username: 'new.operator', password: 'a-long-enough-password', role: UserRole.ADMIN } as never,
      ACTOR,
      REQUEST,
    );

    assert.equal(created.length, 1, 'no admin row was created');
    assert.deepEqual(
      rowOf(created[0]['passwordHash']),
      ADMIN_ROW,
      'a NEW OPERATOR ACCOUNT was minted at the subscriber cost',
    );
  });

  it('admin-auth.service.ts `bootstrapFirstAdmin` — the first DEV account', async () => {
    const created: Array<Record<string, unknown>> = [];
    const profile = {
      id: 'admin-1',
      login: 'root',
      loginNormalized: 'root',
      email: null,
      name: null,
      role: UserRole.DEV,
      isActive: true,
      tokenVersion: 0,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      lastLoginAt: null,
      lastLoginIp: null,
      rbacRoleId: null,
      mustChangePassword: false,
    };
    const prisma = {
      $transaction: async (callback: (client: unknown) => Promise<unknown>) =>
        callback({
          adminUser: {
            count: async () => 0,
            create: async ({ data }: { data: Record<string, unknown> }) => {
              created.push(data);
              return profile;
            },
          },
          adminAuditLog: { create: async () => null },
        }),
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
      prisma as never,
    );

    await service.bootstrapFirstAdmin({
      login: 'root',
      password: 'a-long-enough-password',
      requestMetadata: { requestId: null, remoteAddress: null, userAgent: null },
    } as never);

    assert.equal(created.length, 1, 'no bootstrap admin was created');
    assert.deepEqual(
      rowOf(created[0]['passwordHash']),
      ADMIN_ROW,
      'the bootstrap DEV account was minted at the subscriber cost',
    );
  });
});

describe('SUBSCRIBER mint sites write the subscriber parameter block', () => {
  it('admin-user-web.controller.ts `resetWebPassword` — an admin endpoint, a subscriber credential', async () => {
    // THE CONTESTED SITE. An operator issues the password; a SUBSCRIBER types
    // it, into `WebAuthService.login`, against `web_accounts.password_hash`.
    // The audience follows the credential, not the caller.
    const updates: Array<{ where: unknown; data: Record<string, unknown> }> = [];
    const prisma = {
      user: { findFirst: async () => ({ id: 'user-1', telegramId: BigInt(123456789) }) },
      webAccount: {
        findFirst: async () => ({ id: 'web-account-1', userId: 'user-1', login: 'subscriber' }),
        update: async (args: { where: unknown; data: Record<string, unknown> }) => {
          updates.push(args);
          return { id: 'web-account-1' };
        },
      },
      adminAuditLog: { create: async () => null },
    };
    const controller = new AdminUserWebController(
      prisma as never,
      new PasswordHashService(),
      { set: async () => undefined } as never,
    );

    await controller.resetWebPassword('123456789', ACTOR, REQUEST);

    assert.equal(updates.length, 1, 'no temporary password was written');
    assert.deepEqual(
      rowOf(updates[0].data['passwordHash']),
      SUBSCRIBER_ROW,
      'a SUBSCRIBER temporary password was minted at the operator cost',
    );
  });

  it('web-auth.service.ts `changePassword` — a subscriber rotating their own password', async () => {
    const updates: Array<{ where: unknown; data: Record<string, unknown> }> = [];
    const hasher = new PasswordHashService();
    const stored = await hasher.hashPassword({
      plainTextPassword: 'the-old-password',
      audience: 'subscriber',
    });
    const prisma = {
      webAccount: {
        findUnique: async () => ({ id: 'web-account-1', userId: 'user-1', passwordHash: stored }),
        update: async (args: { where: unknown; data: Record<string, unknown> }) => {
          updates.push(args);
          return { id: 'web-account-1' };
        },
      },
    };
    const service = new WebAuthService(
      prisma as never,
      hasher,
      null as never,
      null as never,
      null as never,
      { del: async () => undefined } as never,
      null as never,
      null as never,
      null as never,
      null as never,
    );

    await service.changePassword({
      userId: 'user-1',
      currentPassword: 'the-old-password',
      newPassword: 'the-new-password',
    } as never);

    assert.equal(updates.length, 1, 'the password was not rotated');
    assert.deepEqual(
      rowOf(updates[0].data['passwordHash']),
      SUBSCRIBER_ROW,
      'a subscriber password rotation minted at the operator cost',
    );
  });
});

// ── The structural layer ─────────────────────────────────────────────────

const SOURCE_ROOT = join(__dirname, '..', 'src');

/**
 * Every mint site in `src/`, with the audience each one is classified as. A
 * verdict per call, in source order — not a count, so swapping two audiences
 * inside one file is caught as readily as changing one.
 */
const EXPECTED_AUDIENCES: Readonly<Record<string, readonly string[]>> = {
  // Operator credentials, all three writing `AdminUser.passwordHash`:
  // bootstrap DEV account, opportunistic re-hash on admin sign-in, rotation.
  'modules/auth/services/admin-auth.service.ts': ['admin', 'admin', 'admin'],
  // Operator credentials: create an admin, and set an admin's password.
  'modules/rbac/controllers/admin-admins.controller.ts': ['admin', 'admin'],
  // Subscriber credential: external-registration finish-setup writes
  // `WebAccount.passwordHash`.
  'modules/external-auth/services/external-auth.service.ts': ['subscriber'],
  // Subscriber credentials, both writing `WebAccount.passwordHash`: the
  // opportunistic re-hash on the linked-web-account sign-in (the SECOND
  // subscriber door — `WebAuthService.login` is the first), and the cabinet
  // setting the user's own web-account password. The sign-in one is reached
  // over the INTERNAL ADMIN API and is still `subscriber`, because the audience
  // follows the credential and the credential is a `WebAccount` row.
  'modules/internal-user/services/internal-user.service.ts': ['subscriber', 'subscriber'],
  // Subscriber credential minted BY an operator — see the behavioural case above.
  'modules/users/controllers/admin-user-web.controller.ts': ['subscriber'],
  // Subscriber credentials: register, claim, claim-on-first-login, the
  // opportunistic re-hash on sign-in, and rotation.
  'modules/web-auth/services/web-auth.service.ts': [
    'subscriber',
    'subscriber',
    'subscriber',
    'subscriber',
    'subscriber',
  ],
};

function listTypeScriptFiles(directory: string, prefix = ''): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      found.push(...listTypeScriptFiles(join(directory, entry.name), relative));
    } else if (entry.name.endsWith('.ts')) {
      found.push(relative);
    }
  }
  return found;
}

/** Audiences of every `hashPassword({ … })` call in a file, in source order. */
function audiencesIn(source: string): { readonly calls: number; readonly audiences: string[] } {
  const audiences: string[] = [];
  let calls = 0;
  let from = 0;
  for (;;) {
    const start = source.indexOf('.hashPassword(', from);
    if (start === -1) break;
    calls += 1;
    from = start + 1;
    const end = source.indexOf('});', start);
    const argument = end === -1 ? source.slice(start) : source.slice(start, end);
    const match = /audience:\s*'([a-z]+)'/.exec(argument);
    if (match !== null) {
      audiences.push(match[1]);
    }
  }
  return { calls, audiences };
}

describe('every mint site in src/ is classified, and only the expected files have one', () => {
  it('pins the audience of each hashPassword call, file by file', () => {
    for (const [relative, expected] of Object.entries(EXPECTED_AUDIENCES)) {
      const source = readFileSync(join(SOURCE_ROOT, relative), 'utf8');
      const { calls, audiences } = audiencesIn(source);

      assert.equal(
        audiences.length,
        calls,
        `${relative}: ${calls} hashPassword call(s) but ${audiences.length} literal audience(s) — ` +
          'a site now passes the audience through a variable, so this pin cannot see it',
      );
      assert.deepEqual(
        audiences,
        expected,
        `${relative}: the audience of a mint site changed. Classify by the ROW written and the ` +
          'LOGIN PATH that verifies it, not by the name of the file.',
      );
    }
  });

  it('fails when a NEW mint site appears anywhere in src/', () => {
    // The point of the whole exercise is that this decision gets made
    // deliberately. A new `hashPassword` call in a file nobody listed here is
    // exactly the moment it is about to be made by accident.
    const withMintSite = listTypeScriptFiles(SOURCE_ROOT)
      .filter((relative) => readFileSync(join(SOURCE_ROOT, relative), 'utf8').includes('.hashPassword('))
      .sort();

    assert.deepEqual(
      withMintSite,
      Object.keys(EXPECTED_AUDIENCES).sort(),
      'a file mints password hashes without a verdict in EXPECTED_AUDIENCES',
    );
  });
});
