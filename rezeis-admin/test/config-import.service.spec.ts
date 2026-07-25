import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BadRequestException } from '@nestjs/common';

import {
  ConfigImportInput,
  ConfigImportService,
} from '../src/modules/config-portability/services/config-import.service';
import { ConfigExportPayloadInterface } from '../src/modules/config-portability/services/config-export.service';

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
