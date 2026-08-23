import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Request } from 'express';

import { AdminConfigPortabilityController } from '../src/modules/config-portability/controllers/admin-config-portability.controller';
import { ConfigExportService } from '../src/modules/config-portability/services/config-export.service';
import { ConfigImportService } from '../src/modules/config-portability/services/config-import.service';
import type {
  ConfigExportRequestOptions,
} from '../src/modules/config-portability/services/config-export.service';
import type { ConfigImportInput } from '../src/modules/config-portability/services/config-import.service';
import { CurrentAdminInterface } from '../src/modules/auth/interfaces/current-admin.interface';

/**
 * Nothing in config-portability was audited
 * ─────────────────────────────────────────
 * `GET /admin/config/export` hands out the deployment's whole configuration as
 * a file, and `POST /admin/config/import` rewrites it. Neither wrote an
 * `adminAuditLog` row. An incident responder had nothing at all: not who
 * exported, not from where, not which sections, not what the import changed.
 *
 * The actor comes from `@CurrentAdmin()` — proved by the JWT — and never from
 * the request body, which the last test here sends deliberately.
 */

const ADMIN: CurrentAdminInterface = {
  id: 'admin-3',
  login: 'ops',
  email: null,
  name: null,
  role: 'ADMIN' as CurrentAdminInterface['role'],
  isActive: true,
  tokenVersion: 1,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  lastLoginAt: null,
  lastLoginIp: null,
  rbacRoleId: 'role-ops',
  mustChangePassword: false,
};

interface AuditRow {
  readonly action: string;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly metadata: Record<string, unknown>;
  readonly adminUser: { connect: { id: string } };
}

function fakeRequest(body: Record<string, unknown> = {}): Request {
  return {
    body,
    ip: '203.0.113.4',
    headers: { 'user-agent': 'Mozilla/5.0', 'x-request-id': 'req-9' },
    socket: { remoteAddress: '203.0.113.4' },
  } as unknown as Request;
}

function auditingPrisma(rows: AuditRow[]): Record<string, unknown> {
  return {
    adminAuditLog: {
      create: async (input: { data: AuditRow }) => {
        rows.push(input.data);
        return {};
      },
    },
    adminRole: { findMany: async () => [{ id: 'role-1', name: 'ops', displayName: 'Ops' }] },
    adminPermission: { findMany: async () => [] },
    adminScopePolicy: { findMany: async () => [] },
    automationRule: { findMany: async () => [] },
    webhookSubscription: { findMany: async () => [] },
    notificationTemplate: { findMany: async () => [] },
    settings: { findFirst: async () => null },
    blockedIp: { findMany: async () => [] },
    adminIpAllowlist: { findMany: async () => [] },
    faqItem: { findMany: async () => [] },
    legalDocument: { findMany: async () => [] },
  };
}

describe('config export — the file that leaves is recorded', () => {
  it('writes an audit row naming the actor, the sections and the secret opt-in', async () => {
    const rows: AuditRow[] = [];
    const service = new ConfigExportService(auditingPrisma(rows) as never);

    await service.exportConfig(['roles', 'webhooks'], {
      includeWebhookSecrets: true,
      actor: {
        adminId: 'admin-3',
        ipAddress: '203.0.113.4',
        userAgent: 'Mozilla/5.0',
        requestId: 'req-9',
      },
    });

    assert.equal(rows.length, 1);
    const row = rows[0]!;
    assert.equal(row.action, 'config_portability.exported');
    assert.equal(row.adminUser.connect.id, 'admin-3');
    assert.equal(row.ipAddress, '203.0.113.4');
    assert.deepEqual(row.metadata.sections, ['roles', 'webhooks']);
    assert.equal(
      row.metadata.includeWebhookSecrets,
      true,
      'whether live signing secrets left the box is the first thing anyone will ask',
    );
  });

  it('stays usable without an actor, so nothing forces an HTTP context', async () => {
    const rows: AuditRow[] = [];
    const service = new ConfigExportService(auditingPrisma(rows) as never);
    await service.exportConfig(['roles']);
    assert.deepEqual(rows, []);
  });
});

describe('config import — what it changed is recorded', () => {
  it('writes an audit row naming the sections, the strategy and the dry-run flag', async () => {
    const rows: AuditRow[] = [];
    const prisma = {
      ...auditingPrisma(rows),
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          adminRole: {
            findUnique: async () => null,
            create: async () => ({}),
            update: async () => ({}),
          },
        }),
    };
    const service = new ConfigImportService(prisma as never);

    await service.importConfig({
      payload: {
        version: 1,
        exportedAt: '2026-01-01T00:00:00.000Z',
        source: 'rezeis-admin',
        manifest: { roles: 1 },
        sections: { roles: [{ id: 'role-1', name: 'ops', displayName: 'Ops' }] },
      },
      sections: ['roles'],
      strategy: 'overwrite',
      dryRun: false,
      importerPermissions: new Set(['config_portability:import', 'rbac_roles:edit']),
      actor: {
        adminId: 'admin-3',
        ipAddress: '203.0.113.4',
        userAgent: 'Mozilla/5.0',
        requestId: 'req-9',
      },
    });

    assert.equal(rows.length, 1);
    const row = rows[0]!;
    assert.equal(row.action, 'config_portability.imported');
    assert.equal(row.adminUser.connect.id, 'admin-3');
    assert.equal(row.metadata.strategy, 'overwrite');
    assert.equal(row.metadata.dryRun, false);
    const sections = row.metadata.sections as { section: string; created: number }[];
    assert.equal(sections.length, 1);
    assert.equal(sections[0]?.section, 'roles');
    assert.equal(sections[0]?.created, 1, 'the row must say what actually moved');
  });
});

describe('AdminConfigPortabilityController — the actor is the token, not the payload', () => {
  it('passes the authenticated admin and the request metadata to both services', async () => {
    const exportCalls: ConfigExportRequestOptions[] = [];
    const importCalls: ConfigImportInput[] = [];
    const controller = new AdminConfigPortabilityController(
      {
        exportConfig: async (_sections: unknown, options: ConfigExportRequestOptions) => {
          exportCalls.push(options);
          return {};
        },
      } as never,
      {
        importConfig: async (input: ConfigImportInput) => {
          importCalls.push(input);
          return {};
        },
      } as never,
      { getEffectivePermissions: async () => [] } as never,
    );

    // A body naming a different admin: the audit row must ignore it entirely.
    const request = fakeRequest({ adminId: 'someone-else' });
    await controller.exportConfig({ sections: ['roles'] }, ADMIN, request);
    await controller.importConfig(
      {
        payload: { version: 1, sections: {} },
        sections: ['roles'],
        strategy: 'skip',
        dryRun: true,
        adminId: 'someone-else',
      } as never,
      ADMIN,
      request,
    );

    assert.equal(exportCalls[0]?.actor?.adminId, 'admin-3');
    assert.equal(exportCalls[0]?.actor?.ipAddress, '203.0.113.4');
    assert.equal(exportCalls[0]?.actor?.requestId, 'req-9');
    assert.equal(importCalls[0]?.actor?.adminId, 'admin-3');
  });

  /**
   * This case used to be called "unless the query asks", and that name was the
   * vulnerability written down as a contract: asking was sufficient. Reading an
   * existing webhook signing secret is the one thing the panel cannot otherwise
   * do — `POST subscriptions` and `POST subscriptions/:id/regenerate-secret`
   * both MINT a new value, and list responses hardcode `secret: null` — so the
   * flag is a read power of its own and carries its own grant.
   *
   * The SPA also gates the control, but `PermissionGate` documents itself as a
   * UX hint rather than a boundary, so the refusal below is the boundary.
   */
  function controllerWith(
    grants: ReadonlyArray<{ resource: string; action: string }>,
    exportCalls: ConfigExportRequestOptions[],
  ): AdminConfigPortabilityController {
    return new AdminConfigPortabilityController(
      {
        exportConfig: async (_sections: unknown, options: ConfigExportRequestOptions) => {
          exportCalls.push(options);
          return {};
        },
      } as never,
      { importConfig: async () => ({}) } as never,
      { getEffectivePermissions: async () => grants } as never,
    );
  }

  it('keeps webhook secrets out of the export unless the query asks AND the caller may', async () => {
    const exportCalls: ConfigExportRequestOptions[] = [];
    const controller = controllerWith([{ resource: 'webhooks', action: 'edit' }], exportCalls);

    await controller.exportConfig({ sections: ['webhooks'] }, ADMIN, fakeRequest());
    await controller.exportConfig(
      { sections: ['webhooks'], includeWebhookSecrets: true },
      ADMIN,
      fakeRequest(),
    );

    assert.equal(exportCalls[0]?.includeWebhookSecrets, false);
    assert.equal(exportCalls[1]?.includeWebhookSecrets, true);
  });

  it('refuses the secret-bearing export to a caller who only holds the export permission', async () => {
    // The half the old name licensed away. `config_portability:export` alone
    // reached every live signing secret in the deployment.
    const exportCalls: ConfigExportRequestOptions[] = [];
    const controller = controllerWith([], exportCalls);

    await assert.rejects(
      () =>
        controller.exportConfig(
          { sections: ['webhooks'], includeWebhookSecrets: true },
          ADMIN,
          fakeRequest(),
        ),
      /webhook/i,
    );
    // And it refused BEFORE the export service read anything, so a refusal
    // cannot leave secrets sitting in a payload nobody ends up receiving.
    assert.deepEqual(exportCalls, []);
  });

  it('leaves an ordinary export untouched for a caller without that grant', async () => {
    // The other half of the rule. A gate that broke ordinary export would be
    // its own outage, and is the failure mode a refusal test alone would miss.
    const exportCalls: ConfigExportRequestOptions[] = [];
    const controller = controllerWith([], exportCalls);

    await controller.exportConfig({ sections: ['webhooks'] }, ADMIN, fakeRequest());

    assert.equal(exportCalls.length, 1);
    assert.equal(exportCalls[0]?.includeWebhookSecrets, false);
  });
});
