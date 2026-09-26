import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ModuleRef } from '@nestjs/core';
import { UserRole } from '@prisma/client';

import type { CurrentAdminInterface } from '../src/modules/auth/interfaces/current-admin.interface';
import { AdminAdminsController } from '../src/modules/rbac/controllers/admin-admins.controller';
import { RBAC_RESOURCES, getAllPermissions, isValidPermission } from '../src/modules/rbac/rbac.resources';
import { RbacService } from '../src/modules/rbac/services/rbac.service';

/**
 * A permission whose feature is gone (`landing_config`, 0.9.7.71)
 * ═══════════════════════════════════════════════════════════════
 * The web landing left the panel, and `landing_config` left the RBAC catalog
 * with it. Its rows did not leave `admin_permissions`: the boot seed never
 * deletes, a role save rewrites only the role being saved, and no migration
 * deletes anything (a rollback must give the permission back). `superadmin`
 * holds them on every install — the seed gave it the whole catalog — and so
 * does any custom role an operator ticked «Веб-лендинг» on.
 *
 * Read as they are stored, those rows would lock operators out of their panel:
 *
 *  - the role editor sends back every pair `GET /admin/rbac/roles/:id` gave it,
 *    so saving such a role — even just renaming it — would be 400 «Unknown
 *    permission: landing_config:view»;
 *  - an admin holding such a role would hold a token no actor can hold (DEV
 *    and superadmin resolve to the catalog), so editing them would be 403 «You
 *    cannot modify an account that holds permissions you do not hold», for a
 *    DEV too;
 *  - and the first save that did go through would drop the stale pair, which
 *    reads as a narrowing and signs every holder of the role out.
 *
 * The real `RbacService` and `AdminAdminsController` run here over an
 * in-memory store that holds those rows.
 */

interface RoleRow {
  id: string;
  name: string;
  displayName: string;
  description: string | null;
  isSystem: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface PermissionRow {
  roleId: string;
  resource: string;
  action: string;
}

interface AdminRow {
  id: string;
  login: string;
  loginNormalized: string;
  name: string | null;
  role: UserRole;
  isActive: boolean;
  rbacRoleId: string | null;
  mustChangePassword: boolean;
  totpEnabled: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  passwordHash: string;
  tokenVersion: number;
}

interface Store {
  roles: RoleRow[];
  permissions: PermissionRow[];
  admins: AdminRow[];
  /** Admin-row writes the controller reached. */
  writes: string[];
  /** Realtime revocations: which holders were signed out, and why. */
  drops: Array<{ ids: string[]; reason: string }>;
}

const stamp = new Date('2026-01-01T00:00:00.000Z');
const RETIRED = [
  { resource: 'landing_config', action: 'view' },
  { resource: 'landing_config', action: 'edit' },
] as const;

function admin(overrides: Partial<AdminRow> & { id: string; createdAt: Date }): AdminRow {
  return {
    login: overrides.id,
    loginNormalized: overrides.id,
    name: null,
    role: UserRole.ADMIN,
    isActive: true,
    rbacRoleId: null,
    mustChangePassword: false,
    totpEnabled: false,
    lastLoginAt: null,
    updatedAt: overrides.createdAt,
    passwordHash: 'stored-hash',
    tokenVersion: 0,
    ...overrides,
  };
}

/**
 * The install as 0.9.7.70 left it: `superadmin` seeded with the whole catalog
 * of that release (landing included), a custom role an operator ticked
 * «Веб-лендинг» on, and a second one that holds it too.
 */
function freshStore(): Store {
  const role = (over: Omit<RoleRow, 'createdAt' | 'updatedAt'>): RoleRow => ({ ...over, createdAt: stamp, updatedAt: stamp });
  const grants = (roleId: string, pairs: ReadonlyArray<{ resource: string; action: string }>): PermissionRow[] =>
    pairs.map((p) => ({ roleId, resource: p.resource, action: p.action }));
  return {
    roles: [
      role({ id: 'role-superadmin', name: 'superadmin', displayName: 'Superadmin', description: null, isSystem: true }),
      role({ id: 'role-content', name: 'content', displayName: 'Content', description: null, isSystem: false }),
      role({ id: 'role-other', name: 'other', displayName: 'Other', description: null, isSystem: false }),
      role({ id: 'role-admins', name: 'admins_editor', displayName: 'Admins editor', description: null, isSystem: false }),
    ],
    permissions: [
      ...grants('role-superadmin', [...getAllPermissions(), ...RETIRED]),
      ...grants('role-content', [{ resource: 'users', action: 'view' }, ...RETIRED]),
      ...grants('role-other', [{ resource: 'faq', action: 'view' }, ...RETIRED]),
      ...grants('role-admins', [
        { resource: 'admins', action: 'view' },
        { resource: 'admins', action: 'edit' },
        { resource: 'users', action: 'view' },
      ]),
    ],
    admins: [
      admin({ id: 'owner', createdAt: new Date('2020-01-01T00:00:00.000Z'), role: UserRole.DEV }),
      admin({ id: 'chief', createdAt: new Date('2021-01-01T00:00:00.000Z'), rbacRoleId: 'role-superadmin' }),
      admin({ id: 'editor', createdAt: new Date('2022-01-01T00:00:00.000Z'), rbacRoleId: 'role-content' }),
      admin({ id: 'writer', createdAt: new Date('2022-02-01T00:00:00.000Z'), rbacRoleId: 'role-content' }),
      admin({ id: 'manager', createdAt: new Date('2022-03-01T00:00:00.000Z'), rbacRoleId: 'role-admins' }),
      admin({ id: 'newcomer', createdAt: new Date('2023-01-01T00:00:00.000Z') }),
    ],
    writes: [],
    drops: [],
  };
}

function hydrate(store: Store, role: RoleRow): unknown {
  return {
    ...role,
    permissions: store.permissions
      .filter((p) => p.roleId === role.id)
      .map((p) => ({ resource: p.resource, action: p.action })),
    _count: { admins: store.admins.filter((a) => a.rbacRoleId === role.id).length },
  };
}

function withRbacRole(row: AdminRow, store: Store): AdminRow & { rbacRole: unknown } {
  const role = store.roles.find((r) => r.id === row.rbacRoleId) ?? null;
  return { ...row, rbacRole: role === null ? null : { id: role.id, displayName: role.displayName } };
}

/** The slice of Prisma the service and the controller touch. `select` is ignored: whole rows come back. */
function prismaDouble(store: Store): unknown {
  const findRole = (where: { id?: string; name?: string }): RoleRow | undefined =>
    store.roles.find(
      (r) => (where.id !== undefined && r.id === where.id) || (where.name !== undefined && r.name === where.name),
    );
  const client = {
    adminRole: {
      findMany: async () => store.roles.map((role) => hydrate(store, role)),
      findUnique: async ({ where }: { where: { id?: string; name?: string } }) => {
        const role = findRole(where);
        return role === undefined ? null : hydrate(store, role);
      },
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
        const role = findRole(where);
        assert.ok(role, `role ${where.id} vanished mid-transaction`);
        return hydrate(store, role);
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = findRole(where)!;
        if (typeof data['displayName'] === 'string') row.displayName = data['displayName'];
        if ('description' in data) row.description = (data['description'] as string | null) ?? null;
        return row;
      },
    },
    adminPermission: {
      deleteMany: async ({ where }: { where: { roleId: string } }) => {
        const before = store.permissions.length;
        store.permissions = store.permissions.filter((p) => p.roleId !== where.roleId);
        return { count: before - store.permissions.length };
      },
      createMany: async ({ data }: { data: PermissionRow[] }) => {
        for (const row of data) {
          const dup = store.permissions.some(
            (p) => p.roleId === row.roleId && p.resource === row.resource && p.action === row.action,
          );
          if (!dup) store.permissions.push({ roleId: row.roleId, resource: row.resource, action: row.action });
        }
        return { count: data.length };
      },
    },
    adminUser: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const row = store.admins.find((a) => a.id === where.id);
        return row === undefined ? null : withRbacRole(row, store);
      },
      findFirst: async () => {
        const sorted = [...store.admins].sort(
          (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
        );
        return sorted.length === 0 ? null : withRbacRole(sorted[0]!, store);
      },
      findMany: async ({ where }: { where?: { rbacRoleId?: string } } = {}) =>
        store.admins
          .filter((a) => where?.rbacRoleId === undefined || a.rbacRoleId === where.rbacRoleId)
          .map((a) => withRbacRole(a, store)),
      count: async () => store.admins.filter((a) => a.isActive).length,
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        store.writes.push(`update:${where.id}:${Object.keys(data).sort().join(',')}`);
        const row = store.admins.find((a) => a.id === where.id)!;
        if (typeof data['name'] === 'string') row.name = data['name'];
        const link = data['rbacRole'] as { connect?: { id: string }; disconnect?: boolean } | undefined;
        if (link?.connect !== undefined) row.rbacRoleId = link.connect.id;
        if (link?.disconnect === true) row.rbacRoleId = null;
        return withRbacRole(row, store);
      },
    },
    adminAuditLog: { create: async () => null },
  };
  return { ...client, $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(client) };
}

/** The realtime gateway, as `RbacService` finds it: records whom it signs out. */
function gatewayModuleRef(store: Store): ModuleRef {
  return {
    get: (token: unknown) => {
      if ((token as { name?: string } | undefined)?.name !== 'RealtimeGateway') {
        throw new Error(`provider ${String((token as { name?: string }).name)} is not registered`);
      }
      return {
        disconnectAdmins: (ids: string[], reason: string) => {
          store.drops.push({ ids: [...ids].sort(), reason });
          return ids.length;
        },
      };
    },
  } as unknown as ModuleRef;
}

function build(store: Store): { rbac: RbacService; admins: AdminAdminsController } {
  const prisma = prismaDouble(store);
  const rbac = new RbacService(prisma as never, gatewayModuleRef(store));
  const admins = new AdminAdminsController(
    prisma as never,
    { hashPassword: async () => 'new-hash' } as never,
    rbac,
    { emit: () => undefined } as never,
  );
  return { rbac, admins };
}

function actorFrom(store: Store, id: string): CurrentAdminInterface {
  const row = store.admins.find((a) => a.id === id)!;
  return {
    id: row.id,
    login: row.login,
    email: null,
    name: row.name,
    role: row.role,
    isActive: row.isActive,
    tokenVersion: row.tokenVersion,
    createdAt: row.createdAt,
    lastLoginAt: null,
    lastLoginIp: null,
    rbacRoleId: row.rbacRoleId,
    mustChangePassword: false,
  };
}

const request = { headers: {}, ip: null, socket: { remoteAddress: null } } as never;
const FULL_CATALOG: ReadonlySet<string> = new Set(getAllPermissions().map((p) => `${p.resource}:${p.action}`));
const tokensOf = (pairs: ReadonlyArray<{ resource: string; action: string }>): string[] =>
  pairs.map((p) => `${p.resource}:${p.action}`).sort();
const storedFor = (store: Store, roleId: string): string[] =>
  tokensOf(store.permissions.filter((p) => p.roleId === roleId));

describe('the catalog no longer has landing_config', () => {
  it('in either direction a role could be written or read', () => {
    assert.equal(Object.prototype.hasOwnProperty.call(RBAC_RESOURCES, 'landing_config'), false);
    assert.equal(isValidPermission('landing_config', 'view'), false);
    assert.equal(isValidPermission('landing_config', 'edit'), false);
    assert.equal(getAllPermissions().some((p) => p.resource === 'landing_config'), false);
  });

  it('reads a stored row that names an Object.prototype key as unknown, without throwing', () => {
    // Stored rows now go through this on every permission lookup.
    for (const resource of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      assert.equal(isValidPermission(resource, 'view'), false, resource);
    }
  });
});

describe('a role that still stores landing_config rows', () => {
  it('is shown without them, and counted without them — while the rows stay', async () => {
    const store = freshStore();
    const { rbac } = build(store);

    const role = await rbac.getRoleById('role-content');
    assert.deepEqual(tokensOf(role.permissions), ['users:view']);
    const listed = (await rbac.listRoles()).find((r) => r.id === 'role-content');
    assert.equal(listed?.permissionsCount, 1);

    const superadmin = await rbac.getRoleById('role-superadmin');
    assert.equal(superadmin.permissions.length, getAllPermissions().length);
    assert.equal(superadmin.permissions.some((p) => p.resource === 'landing_config'), false);

    // Reading prunes nothing: a rollback to 0.9.7.70 finds the rows it wrote.
    assert.deepEqual(storedFor(store, 'role-content'), ['landing_config:edit', 'landing_config:view', 'users:view']);
  });

  it('saves with what the editor was given back — and that save drops the rows of this role only', async () => {
    const store = freshStore();
    const { rbac } = build(store);
    const shown = await rbac.getRoleById('role-content');

    const saved = await rbac.updateRole('role-content', {
      displayName: 'Content team',
      description: null,
      permissions: shown.permissions,
      actorPermissions: FULL_CATALOG,
    });

    assert.equal(saved.displayName, 'Content team');
    assert.deepEqual(tokensOf(saved.permissions), ['users:view']);
    assert.deepEqual(storedFor(store, 'role-content'), ['users:view'], 'the save rewrote the role from its payload');
    assert.deepEqual(
      storedFor(store, 'role-other'),
      ['faq:view', 'landing_config:edit', 'landing_config:view'],
      'another role is not touched by this one’s save',
    );
  });

  it('is saved with no holder signed out: a retired pair granted nothing, so dropping it narrows nothing', async () => {
    const store = freshStore();
    const { rbac } = build(store);
    const shown = await rbac.getRoleById('role-content');

    await rbac.updateRole('role-content', {
      displayName: 'Content',
      description: null,
      permissions: shown.permissions,
      actorPermissions: FULL_CATALOG,
    });
    assert.deepEqual(store.drops, []);

    // The control: a real narrowing of the same role still signs its holders
    // out, so the silence above is the rule and not a disconnected gateway.
    await rbac.updateRole('role-content', {
      displayName: 'Content',
      description: null,
      permissions: [],
      actorPermissions: FULL_CATALOG,
    });
    assert.deepEqual(store.drops, [{ ids: ['editor', 'writer'], reason: 'role_permissions_narrowed' }]);
  });

  it('superadmin, which the seed gave the landing rows on every install, still saves', async () => {
    const store = freshStore();
    const { rbac } = build(store);
    const shown = await rbac.getRoleById('role-superadmin');

    const saved = await rbac.updateRole('role-superadmin', {
      displayName: 'Главный',
      description: 'Всё',
      permissions: shown.permissions,
      actorPermissions: FULL_CATALOG,
    });
    assert.equal(saved.displayName, 'Главный');
    assert.deepEqual(store.drops, []);
  });

  it('grants nothing of the retired resource, to its holders or to whoever is assigned it', async () => {
    const store = freshStore();
    const { rbac } = build(store);
    const holder = store.admins.find((a) => a.id === 'editor')!;

    const tokens = await rbac.getEffectivePermissionTokens(holder);
    assert.deepEqual([...tokens].sort(), ['users:view']);
    assert.equal(await rbac.hasPermission(holder, 'landing_config', 'view'), false);
    assert.deepEqual([...((await rbac.getRoleGrantTokens('role-content')) ?? [])].sort(), ['users:view']);
  });
});

describe('an admin holding such a role', () => {
  it('can be edited by a DEV, and by a superadmin', async () => {
    for (const actorId of ['owner', 'chief']) {
      const store = freshStore();
      const { admins } = build(store);
      await admins.update('editor', { name: `Renamed by ${actorId}` } as never, actorFrom(store, actorId), request);
      assert.deepEqual(store.writes, ['update:editor:name'], actorId);
    }
  });

  it('can be edited by an admin who holds everything that role still grants', async () => {
    // `admins:edit` + `users:view`: every live grant of the target, and none of
    // the retired ones — which nobody can hold any more.
    const store = freshStore();
    const { admins } = build(store);
    await admins.update('editor', { name: 'Renamed' } as never, actorFrom(store, 'manager'), request);
    assert.deepEqual(store.writes, ['update:editor:name']);
  });

  it('and the role can still be assigned', async () => {
    const store = freshStore();
    const { admins } = build(store);
    await admins.update('newcomer', { rbacRoleId: 'role-content' } as never, actorFrom(store, 'chief'), request);
    assert.deepEqual(store.writes, ['update:newcomer:rbacRole']);
    assert.equal(store.admins.find((a) => a.id === 'newcomer')?.rbacRoleId, 'role-content');
  });
});

describe('an admin with no role (the pre-RBAC fallback)', () => {
  it('no longer gets the landing permission, and keeps the rest of the allowlist', async () => {
    const store = freshStore();
    const { rbac } = build(store);
    const tokens = await rbac.getEffectivePermissionTokens(store.admins.find((a) => a.id === 'newcomer')!);
    assert.equal([...tokens].some((token) => token.startsWith('landing_config:')), false);
    assert.ok(tokens.has('subpage_config:view'));
    assert.ok(tokens.has('subpage_config:edit'));
  });
});
