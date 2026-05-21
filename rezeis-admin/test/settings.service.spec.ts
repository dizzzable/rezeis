import 'reflect-metadata';

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import { NotFoundException } from '@nestjs/common';
import { AccessMode, Currency, UserRole } from '@prisma/client';

import { DEFAULT_PAYMENT_OPS_ALERT_SETTINGS } from '../src/common/interfaces/payment-ops-alert-settings.interface';
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
  readonly branding?: unknown;
  readonly botMenu?: unknown;
  readonly systemNotifications?: unknown;
  readonly partnerSettings?: unknown;
  readonly updatedAt: Date;
}

interface MockPrismaService {
  readonly adminApiToken?: {
    findMany?: (...args: readonly unknown[]) => Promise<readonly MockAdminApiTokenRecord[]>;
    create?: (...args: readonly unknown[]) => Promise<MockAdminApiTokenRecord>;
    findUnique?: (...args: readonly unknown[]) => Promise<MockAdminApiTokenRecord | null>;
    update?: (...args: readonly unknown[]) => Promise<MockAdminApiTokenRecord>;
  };
  readonly settings: {
    findFirst: (...args: readonly unknown[]) => Promise<MockSettingsRecord | null>;
    create: (...args: readonly unknown[]) => Promise<MockSettingsRecord>;
    update?: (...args: readonly unknown[]) => Promise<MockSettingsRecord>;
  };
  readonly adminAuditLog?: {
    create: (args: unknown) => Promise<void>;
  };
  readonly $transaction?: (
    callback: (transactionClient: MockPrismaService) => Promise<MockSettingsRecord | MockAdminApiTokenRecord>,
  ) => Promise<MockSettingsRecord | MockAdminApiTokenRecord>;
}

interface MockAdminApiTokenRecord {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly tokenPrefix: string;
  readonly secretHash: string;
  readonly lastUsedAt: Date | null;
  readonly revokedAt: Date | null;
  readonly createdByAdminUserId: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
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

const EXPECTED_EMPTY_BRANDING = {
  projectName: null,
  webTitle: null,
  supportUrl: null,
  supportUsername: null,
  accessRequestIntro: null,
  accessApprovedMessage: null,
  accessRejectedMessage: null,
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
      branding: EXPECTED_EMPTY_BRANDING,
      updatedAt: createdAt.toISOString(),
    });
  });

  it('returns default payment-ops alert settings when system notifications are missing', async () => {
    const now = new Date('2026-04-16T15:15:00.000Z');
    const prismaService: MockPrismaService = {
      settings: {
        findFirst: async (): Promise<MockSettingsRecord | null> => ({
          id: 'settings-1',
          rulesRequired: true,
          rulesLink: null,
          channelRequired: false,
          channelId: null,
          channelLink: null,
          accessMode: AccessMode.PUBLIC,
          inviteModeStartedAt: null,
          defaultCurrency: Currency.USD,
          systemNotifications: null,
          updatedAt: now,
        }),
        create: async (): Promise<MockSettingsRecord> => {
          throw new Error('settings.create should not be called when a row already exists');
        },
      },
    };
    const service = new SettingsService(prismaService as never);
    const actualSettings = await service.getPaymentOpsAlertSettings();
    assert.deepStrictEqual(actualSettings, DEFAULT_PAYMENT_OPS_ALERT_SETTINGS);
  });

  it('returns default partner withdrawal policy when partner settings are missing', async () => {
    const now = new Date('2026-04-16T15:16:00.000Z');
    const prismaService: MockPrismaService = {
      settings: {
        findFirst: async (): Promise<MockSettingsRecord | null> => ({
          id: 'settings-1',
          rulesRequired: true,
          rulesLink: null,
          channelRequired: false,
          channelId: null,
          channelLink: null,
          accessMode: AccessMode.PUBLIC,
          inviteModeStartedAt: null,
          defaultCurrency: Currency.USD,
          partnerSettings: null,
          updatedAt: now,
        }),
        create: async (): Promise<MockSettingsRecord> => {
          throw new Error('settings.create should not be called when a row already exists');
        },
      },
    };
    const service = new SettingsService(prismaService as never);
    const actualPolicy = await service.getPartnerWithdrawalPolicy();
    assert.deepStrictEqual(actualPolicy, {
      enabled: false,
      minimumAmount: 0,
      supportedMethods: [],
      updatedAt: now.toISOString(),
    });
  });

  it('merges partner withdrawal policy updates and records bounded audit metadata', async () => {
    let actualTransactionUpdateArgs: unknown;
    const actualAuditEntries: unknown[] = [];
    const existingSettings: MockSettingsRecord = {
      id: 'settings-1',
      rulesRequired: true,
      rulesLink: null,
      channelRequired: false,
      channelId: null,
      channelLink: null,
      accessMode: AccessMode.PUBLIC,
      inviteModeStartedAt: null,
      defaultCurrency: Currency.USD,
      partnerSettings: {
        withdrawals: {
          enabled: true,
          minimumAmount: 100,
          supportedMethods: ['USDT_TRC20'],
        },
        untouched: 'preserved',
      },
      updatedAt: new Date('2026-04-16T15:17:00.000Z'),
    };
    const updatedSettings: MockSettingsRecord = {
      ...existingSettings,
      partnerSettings: {
        withdrawals: {
          enabled: true,
          minimumAmount: 250,
          supportedMethods: ['CARD', 'USDT_TRC20'],
        },
        untouched: 'preserved',
      },
      updatedAt: new Date('2026-04-16T15:18:00.000Z'),
    };
    const transactionClient: MockPrismaService = {
      settings: {
        findFirst: async (): Promise<MockSettingsRecord | null> => existingSettings,
        create: async (): Promise<MockSettingsRecord> => {
          throw new Error('transaction settings.create should not be called when settings already exist');
        },
        update: async (...args: readonly unknown[]): Promise<MockSettingsRecord> => {
          actualTransactionUpdateArgs = args[0];
          return updatedSettings;
        },
      },
      adminAuditLog: {
        create: async (args): Promise<void> => {
          actualAuditEntries.push((args as { readonly data: unknown }).data);
        },
      },
    };
    const prismaService: MockPrismaService = {
      settings: {
        findFirst: async (): Promise<MockSettingsRecord | null> => existingSettings,
        create: async (): Promise<MockSettingsRecord> => {
          throw new Error('root settings.create should not be called inside partner policy transaction');
        },
      },
      $transaction: async (
        callback: (_transactionClientInput: MockPrismaService) => Promise<MockSettingsRecord | MockAdminApiTokenRecord>,
      ): Promise<MockSettingsRecord> => callback(transactionClient) as Promise<MockSettingsRecord>,
    };
    const service = new SettingsService(prismaService as never);
    const actualPolicy = await service.updatePartnerWithdrawalPolicy({
      currentAdmin: CURRENT_ADMIN,
      requestMetadata: REQUEST_METADATA,
      updatePartnerWithdrawalPolicyDto: {
        minimumAmount: 250,
        supportedMethods: [' USDT_TRC20 ', 'CARD', 'CARD'],
      },
    });
    assert.deepStrictEqual(actualTransactionUpdateArgs, {
      where: { id: 'settings-1' },
      data: {
        partnerSettings: {
          withdrawals: {
            enabled: true,
            minimumAmount: 250,
            supportedMethods: ['CARD', 'USDT_TRC20'],
          },
          untouched: 'preserved',
        },
      },
    });
    assert.deepStrictEqual(actualAuditEntries, [
      {
        action: 'settings.partnerWithdrawalPolicy.updated',
        ipAddress: REQUEST_METADATA.remoteAddress,
        userAgent: REQUEST_METADATA.userAgent,
        metadata: {
          requestId: REQUEST_METADATA.requestId,
          updatedFields: ['minimumAmount', 'supportedMethods'],
        },
        adminUser: {
          connect: {
            id: CURRENT_ADMIN.id,
          },
        },
      },
    ]);
    assert.deepStrictEqual(actualPolicy, {
      enabled: true,
      minimumAmount: 250,
      supportedMethods: ['CARD', 'USDT_TRC20'],
      updatedAt: updatedSettings.updatedAt.toISOString(),
    });
  });

  it('updates payment-ops alert settings inside a transaction and records audit metadata for changed fields', async () => {
    let actualTransactionClient: MockPrismaService | null = null;
    let actualTransactionUpdateArgs: unknown;
    const actualAuditEntries: unknown[] = [];
    let hasRootUpdateBeenCalled = false;
    let hasRootAuditCreateBeenCalled = false;
    const existingSettings: MockSettingsRecord = {
      id: 'settings-1',
      rulesRequired: true,
      rulesLink: null,
      channelRequired: false,
      channelId: null,
      channelLink: null,
      accessMode: AccessMode.PUBLIC,
      inviteModeStartedAt: null,
      defaultCurrency: Currency.USD,
      systemNotifications: {
        paymentOps: {
          enabled: false,
          chatId: null,
          threadId: null,
          hashtag: '#payments_ops',
        },
      },
      updatedAt: new Date('2026-04-16T15:40:00.000Z'),
    };
    const updatedSettings: MockSettingsRecord = {
      ...existingSettings,
      systemNotifications: {
        paymentOps: {
          enabled: true,
          chatId: '-1009876543210',
          threadId: '84',
          hashtag: '#urgent_ops',
        },
      },
      updatedAt: new Date('2026-04-16T15:45:00.000Z'),
    };
    const transactionClient: MockPrismaService = {
      settings: {
        findFirst: async (): Promise<MockSettingsRecord | null> => existingSettings,
        create: async (): Promise<MockSettingsRecord> => {
          throw new Error('settings.create should not be called when a row already exists');
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
          throw new Error('root settings.findFirst should not be used inside the payment-ops update transaction');
        },
        create: async (): Promise<MockSettingsRecord> => {
          throw new Error('root settings.create should not be used inside the payment-ops update transaction');
        },
        update: async (): Promise<MockSettingsRecord> => {
          hasRootUpdateBeenCalled = true;
          throw new Error('root settings.update should not be used inside the payment-ops update transaction');
        },
      },
      adminAuditLog: {
        create: async (): Promise<void> => {
          hasRootAuditCreateBeenCalled = true;
          throw new Error('root adminAuditLog.create should not be used inside the payment-ops update transaction');
        },
      },
      $transaction: async (
        callback: (_transactionClientInput: MockPrismaService) => Promise<MockSettingsRecord | MockAdminApiTokenRecord>,
      ): Promise<MockSettingsRecord> => {
        actualTransactionClient = transactionClient;
        return callback(transactionClient) as Promise<MockSettingsRecord>;
      },
    };
    const service = new SettingsService(prismaService as never);
    const actualSettings = await service.updatePaymentOpsAlertSettings({
      currentAdmin: CURRENT_ADMIN,
      requestMetadata: REQUEST_METADATA,
      updatePaymentOpsAlertSettingsDto: {
        enabled: true,
        chatId: ' -1009876543210 ',
        threadId: ' 84 ',
        hashtag: '  #Urgent Ops  ',
      },
    });
    assert.equal(actualTransactionClient, transactionClient);
    assert.equal(hasRootUpdateBeenCalled, false);
    assert.equal(hasRootAuditCreateBeenCalled, false);
    assert.deepStrictEqual(actualTransactionUpdateArgs, {
      where: { id: 'settings-1' },
      data: {
        systemNotifications: {
          paymentOps: {
            enabled: true,
            chatId: '-1009876543210',
            threadId: '84',
            hashtag: '#urgent_ops',
          },
        },
      },
    });
    assert.deepStrictEqual(actualAuditEntries, [
      {
        data: {
          action: 'settings.paymentOpsAlert.updated',
          ipAddress: REQUEST_METADATA.remoteAddress,
          userAgent: REQUEST_METADATA.userAgent,
          metadata: {
            requestId: REQUEST_METADATA.requestId,
            updatedFields: ['enabled', 'chatId', 'threadId', 'hashtag'],
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
      enabled: true,
      chatId: '-1009876543210',
      threadId: '84',
      hashtag: '#urgent_ops',
    });
  });

  it('throws BadRequestException when sending a payment-ops test alert without a configured chat id', async () => {
    let hasAuditCreateBeenCalled = false;
    const prismaService: MockPrismaService = {
      settings: {
        findFirst: async (): Promise<MockSettingsRecord | null> => ({
          id: 'settings-1',
          rulesRequired: true,
          rulesLink: null,
          channelRequired: false,
          channelId: null,
          channelLink: null,
          accessMode: AccessMode.PUBLIC,
          inviteModeStartedAt: null,
          defaultCurrency: Currency.USD,
          systemNotifications: {
            paymentOps: {
              enabled: true,
              chatId: null,
              threadId: null,
              hashtag: '#payments_ops',
            },
          },
          updatedAt: new Date('2026-04-16T15:50:00.000Z'),
        }),
        create: async (): Promise<MockSettingsRecord> => {
          throw new Error('settings.create should not be called when a row already exists');
        },
      },
      adminAuditLog: {
        create: async (): Promise<void> => {
          hasAuditCreateBeenCalled = true;
          throw new Error('adminAuditLog.create should not be called when sending the test alert fails early');
        },
      },
    };
    const service = new SettingsService(prismaService as never);
    await assert.rejects(
      async () => {
        await service.sendPaymentOpsAlertTest({
          currentAdmin: CURRENT_ADMIN,
          requestMetadata: REQUEST_METADATA,
          sendPaymentOpsAlertTestDto: {
            note: 'Verify missing chat handling',
          },
        });
      },
      (error: unknown): boolean => {
        assert.equal((error as { readonly message?: string }).message, 'PAYMENT_OPS_ALERT_CHAT_NOT_CONFIGURED');
        return true;
      },
    );
    assert.equal(hasAuditCreateBeenCalled, false);
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
      defaultCurrency: Currency.USDT,
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
        callback: (_transactionClientInput: MockPrismaService) => Promise<MockSettingsRecord | MockAdminApiTokenRecord>,
      ): Promise<MockSettingsRecord> => {
        actualTransactionClient = transactionClient;
        return callback(transactionClient) as Promise<MockSettingsRecord>;
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
        defaultCurrency: Currency.USDT,
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
          defaultCurrency: Currency.USDT,
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
      defaultCurrency: Currency.USDT,
      branding: EXPECTED_EMPTY_BRANDING,
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
        callback: (_transactionClientInput: MockPrismaService) => Promise<MockSettingsRecord | MockAdminApiTokenRecord>,
      ): Promise<MockSettingsRecord> => {
        actualTransactionClient = transactionClient;
        return callback(transactionClient) as Promise<MockSettingsRecord>;
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
      branding: EXPECTED_EMPTY_BRANDING,
      updatedAt: updatedSettings.updatedAt.toISOString(),
    });
  });

  it('merges partial platform branding updates without erasing omitted fields', async () => {
    let actualTransactionUpdateArgs: unknown;
    const existingBranding = {
      projectName: 'Old project',
      webTitle: 'Old web title',
      supportUrl: 'https://support.example.com',
      supportUsername: 'old_support',
      accessRequestIntro: 'Old request intro',
      accessApprovedMessage: 'Old approved message',
      accessRejectedMessage: 'Old rejected message',
    } as const;
    const expectedBranding = {
      ...existingBranding,
      projectName: 'New project',
      accessApprovedMessage: null,
    } as const;
    const existingSettings: MockSettingsRecord = {
      id: 'settings-1',
      rulesRequired: true,
      rulesLink: null,
      channelRequired: false,
      channelId: null,
      channelLink: null,
      accessMode: AccessMode.PUBLIC,
      inviteModeStartedAt: null,
      defaultCurrency: Currency.USD,
      branding: existingBranding,
      updatedAt: new Date('2026-04-16T16:10:00.000Z'),
    };
    const updatedSettings: MockSettingsRecord = {
      ...existingSettings,
      branding: expectedBranding,
      updatedAt: new Date('2026-04-16T16:15:00.000Z'),
    };
    const transactionClient: MockPrismaService = {
      settings: {
        findFirst: async (): Promise<MockSettingsRecord | null> => existingSettings,
        create: async (): Promise<MockSettingsRecord> => {
          throw new Error('settings.create should not be called when settings already exist');
        },
        update: async (...args: readonly unknown[]): Promise<MockSettingsRecord> => {
          actualTransactionUpdateArgs = args[0];
          return updatedSettings;
        },
      },
      adminAuditLog: {
        create: async (): Promise<void> => {},
      },
    };
    const prismaService: MockPrismaService = {
      settings: {
        findFirst: async (): Promise<MockSettingsRecord | null> => {
          throw new Error('root settings.findFirst should not be used inside the branding update transaction');
        },
        create: async (): Promise<MockSettingsRecord> => {
          throw new Error('root settings.create should not be used inside the branding update transaction');
        },
        update: async (): Promise<MockSettingsRecord> => {
          throw new Error('root settings.update should not be used inside the branding update transaction');
        },
      },
      adminAuditLog: {
        create: async (): Promise<void> => {
          throw new Error('root adminAuditLog.create should not be used inside the branding update transaction');
        },
      },
      $transaction: async (
        callback: (_transactionClientInput: MockPrismaService) => Promise<MockSettingsRecord | MockAdminApiTokenRecord>,
      ): Promise<MockSettingsRecord> => callback(transactionClient) as Promise<MockSettingsRecord>,
    };
    const service = new SettingsService(prismaService as never);
    const actualSettings = await service.updatePlatformSettings({
      currentAdmin: CURRENT_ADMIN,
      requestMetadata: REQUEST_METADATA,
      updatePlatformSettingsDto: {
        branding: {
          projectName: ' New project ',
          accessApprovedMessage: '',
        },
      },
    });
    assert.deepStrictEqual(actualTransactionUpdateArgs, {
      where: { id: 'settings-1' },
      data: {
        branding: expectedBranding,
      },
    });
    assert.deepStrictEqual(actualSettings.branding, expectedBranding);
  });

  it('rejects null platform branding payloads before writing settings', async () => {
    let hasUpdateBeenCalled = false;
    const existingSettings: MockSettingsRecord = {
      id: 'settings-1',
      rulesRequired: true,
      rulesLink: null,
      channelRequired: false,
      channelId: null,
      channelLink: null,
      accessMode: AccessMode.PUBLIC,
      inviteModeStartedAt: null,
      defaultCurrency: Currency.USD,
      branding: EXPECTED_EMPTY_BRANDING,
      updatedAt: new Date('2026-04-16T16:20:00.000Z'),
    };
    const transactionClient: MockPrismaService = {
      settings: {
        findFirst: async (): Promise<MockSettingsRecord | null> => existingSettings,
        create: async (): Promise<MockSettingsRecord> => {
          throw new Error('settings.create should not be called when settings already exist');
        },
        update: async (): Promise<MockSettingsRecord> => {
          hasUpdateBeenCalled = true;
          throw new Error('settings.update should not be called for invalid branding payloads');
        },
      },
      adminAuditLog: {
        create: async (): Promise<void> => {
          throw new Error('adminAuditLog.create should not be called for invalid branding payloads');
        },
      },
    };
    const prismaService: MockPrismaService = {
      settings: {
        findFirst: async (): Promise<MockSettingsRecord | null> => null,
        create: async (): Promise<MockSettingsRecord> => {
          throw new Error('root settings.create should not be called for invalid branding payloads');
        },
      },
      $transaction: async (
        callback: (_transactionClientInput: MockPrismaService) => Promise<MockSettingsRecord | MockAdminApiTokenRecord>,
      ): Promise<MockSettingsRecord> => callback(transactionClient) as Promise<MockSettingsRecord>,
    };
    const service = new SettingsService(prismaService as never);
    await assert.rejects(
      () => service.updatePlatformSettings({
        currentAdmin: CURRENT_ADMIN,
        requestMetadata: REQUEST_METADATA,
        updatePlatformSettingsDto: { branding: null } as never,
      }),
      /branding must be an object/,
    );
    assert.equal(hasUpdateBeenCalled, false);
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
      branding: EXPECTED_EMPTY_BRANDING,
      updatedAt: '2026-04-16T17:00:00.000Z',
    });
  });

  it('updates notification templates and records audit log inside one transaction', async () => {
    const events: string[] = [];
    let actualTransactionClient: MockPrismaService | null = null;
    let hasRootUpdateBeenCalled = false;
    let hasRootAuditCreateBeenCalled = false;
    let actualUpdateArgs: unknown;
    let actualAuditArgs: unknown;
    const updatedAt = new Date('2026-04-16T18:00:00.000Z');
    const existingSettings: MockSettingsRecord = {
      id: 'settings-templates-1',
      rulesRequired: true,
      rulesLink: null,
      channelRequired: false,
      channelId: null,
      channelLink: null,
      accessMode: AccessMode.PUBLIC,
      inviteModeStartedAt: null,
      defaultCurrency: Currency.USD,
      botMenu: {
        notificationTemplates: {
          PAYMENT_COMPLETED: 'old completed template',
          PAYMENT_FAILED: 'old failed template',
        },
      },
      updatedAt,
    };
    const updatedSettings: MockSettingsRecord = {
      ...existingSettings,
      botMenu: {
        notificationTemplates: {
          PAYMENT_COMPLETED: 'new completed template',
          PAYMENT_FAILED: 'new failed template',
        },
      },
    };
    const transactionClient: MockPrismaService = {
      settings: {
        findFirst: async (): Promise<MockSettingsRecord | null> => {
          events.push('tx.settings.findFirst');
          return existingSettings;
        },
        create: async (): Promise<MockSettingsRecord> => {
          throw new Error('settings.create should not be called when settings already exist');
        },
        update: async (...args: readonly unknown[]): Promise<MockSettingsRecord> => {
          events.push('tx.settings.update');
          actualUpdateArgs = args[0];
          return updatedSettings;
        },
      },
      adminAuditLog: {
        create: async (args: unknown): Promise<void> => {
          events.push('tx.adminAuditLog.create');
          actualAuditArgs = args;
        },
      },
    };
    const prismaService: MockPrismaService = {
      settings: {
        findFirst: async (): Promise<MockSettingsRecord | null> => {
          throw new Error('root settings.findFirst should not be used inside the notification template transaction');
        },
        create: async (): Promise<MockSettingsRecord> => {
          throw new Error('root settings.create should not be called when settings already exist');
        },
        update: async (): Promise<MockSettingsRecord> => {
          hasRootUpdateBeenCalled = true;
          throw new Error('root settings.update should not be used for notification template writes');
        },
      },
      adminAuditLog: {
        create: async (): Promise<void> => {
          hasRootAuditCreateBeenCalled = true;
          throw new Error('root adminAuditLog.create should not be used for notification template audit writes');
        },
      },
      $transaction: async (
        callback: (_transactionClientInput: MockPrismaService) => Promise<MockSettingsRecord | MockAdminApiTokenRecord>,
      ): Promise<MockSettingsRecord> => {
        events.push('transaction.begin');
        actualTransactionClient = transactionClient;
        const result = await callback(transactionClient);
        events.push('transaction.commit');
        return result as MockSettingsRecord;
      },
    };
    const service = new SettingsService(prismaService as never);
    const actualTemplates = await service.updateNotificationTemplates({
      currentAdmin: CURRENT_ADMIN,
      requestMetadata: REQUEST_METADATA,
      dto: {
        paymentCompleted: 'new completed template',
        paymentFailed: 'new failed template',
      },
    });
    assert.equal(actualTransactionClient, transactionClient);
    assert.equal(hasRootUpdateBeenCalled, false);
    assert.equal(hasRootAuditCreateBeenCalled, false);
    assert.deepStrictEqual(events, [
      'transaction.begin',
      'tx.settings.findFirst',
      'tx.settings.update',
      'tx.adminAuditLog.create',
      'transaction.commit',
    ]);
    assert.deepStrictEqual((actualUpdateArgs as { readonly where: unknown }).where, { id: existingSettings.id });
    assert.deepStrictEqual(actualAuditArgs, {
      data: {
        adminUserId: CURRENT_ADMIN.id,
        action: 'UPDATE_NOTIFICATION_TEMPLATES',
        metadata: { updatedFields: ['paymentCompleted', 'paymentFailed'] },
      },
    });
    assert.deepStrictEqual(actualTemplates, {
      paymentCompleted: 'new completed template',
      paymentFailed: 'new failed template',
    });
  });

  it('lists admin api tokens without exposing plaintext secrets', async () => {
    let actualFindManyArgs: unknown;
    const prismaService: MockPrismaService = {
      adminApiToken: {
        findMany: async (...args: readonly unknown[]): Promise<readonly MockAdminApiTokenRecord[]> => {
          actualFindManyArgs = args[0];
          return [
            {
              id: 'token-2',
              name: 'Support dashboard',
              description: null,
              tokenPrefix: 'rzadm_abcdef123456',
              secretHash: 'hidden-hash',
              lastUsedAt: new Date('2026-04-17T09:00:00.000Z'),
              revokedAt: null,
              createdByAdminUserId: CURRENT_ADMIN.id,
              createdAt: new Date('2026-04-17T08:00:00.000Z'),
              updatedAt: new Date('2026-04-17T08:30:00.000Z'),
            },
          ];
        },
      },
      settings: {
        findFirst: async (): Promise<MockSettingsRecord | null> => null,
        create: async (): Promise<MockSettingsRecord> => {
          throw new Error('settings.create should not be called when listing api tokens');
        },
      },
    };
    const service = new SettingsService(prismaService as never);
    const actualTokens = await service.listApiTokens();
    assert.deepStrictEqual(actualFindManyArgs, {
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    assert.deepStrictEqual(actualTokens, [
      {
        id: 'token-2',
        name: 'Support dashboard',
        description: null,
        tokenPrefix: 'rzadm_abcdef123456',
        lastUsedAt: '2026-04-17T09:00:00.000Z',
        revokedAt: null,
        createdAt: '2026-04-17T08:00:00.000Z',
        updatedAt: '2026-04-17T08:30:00.000Z',
      },
    ]);
  });

  it('creates an admin api token inside a transaction, stores only the secret hash, and records an audit log entry', async () => {
    let actualTransactionClient: MockPrismaService | null = null;
    let actualCreateArgs: unknown;
    const actualAuditEntries: unknown[] = [];
    let hasRootCreateBeenCalled = false;
    let hasRootAuditCreateBeenCalled = false;
    const createdToken: MockAdminApiTokenRecord = {
      id: 'token-3',
      name: 'Internal automation',
      description: 'Used by CI jobs',
      tokenPrefix: 'placeholder',
      secretHash: 'placeholder',
      lastUsedAt: null,
      revokedAt: null,
      createdByAdminUserId: CURRENT_ADMIN.id,
      createdAt: new Date('2026-04-18T10:00:00.000Z'),
      updatedAt: new Date('2026-04-18T10:00:00.000Z'),
    };
    const transactionClient: MockPrismaService = {
      adminApiToken: {
        create: async (...args: readonly unknown[]): Promise<MockAdminApiTokenRecord> => {
          actualCreateArgs = args[0];
          const data = args[0] as {
            readonly data: {
              readonly name: string;
              readonly description: string | null;
              readonly tokenPrefix: string;
              readonly secretHash: string;
              readonly createdByAdminUser: {
                readonly connect: {
                  readonly id: string;
                };
              };
            };
          };
          return {
            ...createdToken,
            name: data.data.name,
            description: data.data.description,
            tokenPrefix: data.data.tokenPrefix,
            secretHash: data.data.secretHash,
          };
        },
      },
      settings: {
        findFirst: async (): Promise<MockSettingsRecord | null> => null,
        create: async (): Promise<MockSettingsRecord> => {
          throw new Error('settings.create should not be called when creating api tokens');
        },
      },
      adminAuditLog: {
        create: async (args): Promise<void> => {
          actualAuditEntries.push(args);
        },
      },
    };
    const prismaService: MockPrismaService = {
      adminApiToken: {
        create: async (): Promise<MockAdminApiTokenRecord> => {
          hasRootCreateBeenCalled = true;
          throw new Error('root adminApiToken.create should not be used inside the token transaction');
        },
      },
      settings: {
        findFirst: async (): Promise<MockSettingsRecord | null> => null,
        create: async (): Promise<MockSettingsRecord> => {
          throw new Error('settings.create should not be called when creating api tokens');
        },
      },
      adminAuditLog: {
        create: async (): Promise<void> => {
          hasRootAuditCreateBeenCalled = true;
          throw new Error('root adminAuditLog.create should not be used inside the token transaction');
        },
      },
      $transaction: async (
        callback: (_transactionClientInput: MockPrismaService) => Promise<MockSettingsRecord | MockAdminApiTokenRecord>,
      ): Promise<MockAdminApiTokenRecord> => {
        actualTransactionClient = transactionClient;
        return callback(transactionClient) as Promise<MockAdminApiTokenRecord>;
      },
    };
    const service = new SettingsService(prismaService as never);
    const actualResponse = await service.createApiToken({
      currentAdmin: CURRENT_ADMIN,
      requestMetadata: REQUEST_METADATA,
      createAdminApiTokenDto: {
        name: '  Internal automation  ',
        description: '  Used by CI jobs  ',
      },
    });
    const [actualTokenPrefix, plaintextSecret] = actualResponse.plaintextToken.split('.');
    assert.equal(actualTransactionClient, transactionClient);
    assert.equal(hasRootCreateBeenCalled, false);
    assert.equal(hasRootAuditCreateBeenCalled, false);
    assert.equal(actualTokenPrefix.startsWith('rzadm_'), true);
    assert.equal(plaintextSecret.length > 0, true);
    assert.deepStrictEqual(actualCreateArgs, {
      data: {
        name: 'Internal automation',
        description: 'Used by CI jobs',
        tokenPrefix: actualTokenPrefix,
        secretHash: createHash('sha256').update(plaintextSecret, 'utf8').digest('hex'),
        createdByAdminUser: {
          connect: {
            id: CURRENT_ADMIN.id,
          },
        },
      },
    });
    assert.deepStrictEqual(actualAuditEntries, [
      {
        data: {
          action: 'settings.apiToken.created',
          ipAddress: REQUEST_METADATA.remoteAddress,
          userAgent: REQUEST_METADATA.userAgent,
          metadata: {
            requestId: REQUEST_METADATA.requestId,
            tokenId: 'token-3',
            tokenPrefix: actualTokenPrefix,
            name: 'Internal automation',
          },
          adminUser: {
            connect: {
              id: CURRENT_ADMIN.id,
            },
          },
        },
      },
    ]);
    assert.deepStrictEqual(actualResponse.token, {
      id: 'token-3',
      name: 'Internal automation',
      description: 'Used by CI jobs',
      tokenPrefix: actualTokenPrefix,
      lastUsedAt: null,
      revokedAt: null,
      createdAt: '2026-04-18T10:00:00.000Z',
      updatedAt: '2026-04-18T10:00:00.000Z',
    });
    assert.equal(actualResponse.plaintextToken.includes('Internal automation'), false);
  });

  it('revokes an active api token inside a transaction and records one revoke audit entry', async () => {
    let actualTransactionClient: MockPrismaService | null = null;
    let actualFindUniqueArgs: unknown;
    let actualUpdateArgs: unknown;
    const actualAuditEntries: unknown[] = [];
    let hasRootFindUniqueBeenCalled = false;
    let hasRootUpdateBeenCalled = false;
    let hasRootAuditCreateBeenCalled = false;
    const activeToken: MockAdminApiTokenRecord = {
      id: 'token-4',
      name: 'Support dashboard',
      description: null,
      tokenPrefix: 'rzadm_support',
      secretHash: 'hidden-hash',
      lastUsedAt: new Date('2026-04-18T12:00:00.000Z'),
      revokedAt: null,
      createdByAdminUserId: CURRENT_ADMIN.id,
      createdAt: new Date('2026-04-18T10:00:00.000Z'),
      updatedAt: new Date('2026-04-18T10:00:00.000Z'),
    };
    let persistedRevokedAt: Date | null = null;
    let revokedToken: MockAdminApiTokenRecord = {
      ...activeToken,
      revokedAt: null,
      updatedAt: activeToken.updatedAt,
    };
    const transactionClient: MockPrismaService = {
      adminApiToken: {
        findUnique: async (...args: readonly unknown[]): Promise<MockAdminApiTokenRecord | null> => {
          actualFindUniqueArgs = args[0];
          return activeToken;
        },
        update: async (...args: readonly unknown[]): Promise<MockAdminApiTokenRecord> => {
          actualUpdateArgs = args[0];
          const updateArgs = args[0] as {
            readonly data: {
              readonly revokedAt: Date;
            };
          };
          persistedRevokedAt = updateArgs.data.revokedAt;
          revokedToken = {
            ...activeToken,
            revokedAt: persistedRevokedAt,
            updatedAt: persistedRevokedAt,
          };
          return revokedToken;
        },
      },
      settings: {
        findFirst: async (): Promise<MockSettingsRecord | null> => null,
        create: async (): Promise<MockSettingsRecord> => {
          throw new Error('settings.create should not be called when revoking api tokens');
        },
      },
      adminAuditLog: {
        create: async (args): Promise<void> => {
          actualAuditEntries.push(args);
        },
      },
    };
    const prismaService: MockPrismaService = {
      adminApiToken: {
        findUnique: async (): Promise<MockAdminApiTokenRecord | null> => {
          hasRootFindUniqueBeenCalled = true;
          throw new Error('root adminApiToken.findUnique should not be used inside the revoke transaction');
        },
        update: async (): Promise<MockAdminApiTokenRecord> => {
          hasRootUpdateBeenCalled = true;
          throw new Error('root adminApiToken.update should not be used inside the revoke transaction');
        },
      },
      settings: {
        findFirst: async (): Promise<MockSettingsRecord | null> => null,
        create: async (): Promise<MockSettingsRecord> => {
          throw new Error('settings.create should not be called when revoking api tokens');
        },
      },
      adminAuditLog: {
        create: async (): Promise<void> => {
          hasRootAuditCreateBeenCalled = true;
          throw new Error('root adminAuditLog.create should not be used inside the revoke transaction');
        },
      },
      $transaction: async (
        callback: (_transactionClientInput: MockPrismaService) => Promise<MockSettingsRecord | MockAdminApiTokenRecord>,
      ): Promise<MockAdminApiTokenRecord> => {
        actualTransactionClient = transactionClient;
        return callback(transactionClient) as Promise<MockAdminApiTokenRecord>;
      },
    };
    const service = new SettingsService(prismaService as never);
    const actualResponse = await service.revokeApiToken({
      tokenId: activeToken.id,
      currentAdmin: CURRENT_ADMIN,
      requestMetadata: REQUEST_METADATA,
    });
    assert.equal(actualTransactionClient, transactionClient);
    assert.equal(hasRootFindUniqueBeenCalled, false);
    assert.equal(hasRootUpdateBeenCalled, false);
    assert.equal(hasRootAuditCreateBeenCalled, false);
    assert.deepStrictEqual(actualFindUniqueArgs, {
      where: { id: activeToken.id },
    });
    assert.deepStrictEqual((actualUpdateArgs as { readonly where: unknown }).where, {
      id: activeToken.id,
    });
    assert.notEqual(persistedRevokedAt, null);
    assert.deepStrictEqual(actualAuditEntries, [
      {
        data: {
          action: 'settings.apiToken.revoked',
          ipAddress: REQUEST_METADATA.remoteAddress,
          userAgent: REQUEST_METADATA.userAgent,
          metadata: {
            requestId: REQUEST_METADATA.requestId,
            tokenId: revokedToken.id,
            tokenPrefix: revokedToken.tokenPrefix,
            name: revokedToken.name,
            revokedAt: revokedToken.revokedAt?.toISOString() ?? null,
          },
          adminUser: {
            connect: {
              id: CURRENT_ADMIN.id,
            },
          },
        },
      },
    ]);
    assert.deepStrictEqual(actualResponse, {
      id: revokedToken.id,
      name: revokedToken.name,
      description: revokedToken.description,
      tokenPrefix: revokedToken.tokenPrefix,
      lastUsedAt: revokedToken.lastUsedAt?.toISOString() ?? null,
      revokedAt: revokedToken.revokedAt?.toISOString() ?? null,
      createdAt: revokedToken.createdAt.toISOString(),
      updatedAt: revokedToken.updatedAt.toISOString(),
    });
  });

  it('returns an already revoked api token unchanged without update or extra audit log', async () => {
    let hasUpdateBeenCalled = false;
    let hasAuditCreateBeenCalled = false;
    const revokedToken: MockAdminApiTokenRecord = {
      id: 'token-5',
      name: 'Already revoked',
      description: 'Legacy token',
      tokenPrefix: 'rzadm_revoked',
      secretHash: 'hidden-hash',
      lastUsedAt: null,
      revokedAt: new Date('2026-04-18T08:00:00.000Z'),
      createdByAdminUserId: CURRENT_ADMIN.id,
      createdAt: new Date('2026-04-17T08:00:00.000Z'),
      updatedAt: new Date('2026-04-18T08:00:00.000Z'),
    };
    const transactionClient: MockPrismaService = {
      adminApiToken: {
        findUnique: async (): Promise<MockAdminApiTokenRecord | null> => revokedToken,
        update: async (): Promise<MockAdminApiTokenRecord> => {
          hasUpdateBeenCalled = true;
          throw new Error('adminApiToken.update should not be called for already revoked tokens');
        },
      },
      settings: {
        findFirst: async (): Promise<MockSettingsRecord | null> => null,
        create: async (): Promise<MockSettingsRecord> => {
          throw new Error('settings.create should not be called when revoking api tokens');
        },
      },
      adminAuditLog: {
        create: async (): Promise<void> => {
          hasAuditCreateBeenCalled = true;
          throw new Error('adminAuditLog.create should not be called for already revoked tokens');
        },
      },
    };
    const prismaService: MockPrismaService = {
      settings: {
        findFirst: async (): Promise<MockSettingsRecord | null> => null,
        create: async (): Promise<MockSettingsRecord> => {
          throw new Error('settings.create should not be called when revoking api tokens');
        },
      },
      $transaction: async (
        callback: (_transactionClientInput: MockPrismaService) => Promise<MockSettingsRecord | MockAdminApiTokenRecord>,
      ): Promise<MockAdminApiTokenRecord> => {
        return callback(transactionClient) as Promise<MockAdminApiTokenRecord>;
      },
    };
    const service = new SettingsService(prismaService as never);
    const actualResponse = await service.revokeApiToken({
      tokenId: revokedToken.id,
      currentAdmin: CURRENT_ADMIN,
      requestMetadata: REQUEST_METADATA,
    });
    assert.equal(hasUpdateBeenCalled, false);
    assert.equal(hasAuditCreateBeenCalled, false);
    assert.deepStrictEqual(actualResponse, {
      id: revokedToken.id,
      name: revokedToken.name,
      description: revokedToken.description,
      tokenPrefix: revokedToken.tokenPrefix,
      lastUsedAt: null,
      revokedAt: revokedToken.revokedAt?.toISOString() ?? null,
      createdAt: revokedToken.createdAt.toISOString(),
      updatedAt: revokedToken.updatedAt.toISOString(),
    });
  });

  it('throws NotFoundException when revoking a missing api token', async () => {
    let hasUpdateBeenCalled = false;
    let hasAuditCreateBeenCalled = false;
    const transactionClient: MockPrismaService = {
      adminApiToken: {
        findUnique: async (): Promise<MockAdminApiTokenRecord | null> => null,
        update: async (): Promise<MockAdminApiTokenRecord> => {
          hasUpdateBeenCalled = true;
          throw new Error('adminApiToken.update should not be called when token is missing');
        },
      },
      settings: {
        findFirst: async (): Promise<MockSettingsRecord | null> => null,
        create: async (): Promise<MockSettingsRecord> => {
          throw new Error('settings.create should not be called when revoking api tokens');
        },
      },
      adminAuditLog: {
        create: async (): Promise<void> => {
          hasAuditCreateBeenCalled = true;
          throw new Error('adminAuditLog.create should not be called when token is missing');
        },
      },
    };
    const prismaService: MockPrismaService = {
      settings: {
        findFirst: async (): Promise<MockSettingsRecord | null> => null,
        create: async (): Promise<MockSettingsRecord> => {
          throw new Error('settings.create should not be called when revoking api tokens');
        },
      },
      $transaction: async (
        callback: (_transactionClientInput: MockPrismaService) => Promise<MockSettingsRecord | MockAdminApiTokenRecord>,
      ): Promise<MockAdminApiTokenRecord> => {
        return callback(transactionClient) as Promise<MockAdminApiTokenRecord>;
      },
    };
    const service = new SettingsService(prismaService as never);
    await assert.rejects(
      async () => {
        await service.revokeApiToken({
          tokenId: 'missing-token',
          currentAdmin: CURRENT_ADMIN,
          requestMetadata: REQUEST_METADATA,
        });
      },
      (error: unknown): boolean => {
        assert.ok(error instanceof NotFoundException);
        assert.equal(error.message, 'API_TOKEN_NOT_FOUND');
        return true;
      },
    );
    assert.equal(hasUpdateBeenCalled, false);
    assert.equal(hasAuditCreateBeenCalled, false);
  });
});
