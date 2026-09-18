import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { UserRole } from '@prisma/client';

import { appConfig } from '../src/common/config/app.config';
import { PrismaService } from '../src/common/prisma/prisma.service';
import type { CurrentAdminInterface } from '../src/modules/auth/interfaces/current-admin.interface';
import { UpdatePlatformSettingsDto } from '../src/modules/settings/dto/update-platform-settings.dto';
import { IconUploadService } from '../src/modules/settings/services/icon-upload.service';
import { SettingsService } from '../src/modules/settings/services/settings.service';
import { readPlatformBranding } from '../src/modules/settings/utils/platform-branding.util';

/**
 * «Верификация (RU/EN)» and «Сброс пароля (RU/EN)» — templates nothing ever sent
 * ═══════════════════════════════════════════════════════════════════════════
 * Settings → Branding offered two pairs of Telegram message templates, and no
 * sender in the panel, the cabinet or the bot ever read either: a reset goes
 * out as a link with the bot's own text, an e-mail code with the e-mail's own.
 * The card no longer offers them and the panel no longer presents or writes
 * them. Two things constrain HOW:
 *
 *   - an admin SPA loaded before the deploy still sends both with every
 *     Branding save, and the global `ValidationPipe` refuses an undeclared
 *     property (`forbidNonWhitelisted`) — so the DTO keeps accepting them, and
 *     the panel ignores them;
 *   - an install's stored values stay where they are, untouched by any save.
 *
 * An exported configuration needs neither: config import writes the
 * `platformPolicy` column as it is and never meets this DTO — and what it
 * brings in is then kept by the second point.
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
  requestId: 'request-retired-telegram-templates',
  remoteAddress: '203.0.113.32',
  userAgent: 'settings-retired-telegram-templates-spec',
} as const;

/** What an install stored before the change — both templates, and a key nobody knows. */
const STORED_VERIFICATION = {
  telegramTemplate: { ru: 'Код: {code}', en: 'Code: {code}' },
  passwordResetTelegramTemplate: { ru: 'Код сброса: {code}', en: 'Reset code: {code}' },
  somethingElse: 42,
};

/** Exactly what the Branding card sent before the change, both templates and all. */
const OLD_SPA_SAVE = {
  platformBranding: {
    projectName: 'Rezeis',
    webTitle: 'Rezeis VPN',
    channelUsername: '@rezeis',
    channelRecheck: true,
    requireTelegramWebCredentials: false,
    subscriptionLinkRecovery: true,
    verification: {
      telegramTemplate: { ru: 'ПЕРЕЗАПИСЬ-В', en: 'OVERWRITE-V' },
      passwordResetTelegramTemplate: { ru: 'ПЕРЕЗАПИСЬ-С', en: 'OVERWRITE-R' },
    },
  },
};

/** One settings row the real `SettingsService` locks, reads and writes. */
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
  const tx = {
    $queryRaw: async () => [{ id: row.id }],
    settings: {
      findFirst: async () => ({ ...row }),
      update: async ({ data }: { readonly data: Record<string, unknown> }) => {
        Object.assign(row, data);
        return { ...row };
      },
    },
    adminAuditLog: { create: async () => ({}) },
  };
  const prisma = {
    settings: { findFirst: async () => ({ ...row }) },
    $transaction: async <T>(work: (client: typeof tx) => Promise<T>): Promise<T> => work(tx),
  };
  return { row, prisma };
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

describe('the retired Telegram templates «Верификация» and «Сброс пароля»', () => {
  it('are still accepted from an admin SPA loaded before the deploy — its save is not a 400', async () => {
    // The pipe exactly as `main.ts` installs it.
    const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true });

    const accepted = await pipe.transform(structuredClone(OLD_SPA_SAVE), {
      type: 'body',
      metatype: UpdatePlatformSettingsDto,
    });

    assert.ok(accepted instanceof UpdatePlatformSettingsDto);
  });

  it('are ignored by a save: the stored ones stay exactly as they were, the rest is written', async () => {
    const { row, prisma } = world({
      projectName: 'Old name',
      externalAuth: { mode: 'allowlist' },
      verification: structuredClone(STORED_VERIFICATION),
    });
    const settings = await settingsServiceOver(prisma);

    await settings.updatePlatformSettings({
      currentAdmin: ADMIN,
      requestMetadata: REQUEST_METADATA,
      updatePlatformSettingsDto: structuredClone(OLD_SPA_SAVE),
    });

    const policy = row.platformPolicy as Record<string, unknown>;
    assert.deepEqual(policy['verification'], STORED_VERIFICATION, 'a save wrote the retired templates');
    assert.equal(policy['projectName'], 'Rezeis');
    assert.deepEqual(policy['externalAuth'], { mode: 'allowlist' });
  });

  it('are no longer presented by the panel', async () => {
    const { prisma } = world({ projectName: 'Rezeis', verification: structuredClone(STORED_VERIFICATION) });
    const settings = await settingsServiceOver(prisma);

    const presented = (await settings.getOverview()).platformBranding as unknown as Record<string, unknown>;

    assert.equal('verification' in presented, false);
    assert.equal(presented['projectName'], 'Rezeis');
    assert.equal('verification' in readPlatformBranding({ verification: STORED_VERIFICATION }), false);
  });

  it('are not written for an install that never had them', async () => {
    const { row, prisma } = world({});
    const settings = await settingsServiceOver(prisma);

    await settings.updatePlatformSettings({
      currentAdmin: ADMIN,
      requestMetadata: REQUEST_METADATA,
      updatePlatformSettingsDto: structuredClone(OLD_SPA_SAVE),
    });

    assert.equal('verification' in (row.platformPolicy as Record<string, unknown>), false);
  });
});
