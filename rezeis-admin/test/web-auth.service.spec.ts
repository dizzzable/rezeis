import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { PasswordHashService } from '../src/modules/auth/services/password-hash.service';
import { ReferralManualAttachService } from '../src/modules/referrals/services/referral-manual-attach.service';
import { AccessModeGuard } from '../src/modules/settings/services/access-mode-guard.service';
import { WebAuthService } from '../src/modules/web-auth/services/web-auth.service';

describe('WebAuthService', () => {
  it('registers a web-first user with sanitized login, normalized email, and hashed password', async () => {
    const prisma = createPrismaMock();
    const passwordHashService = createPasswordHashServiceMock();
    const service = createService({ prisma, passwordHashService });

    const result = await service.register({
      login: '  Mixed.Login-Name  ',
      password: 'plain-password',
      email: 'User@Example.COM',
    });

    assert.deepStrictEqual(result, { userId: 'user-1', webAccountId: 'web-account-1' });
    assert.equal(prisma.createdUsers.length, 1);
    assert.deepStrictEqual(prisma.createdUsers[0], { name: '', email: 'user@example.com' });
    assert.equal(prisma.createdWebAccounts.length, 1);
    assert.equal(prisma.createdWebAccounts[0].login, 'Mixed.Login-Name');
    assert.equal(prisma.createdWebAccounts[0].loginNormalized, 'mixed.login-name');
    assert.equal(prisma.createdWebAccounts[0].email, 'User@Example.COM');
    assert.equal(prisma.createdWebAccounts[0].emailNormalized, 'user@example.com');
    assert.equal(prisma.createdWebAccounts[0].passwordHash, 'hashed:plain-password');
    assert.equal(prisma.createdWebAccounts[0].requiresPasswordChange, false);
    assert.ok(prisma.createdWebAccounts[0].credentialsBootstrappedAt instanceof Date);
    assert.deepStrictEqual(passwordHashService.hashPasswordCalls, ['plain-password']);
  });

  it('links credentials to an existing Telegram user before creating the web account', async () => {
    const prisma = createPrismaMock({
      usersByTelegramId: new Map([[BigInt(123456789), { id: 'telegram-user-1' }]]),
    });
    const service = createService({ prisma });

    const result = await service.register({
      login: 'telegram-user',
      password: 'plain-password',
      telegramIdToLink: '123456789',
      email: 'tg@example.com',
    });

    assert.deepStrictEqual(result, { userId: 'telegram-user-1', webAccountId: 'web-account-1' });
    assert.equal(prisma.createdUsers.length, 0);
    assert.deepStrictEqual(prisma.userEmailUpdateCalls, [
      { where: { id: 'telegram-user-1', email: null }, data: { email: 'tg@example.com' } },
    ]);
    assert.equal(prisma.createdWebAccounts[0].userId, 'telegram-user-1');
  });

  it('rejects invalid register logins before hashing or starting a transaction', async () => {
    const prisma = createPrismaMock();
    const passwordHashService = createPasswordHashServiceMock();
    const service = createService({ prisma, passwordHashService });

    await assert.rejects(
      () => service.register({ login: 'invalid login', password: 'plain-password' }),
      BadRequestException,
    );

    assert.equal(prisma.transactionCallsCount, 0);
    assert.deepStrictEqual(passwordHashService.hashPasswordCalls, []);
  });

  it('rejects a Telegram link when the bot has not bootstrapped the user yet', async () => {
    const service = createService({ prisma: createPrismaMock() });

    await assert.rejects(
      () =>
        service.register({
          login: 'telegram-user',
          password: 'plain-password',
          telegramIdToLink: '123456789',
        }),
      NotFoundException,
    );
  });

  it('rejects duplicate web accounts on the resolved user', async () => {
    const service = createService({
      prisma: createPrismaMock({ existingWebAccountByUserId: new Map([['user-1', { id: 'existing' }]]) }),
    });

    await assert.rejects(
      () => service.register({ login: 'new-login', password: 'plain-password' }),
      (error: unknown) => error instanceof ConflictException && error.message === 'User already has a web account',
    );
  });

  it('rejects duplicate logins case-insensitively', async () => {
    const service = createService({
      prisma: createPrismaMock({ existingWebAccountByLoginNormalized: new Map([['taken', { id: 'existing' }]]) }),
    });

    await assert.rejects(
      () => service.register({ login: 'TaKeN', password: 'plain-password' }),
      (error: unknown) => error instanceof ConflictException && error.message === 'login is already taken',
    );
  });

  it('claims a web account against an existing user identified by reiwa_id', async () => {
    const prisma = createPrismaMock({ usersById: new Map([['user-1', { id: 'user-1' }]]) });
    const passwordHashService = createPasswordHashServiceMock();
    const service = createService({ prisma, passwordHashService });

    const result = await service.claim({
      userId: 'user-1',
      login: '  Claim.Login  ',
      password: 'plain-password',
    });

    assert.deepStrictEqual(result, { userId: 'user-1', webAccountId: 'web-account-1' });
    assert.equal(prisma.createdUsers.length, 0);
    assert.equal(prisma.createdWebAccounts.length, 1);
    assert.equal(prisma.createdWebAccounts[0].userId, 'user-1');
    assert.equal(prisma.createdWebAccounts[0].login, 'Claim.Login');
    assert.equal(prisma.createdWebAccounts[0].loginNormalized, 'claim.login');
    assert.equal(prisma.createdWebAccounts[0].passwordHash, 'hashed:plain-password');
    assert.equal(prisma.createdWebAccounts[0].requiresPasswordChange, false);
    assert.deepStrictEqual(passwordHashService.hashPasswordCalls, ['plain-password']);
  });

  it('rejects invalid claim logins before hashing or starting a transaction', async () => {
    const prisma = createPrismaMock({ usersById: new Map([['user-1', { id: 'user-1' }]]) });
    const passwordHashService = createPasswordHashServiceMock();
    const service = createService({ prisma, passwordHashService });

    await assert.rejects(
      () => service.claim({ userId: 'user-1', login: 'invalid login', password: 'plain-password' }),
      BadRequestException,
    );

    assert.equal(prisma.transactionCallsCount, 0);
    assert.deepStrictEqual(passwordHashService.hashPasswordCalls, []);
  });

  it('rejects a claim when the resolved user does not exist', async () => {
    const service = createService({ prisma: createPrismaMock() });

    await assert.rejects(
      () => service.claim({ userId: 'missing-user', login: 'claim-login', password: 'plain-password' }),
      (error: unknown) => error instanceof NotFoundException && error.message === 'User not found',
    );
  });

  it('rejects a claim when the user already has a web account', async () => {
    const service = createService({
      prisma: createPrismaMock({
        usersById: new Map([['user-1', { id: 'user-1' }]]),
        existingWebAccountByUserId: new Map([['user-1', { id: 'existing' }]]),
      }),
    });

    await assert.rejects(
      () => service.claim({ userId: 'user-1', login: 'claim-login', password: 'plain-password' }),
      (error: unknown) => error instanceof ConflictException && error.message === 'User already has a web account',
    );
  });

  it('rejects a claim when the login is already taken case-insensitively', async () => {
    const service = createService({
      prisma: createPrismaMock({
        usersById: new Map([['user-1', { id: 'user-1' }]]),
        existingWebAccountByLoginNormalized: new Map([['taken', { id: 'existing' }]]),
      }),
    });

    await assert.rejects(
      () => service.claim({ userId: 'user-1', login: 'TaKeN', password: 'plain-password' }),
      (error: unknown) => error instanceof ConflictException && error.message === 'login is already taken',
    );
  });

  it('consumes referral codes best-effort after successful registration', async () => {
    const prisma = createPrismaMock({ referrersByCode: new Map([['ref-code', { id: 'referrer-1' }]]) });
    const referralManualAttachService = createReferralManualAttachServiceMock();
    const service = createService({ prisma, referralManualAttachService });

    await service.register({ login: 'new-user', password: 'plain-password', referralCode: 'ref-code' });

    assert.deepStrictEqual(prisma.referrerLookupCodes, ['ref-code']);
    assert.deepStrictEqual(referralManualAttachService.attachCalls, [
      { userId: 'user-1', referrerId: 'referrer-1' },
    ]);
  });

  it('checks login availability without creating an account', async () => {
    const prisma = createPrismaMock({ existingWebAccountByLoginNormalized: new Map([['taken', { id: 'existing' }]]) });
    const service = createService({ prisma });

    assert.deepStrictEqual(await service.checkLoginAvailable('taken'), { available: false });
    assert.deepStrictEqual(await service.checkLoginAvailable('free'), { available: true });
    assert.deepStrictEqual(await service.checkLoginAvailable('no spaces'), { available: false });
    assert.equal(prisma.transactionCallsCount, 0);
  });

  it('returns session flags when login credentials match', async () => {
    const service = createService({
      prisma: createPrismaMock({
        loginAccounts: new Map([
          [
            'user-name',
            {
              userId: 'user-1',
              passwordHash: 'hashed:plain-password',
              requiresPasswordChange: true,
              emailVerifiedAt: new Date('2026-06-02T12:00:00.000Z'),
              user: { telegramId: BigInt(123456789) },
            },
          ],
        ]),
      }),
    });

    assert.deepStrictEqual(await service.login({ login: 'USER-NAME', password: 'plain-password' }), {
      userId: 'user-1',
      requiresPasswordChange: true,
      telegramLinked: true,
      emailVerified: true,
    });
  });

  it('claims a migrated web-only account with any password on first login and forces a reset', async () => {
    const passwordHashService = createPasswordHashServiceMock();
    const prisma = createPrismaMock({
      loginAccounts: new Map([
        [
          'migrated',
          {
            id: 'wa-1',
            userId: 'user-9',
            passwordHash: null,
            passwordBootstrapPending: true,
            requiresPasswordChange: true,
            credentialsBootstrappedAt: null,
            emailVerifiedAt: null,
            user: { telegramId: null },
          },
        ],
      ]),
    });
    const service = createService({ prisma, passwordHashService });

    const result = await service.login({ login: 'Migrated', password: 'whatever-they-typed' });

    assert.deepStrictEqual(result, {
      userId: 'user-9',
      requiresPasswordChange: true,
      telegramLinked: false,
      emailVerified: false,
    });
    // The submitted password is adopted; the pending flag is cleared; reset forced.
    assert.equal(prisma.webAccountUpdates.length, 1);
    const data = prisma.webAccountUpdates[0].data as {
      passwordHash: string;
      passwordBootstrapPending: boolean;
      requiresPasswordChange: boolean;
    };
    assert.equal(data.passwordHash, 'hashed:whatever-they-typed');
    assert.equal(data.passwordBootstrapPending, false);
    assert.equal(data.requiresPasswordChange, true);
    assert.deepStrictEqual(passwordHashService.hashPasswordCalls, ['whatever-they-typed']);
  });

  it('does not claim an ordinary null-password account (no pending flag)', async () => {
    const prisma = createPrismaMock({
      loginAccounts: new Map([
        [
          'no-pass',
          {
            id: 'wa-2',
            userId: 'user-2',
            passwordHash: null,
            passwordBootstrapPending: false,
            requiresPasswordChange: false,
            emailVerifiedAt: null,
            user: { telegramId: null },
          },
        ],
      ]),
    });
    const service = createService({ prisma });

    await assertGenericLoginFailure(service, { login: 'no-pass', password: 'anything' });
    assert.equal(prisma.webAccountUpdates.length, 0);
  });

  it('returns the same generic login failure for unknown users, wrong passwords, and invalid logins', async () => {
    const service = createService({
      prisma: createPrismaMock({
        loginAccounts: new Map([
          [
            'known-user',
            {
              userId: 'user-1',
              passwordHash: 'hashed:correct-password',
              requiresPasswordChange: false,
              emailVerifiedAt: null,
              user: { telegramId: null },
            },
          ],
        ]),
      }),
    });

    await assertGenericLoginFailure(service, { login: 'missing-user', password: 'correct-password' });
    await assertGenericLoginFailure(service, { login: 'known-user', password: 'wrong-password' });
    await assertGenericLoginFailure(service, { login: 'bad login', password: 'correct-password' });
  });

  it('resolves recovery channels without leaking unknown accounts', async () => {
    const service = createService({
      prisma: createPrismaMock({
        recoveryAccounts: new Map([
          ['telegram-user', { email: null, emailVerifiedAt: null, user: { telegramId: BigInt(1) } }],
          [
            'email-user',
            { email: 'user@example.com', emailVerifiedAt: new Date('2026-06-02T12:00:00.000Z'), user: { telegramId: null } },
          ],
          ['bare-user', { email: 'user@example.com', emailVerifiedAt: null, user: { telegramId: null } }],
        ]),
      }),
    });

    assert.deepStrictEqual(await service.recover({ login: 'telegram-user' }), { method: 'telegram' });
    assert.deepStrictEqual(await service.recover({ login: 'email-user' }), { method: 'email' });
    assert.deepStrictEqual(await service.recover({ login: 'bare-user' }), { method: 'none' });
    assert.deepStrictEqual(await service.recover({ login: 'missing-user' }), { method: 'none' });
  });

  it('changes a password after verifying the current password', async () => {
    const prisma = createPrismaMock({
      accountsByUserId: new Map([
        [
          'user-1',
          {
            id: 'web-account-1',
            passwordHash: 'hashed:old-password',
          },
        ],
      ]),
    });
    const service = createService({ prisma });

    assert.deepStrictEqual(
      await service.changePassword({
        userId: 'user-1',
        currentPassword: 'old-password',
        newPassword: 'new-password',
      }),
      { success: true },
    );
    assert.deepStrictEqual(prisma.webAccountUpdates, [
      {
        where: { id: 'web-account-1' },
        data: {
          passwordHash: 'hashed:new-password',
          requiresPasswordChange: false,
          temporaryPasswordExpiresAt: null,
        },
      },
    ]);
  });

  it('clears the cached temporary password when the user changes their password', async () => {
    const prisma = createPrismaMock({
      accountsByUserId: new Map([
        ['user-1', { id: 'web-account-1', passwordHash: 'hashed:old-password' }],
      ]),
    });
    const delCalls: string[] = [];
    const cacheService = {
      set: async () => undefined,
      get: async () => null,
      del: async (key: string) => {
        delCalls.push(key);
      },
    };
    const service = createService({ prisma, cacheService });

    await service.changePassword({
      userId: 'user-1',
      currentPassword: 'old-password',
      newPassword: 'new-password',
    });

    assert.deepStrictEqual(delCalls, ['web-auth:temp-password:web-account-1']);
  });

  it('rejects password changes for missing accounts and wrong current passwords', async () => {
    const service = createService({
      prisma: createPrismaMock({
        accountsByUserId: new Map([
          ['user-1', { id: 'web-account-1', passwordHash: 'hashed:old-password' }],
          ['passwordless-user', { id: 'web-account-2', passwordHash: null }],
        ]),
      }),
    });

    await assert.rejects(
      () =>
        service.changePassword({
          userId: 'missing-user',
          currentPassword: 'old-password',
          newPassword: 'new-password',
        }),
      NotFoundException,
    );
    await assert.rejects(
      () =>
        service.changePassword({
          userId: 'passwordless-user',
          currentPassword: 'old-password',
          newPassword: 'new-password',
        }),
      NotFoundException,
    );
    await assert.rejects(
      () =>
        service.changePassword({
          userId: 'user-1',
          currentPassword: 'wrong-password',
          newPassword: 'new-password',
        }),
      (error: unknown) => error instanceof UnauthorizedException && error.message === 'Invalid current password',
    );
  });

  // ── Access-mode wiring (real AccessModeGuard) ──────────────────────────────
  // Integration coverage for Task 36: register must consult the platform
  // access mode through the wired guard and reject per the matrix.

  it('register passes under PUBLIC with the real guard', async () => {
    const service = createService({ accessMode: 'PUBLIC' });
    const result = await service.register({ login: 'pubuser', password: 'plain-password' });
    assert.deepStrictEqual(result, { userId: 'user-1', webAccountId: 'web-account-1' });
  });

  it('register rejects under REG_BLOCKED with 403 REGISTRATION_DISABLED', async () => {
    const service = createService({ accessMode: 'REG_BLOCKED' });
    await assert.rejects(
      () => service.register({ login: 'newuser', password: 'plain-password' }),
      (error: unknown) =>
        error instanceof ForbiddenException &&
        (error.getResponse() as { code?: string }).code === 'REGISTRATION_DISABLED',
    );
  });

  it('register rejects under RESTRICTED with 503 SERVICE_RESTRICTED', async () => {
    const service = createService({ accessMode: 'RESTRICTED' });
    await assert.rejects(
      () => service.register({ login: 'newuser', password: 'plain-password' }),
      (error: unknown) =>
        error instanceof ServiceUnavailableException &&
        (error.getResponse() as { code?: string }).code === 'SERVICE_RESTRICTED',
    );
  });

  it('register under INVITED requires a referral code (INVITE_REQUIRED without one)', async () => {
    const service = createService({ accessMode: 'INVITED' });
    await assert.rejects(
      () => service.register({ login: 'newuser', password: 'plain-password' }),
      (error: unknown) =>
        error instanceof ForbiddenException &&
        (error.getResponse() as { code?: string }).code === 'INVITE_REQUIRED',
    );
  });

  it('register passes under PURCHASE_BLOCKED (registration unaffected)', async () => {
    const service = createService({ accessMode: 'PURCHASE_BLOCKED' });
    const result = await service.register({ login: 'pbuser', password: 'plain-password' });
    assert.deepStrictEqual(result, { userId: 'user-1', webAccountId: 'web-account-1' });
  });

  // ── telegramClaim — self-service Mini App account link ─────────────────────

  it('telegramClaim links a free Telegram id to the existing account', async () => {
    const { prisma, userUpdates, userDeletes } = createTelegramClaimPrismaMock({
      loginNormalized: 'web-user',
      account: { userId: 'A', passwordHash: 'hashed:plain-password' },
      targetUser: { id: 'A', telegramId: null },
      telegramOwner: null,
    });
    const service = createService({ prisma });

    const result = await service.telegramClaim({ telegramId: '123', login: 'Web-User', password: 'plain-password' });

    assert.deepStrictEqual(result, { status: 'linked', userId: 'A' });
    assert.equal(userDeletes.length, 0);
    assert.deepStrictEqual(userUpdates, [{ where: { id: 'A' }, data: { telegramId: BigInt(123) } }]);
  });

  it('telegramClaim is idempotent when the Telegram id is already on the account', async () => {
    const { prisma, userUpdates } = createTelegramClaimPrismaMock({
      loginNormalized: 'web-user',
      account: { userId: 'A', passwordHash: 'hashed:plain-password' },
      targetUser: { id: 'A', telegramId: BigInt(123) },
      telegramOwner: { id: 'A' },
    });
    const service = createService({ prisma });

    const result = await service.telegramClaim({ telegramId: '123', login: 'web-user', password: 'plain-password' });

    assert.deepStrictEqual(result, { status: 'already_linked', userId: 'A' });
    assert.equal(userUpdates.length, 0);
  });

  it('telegramClaim refuses when the account already has a different Telegram linked', async () => {
    const { prisma } = createTelegramClaimPrismaMock({
      loginNormalized: 'web-user',
      account: { userId: 'A', passwordHash: 'hashed:plain-password' },
      targetUser: { id: 'A', telegramId: BigInt(999) },
    });
    const service = createService({ prisma });

    const result = await service.telegramClaim({ telegramId: '123', login: 'web-user', password: 'plain-password' });

    assert.deepStrictEqual(result, { status: 'web_account_has_other_telegram' });
  });

  it('telegramClaim retires an empty shell and links the Telegram id to the account', async () => {
    const { prisma, userUpdates, userDeletes } = createTelegramClaimPrismaMock({
      loginNormalized: 'web-user',
      account: { userId: 'A', passwordHash: 'hashed:plain-password' },
      targetUser: { id: 'A', telegramId: null },
      telegramOwner: { id: 'B' },
      shellEmpty: true,
    });
    const service = createService({ prisma });

    const result = await service.telegramClaim({ telegramId: '123', login: 'web-user', password: 'plain-password' });

    assert.deepStrictEqual(result, { status: 'linked', userId: 'A' });
    assert.deepStrictEqual(userDeletes, ['B']);
    assert.deepStrictEqual(userUpdates, [
      { where: { id: 'B' }, data: { telegramId: null } },
      { where: { id: 'A' }, data: { telegramId: BigInt(123) } },
    ]);
  });

  it('telegramClaim refuses to merge a Telegram account that has material data', async () => {
    const { prisma, userDeletes } = createTelegramClaimPrismaMock({
      loginNormalized: 'web-user',
      account: { userId: 'A', passwordHash: 'hashed:plain-password' },
      targetUser: { id: 'A', telegramId: null },
      telegramOwner: { id: 'B' },
      shellEmpty: false,
    });
    const service = createService({ prisma });

    const result = await service.telegramClaim({ telegramId: '123', login: 'web-user', password: 'plain-password' });

    assert.deepStrictEqual(result, { status: 'needs_admin_merge' });
    assert.equal(userDeletes.length, 0);
  });

  it('telegramClaim returns a generic failure on wrong password or unknown login', async () => {
    const wrongPw = createTelegramClaimPrismaMock({
      loginNormalized: 'web-user',
      account: { userId: 'A', passwordHash: 'hashed:correct-password' },
      targetUser: { id: 'A', telegramId: null },
    });
    const wrongService = createService({ prisma: wrongPw.prisma });
    await assert.rejects(
      () => wrongService.telegramClaim({ telegramId: '123', login: 'web-user', password: 'wrong-password' }),
      (error: unknown) => error instanceof UnauthorizedException && error.message === 'Invalid login or password',
    );

    const unknown = createTelegramClaimPrismaMock({ loginNormalized: 'web-user', account: null });
    const unknownService = createService({ prisma: unknown.prisma });
    await assert.rejects(
      () => unknownService.telegramClaim({ telegramId: '123', login: 'missing', password: 'whatever-pw' }),
      (error: unknown) => error instanceof UnauthorizedException && error.message === 'Invalid login or password',
    );
  });
});

interface CreatePrismaMockOptions {
  readonly usersByTelegramId?: Map<bigint, { readonly id: string }>;
  readonly usersById?: Map<string, { readonly id: string }>;
  readonly existingWebAccountByUserId?: Map<string, { readonly id: string }>;
  readonly existingWebAccountByLoginNormalized?: Map<string, { readonly id: string }>;
  readonly loginAccounts?: Map<string, LoginAccountRecord>;
  readonly recoveryAccounts?: Map<string, RecoveryAccountRecord>;
  readonly accountsByUserId?: Map<string, ChangePasswordAccountRecord>;
  readonly referrersByCode?: Map<string, { readonly id: string }>;
}

interface LoginAccountRecord {
  readonly userId: string;
  readonly passwordHash: string | null;
  readonly requiresPasswordChange: boolean;
  readonly emailVerifiedAt: Date | null;
  readonly user: { readonly telegramId: bigint | null };
}

interface RecoveryAccountRecord {
  readonly email: string | null;
  readonly emailVerifiedAt: Date | null;
  readonly user: { readonly telegramId: bigint | null };
}

interface ChangePasswordAccountRecord {
  readonly id: string;
  readonly passwordHash: string | null;
}

interface CreatedWebAccountRecord {
  readonly userId: string;
  readonly login: string;
  readonly loginNormalized: string;
  readonly email: string | null;
  readonly emailNormalized: string | null;
  readonly passwordHash: string;
  readonly requiresPasswordChange: boolean;
  readonly credentialsBootstrappedAt: Date;
}

interface PrismaMock extends PrismaService {
  readonly createdUsers: Array<{ readonly name: string; readonly email: string | null }>;
  readonly createdWebAccounts: CreatedWebAccountRecord[];
  readonly userEmailUpdateCalls: Array<{ readonly where: unknown; readonly data: unknown }>;
  readonly webAccountUpdates: Array<{ readonly where: unknown; readonly data: unknown }>;
  readonly referrerLookupCodes: string[];
  readonly transactionCallsCount: number;
}

interface PasswordHashServiceMock extends PasswordHashService {
  readonly hashPasswordCalls: string[];
}

interface ReferralManualAttachServiceMock extends ReferralManualAttachService {
  readonly attachCalls: Array<{ readonly userId: string; readonly referrerId: string }>;
}

function createService(options: {
  readonly prisma?: PrismaMock;
  readonly passwordHashService?: PasswordHashServiceMock;
  readonly referralManualAttachService?: ReferralManualAttachServiceMock;
  /** When set, drives the real AccessModeGuard with this platform mode. */
  readonly accessMode?: 'PUBLIC' | 'INVITED' | 'PURCHASE_BLOCKED' | 'REG_BLOCKED' | 'RESTRICTED';
  /** Optional cache stub to observe temp-password clearing on change. */
  readonly cacheService?: { set: (...a: unknown[]) => Promise<void>; get: (...a: unknown[]) => Promise<unknown>; del: (...a: unknown[]) => Promise<void> };
} = {}): WebAuthService {
  // Stub SettingsService → returns the requested mode (PUBLIC by default, so
  // the gate is a no-op for the existing unit tests). When `accessMode` is
  // supplied we wire the REAL AccessModeGuard for a true wiring test;
  // otherwise a no-op evaluator keeps legacy tests fast.
  const mode = options.accessMode ?? 'PUBLIC';
  const settingsService = {
    getInternalPlatformPolicy: async () => ({ accessMode: mode as never }),
  };
  const accessModeGuard =
    options.accessMode === undefined ? { evaluate: () => null } : new AccessModeGuard();
  const cacheService = options.cacheService ?? { set: async () => undefined, get: async () => null, del: async () => undefined };
  const systemEventsService = { info: () => undefined, warn: () => undefined, error: () => undefined, emit: () => undefined };
  const emailDeliveryService = { getSmtpSettings: async () => ({ enabled: true, host: 'smtp.example.com' }) };
  const registrationSnapshotService = {
    captureBestEffort: async () => undefined,
  };
  return new WebAuthService(
    options.prisma ?? createPrismaMock(),
    options.passwordHashService ?? createPasswordHashServiceMock(),
    options.referralManualAttachService ?? createReferralManualAttachServiceMock(),
    settingsService as never,
    accessModeGuard as never,
    cacheService as never,
    systemEventsService as never,
    emailDeliveryService as never,
    registrationSnapshotService as never,
  );
}

function createPrismaMock(options: CreatePrismaMockOptions = {}): PrismaMock {
  const createdUsers: Array<{ name: string; email: string | null }> = [];
  const createdWebAccounts: CreatedWebAccountRecord[] = [];
  const userEmailUpdateCalls: Array<{ where: unknown; data: unknown }> = [];
  const webAccountUpdates: Array<{ where: unknown; data: unknown }> = [];
  const referrerLookupCodes: string[] = [];
  let transactionCallsCount = 0;

  const tx = {
    user: {
      findUnique: async (args: {
        readonly where: { readonly telegramId?: bigint; readonly id?: string };
      }) => {
        if (args.where.id !== undefined) {
          return options.usersById?.get(args.where.id) ?? null;
        }
        if (args.where.telegramId !== undefined) {
          return options.usersByTelegramId?.get(args.where.telegramId) ?? null;
        }
        return null;
      },
      updateMany: async (args: { readonly where: unknown; readonly data: unknown }) => {
        userEmailUpdateCalls.push(args);
        return { count: 1 };
      },
      create: async (args: { readonly data: { readonly name: string; readonly email: string | null } }) => {
        createdUsers.push(args.data);
        return { id: `user-${createdUsers.length}` };
      },
    },
    webAccount: {
      findUnique: async (args: { readonly where: { readonly userId?: string; readonly loginNormalized?: string } }) => {
        if (args.where.userId !== undefined) {
          return options.existingWebAccountByUserId?.get(args.where.userId) ?? null;
        }
        if (args.where.loginNormalized !== undefined) {
          return options.existingWebAccountByLoginNormalized?.get(args.where.loginNormalized) ?? null;
        }
        return null;
      },
      create: async (args: { readonly data: CreatedWebAccountRecord }) => {
        createdWebAccounts.push(args.data);
        return { id: `web-account-${createdWebAccounts.length}` };
      },
    },
  };

  const prisma = {
    get createdUsers() {
      return createdUsers;
    },
    get createdWebAccounts() {
      return createdWebAccounts;
    },
    get userEmailUpdateCalls() {
      return userEmailUpdateCalls;
    },
    get webAccountUpdates() {
      return webAccountUpdates;
    },
    get referrerLookupCodes() {
      return referrerLookupCodes;
    },
    get transactionCallsCount() {
      return transactionCallsCount;
    },
    $transaction: async <T>(callback: (transaction: typeof tx) => Promise<T>): Promise<T> => {
      transactionCallsCount += 1;
      return callback(tx);
    },
    user: {
      findFirst: async (args: { readonly where: { readonly OR: Array<Record<string, unknown>> } }) => {
        const codes = args.where.OR.flatMap((condition) => Object.values(condition).map(String));
        referrerLookupCodes.push(codes[0]);
        for (const code of codes) {
          const referrer = options.referrersByCode?.get(code);
          if (referrer !== undefined) {
            return referrer;
          }
        }
        return null;
      },
    },
    webAccount: {
      findUnique: async (args: { readonly where: { readonly loginNormalized?: string; readonly userId?: string } }) => {
        if (args.where.loginNormalized !== undefined) {
          return (
            options.loginAccounts?.get(args.where.loginNormalized) ??
            options.recoveryAccounts?.get(args.where.loginNormalized) ??
            options.existingWebAccountByLoginNormalized?.get(args.where.loginNormalized) ??
            null
          );
        }
        if (args.where.userId !== undefined) {
          return options.accountsByUserId?.get(args.where.userId) ?? null;
        }
        return null;
      },
      update: async (args: { readonly where: unknown; readonly data: unknown }) => {
        webAccountUpdates.push(args);
        return { id: 'web-account-1' };
      },
    },
  };

  return prisma as unknown as PrismaMock;
}

function createPasswordHashServiceMock(): PasswordHashServiceMock {
  const hashPasswordCalls: string[] = [];
  return {
    get hashPasswordCalls() {
      return hashPasswordCalls;
    },
    hashPassword: async (input: { readonly plainTextPassword: string }): Promise<string> => {
      hashPasswordCalls.push(input.plainTextPassword);
      return `hashed:${input.plainTextPassword}`;
    },
    verifyPassword: async (input: {
      readonly plainTextPassword: string;
      readonly passwordHash: string;
    }): Promise<boolean> => input.passwordHash === `hashed:${input.plainTextPassword}`,
  } as PasswordHashServiceMock;
}

function createReferralManualAttachServiceMock(): ReferralManualAttachServiceMock {
  const attachCalls: Array<{ userId: string; referrerId: string }> = [];
  return {
    get attachCalls() {
      return attachCalls;
    },
    attachReferrerManually: async (input: { readonly userId: string; readonly referrerId: string }) => {
      attachCalls.push(input);
      return { attached: true };
    },
  } as unknown as ReferralManualAttachServiceMock;
}

async function assertGenericLoginFailure(
  service: WebAuthService,
  input: { readonly login: string; readonly password: string },
): Promise<void> {
  await assert.rejects(
    () => service.login(input),
    (error: unknown) => error instanceof UnauthorizedException && error.message === 'Invalid login or password',
  );
}

/**
 * Focused Prisma stub for `telegramClaim` — covers only the surface that method
 * touches (credential lookup, target/owner resolution, empty-shell counts,
 * user update/delete) and records the user.update / user.delete calls.
 */
function createTelegramClaimPrismaMock(opts: {
  readonly loginNormalized?: string;
  readonly account?: { readonly userId: string; readonly passwordHash: string | null } | null;
  readonly targetUser?: { readonly id: string; readonly telegramId: bigint | null };
  readonly telegramOwner?: { readonly id: string } | null;
  readonly shellEmpty?: boolean;
}): {
  readonly prisma: PrismaMock;
  readonly userUpdates: Array<{ where: unknown; data: unknown }>;
  readonly userDeletes: string[];
} {
  const userUpdates: Array<{ where: unknown; data: unknown }> = [];
  const userDeletes: string[] = [];
  const empty = opts.shellEmpty !== false; // default: empty shell
  const tx = {
    webAccount: {
      findUnique: async (args: { readonly where: { readonly loginNormalized?: string; readonly userId?: string } }) => {
        if (args.where.loginNormalized !== undefined) {
          return opts.account && args.where.loginNormalized === opts.loginNormalized
            ? opts.account
            : null;
        }
        return null; // isEmptyShell: a shell has no web account
      },
    },
    user: {
      findUnique: async (args: { readonly where: { readonly id?: string; readonly telegramId?: bigint } }) => {
        if (args.where.id !== undefined) {
          if (opts.targetUser && args.where.id === opts.targetUser.id) return opts.targetUser;
          if (opts.telegramOwner && args.where.id === opts.telegramOwner.id) return { id: opts.telegramOwner.id };
          return null;
        }
        if (args.where.telegramId !== undefined) {
          return opts.telegramOwner ?? null;
        }
        return null;
      },
      update: async (args: { readonly where: unknown; readonly data: unknown }) => {
        userUpdates.push(args);
        return { id: 'updated' };
      },
      delete: async (args: { readonly where: { readonly id: string } }) => {
        userDeletes.push(args.where.id);
        return { id: args.where.id };
      },
    },
    transaction: { count: async () => (empty ? 0 : 1) },
    partner: { findUnique: async () => null },
    subscription: { count: async () => 0 },
    referralReward: { count: async () => 0 },
    promocodeActivation: { count: async () => 0 },
    partnerTransaction: { count: async () => 0 },
    partnerReferral: { count: async () => 0 },
    referral: { count: async () => 0 },
  };
  const prisma = {
    $transaction: async <T>(callback: (transaction: typeof tx) => Promise<T>): Promise<T> => callback(tx),
  };
  return { prisma: prisma as unknown as PrismaMock, userUpdates, userDeletes };
}
