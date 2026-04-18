import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BadRequestException, ConflictException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { UserRole } from '@prisma/client';

import { AdminAuthService } from '../src/modules/auth/services/admin-auth.service';

interface MockAdminUserAuthRecord {
  readonly id: string;
  readonly login: string;
  readonly loginNormalized: string;
  readonly email: string;
  readonly name: string | null;
  readonly role: UserRole;
  readonly isActive: boolean;
  readonly tokenVersion: number;
  readonly passwordHash: string;
  readonly createdAt: Date;
  readonly lastLoginAt: Date | null;
  readonly lastLoginIp: string | null;
}

interface MockAdminUserProfileRecord {
  readonly id: string;
  readonly login: string;
  readonly loginNormalized: string;
  readonly email: string;
  readonly name: string | null;
  readonly role: UserRole;
  readonly isActive: boolean;
  readonly tokenVersion: number;
  readonly createdAt: Date;
  readonly lastLoginAt: Date | null;
  readonly lastLoginIp: string | null;
}

interface MockAuditLogCreateArgs {
  readonly data: {
    readonly action: string;
    readonly ipAddress: string | null;
    readonly userAgent: string | null;
    readonly metadata: {
      readonly login: string;
      readonly requestId: string | null;
      readonly email?: string;
      readonly name?: string;
      readonly reason?: string;
    };
    readonly adminUser?: {
      readonly connect: {
        readonly id: string;
      };
    };
  };
}

interface MockTransactionClient {
  readonly adminUser: {
    count: () => Promise<number>;
    create: (args: unknown) => Promise<MockAdminUserProfileRecord>;
    update: (args: unknown) => Promise<MockAdminUserProfileRecord>;
  };
  readonly adminAuditLog: {
    create: (args: MockAuditLogCreateArgs) => Promise<void>;
  };
}

interface MockPrismaService {
  readonly adminUser: {
    findUnique: (args: unknown) => Promise<MockAdminUserAuthRecord | null>;
  };
  readonly adminAuditLog: {
    create: (args: MockAuditLogCreateArgs) => Promise<void>;
  };
  readonly $transaction: (
    callback: (transactionClient: MockTransactionClient) => Promise<MockAdminUserProfileRecord>,
  ) => Promise<MockAdminUserProfileRecord>;
}

interface MockJwtService {
  readonly signAsync: (payload: object) => Promise<string>;
}

interface MockPasswordHashService {
  readonly hashPassword: (input: { readonly plainTextPassword: string }) => Promise<string>;
  readonly verifyPassword: (input: {
    readonly plainTextPassword: string;
    readonly passwordHash: string;
  }) => Promise<boolean>;
}

interface MockAuthConfiguration {
  readonly jwtSecret: string;
  readonly jwtExpiresIn: '12h';
  readonly internalApiKey: string;
}

const REQUEST_METADATA = {
  requestId: 'request-1',
  remoteAddress: '203.0.113.10',
  userAgent: 'unit-test',
} as const;

function createAdminAuthService(input: {
  readonly findUniqueResult: MockAdminUserAuthRecord | null;
  readonly existingAdminsCount?: number;
  readonly createdAdmin?: MockAdminUserProfileRecord;
  readonly hashedPassword?: string;
  readonly verifyPasswordResult?: boolean;
  readonly updatedAdmin?: MockAdminUserProfileRecord;
}): {
  readonly service: AdminAuthService;
  readonly auditEntries: MockAuditLogCreateArgs[];
  readonly countCalls: number[];
  readonly createCalls: unknown[];
  readonly findUniqueCalls: unknown[];
  readonly hashCalls: Array<{
    readonly plainTextPassword: string;
  }>;
  readonly jwtPayloads: object[];
  readonly updateCalls: unknown[];
  readonly verifyCalls: Array<{
    readonly plainTextPassword: string;
    readonly passwordHash: string;
  }>;
} {
  const auditEntries: MockAuditLogCreateArgs[] = [];
  const countCalls: number[] = [];
  const createCalls: unknown[] = [];
  const findUniqueCalls: unknown[] = [];
  const hashCalls: Array<{
    readonly plainTextPassword: string;
  }> = [];
  const jwtPayloads: object[] = [];
  const updateCalls: unknown[] = [];
  const verifyCalls: Array<{
    readonly plainTextPassword: string;
    readonly passwordHash: string;
  }> = [];
  const createdAdmin: MockAdminUserProfileRecord =
    input.createdAdmin ??
    buildAdminProfileRecord({
      id: 'admin-1',
      login: 'admin',
      email: 'admin@example.com',
      isActive: true,
      tokenVersion: 2,
      lastLoginAt: null,
      lastLoginIp: null,
      name: 'Admin',
      role: UserRole.DEV,
    });
  const updatedAdmin: MockAdminUserProfileRecord =
    input.updatedAdmin ??
    buildAdminProfileRecord({
      id: 'admin-1',
      login: 'admin',
      email: 'admin@example.com',
      isActive: true,
      tokenVersion: 2,
      lastLoginAt: new Date('2026-04-16T12:00:00.000Z'),
      lastLoginIp: REQUEST_METADATA.remoteAddress,
      name: 'Admin',
      role: UserRole.ADMIN,
    });
  const prismaService: MockPrismaService = {
    adminUser: {
      findUnique: async (args: unknown): Promise<MockAdminUserAuthRecord | null> => {
        findUniqueCalls.push(args);
        return input.findUniqueResult;
      },
    },
    adminAuditLog: {
      create: async (args: MockAuditLogCreateArgs): Promise<void> => {
        auditEntries.push(args);
      },
    },
    $transaction: async (
      callback: (transactionClient: MockTransactionClient) => Promise<MockAdminUserProfileRecord>,
    ): Promise<MockAdminUserProfileRecord> => {
      const transactionClient: MockTransactionClient = {
        adminUser: {
          count: async (): Promise<number> => {
            countCalls.push(1);
            return input.existingAdminsCount ?? 0;
          },
          create: async (args: unknown): Promise<MockAdminUserProfileRecord> => {
            createCalls.push(args);
            return createdAdmin;
          },
          update: async (args: unknown): Promise<MockAdminUserProfileRecord> => {
            updateCalls.push(args);
            return updatedAdmin;
          },
        },
        adminAuditLog: {
          create: async (args: MockAuditLogCreateArgs): Promise<void> => {
            auditEntries.push(args);
          },
        },
      };
      return callback(transactionClient);
    },
  };
  const jwtService: MockJwtService = {
    signAsync: async (payload: object): Promise<string> => {
      jwtPayloads.push(payload);
      return 'signed-token';
    },
  };
  const passwordHashService: MockPasswordHashService = {
    hashPassword: async (hashInput): Promise<string> => {
      hashCalls.push(hashInput);
      return input.hashedPassword ?? 'hashed-password';
    },
    verifyPassword: async (verifyInput): Promise<boolean> => {
      verifyCalls.push(verifyInput);
      return input.verifyPasswordResult ?? true;
    },
  };
  const service = new AdminAuthService(
    { jwtSecret: 'secret', jwtExpiresIn: '12h', internalApiKey: 'internal' } as MockAuthConfiguration,
    jwtService as never,
    passwordHashService as never,
    prismaService as never,
  );
  return {
    service,
    auditEntries,
    countCalls,
    createCalls,
    findUniqueCalls,
    hashCalls,
    jwtPayloads,
    updateCalls,
    verifyCalls,
  };
}

function buildAdminAuthRecord(input: {
  readonly id: string;
  readonly login: string;
  readonly email: string;
  readonly isActive: boolean;
  readonly tokenVersion: number;
  readonly passwordHash: string;
}): MockAdminUserAuthRecord {
  return {
    id: input.id,
    login: input.login,
    loginNormalized: input.login.toLowerCase(),
    email: input.email,
    name: 'Admin',
    role: UserRole.ADMIN,
    isActive: input.isActive,
    tokenVersion: input.tokenVersion,
    passwordHash: input.passwordHash,
    createdAt: new Date('2026-04-01T00:00:00.000Z'),
    lastLoginAt: new Date('2026-04-15T12:00:00.000Z'),
    lastLoginIp: '198.51.100.1',
  };
}

function buildAdminProfileRecord(input: {
  readonly id: string;
  readonly login: string;
  readonly email: string;
  readonly isActive: boolean;
  readonly tokenVersion: number;
  readonly lastLoginAt: Date | null;
  readonly lastLoginIp: string | null;
  readonly name?: string | null;
  readonly role?: UserRole;
}): MockAdminUserProfileRecord {
  return {
    id: input.id,
    login: input.login,
    loginNormalized: input.login.toLowerCase(),
    email: input.email,
    name: input.name ?? 'Admin',
    role: input.role ?? UserRole.ADMIN,
    isActive: input.isActive,
    tokenVersion: input.tokenVersion,
    createdAt: new Date('2026-04-01T00:00:00.000Z'),
    lastLoginAt: input.lastLoginAt,
    lastLoginIp: input.lastLoginIp,
  };
}

describe('AdminAuthService', () => {
  it('creates the first admin as a DEV user, hashes the password, and records the bootstrap audit log', async () => {
    const createdAdmin = buildAdminProfileRecord({
      id: 'admin-dev-1',
      login: 'dev-admin',
      email: 'dev@example.com',
      isActive: true,
      tokenVersion: 0,
      lastLoginAt: null,
      lastLoginIp: null,
      name: 'DEV Admin',
      role: UserRole.DEV,
    });
    const { service, auditEntries, countCalls, createCalls, findUniqueCalls, hashCalls, jwtPayloads, updateCalls, verifyCalls } =
      createAdminAuthService({
        findUniqueResult: null,
        createdAdmin,
        existingAdminsCount: 0,
        hashedPassword: 'hashed-bootstrap-password',
      });
    const actualResult = await service.bootstrapFirstAdmin({
      login: '  DEV-ADMIN  ',
      email: '  DEV@EXAMPLE.COM  ',
      password: 'strong-password',
      name: '  DEV Admin  ',
      requestMetadata: REQUEST_METADATA,
    });
    assert.deepStrictEqual(countCalls, [1]);
    assert.deepStrictEqual(hashCalls, [{ plainTextPassword: 'strong-password' }]);
    assert.equal(createCalls.length, 1);
    assert.deepStrictEqual(createCalls[0], {
      data: {
        login: 'DEV-ADMIN',
        loginNormalized: 'dev-admin',
        email: 'dev@example.com',
        passwordHash: 'hashed-bootstrap-password',
        name: 'DEV Admin',
        role: UserRole.DEV,
      },
      select: {
        id: true,
        login: true,
        loginNormalized: true,
        email: true,
        name: true,
        role: true,
        isActive: true,
        tokenVersion: true,
        createdAt: true,
        lastLoginAt: true,
        lastLoginIp: true,
      },
    });
    assert.deepStrictEqual(actualResult, {
      id: 'admin-dev-1',
      login: 'dev-admin',
      email: 'dev@example.com',
      name: 'DEV Admin',
      role: UserRole.DEV,
      isActive: true,
      tokenVersion: 0,
      createdAt: new Date('2026-04-01T00:00:00.000Z'),
      lastLoginAt: null,
      lastLoginIp: null,
    });
    assert.deepStrictEqual(auditEntries, [
      {
        data: {
          action: 'admin.bootstrap',
          ipAddress: REQUEST_METADATA.remoteAddress,
          userAgent: REQUEST_METADATA.userAgent,
          metadata: {
            login: 'dev-admin',
            email: 'dev@example.com',
            name: 'DEV Admin',
            requestId: REQUEST_METADATA.requestId,
          },
          adminUser: {
            connect: {
              id: 'admin-dev-1',
            },
          },
        },
      },
    ]);
    assert.deepStrictEqual(findUniqueCalls, []);
    assert.deepStrictEqual(jwtPayloads, []);
    assert.deepStrictEqual(updateCalls, []);
    assert.deepStrictEqual(verifyCalls, []);
  });

  it('rejects bootstrap when an admin already exists and does not create side effects', async () => {
    const { service, auditEntries, countCalls, createCalls, findUniqueCalls, hashCalls, jwtPayloads, updateCalls, verifyCalls } =
      createAdminAuthService({
        findUniqueResult: null,
        existingAdminsCount: 1,
      });
    await assert.rejects(
      async (): Promise<void> => {
        await service.bootstrapFirstAdmin({
          login: 'dev-admin',
          email: 'dev@example.com',
          password: 'strong-password',
          name: 'DEV Admin',
          requestMetadata: REQUEST_METADATA,
        });
      },
      {
        name: ConflictException.name,
        message: 'Bootstrap DEV admin is already created',
      },
    );
    assert.deepStrictEqual(countCalls, [1]);
    assert.deepStrictEqual(hashCalls, []);
    assert.deepStrictEqual(createCalls, []);
    assert.deepStrictEqual(auditEntries, []);
    assert.deepStrictEqual(findUniqueCalls, []);
    assert.deepStrictEqual(jwtPayloads, []);
    assert.deepStrictEqual(updateCalls, []);
    assert.deepStrictEqual(verifyCalls, []);
  });

  it('rejects bootstrap when the login is invalid after trimming', async () => {
    const { service, auditEntries, countCalls, createCalls, findUniqueCalls, hashCalls, jwtPayloads, updateCalls, verifyCalls } =
      createAdminAuthService({
        findUniqueResult: null,
      });
    await assert.rejects(
      async (): Promise<void> => {
        await service.bootstrapFirstAdmin({
          login: '   ',
          email: 'dev@example.com',
          password: 'strong-password',
          name: 'DEV Admin',
          requestMetadata: REQUEST_METADATA,
        });
      },
      {
        name: BadRequestException.name,
        message: 'admin login is invalid',
      },
    );
    assert.deepStrictEqual(countCalls, []);
    assert.deepStrictEqual(hashCalls, []);
    assert.deepStrictEqual(createCalls, []);
    assert.deepStrictEqual(auditEntries, []);
    assert.deepStrictEqual(findUniqueCalls, []);
    assert.deepStrictEqual(jwtPayloads, []);
    assert.deepStrictEqual(updateCalls, []);
    assert.deepStrictEqual(verifyCalls, []);
  });

  it('returns the token payload for a valid admin login', async () => {
    const actualLastLoginAt = new Date();
    const adminUser = buildAdminAuthRecord({
      id: 'admin-1',
      login: 'admin',
      email: 'Admin@Example.com',
      isActive: true,
      tokenVersion: 2,
      passwordHash: 'password-hash',
    });
    const loggedInAdmin = buildAdminProfileRecord({
      id: 'admin-1',
      login: 'admin',
      email: 'admin@example.com',
      isActive: true,
      tokenVersion: 2,
      lastLoginAt: actualLastLoginAt,
      lastLoginIp: REQUEST_METADATA.remoteAddress,
      name: 'Admin',
      role: UserRole.ADMIN,
    });
    const { service, auditEntries, findUniqueCalls, jwtPayloads, updateCalls, verifyCalls } =
      createAdminAuthService({
        findUniqueResult: adminUser,
        verifyPasswordResult: true,
        updatedAdmin: loggedInAdmin,
      });
    const actualResult = await service.loginAdmin({
      login: '  ADMIN  ',
      password: 'correct-password',
      requestMetadata: REQUEST_METADATA,
    });
    assert.deepStrictEqual(findUniqueCalls, [
      {
        where: { loginNormalized: 'admin' },
        select: {
          id: true,
          login: true,
          loginNormalized: true,
          email: true,
          name: true,
          role: true,
          isActive: true,
          tokenVersion: true,
          passwordHash: true,
          createdAt: true,
          lastLoginAt: true,
          lastLoginIp: true,
        },
      },
    ]);
    assert.deepStrictEqual(verifyCalls, [
      {
        plainTextPassword: 'correct-password',
        passwordHash: 'password-hash',
      },
    ]);
    assert.equal(updateCalls.length, 1);
    const actualUpdateCall = updateCalls[0] as {
      readonly where: {
        readonly id: string;
      };
      readonly data: {
        readonly lastLoginAt: Date;
        readonly lastLoginIp: string | null;
      };
      readonly select: Record<string, boolean>;
    };
    assert.deepStrictEqual(actualUpdateCall.where, { id: 'admin-1' });
    assert.equal(actualUpdateCall.data.lastLoginIp, REQUEST_METADATA.remoteAddress);
    assert.equal(actualUpdateCall.data.lastLoginAt instanceof Date, true);
    assert.equal(Number.isNaN(actualUpdateCall.data.lastLoginAt.getTime()), false);
    assert.deepStrictEqual(actualUpdateCall.select, {
      id: true,
      login: true,
      loginNormalized: true,
      email: true,
      name: true,
      role: true,
      isActive: true,
      tokenVersion: true,
      createdAt: true,
      lastLoginAt: true,
      lastLoginIp: true,
    });
    assert.deepStrictEqual(jwtPayloads, [
      {
        sub: 'admin-1',
        login: 'admin',
        role: UserRole.ADMIN,
        tokenVersion: 2,
      },
    ]);
    assert.deepStrictEqual(actualResult, {
      accessToken: 'signed-token',
      tokenType: 'Bearer',
      expiresIn: '12h',
      admin: {
        id: 'admin-1',
        login: 'admin',
        email: 'admin@example.com',
        name: 'Admin',
        role: UserRole.ADMIN,
        isActive: true,
        tokenVersion: 2,
        createdAt: new Date('2026-04-01T00:00:00.000Z'),
        lastLoginAt: actualLastLoginAt,
        lastLoginIp: REQUEST_METADATA.remoteAddress,
      },
    });
    assert.equal(auditEntries.length, 1);
    assert.deepStrictEqual(auditEntries[0], {
      data: {
        action: 'admin.login.succeeded',
        ipAddress: REQUEST_METADATA.remoteAddress,
        userAgent: REQUEST_METADATA.userAgent,
        metadata: {
          login: 'admin',
          email: 'admin@example.com',
          requestId: REQUEST_METADATA.requestId,
        },
        adminUser: {
          connect: {
            id: 'admin-1',
          },
        },
      },
    });
  });

  it('rejects a missing admin with unauthorized failure and records the audit intent', async () => {
    const { service, auditEntries, findUniqueCalls, jwtPayloads, updateCalls, verifyCalls } =
      createAdminAuthService({
        findUniqueResult: null,
      });
    await assert.rejects(
      async (): Promise<void> => {
        await service.loginAdmin({
          login: '  missing-admin  ',
          password: 'irrelevant',
          requestMetadata: REQUEST_METADATA,
        });
      },
      {
        name: UnauthorizedException.name,
        message: 'Invalid login or password',
      },
    );
    assert.deepStrictEqual(findUniqueCalls, [
      {
        where: { loginNormalized: 'missing-admin' },
        select: {
          id: true,
          login: true,
          loginNormalized: true,
          email: true,
          name: true,
          role: true,
          isActive: true,
          tokenVersion: true,
          passwordHash: true,
          createdAt: true,
          lastLoginAt: true,
          lastLoginIp: true,
        },
      },
    ]);
    assert.deepStrictEqual(verifyCalls, []);
    assert.deepStrictEqual(updateCalls, []);
    assert.deepStrictEqual(jwtPayloads, []);
    assert.deepStrictEqual(auditEntries, [
      {
        data: {
          action: 'admin.login.failed',
          ipAddress: REQUEST_METADATA.remoteAddress,
          userAgent: REQUEST_METADATA.userAgent,
          metadata: {
            login: 'missing-admin',
            requestId: REQUEST_METADATA.requestId,
            reason: 'admin_not_found',
          },
        },
      },
    ]);
  });

  it('rejects login when the login is invalid after trimming', async () => {
    const { service, auditEntries, findUniqueCalls, jwtPayloads, updateCalls, verifyCalls } =
      createAdminAuthService({
        findUniqueResult: null,
      });
    await assert.rejects(
      async (): Promise<void> => {
        await service.loginAdmin({
          login: '   ',
          password: 'irrelevant',
          requestMetadata: REQUEST_METADATA,
        });
      },
      {
        name: UnauthorizedException.name,
        message: 'Invalid login or password',
      },
    );
    assert.deepStrictEqual(findUniqueCalls, []);
    assert.deepStrictEqual(verifyCalls, []);
    assert.deepStrictEqual(updateCalls, []);
    assert.deepStrictEqual(jwtPayloads, []);
    assert.deepStrictEqual(auditEntries, []);
  });

  it('rejects an inactive admin with forbidden failure', async () => {
    const adminUser = buildAdminAuthRecord({
      id: 'admin-2',
      login: 'inactive-admin',
      email: 'inactive@example.com',
      isActive: false,
      tokenVersion: 1,
      passwordHash: 'password-hash',
    });
    const { service, auditEntries, jwtPayloads, updateCalls, verifyCalls } =
      createAdminAuthService({
        findUniqueResult: adminUser,
      });
    await assert.rejects(
      async (): Promise<void> => {
        await service.loginAdmin({
          login: 'inactive-admin',
          password: 'irrelevant',
          requestMetadata: REQUEST_METADATA,
        });
      },
      {
        name: ForbiddenException.name,
        message: 'Admin user is inactive',
      },
    );
    assert.deepStrictEqual(verifyCalls, []);
    assert.deepStrictEqual(updateCalls, []);
    assert.deepStrictEqual(jwtPayloads, []);
    assert.deepStrictEqual(auditEntries, [
      {
        data: {
          action: 'admin.login.failed',
          ipAddress: REQUEST_METADATA.remoteAddress,
          userAgent: REQUEST_METADATA.userAgent,
          metadata: {
            login: 'inactive-admin',
            email: 'inactive@example.com',
            requestId: REQUEST_METADATA.requestId,
            reason: 'admin_inactive',
          },
          adminUser: {
            connect: {
              id: 'admin-2',
            },
          },
        },
      },
    ]);
  });

  it('rejects an invalid password with unauthorized failure', async () => {
    const adminUser = buildAdminAuthRecord({
      id: 'admin-3',
      login: 'admin',
      email: 'admin@example.com',
      isActive: true,
      tokenVersion: 4,
      passwordHash: 'password-hash',
    });
    const { service, auditEntries, jwtPayloads, updateCalls, verifyCalls } =
      createAdminAuthService({
        findUniqueResult: adminUser,
        verifyPasswordResult: false,
      });
    await assert.rejects(
      async (): Promise<void> => {
        await service.loginAdmin({
          login: 'admin',
          password: 'wrong-password',
          requestMetadata: REQUEST_METADATA,
        });
      },
      {
        name: UnauthorizedException.name,
        message: 'Invalid login or password',
      },
    );
    assert.deepStrictEqual(verifyCalls, [
      {
        plainTextPassword: 'wrong-password',
        passwordHash: 'password-hash',
      },
    ]);
    assert.deepStrictEqual(updateCalls, []);
    assert.deepStrictEqual(jwtPayloads, []);
    assert.deepStrictEqual(auditEntries, [
      {
        data: {
          action: 'admin.login.failed',
          ipAddress: REQUEST_METADATA.remoteAddress,
          userAgent: REQUEST_METADATA.userAgent,
          metadata: {
            login: 'admin',
            email: 'admin@example.com',
            requestId: REQUEST_METADATA.requestId,
            reason: 'invalid_password',
          },
          adminUser: {
            connect: {
              id: 'admin-3',
            },
          },
        },
      },
    ]);
  });
});
