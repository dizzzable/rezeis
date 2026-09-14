import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { UserRole } from '@prisma/client';

import type { CurrentAdminInterface } from '../src/modules/auth/interfaces/current-admin.interface';
import type { ReiwaCacheInvalidatorService } from '../src/modules/bot-config/services/reiwa-cache-invalidator.service';
import type { IconUploadService } from '../src/modules/settings/services/icon-upload.service';
import { SettingsService } from '../src/modules/settings/services/settings.service';

/**
 * Every save that feeds the cabinet's public-config tells the cabinet so
 * ══════════════════════════════════════════════════════════════════════
 * `GET internal/branding/public-config` answers the cabinet with the theme,
 * the custom icon library, `defaultCurrency`, the project name and web title,
 * and whether email is on. The cabinet keeps that answer for 60 seconds and
 * drops it early only on `reiwa.branding.invalidate`.
 *
 * Only the Branding save sent it. The icon library save sent nothing at all —
 * while it deleted the files of the icons it removed, so fresh cabinet loads
 * drew broken images for a minute. Default currency, project name and web
 * title sent only the POLICY invalidation, which drops a cache none of those
 * fields are served from: tariff cards kept the old currency first and the tab
 * kept the old title. The cabinet release that also resets public-config on a
 * policy invalidation covers new cabinets; this covers every cabinet already
 * deployed, which does not.
 *
 * Each case records the order of the commit and the enqueue: an invalidation
 * that fires before the commit lets the cabinet re-read the old row.
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
  requestId: 'request-public-config',
  remoteAddress: '203.0.113.50',
  userAgent: 'settings-public-config-spec',
} as const;

function harness(options: { readonly failCommit?: boolean } = {}) {
  const log: string[] = [];
  const row: Record<string, unknown> = {
    id: 1,
    rulesRequired: false,
    rulesLink: '',
    channelRequired: false,
    channelId: null,
    channelLink: '',
    accessMode: 'PUBLIC',
    inviteModeStartedAt: null,
    defaultCurrency: 'USD',
    platformPolicy: {},
    systemNotifications: {},
    customIcons: [{ id: 'old', name: 'Old', url: '/uploads/icons/old.svg', color: null }],
    updatedAt: new Date('2026-09-13T10:00:00.000Z'),
  };
  const tx = {
    $queryRaw: async () => [{ id: row.id }],
    settings: {
      findFirst: async () => ({ ...row }),
      update: async ({ data }: { readonly data: Record<string, unknown> }) => ({ ...row, ...data }),
    },
    adminAuditLog: { create: async () => ({}) },
  };
  const prisma = {
    settings: { findFirst: async () => ({ ...row }) },
    $transaction: async <T>(work: (client: typeof tx) => Promise<T>): Promise<T> => {
      const result = await work(tx);
      if (options.failCommit === true) throw new Error('could not serialize access');
      log.push('commit');
      return result;
    },
  };
  const invalidator = {
    invalidateBranding: async (reason: string) => {
      log.push(`branding:${reason}`);
    },
    invalidatePolicy: async (reason: string) => {
      log.push(`policy:${reason}`);
    },
    invalidate: async (reason: string) => {
      log.push(`bot:${reason}`);
    },
  } satisfies Pick<ReiwaCacheInvalidatorService, 'invalidateBranding' | 'invalidatePolicy' | 'invalidate'>;
  const icons = {
    remove: async (url: string) => {
      log.push(`remove:${url}`);
    },
  };
  const service = new SettingsService(
    prisma as never,
    icons as unknown as IconUploadService,
    { cryptKey: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } as never,
    undefined,
    undefined,
    invalidator as unknown as ReiwaCacheInvalidatorService,
  );
  return { service, log };
}

const brandingEvents = (log: readonly string[]) => log.filter((entry) => entry.startsWith('branding:'));

describe('SettingsService — saves that feed public-config enqueue the branding invalidation', () => {
  it('the custom icon library, after its commit', async () => {
    const { service, log } = harness();

    await service.updateCustomIcons({
      currentAdmin: ADMIN,
      requestMetadata: REQUEST_METADATA,
      icons: [{ id: 'new', name: 'New', url: '/uploads/icons/new.svg' }],
    });

    assert.equal(brandingEvents(log).length, 1, `expected one branding invalidation, got ${JSON.stringify(log)}`);
    assert.ok(
      log.indexOf('commit') < log.findIndex((entry) => entry.startsWith('branding:')),
      `the invalidation must follow the commit: ${JSON.stringify(log)}`,
    );
  });

  it('nothing for an icon save whose transaction did not commit', async () => {
    const { service, log } = harness({ failCommit: true });

    await assert.rejects(() =>
      service.updateCustomIcons({
        currentAdmin: ADMIN,
        requestMetadata: REQUEST_METADATA,
        icons: [],
      }),
    );

    assert.deepStrictEqual(brandingEvents(log), []);
  });

  for (const [field, dto] of [
    ['defaultCurrency', { defaultCurrency: 'RUB' }],
    ['platformBranding', { platformBranding: { projectName: 'New name', webTitle: 'New title' } }],
  ] as const) {
    it(`a platform save of ${field}, after its commit, alongside the policy invalidation`, async () => {
      const { service, log } = harness();

      await service.updatePlatformSettings({
        currentAdmin: ADMIN,
        requestMetadata: REQUEST_METADATA,
        updatePlatformSettingsDto: dto as never,
      });

      assert.equal(brandingEvents(log).length, 1, `expected one branding invalidation, got ${JSON.stringify(log)}`);
      assert.ok(log.some((entry) => entry.startsWith('policy:')), 'the policy invalidation still goes out');
      assert.ok(log.indexOf('commit') < log.findIndex((entry) => entry.startsWith('branding:')));
    });
  }

  it('not for a platform save that touches nothing public-config serves (control)', async () => {
    const { service, log } = harness();

    await service.updatePlatformSettings({
      currentAdmin: ADMIN,
      requestMetadata: REQUEST_METADATA,
      updatePlatformSettingsDto: { rulesRequired: true },
    });

    assert.ok(log.some((entry) => entry.startsWith('policy:')), 'rulesRequired is policy');
    assert.deepStrictEqual(brandingEvents(log), []);
  });
});
