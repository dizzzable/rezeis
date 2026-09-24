import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BadRequestException } from '@nestjs/common';
import { AccessMode, Currency, UserRole } from '@prisma/client';

import { DEFAULT_PAYMENT_OPS_ALERT_SETTINGS } from '../src/common/interfaces/payment-ops-alert-settings.interface';
import { CurrentAdminInterface } from '../src/modules/auth/interfaces/current-admin.interface';
import { IconUploadService } from '../src/modules/settings/services/icon-upload.service';
import { SettingsService } from '../src/modules/settings/services/settings.service';

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
  rbacRoleId: null,
  mustChangePassword: false,
};

const REQUEST_METADATA = {
  requestId: 'request-2',
  remoteAddress: '203.0.113.10',
  userAgent: 'settings-spec',
} as const;

function buildSettingsRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'settings-1',
    rulesRequired: true,
    rulesLink: null,
    channelRequired: false,
    channelId: null,
    channelLink: null,
    channelNewUsersSince: null,
    accessMode: AccessMode.PUBLIC,
    inviteModeStartedAt: null,
    defaultCurrency: Currency.USD,
    userNotifications: null,
    systemNotifications: null,
    brandingSettings: null,
    referralSettings: null,
    partnerSettings: null,
    pointsSettings: null,
    multiSubscriptionSettings: null,
    customIcons: null,
    updatedAt: new Date('2026-04-16T15:00:00.000Z'),
    ...overrides,
  };
}

function createService(prismaService: unknown, iconUploadService: Partial<IconUploadService> = {}): SettingsService {
  return new SettingsService(
    prismaService as never,
    iconUploadService as unknown as IconUploadService,
    { cryptKey: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } as never,
  );
}

describe('SettingsService', () => {
  it('returns platform settings and creates defaults when the singleton row is missing', async () => {
    let actualFindFirstArgs: unknown;
    let actualCreateArgs: unknown;
    const createdAt = new Date('2026-04-16T15:10:00.000Z');
    const prismaService = {
      settings: {
        findFirst: async (args: unknown) => {
          actualFindFirstArgs = args;
          return null;
        },
        create: async (args: unknown) => {
          actualCreateArgs = args;
          return buildSettingsRecord({
            rulesLink: '',
            channelLink: '',
            updatedAt: createdAt,
          });
        },
      },
    };

    const actualSettings = await createService(prismaService).getPlatformSettings();

    assert.deepStrictEqual(actualFindFirstArgs, { orderBy: { updatedAt: 'asc' } });
    assert.deepStrictEqual(actualCreateArgs, { data: {} });
    assert.deepStrictEqual(actualSettings, {
      rulesRequired: true,
      rulesLink: '',
      channelRequired: false,
      channelId: null,
      channelLink: '',
      channelNewUsersSince: null,
      accessMode: AccessMode.PUBLIC,
      inviteModeStartedAt: null,
      defaultCurrency: Currency.USD,
      updatedAt: createdAt.toISOString(),
    });
  });

  it('keeps internal platform policy read-only when settings are missing', async () => {
    let hasCreateBeenCalled = false;
    const service = createService({
      settings: {
        findFirst: async () => null,
        create: async () => {
          hasCreateBeenCalled = true;
          throw new Error('create must not be called by the internal read-only policy path');
        },
      },
    });

    assert.deepStrictEqual(await service.getInternalPlatformPolicy(), {
      rulesRequired: true,
      rulesLink: null,
      channelRequired: false,
      channelLink: null,
      channelId: null,
      channelUsername: null,
      channelRecheck: true,
      // «Проверять только новых» starts OFF: the gate asks everyone, as before.
      channelNewUsersSince: null,
      requireTelegramWebCredentials: false,
      // «Восстановление пароля по ссылке подписки» is ON until an operator
      // switches it off — a fresh install included.
      subscriptionLinkRecovery: true,
      accessMode: AccessMode.PUBLIC,
      inviteModeStartedAt: null,
      defaultCurrency: Currency.USD,
    });
    assert.equal(hasCreateBeenCalled, false);
  });

  it('returns default payment-ops alert settings when system notifications are absent', async () => {
    const service = createService({
      settings: {
        findFirst: async () => buildSettingsRecord({ systemNotifications: null }),
        create: async () => {
          throw new Error('settings.create should not be called when a row already exists');
        },
      },
    });

    assert.deepStrictEqual(await service.getPaymentOpsAlertSettings(), DEFAULT_PAYMENT_OPS_ALERT_SETTINGS);
  });

  it('updates platform settings with normalized nullable fields and bounded audit metadata', async () => {
    const updateCalls: unknown[] = [];
    const auditEntries: unknown[] = [];
    const existingSettings = buildSettingsRecord({ id: 'settings-1' });
    const updatedSettings = buildSettingsRecord({
      rulesRequired: false,
      rulesLink: '',
      channelId: BigInt('-1009876543210'),
      multiSubscriptionSettings: { enabled: true, defaultMaxSubscriptions: 5 },
      updatedAt: new Date('2026-04-16T16:00:00.000Z'),
    });
    const transactionClient = {
      // The settings row lock (`SELECT "id" FROM "settings" FOR UPDATE`) finding the row.
      $queryRaw: async () => [{ id: existingSettings.id }],
      settings: {
        findFirst: async () => existingSettings,
        create: async () => {
          throw new Error('transaction settings.create should not be called when settings already exist');
        },
        update: async (args: unknown) => {
          updateCalls.push(args);
          return updatedSettings;
        },
      },
      adminAuditLog: {
        create: async (args: { readonly data: unknown }) => {
          auditEntries.push(args.data);
        },
      },
    };
    const service = createService({
      settings: {
        findFirst: async () => existingSettings,
        create: async () => existingSettings,
      },
      $transaction: async (callback: (client: typeof transactionClient) => Promise<unknown>) => callback(transactionClient),
    });

    const actualSettings = await service.updatePlatformSettings({
      currentAdmin: CURRENT_ADMIN,
      requestMetadata: REQUEST_METADATA,
      updatePlatformSettingsDto: {
        rulesRequired: false,
        rulesLink: null,
        channelId: '-1009876543210',
        multiSubscriptionSettings: { enabled: true, defaultMaxSubscriptions: 5 },
      },
    });

    assert.deepStrictEqual(updateCalls, [
      {
        where: { id: 'settings-1' },
        data: {
          rulesRequired: false,
          rulesLink: '',
          channelId: BigInt('-1009876543210'),
          multiSubscriptionSettings: { enabled: true, defaultMaxSubscriptions: 5 },
        },
      },
    ]);
    assert.deepStrictEqual(auditEntries, [
      {
        action: 'settings.platform.updated',
        ipAddress: REQUEST_METADATA.remoteAddress,
        userAgent: REQUEST_METADATA.userAgent,
        metadata: {
          requestId: REQUEST_METADATA.requestId,
          updatedFields: ['rulesRequired', 'rulesLink', 'channelId', 'multiSubscriptionSettings'],
        },
        adminUser: { connect: { id: CURRENT_ADMIN.id } },
      },
    ]);
    assert.deepStrictEqual(actualSettings, {
      rulesRequired: false,
      rulesLink: '',
      channelRequired: false,
      channelId: '-1009876543210',
      channelLink: null,
      channelNewUsersSince: null,
      accessMode: AccessMode.PUBLIC,
      inviteModeStartedAt: null,
      defaultCurrency: Currency.USD,
      updatedAt: '2026-04-16T16:00:00.000Z',
    });
  });

  it('merge-updates notification toggle maps and records audit metadata', async () => {
    const updateCalls: unknown[] = [];
    const auditEntries: unknown[] = [];
    const existingSettings = buildSettingsRecord({
      userNotifications: { expiresSoon: true },
      systemNotifications: { incidents: true, telegram: { chatId: '-100123' } },
    });
    const updatedSettings = buildSettingsRecord({
      userNotifications: { expiresSoon: true, referralReward: false },
      systemNotifications: { incidents: false, telegram: { chatId: '-100123' } },
    });
    const transactionClient = {
      $queryRaw: async () => [{ id: existingSettings.id }],
      settings: {
        findFirst: async () => existingSettings,
        create: async () => existingSettings,
        update: async (args: unknown) => {
          updateCalls.push(args);
          return updatedSettings;
        },
      },
      adminAuditLog: {
        create: async (args: { readonly data: unknown }) => {
          auditEntries.push(args.data);
        },
      },
    };
    const service = createService({
      settings: { findFirst: async () => existingSettings, create: async () => existingSettings },
      $transaction: async (callback: (client: typeof transactionClient) => Promise<unknown>) => callback(transactionClient),
    });

    const actualSettings = await service.updateNotificationToggles({
      currentAdmin: CURRENT_ADMIN,
      requestMetadata: REQUEST_METADATA,
      userNotifications: { referralReward: false },
      systemNotifications: { incidents: false },
    });

    assert.deepStrictEqual(updateCalls, [
      {
        where: { id: 'settings-1' },
        data: {
          userNotifications: { expiresSoon: true, referralReward: false },
          systemNotifications: { incidents: false, telegram: { chatId: '-100123' } },
        },
      },
    ]);
    assert.deepStrictEqual(auditEntries, [
      {
        action: 'settings.notifications.updated',
        ipAddress: REQUEST_METADATA.remoteAddress,
        userAgent: REQUEST_METADATA.userAgent,
        metadata: {
          requestId: REQUEST_METADATA.requestId,
          updatedFields: ['userNotifications', 'systemNotifications'],
        },
        adminUser: { connect: { id: CURRENT_ADMIN.id } },
      },
    ]);
    assert.deepStrictEqual(actualSettings, {
      userNotifications: { expiresSoon: true, referralReward: false },
      systemNotifications: { incidents: false, telegram: { chatId: '-100123' } },
    });
  });

  it('updates Telegram delivery config with normalized topic keys', async () => {
    const updateCalls: unknown[] = [];
    const existingSettings = buildSettingsRecord({
      systemNotifications: {
        telegram: {
          enabled: false,
          chatId: '-100123',
          topics: { USER: 7, ignored: 'not-a-number' },
        },
      },
    });
    const updatedSettings = buildSettingsRecord({
      systemNotifications: {
        telegram: {
          enabled: true,
          chatId: '-100123',
          topics: { USER: null, PAYMENT: 9 },
          mirrorUserNotifications: true,
        },
      },
    });
    const transactionClient = {
      $queryRaw: async () => [{ id: existingSettings.id }],
      settings: {
        findFirst: async () => existingSettings,
        create: async () => existingSettings,
        update: async (args: unknown) => {
          updateCalls.push(args);
          return updatedSettings;
        },
      },
      adminAuditLog: { create: async () => undefined },
    };
    const service = createService({
      settings: { findFirst: async () => existingSettings, create: async () => existingSettings },
      $transaction: async (callback: (client: typeof transactionClient) => Promise<unknown>) => callback(transactionClient),
    });

    const actualConfig = await service.updateTelegramDelivery({
      currentAdmin: CURRENT_ADMIN,
      requestMetadata: REQUEST_METADATA,
      enabled: true,
      topics: { user: null, payment: 9 },
      mirrorUserNotifications: true,
    });

    assert.deepStrictEqual(updateCalls, [
      {
        where: { id: 'settings-1' },
        data: {
          systemNotifications: {
            telegram: {
              enabled: true,
              chatId: '-100123',
              topics: { USER: null, PAYMENT: 9 },
              mirrorUserNotifications: true,
            },
          },
        },
      },
    ]);
    assert.deepStrictEqual(actualConfig, {
      enabled: true,
      chatId: '-100123',
      topicId: null,
      errorTopicId: null,
      topics: { USER: null, PAYMENT: 9 },
      mirrorUserNotifications: true,
      devChatId: null,
      errorReports: { mode: 'manual', telegramTxt: true },
      eventsMode: 'all',
      events: [],
    });
  });

  it('rejects enabling Telegram delivery without a chat id', async () => {
    const updateCalls: unknown[] = [];
    const existingSettings = buildSettingsRecord({ systemNotifications: { telegram: { enabled: false } } });
    const transactionClient = {
      $queryRaw: async () => [{ id: existingSettings.id }],
      settings: {
        findFirst: async () => existingSettings,
        create: async () => existingSettings,
        update: async (args: unknown) => {
          updateCalls.push(args);
          return existingSettings;
        },
      },
      adminAuditLog: { create: async () => undefined },
    };
    const service = createService({
      settings: { findFirst: async () => existingSettings, create: async () => existingSettings },
      $transaction: async (callback: (client: typeof transactionClient) => Promise<unknown>) => callback(transactionClient),
    });

    await assert.rejects(
      service.updateTelegramDelivery({
        currentAdmin: CURRENT_ADMIN,
        requestMetadata: REQUEST_METADATA,
        enabled: true,
      }),
      BadRequestException,
    );
    assert.deepStrictEqual(updateCalls, []);
  });

  it('shallow-deep merges referral and partner settings sections', async () => {
    const updateCalls: unknown[] = [];
    const existingSettings = buildSettingsRecord({
      referralSettings: { pointsExchange: { enabled: false, costPerDay: 10 }, inviteLimits: { daily: 3 } },
      partnerSettings: { levels: { LEVEL_1: 10 }, withdrawals: { enabled: false, methods: ['USDT'] } },
    });
    const transactionClient = {
      $queryRaw: async () => [{ id: existingSettings.id }],
      settings: {
        findFirst: async () => existingSettings,
        create: async () => existingSettings,
        update: async (args: unknown) => {
          updateCalls.push(args);
          return existingSettings;
        },
      },
      adminAuditLog: { create: async () => undefined },
    };
    const service = createService({
      settings: { findFirst: async () => existingSettings, create: async () => existingSettings },
      $transaction: async (callback: (client: typeof transactionClient) => Promise<unknown>) => callback(transactionClient),
    });

    assert.deepStrictEqual(
      await service.updateReferralSettings({
        currentAdmin: CURRENT_ADMIN,
        requestMetadata: REQUEST_METADATA,
        patch: { pointsExchange: { enabled: true }, other: 'value' },
      }),
      { pointsExchange: { enabled: true, costPerDay: 10 }, inviteLimits: { daily: 3 }, other: 'value' },
    );
    assert.deepStrictEqual(
      await service.updatePartnerSettings({
        currentAdmin: CURRENT_ADMIN,
        requestMetadata: REQUEST_METADATA,
        patch: { withdrawals: { enabled: true }, levels: { LEVEL_2: 5 } },
      }),
      { levels: { LEVEL_1: 10, LEVEL_2: 5 }, withdrawals: { enabled: true, methods: ['USDT'] } },
    );
    assert.deepStrictEqual(updateCalls, [
      {
        where: { id: 'settings-1' },
        data: {
          referralSettings: { pointsExchange: { enabled: true, costPerDay: 10 }, inviteLimits: { daily: 3 }, other: 'value' },
        },
      },
      {
        where: { id: 'settings-1' },
        data: {
          partnerSettings: { levels: { LEVEL_1: 10, LEVEL_2: 5 }, withdrawals: { enabled: true, methods: ['USDT'] } },
        },
      },
    ]);
  });

  it('replaces custom icons and removes files no longer referenced', async () => {
    const removedUrls: string[] = [];
    const existingSettings = buildSettingsRecord({
      customIcons: [
        { id: 'kept', name: 'Kept', url: '/uploads/icons/kept.svg', color: null },
        { id: 'removed', name: 'Removed', url: '/uploads/icons/removed.svg', color: null },
      ],
    });
    const updatedSettings = buildSettingsRecord({
      customIcons: [
        { id: 'kept', name: 'Kept', url: '/uploads/icons/kept.svg', color: '#ffffff' },
        { id: 'new', name: 'New', url: '/uploads/icons/new.svg', color: null },
      ],
    });
    const transactionClient = {
      $queryRaw: async () => [{ id: existingSettings.id }],
      settings: {
        findFirst: async () => existingSettings,
        create: async () => existingSettings,
        update: async () => updatedSettings,
      },
      adminAuditLog: { create: async () => undefined },
    };
    const service = createService(
      {
        settings: { findFirst: async () => existingSettings, create: async () => existingSettings },
        $transaction: async (callback: (client: typeof transactionClient) => Promise<unknown>) => callback(transactionClient),
      },
      {
        remove: async (url: string) => {
          removedUrls.push(url);
        },
      },
    );

    assert.deepStrictEqual(
      await service.updateCustomIcons({
        currentAdmin: CURRENT_ADMIN,
        requestMetadata: REQUEST_METADATA,
        icons: [
          { id: 'kept', name: 'Kept', url: '/uploads/icons/kept.svg', color: '#ffffff' },
          { id: 'new', name: 'New', url: '/uploads/icons/new.svg' },
        ],
      }),
      [
        { id: 'kept', name: 'Kept', url: '/uploads/icons/kept.svg', color: '#ffffff' },
        { id: 'new', name: 'New', url: '/uploads/icons/new.svg', color: null },
      ],
    );
    assert.deepStrictEqual(removedUrls, ['/uploads/icons/removed.svg']);
  });

  /** One update of the singleton through the transactional path, returning what was written. */
  async function updateChannelNewUsersSince(
    value: string | null,
    stored: Date | null,
  ): Promise<{ readonly written: unknown; readonly returned: unknown }> {
    const updateCalls: Array<{ readonly data: Record<string, unknown> }> = [];
    const existingSettings = buildSettingsRecord({ id: 'settings-1' });
    const updatedSettings = buildSettingsRecord({ id: 'settings-1', channelNewUsersSince: stored });
    const transactionClient = {
      $queryRaw: async () => [{ id: existingSettings.id }],
      settings: {
        findFirst: async () => existingSettings,
        create: async () => {
          throw new Error('settings.create must not be called when the row exists');
        },
        update: async (args: { readonly data: Record<string, unknown> }) => {
          updateCalls.push(args);
          return updatedSettings;
        },
      },
      adminAuditLog: { create: async () => undefined },
    };
    const service = createService({
      settings: { findFirst: async () => existingSettings, create: async () => existingSettings },
      $transaction: async (callback: (client: typeof transactionClient) => Promise<unknown>) =>
        callback(transactionClient),
    });
    const returned = await service.updatePlatformSettings({
      currentAdmin: CURRENT_ADMIN,
      requestMetadata: REQUEST_METADATA,
      updatePlatformSettingsDto: { channelNewUsersSince: value },
    });
    return { written: updateCalls[0]?.data['channelNewUsersSince'], returned };
  }

  it('stores «Проверять только новых» as a moment and hands it to BOTH readers', async () => {
    // The whole feature is this one column: NULL asks everyone, a moment asks
    // only accounts created at or after it. It has two readers — the panel form
    // (platform settings) and reiwa's gate (internal policy). Reaching only the
    // first is the failure worth a test: the switch reads ON in the panel while
    // the bot keeps asking every old customer to subscribe.
    const since = '2026-09-22T09:00:00.000Z';
    const { written, returned } = await updateChannelNewUsersSince(since, new Date(since));
    assert.ok(written instanceof Date, `stored as a moment, not as text: ${String(written)}`);
    assert.equal(written.toISOString(), since);
    assert.equal((returned as { channelNewUsersSince: unknown }).channelNewUsersSince, since);

    const reader = createService({
      settings: {
        findFirst: async () => buildSettingsRecord({ channelRequired: true, channelNewUsersSince: new Date(since) }),
        create: async () => {
          throw new Error('the internal policy is read-only');
        },
      },
    });
    assert.equal((await reader.getInternalPlatformPolicy()).channelNewUsersSince, since);
  });

  it('clears «Проверять только новых» back to asking everyone', async () => {
    // ANTI-VACUITY for the one above: `null` must be written as NULL, not
    // skipped. A skipped field would leave the old moment in place and the
    // switch would be impossible to turn off.
    const { written, returned } = await updateChannelNewUsersSince(null, null);
    assert.equal(written, null);
    assert.equal((returned as { channelNewUsersSince: unknown }).channelNewUsersSince, null);
  });
});
