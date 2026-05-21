import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ConflictException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';

import { WebAuthService } from '../src/modules/web-auth/web-auth.service';

// Mock dependencies for the new constructor parameters
const mockCache = {
  get: async () => null,
  set: async () => {},
  del: async () => {},
  exists: async () => false,
} as any;

const mockTelegramNotify = {
  sendToUser: async () => true,
  sendToAdmin: async () => {},
} as any;

const mockConfigService = {
  get: () => null,
} as any;

const mockWebRegistrationSettings = {
  getFullSettings: async () => ({ enabled: true, recoveryConfirmMode: 'automatic', updatedAt: new Date() }),
} as any;

function createService(mockPrisma: any): InstanceType<typeof WebAuthService> {
  return new WebAuthService(
    mockPrisma,
    mockCache,
    mockTelegramNotify,
    mockConfigService,
    mockWebRegistrationSettings,
  );
}

function buildMockPrisma(options: {
  registrationEnabled?: boolean;
  settingExists?: boolean;
  usernameExists?: boolean;
} = {}) {
  const { registrationEnabled = true, settingExists = true, usernameExists = false } = options;

  let createdUser: any = null;
  let createdWebAccount: any = null;

  const txProxy = {
    user: {
      create: async (args: any) => {
        createdUser = {
          id: 1,
          telegramId: args.data.telegramId,
          name: args.data.name,
          username: args.data.username,
          referralCode: args.data.referralCode,
          role: args.data.role,
          language: args.data.language,
        };
        return createdUser;
      },
    },
    webAccount: {
      create: async (args: any) => {
        createdWebAccount = {
          uuid: 'web-account-uuid-123',
          userId: args.data.userId,
          username: args.data.username,
          passwordHash: args.data.passwordHash,
        };
        return createdWebAccount;
      },
    },
  };

  return {
    webRegistrationSetting: {
      findFirst: async () => settingExists ? { id: 1, enabled: registrationEnabled } : null,
    },
    webAccount: {
      findUnique: async (_args: any) => usernameExists ? { uuid: 'existing-uuid' } : null,
    },
    $transaction: async (fn: (tx: any) => Promise<any>) => fn(txProxy),
    _getCreatedUser: () => createdUser,
    _getCreatedWebAccount: () => createdWebAccount,
  };
}

describe('WebAuthService', () => {
  it('successfully registers a new user when toggle is enabled and username is available', async () => {
    const mockPrisma = buildMockPrisma({ registrationEnabled: true, usernameExists: false });
    const service = createService(mockPrisma);

    const result = await service.register({
      username: 'new-user',
      passwordHash: 'a'.repeat(64),
    });

    assert.ok(result.userId, 'Expected userId to be returned');
    assert.ok(result.webAccountId, 'Expected webAccountId to be returned');
    assert.equal(result.userId, 'web-account-uuid-123');
    assert.equal(result.webAccountId, 'web-account-uuid-123');
  });

  it('throws ForbiddenException when registration toggle is disabled', async () => {
    const mockPrisma = buildMockPrisma({ registrationEnabled: false });
    const service = createService(mockPrisma);

    await assert.rejects(
      () => service.register({ username: 'test-user', passwordHash: 'a'.repeat(64) }),
      (err: any) => {
        assert.ok(err instanceof ForbiddenException);
        return true;
      },
    );
  });

  it('throws ForbiddenException when registration setting does not exist (fresh install)', async () => {
    const mockPrisma = buildMockPrisma({ settingExists: false });
    const service = createService(mockPrisma);

    await assert.rejects(
      () => service.register({ username: 'test-user', passwordHash: 'a'.repeat(64) }),
      (err: any) => {
        assert.ok(err instanceof ForbiddenException);
        return true;
      },
    );
  });

  it('throws ConflictException when username already exists', async () => {
    const mockPrisma = buildMockPrisma({ registrationEnabled: true, usernameExists: true });
    const service = createService(mockPrisma);

    await assert.rejects(
      () => service.register({ username: 'taken-user', passwordHash: 'b'.repeat(64) }),
      (err: any) => {
        assert.ok(err instanceof ConflictException);
        return true;
      },
    );
  });

  it('hashes the password with bcrypt before storing', async () => {
    const mockPrisma = buildMockPrisma({ registrationEnabled: true, usernameExists: false });
    const service = createService(mockPrisma);

    await service.register({
      username: 'hash-test',
      passwordHash: 'c'.repeat(64),
    });

    const createdWebAccount = mockPrisma._getCreatedWebAccount();
    assert.ok(createdWebAccount, 'Expected web account to be created');
    // bcrypt hashes start with $2a$ or $2b$
    assert.ok(
      createdWebAccount.passwordHash.startsWith('$2'),
      `Expected bcrypt hash, got: ${createdWebAccount.passwordHash.substring(0, 10)}...`,
    );
    // The stored hash should NOT be the raw SHA-256 input
    assert.notEqual(createdWebAccount.passwordHash, 'c'.repeat(64));
  });

  it('creates User and WebAccount in a transaction', async () => {
    const mockPrisma = buildMockPrisma({ registrationEnabled: true, usernameExists: false });
    const service = createService(mockPrisma);

    await service.register({
      username: 'tx-test',
      passwordHash: 'd'.repeat(64),
    });

    const createdUser = mockPrisma._getCreatedUser();
    const createdWebAccount = mockPrisma._getCreatedWebAccount();

    assert.ok(createdUser, 'Expected user to be created');
    assert.ok(createdWebAccount, 'Expected web account to be created');
    assert.equal(createdUser.username, 'tx-test');
    assert.equal(createdWebAccount.username, 'tx-test');
    // WebAccount.userId should reference the User's telegramId
    assert.equal(createdWebAccount.userId, createdUser.telegramId);
  });
});

describe('WebAuthService — login', () => {
  const validPasswordHash = 'a'.repeat(64);

  function buildLoginMockPrisma(options: {
    accountExists?: boolean;
    storedHash?: string;
    telegramId?: bigint | null;
    emailVerified?: boolean;
    requiresPasswordChange?: boolean;
  } = {}) {
    const {
      accountExists = true,
      storedHash = '',
      telegramId = null,
      emailVerified = false,
      requiresPasswordChange = false,
    } = options;

    return {
      webAccount: {
        findUnique: async () =>
          accountExists
            ? {
                uuid: 'user-uuid-1',
                username: 'test-user',
                passwordHash: storedHash,
                requiresPasswordChange,
                telegramId,
                emailVerified,
              }
            : null,
      },
    };
  }

  it('returns user info on successful login with correct credentials', async () => {
    const storedHash = await bcrypt.hash(validPasswordHash, 10);
    const mockPrisma = buildLoginMockPrisma({
      accountExists: true,
      storedHash,
      telegramId: BigInt(123456),
      emailVerified: true,
      requiresPasswordChange: false,
    });
    const service = createService(mockPrisma);

    const result = await service.login(
      { username: 'test-user', passwordHash: validPasswordHash },
      '192.168.1.1',
    );

    assert.equal(result.userId, 'user-uuid-1');
    assert.equal(result.requiresPasswordChange, false);
    assert.equal(result.telegramLinked, true);
    assert.equal(result.emailVerified, true);
  });

  it('throws UnauthorizedException when username does not exist', async () => {
    const mockPrisma = buildLoginMockPrisma({ accountExists: false });
    const service = createService(mockPrisma);

    await assert.rejects(
      () => service.login({ username: 'nonexistent', passwordHash: validPasswordHash }, '10.0.0.1'),
      (err: any) => {
        assert.ok(err instanceof UnauthorizedException);
        assert.equal(err.message, 'Invalid credentials');
        return true;
      },
    );
  });

  it('throws UnauthorizedException when password hash does not match', async () => {
    const storedHash = await bcrypt.hash('b'.repeat(64), 10);
    const mockPrisma = buildLoginMockPrisma({ accountExists: true, storedHash });
    const service = createService(mockPrisma);

    await assert.rejects(
      () => service.login({ username: 'test-user', passwordHash: validPasswordHash }, '10.0.0.1'),
      (err: any) => {
        assert.ok(err instanceof UnauthorizedException);
        assert.equal(err.message, 'Invalid credentials');
        return true;
      },
    );
  });

  it('returns same generic error for wrong username and wrong password (no distinction)', async () => {
    const storedHash = await bcrypt.hash(validPasswordHash, 10);

    // Wrong username
    const mockPrismaNoUser = buildLoginMockPrisma({ accountExists: false });
    const serviceNoUser = createService(mockPrismaNoUser);

    let errorNoUser: any;
    try {
      await serviceNoUser.login({ username: 'wrong-user', passwordHash: validPasswordHash }, '10.0.0.1');
    } catch (e) {
      errorNoUser = e;
    }

    // Wrong password
    const mockPrismaBadPw = buildLoginMockPrisma({ accountExists: true, storedHash });
    const serviceBadPw = createService(mockPrismaBadPw);

    let errorBadPw: any;
    try {
      await serviceBadPw.login({ username: 'test-user', passwordHash: 'f'.repeat(64) }, '10.0.0.1');
    } catch (e) {
      errorBadPw = e;
    }

    // Both errors should be identical in type and message
    assert.ok(errorNoUser instanceof UnauthorizedException);
    assert.ok(errorBadPw instanceof UnauthorizedException);
    assert.equal(errorNoUser.message, errorBadPw.message);
  });

  it('returns telegramLinked=false when telegramId is null', async () => {
    const storedHash = await bcrypt.hash(validPasswordHash, 10);
    const mockPrisma = buildLoginMockPrisma({
      accountExists: true,
      storedHash,
      telegramId: null,
    });
    const service = createService(mockPrisma);

    const result = await service.login(
      { username: 'test-user', passwordHash: validPasswordHash },
      '192.168.1.1',
    );

    assert.equal(result.telegramLinked, false);
  });

  it('returns requiresPasswordChange=true when account requires password change', async () => {
    const storedHash = await bcrypt.hash(validPasswordHash, 10);
    const mockPrisma = buildLoginMockPrisma({
      accountExists: true,
      storedHash,
      requiresPasswordChange: true,
    });
    const service = createService(mockPrisma);

    const result = await service.login(
      { username: 'test-user', passwordHash: validPasswordHash },
      '192.168.1.1',
    );

    assert.equal(result.requiresPasswordChange, true);
  });
});

describe('WebAuthService — changePassword', () => {
  const currentPasswordHash = 'a'.repeat(64);
  const newPasswordHash = 'b'.repeat(64);

  function buildChangePasswordMockPrisma(options: {
    accountExists?: boolean;
    storedHash?: string;
    requiresPasswordChange?: boolean;
  } = {}) {
    const {
      accountExists = true,
      storedHash = '',
      requiresPasswordChange = true,
    } = options;

    let updatedData: any = null;

    return {
      webAccount: {
        findUnique: async () =>
          accountExists
            ? {
                uuid: 'user-uuid-1',
                username: 'test-user',
                passwordHash: storedHash,
                requiresPasswordChange,
                telegramId: null,
                emailVerified: false,
              }
            : null,
        update: async (args: any) => {
          updatedData = args.data;
          return { ...args.data, uuid: args.where.uuid };
        },
      },
      _getUpdatedData: () => updatedData,
    };
  }

  it('successfully changes password when current password is correct', async () => {
    const storedHash = await bcrypt.hash(currentPasswordHash, 10);
    const mockPrisma = buildChangePasswordMockPrisma({
      accountExists: true,
      storedHash,
      requiresPasswordChange: true,
    });
    const service = createService(mockPrisma);

    const result = await service.changePassword({
      userId: 'user-uuid-1',
      currentPasswordHash,
      newPasswordHash,
    });

    assert.deepEqual(result, { success: true });
  });

  it('sets requiresPasswordChange to false after password change', async () => {
    const storedHash = await bcrypt.hash(currentPasswordHash, 10);
    const mockPrisma = buildChangePasswordMockPrisma({
      accountExists: true,
      storedHash,
      requiresPasswordChange: true,
    });
    const service = createService(mockPrisma);

    await service.changePassword({
      userId: 'user-uuid-1',
      currentPasswordHash,
      newPasswordHash,
    });

    const updatedData = mockPrisma._getUpdatedData();
    assert.equal(updatedData.requiresPasswordChange, false);
  });

  it('stores the new password as a bcrypt hash', async () => {
    const storedHash = await bcrypt.hash(currentPasswordHash, 10);
    const mockPrisma = buildChangePasswordMockPrisma({
      accountExists: true,
      storedHash,
    });
    const service = createService(mockPrisma);

    await service.changePassword({
      userId: 'user-uuid-1',
      currentPasswordHash,
      newPasswordHash,
    });

    const updatedData = mockPrisma._getUpdatedData();
    assert.ok(updatedData.passwordHash.startsWith('$2'), 'Expected bcrypt hash');
    // Verify the new hash matches the new password
    const matches = await bcrypt.compare(newPasswordHash, updatedData.passwordHash);
    assert.ok(matches, 'New password hash should verify against the new password');
  });

  it('throws UnauthorizedException when user does not exist', async () => {
    const mockPrisma = buildChangePasswordMockPrisma({ accountExists: false });
    const service = createService(mockPrisma);

    await assert.rejects(
      () => service.changePassword({
        userId: 'nonexistent-uuid',
        currentPasswordHash,
        newPasswordHash,
      }),
      (err: any) => {
        assert.ok(err instanceof UnauthorizedException);
        assert.equal(err.message, 'Current password is incorrect');
        return true;
      },
    );
  });

  it('throws UnauthorizedException when current password is incorrect', async () => {
    const storedHash = await bcrypt.hash('c'.repeat(64), 10); // different from currentPasswordHash
    const mockPrisma = buildChangePasswordMockPrisma({
      accountExists: true,
      storedHash,
    });
    const service = createService(mockPrisma);

    await assert.rejects(
      () => service.changePassword({
        userId: 'user-uuid-1',
        currentPasswordHash,
        newPasswordHash,
      }),
      (err: any) => {
        assert.ok(err instanceof UnauthorizedException);
        assert.equal(err.message, 'Current password is incorrect');
        return true;
      },
    );
  });
});
