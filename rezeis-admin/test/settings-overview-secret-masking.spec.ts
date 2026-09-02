import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AccessMode, Currency, UserRole } from '@prisma/client';

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
  requestId: 'request-mask-1',
  remoteAddress: '203.0.113.10',
  userAgent: 'settings-masking-spec',
} as const;

/**
 * The blob as it really sits in `Settings.systemNotifications`: operator
 * toggles and Telegram routing alongside three credentials — a PLAINTEXT SMTP
 * password, the admin bot token ciphertext, and the VAPID private key.
 */
const SMTP_PASSWORD = 'sup3r-secret-smtp-password';
const BOT_TOKEN_ENC = 'ENCRYPTED-BOT-TOKEN-CIPHERTEXT';
const VAPID_PRIVATE_ENC = 'ENCRYPTED-VAPID-PRIVATE-KEY';

function buildSystemNotifications(): Record<string, unknown> {
  return {
    incidents: true,
    node_status: false,
    telegram: { enabled: true, chatId: '-100123', topicId: 7 },
    email: {
      enabled: true,
      host: 'smtp.example.com',
      port: 587,
      username: 'postmaster@example.com',
      password: SMTP_PASSWORD,
      fromAddress: 'no-reply@example.com',
      useTls: true,
    },
    botTokenEnc: BOT_TOKEN_ENC,
    webPush: {
      publicKey: 'BPublicKeyValue',
      privateKeyEnc: VAPID_PRIVATE_ENC,
      contactEmail: 'ops@example.com',
    },
  };
}

function buildSettingsRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
    userNotifications: { expiresSoon: true },
    systemNotifications: buildSystemNotifications(),
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

function createService(prismaService: unknown): SettingsService {
  return new SettingsService(
    prismaService as never,
    {} as unknown as IconUploadService,
    { cryptKey: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } as never,
  );
}

/** Every string in the response, so a secret cannot hide in a nested key. */
function serialise(value: unknown): string {
  return JSON.stringify(value);
}

describe('GET /admin/settings — systemNotifications masking', () => {
  it('does not ship the plaintext SMTP password, bot token or VAPID private key', async () => {
    const record = buildSettingsRecord();
    const service = createService({
      settings: { findFirst: async () => record, create: async () => record },
    });

    const overview = await service.getOverview();
    const body = serialise(overview);

    assert.ok(!body.includes(SMTP_PASSWORD), 'the SMTP password must not reach the SPA');
    assert.ok(!body.includes(BOT_TOKEN_ENC), 'the bot token ciphertext must not reach the SPA');
    assert.ok(!body.includes(VAPID_PRIVATE_ENC), 'the VAPID private key must not reach the SPA');
    assert.equal('email' in overview.systemNotifications, false);
    assert.equal('botTokenEnc' in overview.systemNotifications, false);
    assert.equal('webPush' in overview.systemNotifications, false);
  });

  it('keeps every non-secret key the SPA actually reads', async () => {
    const record = buildSettingsRecord();
    const service = createService({
      settings: { findFirst: async () => record, create: async () => record },
    });

    const overview = await service.getOverview();

    // The system-notification toggle list and the Telegram routing panel.
    assert.equal(overview.systemNotifications.incidents, true);
    assert.equal(overview.systemNotifications.node_status, false);
    assert.deepEqual(overview.systemNotifications.telegram, {
      enabled: true,
      chatId: '-100123',
      topicId: 7,
    });
  });

  it('replaces each masked secret with a presence flag', async () => {
    const record = buildSettingsRecord();
    const service = createService({
      settings: { findFirst: async () => record, create: async () => record },
    });

    const overview = await service.getOverview();

    assert.equal(overview.botTokenConfigured, true);
    assert.equal(overview.emailConfigured, true);
    assert.equal(overview.emailPasswordSet, true);
  });

  it('reports the flags as false when nothing is configured', async () => {
    const record = buildSettingsRecord({ systemNotifications: { incidents: true } });
    const service = createService({
      settings: { findFirst: async () => record, create: async () => record },
    });

    const overview = await service.getOverview();

    assert.equal(overview.botTokenConfigured, false);
    assert.equal(overview.emailConfigured, false);
    assert.equal(overview.emailPasswordSet, false);
    assert.deepEqual(overview.systemNotifications, { incidents: true });
  });

  it('leaves the stored record untouched (masking must not mutate the blob)', async () => {
    const record = buildSettingsRecord();
    const service = createService({
      settings: { findFirst: async () => record, create: async () => record },
    });

    await service.getOverview();

    const stored = record.systemNotifications as Record<string, unknown>;
    assert.equal((stored.email as Record<string, unknown>).password, SMTP_PASSWORD);
    assert.equal(stored.botTokenEnc, BOT_TOKEN_ENC);
  });
});

describe('PATCH /admin/settings/notifications — systemNotifications masking', () => {
  function createTogglesService(record: Record<string, unknown>): {
    readonly service: SettingsService;
    readonly updateCalls: unknown[];
  } {
    const updateCalls: unknown[] = [];
    const transactionClient = {
      settings: {
        findFirst: async () => record,
        create: async () => record,
        update: async (args: { readonly data: Record<string, unknown> }) => {
          updateCalls.push(args);
          return { ...record, ...args.data };
        },
      },
      adminAuditLog: { create: async () => undefined },
    };
    const service = createService({
      settings: { findFirst: async () => record, create: async () => record },
      $transaction: async (callback: (client: typeof transactionClient) => Promise<unknown>) =>
        callback(transactionClient),
    });
    return { service, updateCalls };
  }

  it('masks the response of a real toggle update', async () => {
    const { service } = createTogglesService(buildSettingsRecord());

    const result = await service.updateNotificationToggles({
      currentAdmin: CURRENT_ADMIN,
      requestMetadata: REQUEST_METADATA,
      systemNotifications: { incidents: false },
    });

    const body = serialise(result);
    assert.ok(!body.includes(SMTP_PASSWORD));
    assert.ok(!body.includes(BOT_TOKEN_ENC));
    assert.ok(!body.includes(VAPID_PRIVATE_ENC));
    assert.equal('email' in result.systemNotifications, false);
    assert.equal(result.systemNotifications.incidents, false);
  });

  it('masks the response of the no-op early-return branch too', async () => {
    const { service } = createTogglesService(buildSettingsRecord());

    const result = await service.updateNotificationToggles({
      currentAdmin: CURRENT_ADMIN,
      requestMetadata: REQUEST_METADATA,
    });

    const body = serialise(result);
    assert.ok(!body.includes(SMTP_PASSWORD));
    assert.ok(!body.includes(BOT_TOKEN_ENC));
    assert.equal('email' in result.systemNotifications, false);
  });

  /**
   * The reason the secrets are DROPPED rather than blanked. The SPA's toggle
   * handler PATCHes back the whole object it last read, and `mergeJsonObject`
   * replaces top-level keys wholesale — so an `email` object returned without
   * its password would erase the stored password on the next click. An absent
   * key is left alone by the merge.
   */
  it('a masked blob echoed straight back does not erase the stored credentials', async () => {
    const record = buildSettingsRecord();
    const { service, updateCalls } = createTogglesService(record);

    const overview = await service.getOverview();
    // Exactly what `handleToggle` sends: `{ ...notifSettings, [key]: !current }`.
    await service.updateNotificationToggles({
      currentAdmin: CURRENT_ADMIN,
      requestMetadata: REQUEST_METADATA,
      systemNotifications: { ...overview.systemNotifications, incidents: false },
    });

    assert.equal(updateCalls.length, 1);
    const persisted = (updateCalls[0] as { data: { systemNotifications: Record<string, unknown> } })
      .data.systemNotifications;
    assert.equal((persisted.email as Record<string, unknown>).password, SMTP_PASSWORD);
    assert.equal(persisted.botTokenEnc, BOT_TOKEN_ENC);
    assert.equal((persisted.webPush as Record<string, unknown>).privateKeyEnc, VAPID_PRIVATE_ENC);
    assert.equal(persisted.incidents, false);
  });
});
