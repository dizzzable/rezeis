import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { UserRole } from '@prisma/client';

import { SYSTEM_ROLES, getAllPermissions } from '../src/modules/rbac/rbac.resources';
import { RbacService } from '../src/modules/rbac/services/rbac.service';

/**
 * Two holes in the role editor, both of the same shape - a decision that looks
 * like it is being made and is not.
 *
 * 1. `createRole` / `updateRole` validated the submitted (resource, action)
 *    pairs against the catalog and nothing else. Nobody asked whether the
 *    ACTOR held what it was granting, so an admin with `rbac_roles:edit` opened
 *    its own custom role, ticked `admins:edit`, saved, and walked out through
 *    the self-promotion path in `admin-admins.controller.ts`.
 *    `config-import.service.ts` had implemented exactly this check on the
 *    import path; the role editor - the obvious way in - had not.
 *
 * 2. `resolvePermissions` granted the whole catalog to any role NAMED
 *    `superadmin`, without asking whether it was the seeded system role.
 *    `createRole` accepted that literal name and wrote `isSystem: false`. The
 *    only thing in the way was the unique-name collision with the boot seed -
 *    and the boot seed fails soft, with nothing retrying it.
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

interface Store {
  roles: RoleRow[];
  permissions: PermissionRow[];
}

const stamp = new Date('2026-01-01T00:00:00.000Z');

function hydrate(store: Store, role: RoleRow): unknown {
  return {
    ...role,
    permissions: store.permissions
      .filter((p) => p.roleId === role.id)
      .map((p) => ({ resource: p.resource, action: p.action })),
    _count: { admins: 0 },
  };
}

function prismaDouble(store: Store): unknown {
  const client = {
    adminRole: {
      findUnique: async ({ where }: { where: { id?: string; name?: string } }) => {
        const role = store.roles.find(
          (r) =>
            (where.id !== undefined && r.id === where.id)
            || (where.name !== undefined && r.name === where.name),
        );
        return role === undefined ? null : hydrate(store, role);
      },
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
        const role = store.roles.find((r) => r.id === where.id);
        assert.ok(role, `role ${where.id} vanished mid-transaction`);
        return hydrate(store, role);
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row: RoleRow = {
          id: `role-${store.roles.length + 1}`,
          name: String(data['name']),
          displayName: String(data['displayName']),
          description: (data['description'] as string | null) ?? null,
          isSystem: data['isSystem'] === true,
          createdAt: stamp,
          updatedAt: stamp,
        };
        store.roles.push(row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = store.roles.find((r) => r.id === where.id)!;
        if (typeof data['displayName'] === 'string') row.displayName = data['displayName'];
        if ('description' in data) row.description = (data['description'] as string | null) ?? null;
        return row;
      },
    },
    adminPermission: {
      createMany: async ({ data }: { data: PermissionRow[] }) => {
        for (const row of data) {
          const dup = store.permissions.some(
            (p) => p.roleId === row.roleId && p.resource === row.resource && p.action === row.action,
          );
          if (!dup) store.permissions.push(row);
        }
        return { count: data.length };
      },
      deleteMany: async ({ where }: { where: { roleId: string } }) => {
        store.permissions = store.permissions.filter((p) => p.roleId !== where.roleId);
        return { count: 0 };
      },
    },
  };
  return {
    ...client,
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(client),
  };
}

const CATALOG = new Set(
  getAllPermissions().map((p) => `${p.resource}:${p.action}`),
);

/** A modest grant: enough to run the role editor, nothing dangerous. */
const MODEST_ACTOR: ReadonlySet<string> = new Set([
  'rbac_roles:view',
  'rbac_roles:create',
  'rbac_roles:edit',
  'users:view',
]);

function service(store: Store): RbacService {
  return new RbacService(prismaDouble(store) as never);
}

describe('RbacService privilege attenuation on role writes', () => {
  it('refuses to create a role granting a permission the actor does not hold', async () => {
    const store: Store = { roles: [], permissions: [] };
    const error = await service(store)
      .createRole({
        name: 'ops_lead',
        displayName: 'Ops lead',
        description: null,
        permissions: [
          { resource: 'users', action: 'view' },
          { resource: 'admins', action: 'edit' },
        ],
        actorPermissions: MODEST_ACTOR,
      })
      .then(
        () => null,
        (err: unknown) => err,
      );

    assert.ok(error instanceof ForbiddenException, `expected Forbidden, got ${String(error)}`);
    assert.match(error.message, /admins:edit/);
    assert.deepStrictEqual(store.roles, [], 'nothing may be written when the grant is refused');
    assert.deepStrictEqual(store.permissions, []);
  });

  it('still creates a role whose every grant the actor holds', async () => {
    const store: Store = { roles: [], permissions: [] };
    const created = await service(store).createRole({
      name: 'ops_lead',
      displayName: 'Ops lead',
      description: null,
      permissions: [{ resource: 'users', action: 'view' }],
      actorPermissions: MODEST_ACTOR,
    });
    assert.deepStrictEqual(created.permissions, [{ resource: 'users', action: 'view' }]);
  });

  it('refuses to add an unheld permission to an existing custom role', async () => {
    // The escalation ran through a role the actor already owned: edit it, tick
    // one more box, save. Nothing about "this role is mine" made the extra box
    // grantable.
    const store: Store = {
      roles: [
        {
          id: 'role-mine',
          name: 'mine',
          displayName: 'Mine',
          description: null,
          isSystem: false,
          createdAt: stamp,
          updatedAt: stamp,
        },
      ],
      permissions: [{ roleId: 'role-mine', resource: 'users', action: 'view' }],
    };
    const error = await service(store)
      .updateRole('role-mine', {
        displayName: 'Mine',
        description: null,
        permissions: [
          { resource: 'users', action: 'view' },
          { resource: 'payments', action: 'refund' },
        ],
        actorPermissions: MODEST_ACTOR,
      })
      .then(
        () => null,
        (err: unknown) => err,
      );

    assert.ok(error instanceof ForbiddenException, `expected Forbidden, got ${String(error)}`);
    assert.match(error.message, /payments:refund/);
    assert.deepStrictEqual(
      store.permissions,
      [{ roleId: 'role-mine', resource: 'users', action: 'view' }],
      'the existing matrix must be intact - updateRole deletes before it recreates',
    );
  });

  it('lets an actor holding everything write any role, so the rule is a subset rule', async () => {
    const store: Store = { roles: [], permissions: [] };
    const created = await service(store).createRole({
      name: 'ops_lead',
      displayName: 'Ops lead',
      description: null,
      permissions: [
        { resource: 'admins', action: 'edit' },
        { resource: 'payments', action: 'refund' },
      ],
      actorPermissions: CATALOG,
    });
    assert.equal(created.permissions.length, 2);
  });
});

describe('RbacService reserved role names', () => {
  it('refuses to create a role under any seeded system name', async () => {
    for (const seed of SYSTEM_ROLES) {
      const store: Store = { roles: [], permissions: [] };
      const error = await service(store)
        .createRole({
          name: seed.name,
          displayName: 'Impostor',
          description: null,
          permissions: [],
          actorPermissions: CATALOG,
        })
        .then(
          () => null,
          (err: unknown) => err,
        );
      assert.ok(
        error instanceof BadRequestException,
        `${seed.name}: expected BadRequest, got ${String(error)}`,
      );
      assert.deepStrictEqual(store.roles, [], `${seed.name}: nothing may be written`);
    }
  });
});

describe('RbacService superadmin is resolved by isSystem, not by name', () => {
  const impostor: RoleRow = {
    id: 'role-impostor',
    name: 'superadmin',
    displayName: 'Superadmin',
    description: null,
    // What `createRole` writes. The name check alone read this as a wildcard.
    isSystem: false,
    createdAt: stamp,
    updatedAt: stamp,
  };
  const seeded: RoleRow = { ...impostor, id: 'role-seeded', isSystem: true };

  it('does not grant the catalog to a non-system role that merely calls itself superadmin', async () => {
    const store: Store = {
      roles: [impostor],
      permissions: [{ roleId: impostor.id, resource: 'users', action: 'view' }],
    };
    const rbac = service(store);
    const holder = { id: 'admin-1', role: UserRole.ADMIN, rbacRoleId: impostor.id };

    assert.equal(await rbac.hasPermission(holder, 'users', 'view'), true);
    assert.equal(
      await rbac.hasPermission(holder, 'admins', 'edit'),
      false,
      'a self-named role must grant exactly its own rows',
    );
    assert.deepStrictEqual(await rbac.getEffectivePermissions(holder), [
      { resource: 'users', action: 'view' },
    ]);
  });

  it('still grants the catalog to the seeded system superadmin', async () => {
    const store: Store = { roles: [seeded], permissions: [] };
    const rbac = service(store);
    const holder = { id: 'admin-2', role: UserRole.ADMIN, rbacRoleId: seeded.id };

    assert.equal(await rbac.hasPermission(holder, 'admins', 'edit'), true);
    assert.equal(
      (await rbac.getEffectivePermissions(holder)).length,
      getAllPermissions().length,
    );
  });

  it('reports the seeded superadmin as granting the whole catalog even before the seed fills its rows', async () => {
    // `getRoleGrantTokens` answers "what would assigning this role hand over".
    // A half-seeded superadmin has no permission rows, and counting rows would
    // report it as a harmless empty role that anyone may assign.
    const store: Store = { roles: [seeded, impostor], permissions: [] };
    const rbac = service(store);

    assert.equal((await rbac.getRoleGrantTokens(seeded.id))!.size, getAllPermissions().length);
    assert.equal((await rbac.getRoleGrantTokens(impostor.id))!.size, 0);
    assert.equal(await rbac.getRoleGrantTokens('role-missing'), null);
  });
});

describe('RbacService system role edits', () => {
  it('edits display metadata on a system role and leaves its matrix alone', async () => {
    // Behaviour pinned because the check that used to sit here was dead code
    // (`displayName !== '' || description !== undefined`, with `displayName`
    // a required @Length(2, 64) field, so never false). Deleting an
    // unreachable branch must not change what the endpoint does.
    const store: Store = {
      roles: [
        {
          id: 'role-operator',
          name: 'operator',
          displayName: 'Operator',
          description: 'before',
          isSystem: true,
          createdAt: stamp,
          updatedAt: stamp,
        },
      ],
      permissions: [{ roleId: 'role-operator', resource: 'users', action: 'view' }],
    };
    const updated = await service(store).updateRole('role-operator', {
      displayName: 'Operator (EU)',
      description: 'after',
      permissions: [],
      actorPermissions: CATALOG,
    });

    assert.equal(updated.displayName, 'Operator (EU)');
    assert.equal(updated.description, 'after');
    assert.deepStrictEqual(
      store.permissions,
      [{ roleId: 'role-operator', resource: 'users', action: 'view' }],
      'a system role keeps its permission matrix through a metadata edit',
    );
  });
});
