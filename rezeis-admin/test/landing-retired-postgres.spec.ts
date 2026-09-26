import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { UserRole } from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import type { CurrentAdminInterface } from '../src/modules/auth/interfaces/current-admin.interface';
import { AdminAdminsController } from '../src/modules/rbac/controllers/admin-admins.controller';
import { getAllPermissions } from '../src/modules/rbac/rbac.resources';
import { RbacService } from '../src/modules/rbac/services/rbac.service';

/**
 * THE RETIRED LANDING, AGAINST POSTGRESQL (0.9.7.71)
 *
 * Two things the in-memory specs can only assume:
 *
 *  - after every migration there is, `landing_configs` and `landing_revisions`
 *    are still there with the columns they were created with, and the kept
 *    Prisma models still read and write them — the operators' landings are
 *    data a later release may export, and a rollback to 0.9.7.70 reads;
 *  - a custom role that stores `landing_config` rows, as 0.9.7.70 wrote them,
 *    is shown without them, saves with what it was shown, and its holder can
 *    be edited by a DEV — through the real `include`/`select` shapes and the
 *    real `createMany`, not a double's reading of them.
 *
 * Skipped without TEST_DATABASE_URL; listed in the PostgreSQL job of ci.yml.
 */

const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;
const prefix = `landing-retired-${process.pid}-${Date.now()}`;

let prisma: PrismaService;

run('the retired landing on a real database', () => {
  const adminIds = [`${prefix}-a-dev`, `${prefix}-b-editor`];
  const roleName = `${prefix}-content`;

  before(async () => {
    process.env.DATABASE_URL = testUrl;
    process.env.DATABASE_POOL_SIZE = '4';
    prisma = new PrismaService();
    await prisma.$connect();
  });

  after(async () => {
    await prisma.adminAuditLog.deleteMany({ where: { adminUserId: { in: adminIds } } });
    await prisma.adminUser.deleteMany({ where: { id: { in: adminIds } } });
    await prisma.adminRole.deleteMany({ where: { name: roleName } });
    await prisma.landingConfig.deleteMany({ where: { key: { startsWith: prefix } } });
    await prisma.landingRevision.deleteMany({ where: { id: { startsWith: prefix } } });
    await prisma.$disconnect();
  });

  it('keeps both landing tables, with their columns, after every migration', async () => {
    const rows = await prisma.$queryRaw<Array<{ table_name: string; column_name: string }>>`
      SELECT table_name, column_name
        FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name IN ('landing_configs', 'landing_revisions')`;
    const columns = (table: string): string[] =>
      rows.filter((row) => row.table_name === table).map((row) => row.column_name).sort();
    assert.deepEqual(columns('landing_configs'), ['draft', 'id', 'key', 'published_revision_id', 'updated_at', 'version']);
    assert.deepEqual(columns('landing_revisions'), ['config', 'id', 'published_at', 'published_by', 'schema_version']);
  });

  it('and the kept models still write and read a landing exactly as it was stored', async () => {
    const config = { enabled: true, sections: [{ id: 'hero', visible: true }], meta: { title: { ru: 'Лендинг' } } };
    const revision = await prisma.landingRevision.create({
      data: { id: `${prefix}-rev`, schemaVersion: 3, config, publishedBy: null },
    });
    await prisma.landingConfig.create({
      data: { key: `${prefix}-key`, draft: config, publishedRevisionId: revision.id, version: 7 },
    });

    const stored = await prisma.landingConfig.findUnique({ where: { key: `${prefix}-key` } });
    assert.ok(stored !== null);
    assert.deepEqual(stored.draft, config);
    assert.equal(stored.version, 7);
    const published = await prisma.landingRevision.findUnique({ where: { id: stored.publishedRevisionId ?? '' } });
    assert.deepEqual(published?.config, config);
  });

  it('a role storing landing_config rows is shown without them, saves as shown, and its holder can be edited', async () => {
    const role = await prisma.adminRole.create({
      data: { name: roleName, displayName: 'Content', description: null, isSystem: false },
    });
    // As 0.9.7.70 left it: rows the catalog no longer names.
    await prisma.adminPermission.createMany({
      data: [
        { roleId: role.id, resource: 'users', action: 'view' },
        { roleId: role.id, resource: 'landing_config', action: 'view' },
        { roleId: role.id, resource: 'landing_config', action: 'edit' },
      ],
    });
    const now = Date.now();
    await prisma.adminUser.create({
      data: {
        id: adminIds[0]!,
        login: adminIds[0]!,
        loginNormalized: adminIds[0]!,
        passwordHash: 'not-a-real-hash',
        role: UserRole.DEV,
        createdAt: new Date(now - 60_000),
      },
    });
    await prisma.adminUser.create({
      data: {
        id: adminIds[1]!,
        login: adminIds[1]!,
        loginNormalized: adminIds[1]!,
        passwordHash: 'not-a-real-hash',
        role: UserRole.ADMIN,
        rbacRoleId: role.id,
        createdAt: new Date(now),
      },
    });

    const rbac = new RbacService(prisma);
    const shown = await rbac.getRoleById(role.id);
    assert.deepEqual(shown.permissions.map((p) => `${p.resource}:${p.action}`), ['users:view']);
    assert.equal((await rbac.listRoles()).find((r) => r.id === role.id)?.permissionsCount, 1);
    const holder = { id: adminIds[1]!, role: UserRole.ADMIN, rbacRoleId: role.id };
    assert.deepEqual([...(await rbac.getEffectivePermissionTokens(holder))], ['users:view']);

    // A DEV edits the holder: the subset check sees no token the DEV lacks.
    const controller = new AdminAdminsController(
      prisma,
      { hashPassword: async () => 'unused' } as never,
      rbac,
      { emit: () => undefined } as never,
    );
    const dev = await prisma.adminUser.findUniqueOrThrow({ where: { id: adminIds[0]! } });
    const actor: CurrentAdminInterface = {
      id: dev.id,
      login: dev.login,
      email: null,
      name: dev.name,
      role: dev.role,
      isActive: dev.isActive,
      tokenVersion: dev.tokenVersion,
      createdAt: dev.createdAt,
      lastLoginAt: null,
      lastLoginIp: null,
      rbacRoleId: dev.rbacRoleId,
      mustChangePassword: false,
    };
    await controller.update(
      adminIds[1]!,
      { name: 'Renamed by DEV' } as never,
      actor,
      { headers: {}, ip: null, socket: { remoteAddress: null } } as never,
    );
    assert.equal((await prisma.adminUser.findUniqueOrThrow({ where: { id: adminIds[1]! } })).name, 'Renamed by DEV');

    // The role saves with what the editor was shown, and the save drops the
    // retired rows of this role — the only rows anything deletes.
    const saved = await rbac.updateRole(role.id, {
      displayName: 'Content team',
      description: null,
      permissions: shown.permissions,
      actorPermissions: new Set(getAllPermissions().map((p) => `${p.resource}:${p.action}`)),
    });
    assert.equal(saved.displayName, 'Content team');
    const rows = await prisma.adminPermission.findMany({ where: { roleId: role.id } });
    assert.deepEqual(rows.map((row) => `${row.resource}:${row.action}`), ['users:view']);
  });
});
