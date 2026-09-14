import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { UserRole } from '@prisma/client';

import type { CurrentAdminInterface } from '../src/modules/auth/interfaces/current-admin.interface';
import { ExternalProviderConfigService } from '../src/modules/external-auth/services/external-provider-config.service';
import type { IconUploadService } from '../src/modules/settings/services/icon-upload.service';
import { SettingsService } from '../src/modules/settings/services/settings.service';

/**
 * Saving the Branding texts must not erase the disposable-email policy
 * ════════════════════════════════════════════════════════════════════
 * `Settings.platformPolicy` holds two unrelated things: the platform-branding
 * texts the Branding tab saves (`PATCH /admin/settings/platform
 * {platformBranding}`) and the External auth email policy
 * (`platformPolicy.externalAuth`, `PUT /admin/external-auth/policy`).
 *
 * `mergePlatformBranding` built the column from the branding keys alone, so
 * every branding save wrote `externalAuth` away. No race was needed: the
 * operator set an allowlist, renamed the project a week later, and the policy
 * page showed the defaults again — while `emailAttachable` went back to
 * attaching unverified addresses from the domains they had excluded. Both
 * requests answered 200.
 *
 * Both services run for real here, over one in-memory row, each through its
 * own settings-row write helper, in the order an operator would use them.
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
  requestId: 'request-platform-branding',
  remoteAddress: '203.0.113.30',
  userAgent: 'settings-platform-branding-spec',
} as const;

/** The operator's own policy: nothing in it matches `DEFAULT_POLICY`. */
const OPERATOR_POLICY = {
  mode: 'allowlist',
  allowlist: ['gmail.com'],
  customBlocklist: ['x.test'],
  gateProvidersByEmailModule: true,
} as const;

function sharedRow(platformPolicy: Record<string, unknown>) {
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
    updatedAt: new Date('2026-09-13T10:00:00.000Z'),
  };
  const tx = {
    // The settings row lock (`SELECT "id" FROM "settings" FOR UPDATE`) finding the row.
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

describe('platform branding save — the email policy in the same column survives it', () => {
  it('keeps platformPolicy.externalAuth when the Branding tab saves a new project name', async () => {
    const { row, prisma } = sharedRow({ projectName: 'A' });
    const policies = new ExternalProviderConfigService(prisma as never, {} as never);
    const settings = new SettingsService(
      prisma as never,
      {} as IconUploadService,
      { cryptKey: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } as never,
    );

    await policies.updatePolicy(OPERATOR_POLICY);
    await settings.updatePlatformSettings({
      currentAdmin: ADMIN,
      requestMetadata: REQUEST_METADATA,
      updatePlatformSettingsDto: { platformBranding: { projectName: 'B' } },
    });

    const stored = row.platformPolicy as Record<string, unknown>;
    assert.deepStrictEqual(
      stored.externalAuth,
      OPERATOR_POLICY,
      'the branding save must write the email policy back as the operator left it',
    );
    assert.equal(stored.projectName, 'B');
    // What the External auth page and `emailAttachable` read back.
    assert.deepStrictEqual(await policies.getPolicy(), OPERATOR_POLICY);
    assert.equal((await settings.getPlatformBranding()).projectName, 'B');
  });

  it('keeps the branding texts when the policy is saved afterwards (the direction that already worked)', async () => {
    const { row, prisma } = sharedRow({ projectName: 'A', webTitle: 'Cabinet' });
    const policies = new ExternalProviderConfigService(prisma as never, {} as never);

    await policies.updatePolicy(OPERATOR_POLICY);

    const stored = row.platformPolicy as Record<string, unknown>;
    assert.equal(stored.projectName, 'A');
    assert.equal(stored.webTitle, 'Cabinet');
    assert.deepStrictEqual(stored.externalAuth, OPERATOR_POLICY);
  });
});
