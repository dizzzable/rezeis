import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Test } from '@nestjs/testing';
import { UserRole } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { appConfig } from '../src/common/config/app.config';
import { PrismaService } from '../src/common/prisma/prisma.service';
import type { CurrentAdminInterface } from '../src/modules/auth/interfaces/current-admin.interface';
import { UpdatePlatformSettingsDto } from '../src/modules/settings/dto/update-platform-settings.dto';
import { IconUploadService } from '../src/modules/settings/services/icon-upload.service';
import { SettingsService } from '../src/modules/settings/services/settings.service';
import { mergePlatformBranding, readPlatformBranding } from '../src/modules/settings/utils/platform-branding.util';

/**
 * «Восстановление пароля по ссылке подписки» — the operator's switch
 * ══════════════════════════════════════════════════════════════════
 * It lives in `Settings.platformPolicy`, the JSON column that already holds the
 * cabinet's other sign-in policy (`requireTelegramWebCredentials`), and is
 * written the way every key in that column is: `PATCH /admin/settings/platform
 * { platformBranding }` → `SettingsService.updatePlatformSettings` →
 * `mutateSettingsRow` (row locked, read under the lock, merged, written). No
 * column, so no migration.
 *
 * `SettingsService` runs for real here over one in-memory row. The fake row
 * does what the database would: the lock statement, the read, the update.
 */

const ADMIN: CurrentAdminInterface = {
  id: 'admin-1',
  login: 'admin',
  email: 'admin@example.test',
  name: 'Admin',
  role: UserRole.ADMIN,
  isActive: true,
  tokenVersion: 1,
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  lastLoginAt: null,
  lastLoginIp: null,
  rbacRoleId: null,
  mustChangePassword: false,
};

const REQUEST_METADATA = {
  requestId: 'request-subscription-link-recovery',
  remoteAddress: '203.0.113.31',
  userAgent: 'settings-subscription-link-recovery-spec',
} as const;

function world(platformPolicy: Record<string, unknown>) {
  const row: Record<string, unknown> = {
    id: 1,
    rulesRequired: false,
    rulesLink: '',
    channelRequired: false,
    channelId: null,
    channelLink: '',
    accessMode: 'PUBLIC',
    inviteModeStartedAt: null,
    defaultCurrency: 'RUB',
    platformPolicy,
    systemNotifications: {},
    brandingSettings: {},
    multiSubscriptionSettings: {},
    referralSettings: {},
    partnerSettings: {},
    pointsSettings: {},
    userNotifications: {},
    updatedAt: new Date('2026-09-18T10:00:00.000Z'),
  };
  /** Every statement, in order — the lock must come before the write. */
  const statements: string[] = [];
  const tx = {
    $queryRaw: async (query: { readonly strings?: readonly string[] }) => {
      statements.push(`lock:${(query.strings ?? []).join('?').replace(/\s+/g, ' ').trim()}`);
      return [{ id: row.id }];
    },
    settings: {
      findFirst: async () => {
        statements.push('read');
        return { ...row };
      },
      update: async ({ data }: { readonly data: Record<string, unknown> }) => {
        statements.push('update');
        Object.assign(row, data);
        return { ...row };
      },
    },
    adminAuditLog: {
      create: async () => {
        statements.push('audit');
        return {};
      },
    },
  };
  const prisma = {
    settings: { findFirst: async () => ({ ...row }) },
    $transaction: async <T>(work: (client: typeof tx) => Promise<T>): Promise<T> => work(tx),
  };
  return { row, prisma, statements };
}

async function settingsServiceOver(prisma: ReturnType<typeof world>['prisma']): Promise<SettingsService> {
  const moduleRef = await Test.createTestingModule({
    providers: [
      SettingsService,
      { provide: PrismaService, useValue: prisma },
      { provide: IconUploadService, useValue: {} },
      { provide: appConfig.KEY, useValue: { cryptKey: 'a'.repeat(32) } },
    ],
  }).compile();
  return moduleRef.get(SettingsService);
}

describe('recovery by subscription link — the operator switch', () => {
  it('is ON for every install that never touched it, and for a fresh one', () => {
    assert.equal(readPlatformBranding(null).subscriptionLinkRecovery, true);
    assert.equal(readPlatformBranding({ projectName: 'A' }).subscriptionLinkRecovery, true);
    assert.equal(readPlatformBranding({ subscriptionLinkRecovery: 'no' }).subscriptionLinkRecovery, true);
    assert.equal(readPlatformBranding({ subscriptionLinkRecovery: false }).subscriptionLinkRecovery, false);
  });

  it('round-trips through the settings writer into the policy the cabinet reads', async () => {
    const { row, prisma, statements } = world({ projectName: 'A' });
    const settings = await settingsServiceOver(prisma);
    assert.equal((await settings.getInternalPlatformPolicy()).subscriptionLinkRecovery, true);

    await settings.updatePlatformSettings({
      currentAdmin: ADMIN,
      requestMetadata: REQUEST_METADATA,
      updatePlatformSettingsDto: { platformBranding: { subscriptionLinkRecovery: false } },
    });

    // Through `mutateSettingsRow`: the row is locked, then read, then written.
    assert.deepEqual(
      statements.filter((statement) => statement !== 'audit'),
      ['lock:SELECT "id" FROM "settings" ORDER BY "id" FOR UPDATE', 'read', 'update'],
    );
    const stored = row.platformPolicy as Record<string, unknown>;
    assert.equal(stored.subscriptionLinkRecovery, false);
    assert.equal(stored.projectName, 'A', 'the switch wrote the rest of the column away');
    assert.equal((await settings.getInternalPlatformPolicy()).subscriptionLinkRecovery, false);
    assert.equal((await settings.getOverview()).platformBranding.subscriptionLinkRecovery, false);
  });

  it('stays OFF when the Branding card saves any other field', async () => {
    const { prisma } = world({ subscriptionLinkRecovery: false });
    const settings = await settingsServiceOver(prisma);

    await settings.updatePlatformSettings({
      currentAdmin: ADMIN,
      requestMetadata: REQUEST_METADATA,
      updatePlatformSettingsDto: { platformBranding: { projectName: 'B', requireTelegramWebCredentials: true } },
    });

    const policy = await settings.getInternalPlatformPolicy();
    assert.equal(policy.subscriptionLinkRecovery, false);
    assert.equal(policy.requireTelegramWebCredentials, true);
  });

  it('merges only the key it was given', () => {
    const merged = mergePlatformBranding({
      existing: { subscriptionLinkRecovery: false, externalAuth: { mode: 'allowlist' } },
      patch: { webTitle: 'Cabinet' },
    });
    assert.equal(merged['subscriptionLinkRecovery'], false);
    assert.deepEqual(merged['externalAuth'], { mode: 'allowlist' });
  });

  it('accepts only a boolean on the wire', async () => {
    const valid = plainToInstance(UpdatePlatformSettingsDto, {
      platformBranding: { subscriptionLinkRecovery: false },
    });
    assert.deepEqual(await validate(valid, { whitelist: true, forbidNonWhitelisted: true }), []);

    const invalid = plainToInstance(UpdatePlatformSettingsDto, {
      platformBranding: { subscriptionLinkRecovery: 'off' },
    });
    const errors = await validate(invalid, { whitelist: true, forbidNonWhitelisted: true });
    assert.equal(errors.length, 1);
    assert.equal(errors[0].property, 'platformBranding');
  });
});
