import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ImportStatus, UserRole, type ImportRecord, type Prisma } from '@prisma/client';

import { AdminJwtAuthGuard } from '../src/modules/auth/guards/admin-jwt-auth.guard';
import { CurrentAdminInterface } from '../src/modules/auth/interfaces/current-admin.interface';
import { AdminImportsController } from '../src/modules/imports/controllers/admin-imports.controller';
import { BackupPlanClonerService } from '../src/modules/imports/services/backup-plan-cloner.service';
import { ImportQueueService } from '../src/modules/imports/services/import-queue.service';
import { ImportsService } from '../src/modules/imports/services/imports.service';
import { RbacGuard } from '../src/modules/rbac/guards/rbac.guard';
import { RBAC_RESOURCES, SYSTEM_ROLES, isValidPermission } from '../src/modules/rbac/rbac.resources';
import {
  assertEveryRouteGuarded,
  assertRoute,
  assertRouteHandlers,
  assertRoutePermission,
  routeLabel,
  type RouteHandler,
} from './helpers/controller-routes';

/** Where the controller answers — stated once, checked below and used in labels. */
const BASE_PATH = 'admin/imports';

describe('AdminImportsController', () => {
  it('exposes the current guarded admin imports routes', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, AdminImportsController), BASE_PATH);
    assert.deepStrictEqual(Reflect.getMetadata(GUARDS_METADATA, AdminImportsController), [AdminJwtAuthGuard, RbacGuard]);
    // The set of routes is read off the class, not remembered here. This test
    // exists to prove every import endpoint is gated; without this line it
    // proved it only of the thirteen someone typed out, and a fourteenth —
    // `@RequirePermission` or not — passed it untouched.
    assertRouteHandlers(AdminImportsController, [
      'listImports',
      'getImport',
      'importFromRemnawave',
      'syncFromRemnawave',
      'importFrom3xui',
      'importFromRemnashop',
      'importFromAltshop',
      'importFromStealthnet',
      'importFromBedolaga',
      'assignPlanToImported',
      'cancelImport',
      'rollbackImport',
      'previewPlanClone',
      'clonePlans',
    ]);

    for (const route of IMPORT_ROUTES) {
      const label = routeLabel(BASE_PATH, route.method, route.path);
      assertRoute(route.handler, { method: route.method, path: route.path }, label);
      assertRoutePermission(route.handler, { resource: 'imports', action: route.action }, label);
    }
    // The rows above say what each LISTED route costs; this says no route
    // escaped having a cost at all. The enumeration forces a new endpoint to be
    // noticed, but it is satisfied by adding a name to it — and an import route
    // with no `@RequirePermission` is not refused by `RbacGuard`, it is waved
    // through (`rbac.guard.ts:41`). On this controller that means bulk user
    // creation and plan assignment open to every signed-in admin. No import
    // route is exempt, hence no list.
    assertEveryRouteGuarded(AdminImportsController);
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
        list: async (input) => {
          assert.deepStrictEqual(input, { limit: 10, offset: 0 });
          return [record];
        },
        getById: async (importId) => {
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
    const fileImports: FileImportInput[] = [];
    const controller = createController({
      importQueueService: {
        enqueueRemnawaveImport: async (input) => {
          calls.push(['remnawave', input]);
          return { importRecordId: 'import-remna', jobId: 'job-remna' };
        },
        enqueueFileImport: async (input) => {
          calls.push(['file', input]);
          fileImports.push(input);
          return { importRecordId: 'import-file', jobId: 'job-file' };
        },
        enqueueAssignPlan: async (input) => {
          calls.push(['assign', input]);
          return 'job-assign';
        },
        cancelImport: async (importId) => {
          calls.push(['cancel', importId]);
          return true;
        },
      },
    });
    const file = uploadedFile({ buffer: Buffer.from('{}'), originalname: 'backup.json' });

    assert.deepStrictEqual(await controller.importFromRemnawave(ADMIN), {
      importRecordId: 'import-remna',
      jobId: 'job-remna',
      message: 'Remnawave import enqueued',
    });
    assert.deepStrictEqual(await controller.syncFromRemnawave(ADMIN), {
      importRecordId: 'import-remna',
      jobId: 'job-remna',
      message: 'Remnawave sync enqueued',
    });
    assert.deepStrictEqual(await controller.importFromAltshop(ADMIN, file, { syncToPanel: 'true' }), {
      importRecordId: 'import-file',
      jobId: 'job-file',
      message: 'Altshop import enqueued',
    });
    // The opt-in "sync to panel after import" flag reaches the queue as a boolean.
    const altshopCall = fileImports.find((call) => call.sourceType === 'altshop');
    assert.equal(altshopCall?.syncToPanel, true);
    assert.deepStrictEqual(await controller.assignPlanToImported(ADMIN, { planId: 'plan-1', userIds: ['user-1'] }), {
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

    await assert.rejects(() => controller.importFrom3xui(ADMIN), /File is required/);
    await assert.rejects(
      () => controller.assignPlanToImported(ADMIN, { planId: '' }),
      /planId is required/,
    );
  });
});

/**
 * Each dependency is stubbed as `Partial<Pick<Service, …>>`.
 *
 * `Pick` keeps the member types IDENTICAL to the service's own, so every stub
 * body is checked against the real signature — argument shapes included, which
 * is why the stubs below take no parameter annotations at all: they are
 * contextually typed off `ImportQueueService` and `ImportsService`. `Partial`
 * is what lets a test stub only the methods its route touches, and it keeps a
 * misspelled method name an excess-property error rather than a silent no-op.
 *
 * The single widening per argument is safe in the way a blanket cast is not:
 * `Service` is assignable to `Partial<Pick<Service, …>>`, so the compiler still
 * has to agree the two describe the same members.
 */
type ImportsServiceStub = Partial<Pick<ImportsService, 'list' | 'getById' | 'rollback'>>;
type ImportQueueServiceStub = Partial<
  Pick<
    ImportQueueService,
    'enqueueRemnawaveImport' | 'enqueueFileImport' | 'enqueueAssignPlan' | 'cancelImport'
  >
>;
type BackupPlanClonerServiceStub = Partial<Pick<BackupPlanClonerService, 'preview' | 'clone'>>;

/** Exactly what the queue is handed for a file-backed import. */
type FileImportInput = Parameters<ImportQueueService['enqueueFileImport']>[0];

/** A complete admin profile — the routes take the whole thing, not just `id`. */
const ADMIN: CurrentAdminInterface = {
  id: 'admin-1',
  login: 'admin',
  email: 'admin@example.com',
  name: 'Admin',
  role: UserRole.ADMIN,
  isActive: true,
  tokenVersion: 1,
  createdAt: new Date('2026-04-24T12:00:00.000Z'),
  lastLoginAt: null,
  lastLoginIp: null,
  rbacRoleId: null,
  mustChangePassword: false,
};

function createController(input: {
  readonly importsService?: ImportsServiceStub;
  readonly importQueueService?: ImportQueueServiceStub;
  readonly backupPlanClonerService?: BackupPlanClonerServiceStub;
} = {}): AdminImportsController {
  return new AdminImportsController(
    (input.importsService ?? {}) as ImportsService,
    (input.importQueueService ?? {}) as ImportQueueService,
    (input.backupPlanClonerService ?? {}) as BackupPlanClonerService,
  );
}

/**
 * The upload as the controller sees it: it reads `buffer` and `originalname`
 * and nothing else. The rest of `Express.Multer.File` is Multer's storage
 * bookkeeping (`stream`, `destination`, `path`, …) and inventing values for it
 * would state things this test has no opinion about — so the narrow view is
 * checked against the real interface and widened once, here.
 */
function uploadedFile(
  file: Pick<Express.Multer.File, 'buffer' | 'originalname'>,
): Express.Multer.File {
  return file as Express.Multer.File;
}

function createImportRecord(input: { readonly result: Prisma.JsonValue }): ImportRecord {
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
    updatedAt: new Date('2026-04-24T12:00:00.000Z'),
  };
}

/** One import endpoint as this spec states it: where it answers and what it costs. */
interface ImportRoute {
  readonly handler: RouteHandler;
  readonly method: RequestMethod;
  /** `'/'` is what a bare `@Get()` records — the collection itself. */
  readonly path: string;
  /** The `imports` action the route is gated on. */
  readonly action: string;
}

/** The routes themselves, so a row names a handler the compiler has to find. */
const handlers = AdminImportsController.prototype;

const IMPORT_ROUTES: readonly ImportRoute[] = [
  { handler: handlers.listImports, method: RequestMethod.GET, path: '/', action: 'view' },
  { handler: handlers.getImport, method: RequestMethod.GET, path: ':importId', action: 'view' },
  { handler: handlers.importFromRemnawave, method: RequestMethod.POST, path: 'remnawave', action: 'import' },
  { handler: handlers.syncFromRemnawave, method: RequestMethod.POST, path: 'remnawave/sync', action: 'run' },
  { handler: handlers.importFrom3xui, method: RequestMethod.POST, path: '3xui', action: 'import' },
  { handler: handlers.importFromRemnashop, method: RequestMethod.POST, path: 'remnashop', action: 'import' },
  { handler: handlers.importFromAltshop, method: RequestMethod.POST, path: 'altshop', action: 'import' },
  { handler: handlers.importFromStealthnet, method: RequestMethod.POST, path: 'stealthnet', action: 'import' },
  { handler: handlers.importFromBedolaga, method: RequestMethod.POST, path: 'bedolaga', action: 'import' },
  { handler: handlers.assignPlanToImported, method: RequestMethod.POST, path: 'assign-plan', action: 'run' },
  { handler: handlers.cancelImport, method: RequestMethod.POST, path: ':importId/cancel', action: 'run' },
  { handler: handlers.rollbackImport, method: RequestMethod.POST, path: ':importId/rollback', action: 'run' },
  { handler: handlers.previewPlanClone, method: RequestMethod.GET, path: ':importId/plan-preview', action: 'view' },
  { handler: handlers.clonePlans, method: RequestMethod.POST, path: ':importId/clone-plans', action: 'run' },
];
