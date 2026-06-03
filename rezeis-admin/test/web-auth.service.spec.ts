import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { PasswordHashService } from '../src/modules/auth/services/password-hash.service';
import { ReferralManualAttachService } from '../src/modules/referrals/services/referral-manual-attach.service';
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
});

interface CreatePrismaMockOptions {
  readonly usersByTelegramId?: Map<bigint, { readonly id: string }>;
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
} = {}): WebAuthService {
  return new WebAuthService(
    options.prisma ?? createPrismaMock(),
    options.passwordHashService ?? createPasswordHashServiceMock(),
    options.referralManualAttachService ?? createReferralManualAttachServiceMock(),
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
      findUnique: async (args: { readonly where: { readonly telegramId: bigint } }) =>
        options.usersByTelegramId?.get(args.where.telegramId) ?? null,
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
