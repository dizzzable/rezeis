import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BadRequestException } from '@nestjs/common';
import { UserRole } from '@prisma/client';

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
  requestId: 'request-af-1',
  remoteAddress: '203.0.113.10',
  userAgent: 'anti-fraud-settings-spec',
} as const;

interface Harness {
  readonly service: SettingsService;
  readonly auditLogs: Array<Record<string, unknown>>;
  readonly writes: Array<unknown>;
  /** Whatever the fake row currently holds in `anti_fraud_settings`. */
  column: () => unknown;
}

function createHarness(initial: unknown = {}): Harness {
  let stored: unknown = initial;
  const auditLogs: Array<Record<string, unknown>> = [];
  const writes: Array<unknown> = [];
  const row = () => ({ id: 1, antiFraudSettings: stored, updatedAt: new Date() });

  const tx = {
    settings: {
      findFirst: async () => row(),
      update: async (args: { data: { antiFraudSettings?: unknown } }) => {
        writes.push(args.data.antiFraudSettings);
        stored = args.data.antiFraudSettings;
        return row();
      },
    },
    adminAuditLog: {
      create: async (args: { data: Record<string, unknown> }) => {
        auditLogs.push(args.data);
        return args.data;
      },
    },
  };

  const prismaService = {
    settings: { findFirst: async () => row() },
    $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
  };

  const service = new SettingsService(
    prismaService as never,
    {} as unknown as IconUploadService,
    { cryptKey: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } as never,
  );

  return { service, auditLogs, writes, column: () => stored };
}

describe('SettingsService — anti-fraud tunables', () => {
  it('reports the built-in defaults when the column is empty', async () => {
    const view = await createHarness({}).service.getAntiFraudSettings();
    assert.deepEqual(view.stored, {});
    assert.deepEqual(view.overridden, { sharing: [], trafficAbuse: [], subscriptionUa: [] });
    assert.equal(view.effective.sharing.enableHwidOverage, true);
    assert.equal(view.effective.sharing.enableIpSharing, false);
    assert.equal(view.effective.trafficAbuse.minGb, 200);
    assert.equal(view.effective.trafficAbuse.maxNodesPerRun, 25);
    assert.equal(view.effective.subscriptionUa.enableSubscriptionUaTunnel, false);
    assert.equal(view.effective.subscriptionUa.uaEvidenceWindowMinutes, 60);
    assert.equal(view.effective.subscriptionUa.uaRequestPageSize, 500);
  });

  it('reports a stored value as effective and overridden', async () => {
    const view = await createHarness({
      sharing: { enableIpSharing: true, ipOverageMargin: 3 },
    }).service.getAntiFraudSettings();
    assert.equal(view.effective.sharing.enableIpSharing, true);
    assert.equal(view.effective.sharing.ipOverageMargin, 3);
    assert.deepEqual(view.overridden.sharing, ['enableIpSharing', 'ipOverageMargin']);
  });

  it('resolves the runtime tunables the detectors read', async () => {
    const tunables = await createHarness({
      trafficAbuse: { minGb: 750 },
    }).service.getAntiFraudTunablesRuntime();
    assert.equal(tunables.trafficAbuse.minGb, 750);
    assert.equal(tunables.trafficAbuse.medianMultiplier, 4, 'untouched knobs stay at default');
    assert.equal(tunables.sharing.maxNodesPerRun, 25);
  });

  it('lets a settings-read failure propagate instead of answering with defaults', async () => {
    const service = new SettingsService(
      {
        settings: {
          findFirst: async () => {
            throw new Error('connection terminated unexpectedly');
          },
        },
      } as never,
      {} as unknown as IconUploadService,
      { cryptKey: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } as never,
    );
    await assert.rejects(
      () => service.getAntiFraudTunablesRuntime(),
      /connection terminated unexpectedly/,
      'swallowing this would silently re-enable a detector the operator switched off',
    );
  });

  it('persists a patch and writes an audit entry naming the fields', async () => {
    const harness = createHarness({});
    const view = await harness.service.updateAntiFraudSettings({
      currentAdmin: CURRENT_ADMIN,
      requestMetadata: REQUEST_METADATA,
      patch: { sharing: { ipWindowMinutes: 45 }, trafficAbuse: { minGb: 750 } },
    });

    assert.deepEqual(harness.column(), {
      sharing: { ipWindowMinutes: 45 },
      trafficAbuse: { minGb: 750 },
    });
    assert.equal(view.effective.sharing.ipWindowMinutes, 45);
    assert.equal(view.effective.trafficAbuse.minGb, 750);

    assert.equal(harness.auditLogs.length, 1);
    assert.equal(harness.auditLogs[0].action, 'settings.antiFraudSettings.update');
    assert.deepEqual(harness.auditLogs[0].adminUser, { connect: { id: 'admin-1' } });
    assert.equal(harness.auditLogs[0].ipAddress, REQUEST_METADATA.remoteAddress);
    assert.deepEqual((harness.auditLogs[0].metadata as Record<string, unknown>).patchKeys, [
      'sharing.ipWindowMinutes',
      'trafficAbuse.minGb',
    ]);
  });

  it('merges into an existing patch rather than replacing it', async () => {
    const harness = createHarness({ sharing: { ipWindowMinutes: 45 } });
    await harness.service.updateAntiFraudSettings({
      currentAdmin: CURRENT_ADMIN,
      requestMetadata: REQUEST_METADATA,
      patch: { sharing: { ipOverageMargin: 2 } },
    });
    assert.deepEqual(harness.column(), { sharing: { ipWindowMinutes: 45, ipOverageMargin: 2 } });
  });

  it('rejects an out-of-range value and writes nothing at all', async () => {
    const harness = createHarness({ sharing: { ipWindowMinutes: 45 } });
    await assert.rejects(
      () =>
        harness.service.updateAntiFraudSettings({
          currentAdmin: CURRENT_ADMIN,
          requestMetadata: REQUEST_METADATA,
          patch: { sharing: { ipWindowMinutes: 0 } },
        }),
      (error: unknown) => {
        assert.ok(error instanceof BadRequestException);
        assert.match((error as Error).message, /between 1 and 1440/);
        return true;
      },
    );
    assert.deepEqual(harness.writes, [], 'a rejected patch must not reach the column');
    assert.deepEqual(harness.auditLogs, [], 'and must not be audited as if it had');
    assert.deepEqual(harness.column(), { sharing: { ipWindowMinutes: 45 } });
  });

  it('clears a field back to the environment when the patch sends null', async () => {
    const harness = createHarness({ sharing: { ipWindowMinutes: 45, enableIpSharing: true } });
    const view = await harness.service.updateAntiFraudSettings({
      currentAdmin: CURRENT_ADMIN,
      requestMetadata: REQUEST_METADATA,
      patch: { sharing: { ipWindowMinutes: null } },
    });
    assert.deepEqual(harness.column(), { sharing: { enableIpSharing: true } });
    assert.equal(view.effective.sharing.ipWindowMinutes, 10, 'back to the fallback');
    assert.deepEqual(view.overridden.sharing, ['enableIpSharing']);
  });
});
