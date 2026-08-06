import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BadRequestException } from '@nestjs/common';

import {
  ConfigImportInput,
  ConfigImportService,
} from '../src/modules/config-portability/services/config-import.service';
import {
  ConfigExportPayloadInterface,
  ConfigExportSection,
  ConfigExportService,
} from '../src/modules/config-portability/services/config-export.service';

/**
 * Minimal Prisma stub. Records every adminPermission.create so tests can
 * assert exactly which grants the import attempted to persist. adminRole
 * always resolves so orphan-skipping never hides a create.
 */
function buildPrismaStub() {
  const createdPermissions: Array<{ roleId: string; resource: string; action: string }> = [];
  const tx = {
    adminRole: {
      findUnique: async () => ({ id: 'role-1', isSystem: false }),
    },
    adminPermission: {
      findUnique: async () => null,
      create: async (args: { data: { roleId: string; resource: string; action: string } }) => {
        createdPermissions.push(args.data);
        return args.data;
      },
    },
  };
  const prisma = {
    $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
  };
  return { prisma, createdPermissions };
}

function payloadWithPermissions(
  perms: Array<{ roleId: string; resource: string; action: string }>,
): ConfigExportPayloadInterface {
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    source: 'rezeis-admin',
    sections: { permissions: perms },
  };
}

function baseInput(
  payload: ConfigExportPayloadInterface,
  importerPermissions: ReadonlySet<string>,
): ConfigImportInput {
  return {
    payload,
    sections: ['permissions'],
    strategy: 'overwrite',
    dryRun: false,
    importerPermissions,
  };
}

describe('ConfigImportService — RBAC escalation guards', () => {
  it('rejects importing the permissions section without rbac_roles:edit', async () => {
    const { prisma, createdPermissions } = buildPrismaStub();
    const service = new ConfigImportService(prisma as never);
    const payload = payloadWithPermissions([
      { roleId: 'role-1', resource: 'rbac_roles', action: 'edit' },
    ]);

    await assert.rejects(
      () => service.importConfig(baseInput(payload, new Set(['config_portability:import']))),
      (err: unknown) => err instanceof BadRequestException,
    );
    assert.deepEqual(createdPermissions, []);
  });

  it('refuses to import a permission the importer does not itself hold', async () => {
    const { prisma, createdPermissions } = buildPrismaStub();
    const service = new ConfigImportService(prisma as never);
    // Importer holds rbac_roles:edit (passes the section gate) but NOT
    // admins:edit — so the admins:edit grant must be skipped, not created.
    const payload = payloadWithPermissions([
      { roleId: 'role-1', resource: 'admins', action: 'edit' },
    ]);

    const result = await service.importConfig(
      baseInput(payload, new Set(['config_portability:import', 'rbac_roles:edit'])),
    );

    const summary = result.summaries.find((s) => s.section === 'permissions');
    assert.equal(summary?.created, 0);
    assert.equal(summary?.skipped, 1);
    assert.deepEqual(createdPermissions, []);
  });

  it('skips grants that are not in the RBAC catalog', async () => {
    const { prisma, createdPermissions } = buildPrismaStub();
    const service = new ConfigImportService(prisma as never);
    const payload = payloadWithPermissions([
      { roleId: 'role-1', resource: 'made_up_resource', action: 'edit' },
    ]);

    const result = await service.importConfig(
      baseInput(payload, new Set(['rbac_roles:edit', 'made_up_resource:edit'])),
    );

    const summary = result.summaries.find((s) => s.section === 'permissions');
    assert.equal(summary?.created, 0);
    assert.equal(summary?.skipped, 1);
    assert.deepEqual(createdPermissions, []);
  });

  it('imports a permission the importer holds (⊆ own grants)', async () => {
    const { prisma, createdPermissions } = buildPrismaStub();
    const service = new ConfigImportService(prisma as never);
    const payload = payloadWithPermissions([
      { roleId: 'role-1', resource: 'payments', action: 'view' },
    ]);

    const result = await service.importConfig(
      baseInput(payload, new Set(['rbac_roles:edit', 'payments:view'])),
    );

    const summary = result.summaries.find((s) => s.section === 'permissions');
    assert.equal(summary?.created, 1);
    assert.deepEqual(createdPermissions, [
      { roleId: 'role-1', resource: 'payments', action: 'view' },
    ]);
  });
});

/**
 * A summary that reports success for a section it never saw
 * ─────────────────────────────────────────────────────────
 * `rows = payload.sections[section] ?? []` gave the same answer to two
 * unrelated questions: "the file says this section is empty" and "the file
 * has no such section". Both then hit the `rows.length === 0` early return
 * and came back as `created: 0, updated: 0, skipped: 0, errors: []` — the
 * shape of a clean no-op. An operator restoring a truncated backup read ten
 * green rows and concluded the restore had worked.
 *
 * The two facts are now different words. The tests below pin each one and,
 * separately, prove that nothing was written for the sections that were only
 * *reported* as untouched — a status string is worth nothing if the write
 * happened anyway.
 */

/** Delegate name per section, mirroring what ConfigImportService reaches for. */
const SECTION_DELEGATE: Readonly<Record<ConfigExportSection, string>> = {
  roles: 'adminRole',
  permissions: 'adminPermission',
  scopePolicies: 'adminScopePolicy',
  automations: 'automationRule',
  webhooks: 'webhookSubscription',
  notificationTemplates: 'notificationTemplate',
  settings: 'settings',
  blockedIps: 'blockedIp',
  adminIpAllowlist: 'adminIpAllowlist',
  faqItems: 'faqItem',
};

/**
 * Prisma stub covering every section, recording each write so a test can
 * assert the database was genuinely left alone rather than trusting the
 * summary it is checking.
 */
function buildRecordingStub() {
  const writes: string[] = [];
  const tx: Record<string, unknown> = {};

  for (const [section, name] of Object.entries(SECTION_DELEGATE)) {
    tx[name] = {
      // `adminRole.findUnique` doubles as the permission orphan check, so
      // it has to resolve for permissions to be creatable at all.
      findUnique: async () => (name === 'adminRole' ? { id: 'role-1', isSystem: false } : null),
      findFirst: async () => null,
      create: async (args: { data: Record<string, unknown> }) => {
        writes.push(`${section}.create`);
        return args.data;
      },
      update: async (args: { data: Record<string, unknown> }) => {
        writes.push(`${section}.update`);
        return args.data;
      },
    };
  }

  const prisma = {
    $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
  };
  return { prisma, writes };
}

function inputFor(
  payload: ConfigExportPayloadInterface,
  sections: readonly ConfigExportSection[] | null,
): ConfigImportInput {
  return {
    payload,
    sections,
    strategy: 'overwrite',
    dryRun: false,
    importerPermissions: new Set(['rbac_roles:edit', 'payments:view']),
  };
}

describe('ConfigImportService — an absent section is not an imported one', () => {
  it('marks a requested-but-absent section missing instead of reporting a clean no-op', async () => {
    const { prisma, writes } = buildRecordingStub();
    const service = new ConfigImportService(prisma as never);
    const payload: ConfigExportPayloadInterface = {
      version: 1,
      exportedAt: new Date().toISOString(),
      source: 'rezeis-admin',
      sections: { webhooks: [{ id: 'wh-1' }] },
    };

    const result = await service.importConfig(inputFor(payload, ['roles', 'webhooks']));

    const roles = result.summaries.find((s) => s.section === 'roles');
    assert.equal(roles?.status, 'missing');
    // The counts still read as a no-op — that is exactly why the status had
    // to exist. Asserting them here keeps the old shape from being the only
    // thing a reader sees.
    assert.equal(roles?.created, 0);
    assert.equal(roles?.updated, 0);
    // Naming a section the file cannot supply is a failed instruction, not
    // a footnote: it has to reach `errors`, which is the column the SPA
    // renders in red.
    assert.equal(roles?.errors.length, 1);
    assert.match(roles?.errors[0] ?? '', /absent/);

    // The healthy section still went through, so the refusal is targeted.
    const webhooks = result.summaries.find((s) => s.section === 'webhooks');
    assert.equal(webhooks?.status, 'imported');
    assert.deepEqual(writes, ['webhooks.create']);
  });

  it('marks an absent section missing without crying error when the whole file was requested', async () => {
    // Exporting a subset on purpose and then importing "everything" is a
    // normal workflow. Nine red rows would teach operators to ignore the
    // column that the case above depends on.
    const { prisma, writes } = buildRecordingStub();
    const service = new ConfigImportService(prisma as never);
    const payload: ConfigExportPayloadInterface = {
      version: 1,
      exportedAt: new Date().toISOString(),
      source: 'rezeis-admin',
      sections: { faqItems: [{ id: 'faq-1' }] },
    };

    const result = await service.importConfig(inputFor(payload, null));

    const missing = result.summaries.filter((s) => s.status === 'missing');
    assert.equal(missing.length, 9, 'nine sections are absent from this file');
    for (const summary of missing) {
      assert.deepEqual(summary.errors, [], `${summary.section} should carry no error`);
      assert.notEqual(summary.status, 'imported');
    }
    assert.equal(result.summaries.find((s) => s.section === 'faqItems')?.status, 'imported');
    assert.deepEqual(writes, ['faqItems.create']);
  });

  it('keeps "the source had none" distinct from "the file has none"', async () => {
    // Same zeros, different truth. `[]` is a claim the file makes and the
    // import is entitled to act on it; an absent key is not.
    const { prisma, writes } = buildRecordingStub();
    const service = new ConfigImportService(prisma as never);
    const payload: ConfigExportPayloadInterface = {
      version: 1,
      exportedAt: new Date().toISOString(),
      source: 'rezeis-admin',
      sections: { roles: [] },
    };

    const result = await service.importConfig(inputFor(payload, ['roles', 'automations']));

    const roles = result.summaries.find((s) => s.section === 'roles');
    const automations = result.summaries.find((s) => s.section === 'automations');
    assert.equal(roles?.status, 'imported');
    assert.deepEqual(roles?.errors, []);
    assert.equal(automations?.status, 'missing');
    // The counts are identical for both — the only thing telling them apart
    // is the status, so it must actually differ.
    assert.deepEqual(
      [roles?.created, roles?.updated, roles?.skipped],
      [automations?.created, automations?.updated, automations?.skipped],
    );
    assert.notEqual(roles?.status, automations?.status);
    assert.deepEqual(writes, []);
  });

  it('refuses a section that is present but is not an array of rows', async () => {
    // A hand-edited or half-decoded file. `?? []` let a string through and
    // `for (const row of "oops")` walked its characters, reporting four
    // skipped rows for a section that never existed.
    const { prisma, writes } = buildRecordingStub();
    const service = new ConfigImportService(prisma as never);
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      source: 'rezeis-admin',
      sections: { blockedIps: 'oops' },
    } as unknown as ConfigExportPayloadInterface;

    const result = await service.importConfig(inputFor(payload, ['blockedIps']));

    const blockedIps = result.summaries.find((s) => s.section === 'blockedIps');
    assert.equal(blockedIps?.status, 'rejected');
    assert.equal(blockedIps?.skipped, 0, 'a string must not be counted as four skipped rows');
    assert.match(blockedIps?.errors[0] ?? '', /not an array/);
    assert.deepEqual(writes, []);
  });
});

describe('ConfigImportService — classifying sections did not loosen the escalation gate', () => {
  it('still refuses a manifest-carrying payload of grants from an admin without rbac_roles:edit', async () => {
    // The gate now reads the classified rows instead of the raw payload.
    // A payload that reaches the importer down the new path — manifest and
    // all — must still be stopped by it.
    const { prisma, writes } = buildRecordingStub();
    const service = new ConfigImportService(prisma as never);
    const payload: ConfigExportPayloadInterface = {
      version: 1,
      exportedAt: new Date().toISOString(),
      source: 'rezeis-admin',
      manifest: { permissions: 1 },
      sections: {
        permissions: [{ roleId: 'role-1', resource: 'rbac_roles', action: 'edit' }],
      },
    };

    await assert.rejects(
      () =>
        service.importConfig({
          payload,
          sections: ['permissions'],
          strategy: 'overwrite',
          dryRun: false,
          importerPermissions: new Set(['config_portability:import']),
        }),
      (err: unknown) => err instanceof BadRequestException,
    );
    assert.deepEqual(writes, []);
  });

  it('diagnoses a malformed privileged section as malformed, not as an escalation attempt', async () => {
    // `(payload.sections.roles ?? []).length > 0` was true for the string
    // "oops", so a corrupt file was reported to the operator as an attempt
    // to escalate privileges — a diagnosis that sends them looking in
    // entirely the wrong place. Nothing is written either way; only the
    // explanation differs.
    const { prisma, writes } = buildRecordingStub();
    const service = new ConfigImportService(prisma as never);
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      source: 'rezeis-admin',
      sections: { roles: 'oops' },
    } as unknown as ConfigExportPayloadInterface;

    const result = await service.importConfig({
      payload,
      sections: ['roles'],
      strategy: 'overwrite',
      dryRun: false,
      importerPermissions: new Set(['config_portability:import']),
    });

    const roles = result.summaries.find((s) => s.section === 'roles');
    assert.equal(roles?.status, 'rejected');
    assert.match(roles?.errors[0] ?? '', /not an array/);
    assert.ok(
      !/rbac_roles:edit/.test(roles?.errors[0] ?? ''),
      'a corrupt file must not be reported as a privilege-escalation attempt',
    );
    assert.deepEqual(writes, []);
  });
});

describe('ConfigImportService — the file is held against its own manifest', () => {
  it('refuses a section whose rows contradict the manifest', async () => {
    // The truncation case: the manifest remembers twelve roles, the payload
    // carries none. Importing zero roles is a silent no-op, which is exactly
    // the outcome that used to be reported as a success.
    const { prisma, writes } = buildRecordingStub();
    const service = new ConfigImportService(prisma as never);
    const payload: ConfigExportPayloadInterface = {
      version: 1,
      exportedAt: new Date().toISOString(),
      source: 'rezeis-admin',
      manifest: { roles: 12, webhooks: 1 },
      sections: { roles: [], webhooks: [{ id: 'wh-1' }] },
    };

    const result = await service.importConfig(inputFor(payload, ['roles', 'webhooks']));

    const roles = result.summaries.find((s) => s.section === 'roles');
    assert.equal(roles?.status, 'rejected');
    assert.match(roles?.errors[0] ?? '', /manifest/);
    assert.match(roles?.errors[0] ?? '', /12/);
    assert.equal(result.integrity, 'violated');
    // The intact section is still imported — a damaged file is not an
    // excuse to abandon the parts that survived.
    assert.equal(result.summaries.find((s) => s.section === 'webhooks')?.status, 'imported');
    assert.deepEqual(writes, ['webhooks.create']);
  });

  it('refuses a section the manifest declares but the payload dropped entirely', async () => {
    const { prisma, writes } = buildRecordingStub();
    const service = new ConfigImportService(prisma as never);
    const payload: ConfigExportPayloadInterface = {
      version: 1,
      exportedAt: new Date().toISOString(),
      source: 'rezeis-admin',
      manifest: { adminIpAllowlist: 4 },
      sections: {},
    };

    const result = await service.importConfig(inputFor(payload, ['adminIpAllowlist']));

    const allowlist = result.summaries.find((s) => s.section === 'adminIpAllowlist');
    // Not "missing": the file itself says this section should be here, so
    // its absence is damage rather than a deliberate omission.
    assert.equal(allowlist?.status, 'rejected');
    assert.equal(result.integrity, 'violated');
    assert.deepEqual(writes, []);
  });

  it('refuses a section injected into a payload the manifest does not account for', async () => {
    const { prisma, writes } = buildRecordingStub();
    const service = new ConfigImportService(prisma as never);
    const payload: ConfigExportPayloadInterface = {
      version: 1,
      exportedAt: new Date().toISOString(),
      source: 'rezeis-admin',
      manifest: { faqItems: 1 },
      sections: { faqItems: [{ id: 'faq-1' }], blockedIps: [{ id: 'ip-1' }] },
    };

    const result = await service.importConfig(inputFor(payload, ['faqItems', 'blockedIps']));

    assert.equal(result.summaries.find((s) => s.section === 'blockedIps')?.status, 'rejected');
    assert.equal(result.summaries.find((s) => s.section === 'faqItems')?.status, 'imported');
    assert.deepEqual(writes, ['faqItems.create']);
  });

  it('rejects a manifest that is not a map of counts', async () => {
    const { prisma } = buildRecordingStub();
    const service = new ConfigImportService(prisma as never);
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      source: 'rezeis-admin',
      manifest: { roles: 'lots' },
      sections: { roles: [] },
    } as unknown as ConfigExportPayloadInterface;

    await assert.rejects(
      () => service.importConfig(inputFor(payload, ['roles'])),
      (err: unknown) => err instanceof BadRequestException,
    );
  });

  it('treats a null manifest as an absent one rather than as a damaged file', async () => {
    // Reachability guard: `readManifest` normalises null to undefined, so
    // `assertManifestShape` has to let null through or that branch is dead
    // code and every null-manifest file is a 400 instead of a legacy file.
    const { prisma } = buildRecordingStub();
    const service = new ConfigImportService(prisma as never);
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      source: 'rezeis-admin',
      manifest: null,
      sections: { roles: [{ id: 'role-1' }] },
    } as unknown as ConfigExportPayloadInterface;

    const result = await service.importConfig(inputFor(payload, ['roles']));

    assert.equal(result.integrity, 'unverifiable');
    assert.equal(result.summaries.find((s) => s.section === 'roles')?.status, 'imported');
  });

  it('calls a file with no manifest unverifiable rather than verified', async () => {
    // This is the honest limit of the fix. A file produced by the code that
    // swallowed section failures carries `"roles": []` and no manifest, and
    // nothing in it distinguishes that from a deployment with no roles. The
    // import cannot detect it — so it says so instead of implying a check
    // that never ran.
    const { prisma } = buildRecordingStub();
    const service = new ConfigImportService(prisma as never);
    const payload: ConfigExportPayloadInterface = {
      version: 1,
      exportedAt: new Date().toISOString(),
      source: 'rezeis-admin',
      sections: { roles: [], webhooks: [] },
    };

    const result = await service.importConfig(inputFor(payload, ['roles', 'webhooks']));

    assert.equal(result.integrity, 'unverifiable');
    assert.notEqual(result.integrity, 'verified');
    for (const summary of result.summaries) {
      assert.equal(summary.status, 'imported');
      assert.deepEqual(summary.errors, []);
    }
  });
});

describe('ConfigImportService — a healthy round-trip is unchanged', () => {
  it('imports every section of a freshly exported file with no errors', async () => {
    // Drives the real export service into the real import service so the
    // manifest under test is the one production writes, not one the test
    // invented.
    const exportPrisma = {
      adminRole: { findMany: async () => [{ id: 'role-1', name: 'Support' }] },
      adminPermission: {
        findMany: async () => [{ id: 'perm-1', roleId: 'role-1', resource: 'payments', action: 'view' }],
      },
      webhookSubscription: { findMany: async () => [{ id: 'wh-1', url: 'https://example.test/hook' }] },
      settings: { findFirst: async () => ({ id: 1, panelName: 'Rezeis' }) },
    };
    const exportService = new ConfigExportService(exportPrisma as never);
    const payload = await exportService.exportConfig([
      'roles',
      'permissions',
      'webhooks',
      'settings',
    ]);

    const { prisma, writes } = buildRecordingStub();
    const importService = new ConfigImportService(prisma as never);
    const result = await importService.importConfig(inputFor(payload, null));

    assert.equal(result.integrity, 'verified');
    for (const section of ['roles', 'permissions', 'webhooks', 'settings'] as const) {
      const summary = result.summaries.find((s) => s.section === section);
      assert.equal(summary?.status, 'imported', `${section} should have imported`);
      assert.deepEqual(summary?.errors, [], `${section} should carry no error`);
      assert.equal(
        (summary?.created ?? 0) + (summary?.updated ?? 0) + (summary?.skipped ?? 0),
        1,
        `${section} should account for its single row`,
      );
    }
    // Every one of the four rows reached the database; nothing was quietly
    // dropped on the way through the new classification pass.
    assert.equal(writes.length, 4, `expected four writes, got ${writes.join(', ')}`);

    // The sections this subset export never covered are absent, so the
    // import reports them as such rather than as six clean successes.
    const missing = result.summaries.filter((s) => s.status === 'missing').map((s) => s.section);
    assert.deepEqual(missing.sort(), [
      'adminIpAllowlist',
      'automations',
      'blockedIps',
      'faqItems',
      'notificationTemplates',
      'scopePolicies',
    ]);
  });
});
