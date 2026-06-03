import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ImportStatus } from '@prisma/client';

import { AdminJwtAuthGuard } from '../src/modules/auth/guards/admin-jwt-auth.guard';
import { AdminImportsController } from '../src/modules/imports/controllers/admin-imports.controller';
import { REQUIRE_PERMISSION_KEY } from '../src/modules/rbac/decorators/require-permission.decorator';
import { RbacGuard } from '../src/modules/rbac/guards/rbac.guard';
import { RBAC_RESOURCES, SYSTEM_ROLES, isValidPermission } from '../src/modules/rbac/rbac.resources';

describe('AdminImportsController', () => {
  it('exposes the current guarded admin imports routes', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, AdminImportsController), 'admin/imports');
    assert.deepStrictEqual(Reflect.getMetadata(GUARDS_METADATA, AdminImportsController), [AdminJwtAuthGuard, RbacGuard]);
    assertRoute(RequestMethod.GET, '/', AdminImportsController.prototype.listImports, 'view');
    assertRoute(RequestMethod.GET, ':importId', AdminImportsController.prototype.getImport, 'view');
    assertRoute(RequestMethod.POST, 'remnawave', AdminImportsController.prototype.importFromRemnawave, 'import');
    assertRoute(RequestMethod.POST, 'remnawave/sync', AdminImportsController.prototype.syncFromRemnawave, 'run');
    assertRoute(RequestMethod.POST, '3xui', AdminImportsController.prototype.importFrom3xui, 'import');
    assertRoute(RequestMethod.POST, 'remnashop', AdminImportsController.prototype.importFromRemnashop, 'import');
    assertRoute(RequestMethod.POST, 'altshop', AdminImportsController.prototype.importFromAltshop, 'import');
    assertRoute(RequestMethod.POST, 'stealthnet', AdminImportsController.prototype.importFromStealthnet, 'import');
    assertRoute(RequestMethod.POST, 'assign-plan', AdminImportsController.prototype.assignPlanToImported, 'run');
    assertRoute(RequestMethod.POST, ':importId/cancel', AdminImportsController.prototype.cancelImport, 'run');
    assertRoute(RequestMethod.GET, ':importId/plan-preview', AdminImportsController.prototype.previewPlanClone, 'view');
    assertRoute(RequestMethod.POST, ':importId/clone-plans', AdminImportsController.prototype.clonePlans, 'run');
  });

  it('declares import permissions without granting default non-superadmin roles', () => {
    assert.deepStrictEqual(RBAC_RESOURCES.imports, ['view', 'create', 'import', 'run']);
    assert.equal(isValidPermission('imports', 'view'), true);
    assert.equal(isValidPermission('imports', 'create'), true);
    assert.equal(isValidPermission('imports', 'import'), true);
    assert.equal(isValidPermission('imports', 'run'), true);

    const nonSuperadminSystemGrants = SYSTEM_ROLES
      .filter((role) => role.name !== 'superadmin')
      .flatMap((role) => role.permissions)
      .filter((permission) => permission.resource === 'imports');
    assert.deepStrictEqual(nonSuperadminSystemGrants, []);
  });

  it('serializes list/detail import records without wrapping or leaking non-object results', async () => {
    const record = createImportRecord({ result: ['unexpected-array-result'] });
    const controller = createController({
      importsService: {
        list: async (input: unknown) => {
          assert.deepStrictEqual(input, { limit: 10, offset: 0 });
          return [record];
        },
        getById: async (importId: string) => {
          assert.equal(importId, 'import-1');
          return { ...record, result: { created: 2 } };
        },
      },
    });

    assert.deepStrictEqual(await controller.listImports('10', '-1'), {
      items: [
        {
          id: 'import-1',
          filename: 'import.json',
          sourceType: 'remnawave',
          status: ImportStatus.DRY_RUN,
          recordsTotal: 2,
          recordsOk: 1,
          recordsFailed: 1,
          errorMessage: null,
          createdBy: 'admin-1',
          committedAt: null,
          rolledBackAt: null,
          createdAt: '2026-04-24T12:00:00.000Z',
          result: null,
        },
      ],
      total: 1,
    });
    assert.deepStrictEqual((await controller.getImport('import-1')).result, { created: 2 });
  });

  it('delegates queue-backed import commands with admin context', async () => {
    const calls: unknown[] = [];
    const controller = createController({
      importQueueService: {
        enqueueRemnawaveImport: async (input: unknown) => {
          calls.push(['remnawave', input]);
          return { importRecordId: 'import-remna', jobId: 'job-remna' };
        },
        enqueueFileImport: async (input: unknown) => {
          calls.push(['file', input]);
          return { importRecordId: 'import-file', jobId: 'job-file' };
        },
        enqueueAssignPlan: async (input: unknown) => {
          calls.push(['assign', input]);
          return 'job-assign';
        },
        cancelImport: async (importId: string) => {
          calls.push(['cancel', importId]);
          return true;
        },
      },
    });
    const admin = { id: 'admin-1' } as never;
    const file = { buffer: Buffer.from('{}'), originalname: 'backup.json' } as Express.Multer.File;

    assert.deepStrictEqual(await controller.importFromRemnawave(admin), {
      importRecordId: 'import-remna',
      jobId: 'job-remna',
      message: 'Remnawave import enqueued',
    });
    assert.deepStrictEqual(await controller.syncFromRemnawave(admin), {
      importRecordId: 'import-remna',
      jobId: 'job-remna',
      message: 'Remnawave sync enqueued',
    });
    assert.deepStrictEqual(await controller.importFromAltshop(admin, file), {
      importRecordId: 'import-file',
      jobId: 'job-file',
      message: 'Altshop import enqueued',
    });
    assert.deepStrictEqual(await controller.assignPlanToImported(admin, { planId: 'plan-1', userIds: ['user-1'] }), {
      jobId: 'job-assign',
      message: 'Plan assignment enqueued',
    });
    assert.deepStrictEqual(await controller.cancelImport('import-1'), {
      canceled: true,
      message: 'Import canceled',
    });
    assert.equal(JSON.stringify(calls).includes('admin-1'), true);
    assert.equal(JSON.stringify(calls).includes('backup.json'), true);
  });

  it('rejects file import and assignment requests that miss required inputs', async () => {
    const controller = createController();

    await assert.rejects(() => controller.importFrom3xui({ id: 'admin-1' } as never), /File is required/);
    await assert.rejects(
      () => controller.assignPlanToImported({ id: 'admin-1' } as never, { planId: '' }),
      /planId is required/,
    );
  });
});

function createController(input: {
  readonly importsService?: Record<string, unknown>;
  readonly importQueueService?: Record<string, unknown>;
  readonly backupPlanClonerService?: Record<string, unknown>;
} = {}): AdminImportsController {
  return new AdminImportsController(
    (input.importsService ?? {}) as never,
    (input.importQueueService ?? {}) as never,
    (input.backupPlanClonerService ?? {}) as never,
  );
}

function createImportRecord(input: { readonly result: unknown }) {
  return {
    id: 'import-1',
    filename: 'import.json',
    sourceType: 'remnawave',
    status: ImportStatus.DRY_RUN,
    recordsTotal: 2,
    recordsOk: 1,
    recordsFailed: 1,
    errorMessage: null,
    result: input.result,
    createdBy: 'admin-1',
    committedAt: null,
    rolledBackAt: null,
    createdAt: new Date('2026-04-24T12:00:00.000Z'),
  };
}

function assertRoute(requestMethod: RequestMethod, path: string | undefined, target: unknown, action: string): void {
  assert.equal(Reflect.getMetadata(METHOD_METADATA, target), requestMethod);
  assert.equal(Reflect.getMetadata(PATH_METADATA, target), path);
  assert.deepStrictEqual(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, target), [
    { resource: 'imports', action },
  ]);
}
