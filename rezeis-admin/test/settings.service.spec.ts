import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AccessMode, Currency, UserRole } from '@prisma/client';

import { CurrentAdminInterface } from '../src/modules/auth/interfaces/current-admin.interface';
import { SettingsService } from '../src/modules/settings/services/settings.service';

const EXPECTED_POLICY_KEYS: readonly string[] = [
  'accessMode',
  'channelLink',
  'channelRequired',
  'defaultCurrency',
  'inviteModeStartedAt',
  'rulesLink',
  'rulesRequired',
];

interface MockSettingsRecord {
  readonly id: string;
  readonly rulesRequired: boolean;
  readonly rulesLink: string | null;
  readonly channelRequired: boolean;
  readonly channelId: bigint | null;
  readonly channelLink: string | null;
  readonly accessMode: AccessMode;
  readonly inviteModeStartedAt: Date | null;
  readonly defaultCurrency: Currency;
  readonly updatedAt: Date;
}

interface MockPrismaService {
  readonly settings: {
    findFirst: (...args: readonly unknown[]) => Promise<MockSettingsRecord | null>;
    create: (...args: readonly unknown[]) => Promise<MockSettingsRecord>;
    update?: (...args: readonly unknown[]) => Promise<MockSettingsRecord>;
  };
  readonly adminAuditLog?: {
    create: (args: {
      readonly data: {
        readonly action: string;
        readonly ipAddress: string | null;
        readonly userAgent: string | null;
        readonly metadata: {
          readonly requestId: string | null;
          readonly updatedFields: readonly string[];
        };
        readonly adminUser: {
          readonly connect: {
            readonly id: string;
          };
        };
      };
    }) => Promise<void>;
  };
  readonly $transaction?: (
    callback: (transactionClient: MockPrismaService) => Promise<MockSettingsRecord>,
  ) => Promise<MockSettingsRecord>;
}

const CURRENT_ADMIN: CurrentAdminInterface = {
  id: 'admin-1',
  login: 'admin',
  email: 'admin@example.com',
  name: 'Admin',
  role: UserRole.ADMIN,
  isActive: true,
  tokenVersion: 2,
  createdAt: new Date('2026-04-01T00:00:00.000Z'),
  lastLoginAt: new Date('2026-04-15T12:00:00.000Z'),
  lastLoginIp: '203.0.113.9',
};

const REQUEST_METADATA = {
  requestId: 'request-2',
  remoteAddress: '203.0.113.10',
  userAgent: 'settings-spec',
} as const;

describe('SettingsService', () => {
  it('maps the internal platform policy down to the user-safe settings slice', async () => {
    let actualOrderBy: unknown;
    const now = new Date('2026-04-16T15:00:00.000Z');
    const inviteModeStartedAt = new Date('2026-04-10T09:30:00.000Z');
    const prismaService: MockPrismaService = {
      settings: {
        findFirst: async (...args: readonly unknown[]): Promise<MockSettingsRecord | null> => {
          actualOrderBy = (args[0] as { readonly orderBy: unknown }).orderBy;
          return {
            id: 'settings-1',
            rulesRequired: true,
            rulesLink: 'https://example.com/rules',
            channelRequired: false,
            channelId: BigInt('123456789'),
            channelLink: 'https://t.me/example',
            accessMode: AccessMode.INVITED,
            inviteModeStartedAt,
            defaultCurrency: Currency.USD,
            updatedAt: now,
          };
        },
        create: async (): Promise<MockSettingsRecord> => {
          throw new Error('create should not be called when settings already exist');
        },
      },
    };
    const service = new SettingsService(prismaService as never);
    const actualPolicy = await service.getInternalPlatformPolicy();
    assert.deepStrictEqual(actualOrderBy, { updatedAt: 'asc' });
    assert.deepStrictEqual(actualPolicy, {
      rulesRequired: true,
      rulesLink: 'https://example.com/rules',
      channelRequired: false,
      channelLink: 'https://t.me/example',
      accessMode: AccessMode.INVITED,
      inviteModeStartedAt: inviteModeStartedAt.toISOString(),
      defaultCurrency: Currency.USD,
    });
    assert.deepStrictEqual(Object.keys(actualPolicy).sort(), [...EXPECTED_POLICY_KEYS]);
  });

  it('does not create settings when the internal read-only policy is requested without a row', async () => {
    let hasCreateBeenCalled = false;
    const prismaService: MockPrismaService = {
      settings: {
        findFirst: async (): Promise<MockSettingsRecord | null> => null,
        create: async (): Promise<MockSettingsRecord> => {
          hasCreateBeenCalled = true;
          throw new Error('create must not be called by the internal read-only policy path');
        },
      },
    };
    const service = new SettingsService(prismaService as never);
    const actualPolicy = await service.getInternalPlatformPolicy();
    assert.equal(hasCreateBeenCalled, false);
    assert.deepStrictEqual(actualPolicy, {
      rulesRequired: true,
      rulesLink: null,
      channelRequired: false,
      channelLink: null,
      accessMode: AccessMode.PUBLIC,
      inviteModeStartedAt: null,
      defaultCurrency: Currency.USD,
    });
    assert.deepStrictEqual(Object.keys(actualPolicy).sort(), [...EXPECTED_POLICY_KEYS]);
  });

  it('returns the singleton platform settings payload and creates defaults when missing', async () => {
    let actualCreateArgs: unknown;
    const createdAt = new Date('2026-04-16T15:10:00.000Z');
    const prismaService: MockPrismaService = {
      settings: {
        findFirst: async (): Promise<MockSettingsRecord | null> => null,
        create: async (...args: readonly unknown[]): Promise<MockSettingsRecord> => {
          actualCreateArgs = args[0];
          return {
            id: 'settings-1',
            rulesRequired: true,
            rulesLink: null,
            channelRequired: false,
            channelId: null,
            channelLink: null,
            accessMode: AccessMode.PUBLIC,
            inviteModeStartedAt: null,
            defaultCurrency: Currency.USD,
            updatedAt: createdAt,
          };
        },
      },
    };
    const service = new SettingsService(prismaService as never);
    const actualSettings = await service.getPlatformSettings();
    assert.deepStrictEqual(actualCreateArgs, { data: {} });
    assert.deepStrictEqual(actualSettings, {
      rulesRequired: true,
      rulesLink: null,
      channelRequired: false,
      channelId: null,
      channelLink: null,
      accessMode: AccessMode.PUBLIC,
      inviteModeStartedAt: null,
      defaultCurrency: Currency.USD,
      updatedAt: createdAt.toISOString(),
    });
  });

  it('persists partial platform updates, serializes inviteModeStartedAt, and records request metadata in audit metadata', async () => {
    let actualTransactionClient: MockPrismaService | null = null;
    let actualTransactionFindFirstArgs: unknown;
    let actualTransactionUpdateArgs: unknown;
    const actualAuditEntries: unknown[] = [];
    let hasRootFindFirstBeenCalled = false;
    let hasRootUpdateBeenCalled = false;
    let hasRootAuditCreateBeenCalled = false;
    const inviteModeStartedAt = new Date('2026-04-16T15:20:00.000Z');
    const existingSettings: MockSettingsRecord = {
      id: 'settings-1',
      rulesRequired: true,
      rulesLink: 'https://example.com/rules',
      channelRequired: false,
      channelId: BigInt('123456789'),
      channelLink: 'https://t.me/old',
      accessMode: AccessMode.PUBLIC,
      inviteModeStartedAt: null,
      defaultCurrency: Currency.USD,
      updatedAt: new Date('2026-04-16T12:00:00.000Z'),
    };
    const updatedSettings: MockSettingsRecord = {
      ...existingSettings,
      rulesLink: null,
      channelId: BigInt('987654321'),
      accessMode: AccessMode.INVITED,
      inviteModeStartedAt,
      defaultCurrency: Currency.EUR,
      updatedAt: new Date('2026-04-16T15:30:00.000Z'),
    };
    const transactionClient: MockPrismaService = {
      settings: {
        findFirst: async (...args: readonly unknown[]): Promise<MockSettingsRecord | null> => {
          actualTransactionFindFirstArgs = args[0];
          return existingSettings;
        },
        create: async (): Promise<MockSettingsRecord> => {
          throw new Error('create should not be called when settings already exist');
        },
        update: async (...args: readonly unknown[]): Promise<MockSettingsRecord> => {
          actualTransactionUpdateArgs = args[0];
          return updatedSettings;
        },
      },
      adminAuditLog: {
        create: async (args): Promise<void> => {
          actualAuditEntries.push(args);
        },
      },
    };
    const prismaService: MockPrismaService = {
      settings: {
        findFirst: async (): Promise<MockSettingsRecord | null> => {
          hasRootFindFirstBeenCalled = true;
          throw new Error('root settings.findFirst should not be used inside the update transaction');
        },
        create: async (): Promise<MockSettingsRecord> => {
          throw new Error('root settings.create should not be used inside the update transaction');
        },
        update: async (): Promise<MockSettingsRecord> => {
          hasRootUpdateBeenCalled = true;
          throw new Error('root settings.update should not be used inside the update transaction');
        },
      },
      adminAuditLog: {
        create: async (): Promise<void> => {
          hasRootAuditCreateBeenCalled = true;
          throw new Error('root adminAuditLog.create should not be used inside the update transaction');
        },
      },
      $transaction: async (
        callback: (_transactionClientInput: MockPrismaService) => Promise<MockSettingsRecord>,
      ): Promise<MockSettingsRecord> => {
        actualTransactionClient = transactionClient;
        return callback(transactionClient);
      },
    };
    const service = new SettingsService(prismaService as never);
    const actualSettings = await service.updatePlatformSettings({
      currentAdmin: CURRENT_ADMIN,
      requestMetadata: REQUEST_METADATA,
      updatePlatformSettingsDto: {
        rulesLink: null,
        channelId: '987654321',
        accessMode: AccessMode.INVITED,
        inviteModeStartedAt: inviteModeStartedAt.toISOString(),
        defaultCurrency: Currency.EUR,
      },
    });
    assert.equal(actualTransactionClient, transactionClient);
    assert.equal(hasRootFindFirstBeenCalled, false);
    assert.equal(hasRootUpdateBeenCalled, false);
    assert.equal(hasRootAuditCreateBeenCalled, false);
    assert.deepStrictEqual(actualTransactionFindFirstArgs, {
      orderBy: { updatedAt: 'asc' },
    });
    assert.deepStrictEqual(actualTransactionUpdateArgs, {
      where: { id: 'settings-1' },
        data: {
          rulesLink: null,
          channelId: BigInt('987654321'),
          accessMode: AccessMode.INVITED,
          inviteModeStartedAt,
          defaultCurrency: Currency.EUR,
        },
      });
    assert.deepStrictEqual(actualAuditEntries, [
      {
        data: {
          action: 'settings.platform.updated',
          ipAddress: REQUEST_METADATA.remoteAddress,
          userAgent: REQUEST_METADATA.userAgent,
          metadata: {
            requestId: REQUEST_METADATA.requestId,
            updatedFields: ['rulesLink', 'channelId', 'accessMode', 'inviteModeStartedAt', 'defaultCurrency'],
          },
          adminUser: {
            connect: {
              id: CURRENT_ADMIN.id,
            },
          },
        },
      },
    ]);
    assert.deepStrictEqual(actualSettings, {
      rulesRequired: true,
      rulesLink: null,
      channelRequired: false,
      channelId: '987654321',
      channelLink: 'https://t.me/old',
      accessMode: AccessMode.INVITED,
      inviteModeStartedAt: inviteModeStartedAt.toISOString(),
      defaultCurrency: Currency.EUR,
      updatedAt: updatedSettings.updatedAt.toISOString(),
    });
  });

  it('creates the settings row inside the transaction before applying the first update', async () => {
    let actualTransactionClient: MockPrismaService | null = null;
    let actualTransactionFindFirstCalls = 0;
    let actualTransactionCreateArgs: unknown;
    let actualTransactionUpdateArgs: unknown;
    const actualAuditEntries: unknown[] = [];
    let hasRootFindFirstBeenCalled = false;
    let hasRootCreateBeenCalled = false;
    let hasRootUpdateBeenCalled = false;
    let hasRootAuditCreateBeenCalled = false;
    const createdSettings: MockSettingsRecord = {
      id: 'settings-1',
      rulesRequired: true,
      rulesLink: null,
      channelRequired: false,
      channelId: null,
      channelLink: null,
      accessMode: AccessMode.PUBLIC,
      inviteModeStartedAt: null,
      defaultCurrency: Currency.USD,
      updatedAt: new Date('2026-04-16T16:00:00.000Z'),
    };
    const updatedSettings: MockSettingsRecord = {
      ...createdSettings,
      channelRequired: true,
      channelLink: 'https://t.me/new',
      updatedAt: new Date('2026-04-16T16:05:00.000Z'),
    };
    const transactionClient: MockPrismaService = {
      settings: {
        findFirst: async (): Promise<MockSettingsRecord | null> => {
          actualTransactionFindFirstCalls += 1;
          return null;
        },
        create: async (...args: readonly unknown[]): Promise<MockSettingsRecord> => {
          actualTransactionCreateArgs = args[0];
          return createdSettings;
        },
        update: async (...args: readonly unknown[]): Promise<MockSettingsRecord> => {
          actualTransactionUpdateArgs = args[0];
          return updatedSettings;
        },
      },
      adminAuditLog: {
        create: async (args): Promise<void> => {
          actualAuditEntries.push(args);
        },
      },
    };
    const prismaService: MockPrismaService = {
      settings: {
        findFirst: async (): Promise<MockSettingsRecord | null> => {
          hasRootFindFirstBeenCalled = true;
          throw new Error('root settings.findFirst should not be used inside the first-write transaction');
        },
        create: async (): Promise<MockSettingsRecord> => {
          hasRootCreateBeenCalled = true;
          throw new Error('root settings.create should not be used inside the first-write transaction');
        },
        update: async (): Promise<MockSettingsRecord> => {
          hasRootUpdateBeenCalled = true;
          throw new Error('root settings.update should not be used inside the first-write transaction');
        },
      },
      adminAuditLog: {
        create: async (): Promise<void> => {
          hasRootAuditCreateBeenCalled = true;
          throw new Error('root adminAuditLog.create should not be used inside the first-write transaction');
        },
      },
      $transaction: async (
        callback: (_transactionClientInput: MockPrismaService) => Promise<MockSettingsRecord>,
      ): Promise<MockSettingsRecord> => {
        actualTransactionClient = transactionClient;
        return callback(transactionClient);
      },
    };
    const service = new SettingsService(prismaService as never);
    const actualSettings = await service.updatePlatformSettings({
      currentAdmin: CURRENT_ADMIN,
      requestMetadata: REQUEST_METADATA,
      updatePlatformSettingsDto: {
        channelRequired: true,
        channelLink: 'https://t.me/new',
      },
    });
    assert.equal(actualTransactionClient, transactionClient);
    assert.equal(actualTransactionFindFirstCalls, 1);
    assert.equal(hasRootFindFirstBeenCalled, false);
    assert.equal(hasRootCreateBeenCalled, false);
    assert.equal(hasRootUpdateBeenCalled, false);
    assert.equal(hasRootAuditCreateBeenCalled, false);
    assert.deepStrictEqual(actualTransactionCreateArgs, { data: {} });
    assert.deepStrictEqual(actualTransactionUpdateArgs, {
      where: { id: 'settings-1' },
      data: {
        channelRequired: true,
        channelLink: 'https://t.me/new',
      },
    });
    assert.deepStrictEqual(actualAuditEntries, [
      {
        data: {
          action: 'settings.platform.updated',
          ipAddress: REQUEST_METADATA.remoteAddress,
          userAgent: REQUEST_METADATA.userAgent,
          metadata: {
            requestId: REQUEST_METADATA.requestId,
            updatedFields: ['channelRequired', 'channelLink'],
          },
          adminUser: {
            connect: {
              id: CURRENT_ADMIN.id,
            },
          },
        },
      },
    ]);
    assert.deepStrictEqual(actualSettings, {
      rulesRequired: true,
      rulesLink: null,
      channelRequired: true,
      channelId: null,
      channelLink: 'https://t.me/new',
      accessMode: AccessMode.PUBLIC,
      inviteModeStartedAt: null,
      defaultCurrency: Currency.USD,
      updatedAt: updatedSettings.updatedAt.toISOString(),
    });
  });

  it('returns the current settings unchanged for empty updates without writing audit noise', async () => {
    let actualRootFindFirstArgs: unknown;
    let hasRootCreateBeenCalled = false;
    let hasRootUpdateBeenCalled = false;
    let hasRootAuditCreateBeenCalled = false;
    let hasTransactionBeenCalled = false;
    const existingSettings: MockSettingsRecord = {
      id: 'settings-1',
      rulesRequired: true,
      rulesLink: 'https://example.com/rules',
      channelRequired: false,
      channelId: BigInt('123456789'),
      channelLink: 'https://t.me/example',
      accessMode: AccessMode.INVITED,
      inviteModeStartedAt: new Date('2026-04-16T10:00:00.000Z'),
      defaultCurrency: Currency.USD,
      updatedAt: new Date('2026-04-16T17:00:00.000Z'),
    };
    const prismaService: MockPrismaService = {
      settings: {
        findFirst: async (...args: readonly unknown[]): Promise<MockSettingsRecord | null> => {
          actualRootFindFirstArgs = args[0];
          return existingSettings;
        },
        create: async (): Promise<MockSettingsRecord> => {
          hasRootCreateBeenCalled = true;
          throw new Error('settings.create should not be called when a row already exists');
        },
        update: async (): Promise<MockSettingsRecord> => {
          hasRootUpdateBeenCalled = true;
          throw new Error('settings.update should not be called for an empty update');
        },
      },
      adminAuditLog: {
        create: async (): Promise<void> => {
          hasRootAuditCreateBeenCalled = true;
          throw new Error('adminAuditLog.create should not be called for an empty update');
        },
      },
      $transaction: async (): Promise<MockSettingsRecord> => {
        hasTransactionBeenCalled = true;
        throw new Error('$transaction should not be called for an empty update');
      },
    };
    const service = new SettingsService(prismaService as never);
    const actualSettings = await service.updatePlatformSettings({
      currentAdmin: CURRENT_ADMIN,
      requestMetadata: REQUEST_METADATA,
      updatePlatformSettingsDto: {},
    });
    assert.equal(hasTransactionBeenCalled, false);
    assert.equal(hasRootCreateBeenCalled, false);
    assert.equal(hasRootUpdateBeenCalled, false);
    assert.equal(hasRootAuditCreateBeenCalled, false);
    assert.deepStrictEqual(actualRootFindFirstArgs, {
      orderBy: { updatedAt: 'asc' },
    });
    assert.deepStrictEqual(actualSettings, {
      rulesRequired: true,
      rulesLink: 'https://example.com/rules',
      channelRequired: false,
      channelId: '123456789',
      channelLink: 'https://t.me/example',
      accessMode: AccessMode.INVITED,
      inviteModeStartedAt: '2026-04-16T10:00:00.000Z',
      defaultCurrency: Currency.USD,
      updatedAt: '2026-04-16T17:00:00.000Z',
    });
  });
});
