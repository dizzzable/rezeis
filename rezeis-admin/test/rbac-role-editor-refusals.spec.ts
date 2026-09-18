import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { RbacService } from '../src/modules/rbac/services/rbac.service';

/**
 * Two refusals the role editor used to meet, and what the server does now.
 *
 * 1. Renaming a SYSTEM role. `updateRole` writes only the name and description
 *    of a system role and never its permissions — but it checks the submitted
 *    permissions against the acting admin FIRST. The editor re-sent the role's
 *    own permissions, so an admin who lacked any one of them could not even
 *    rename it. The editor now sends none; these cases pin that the server
 *    ignores them for a system role, and that the re-sent set is what was
 *    refused.
 *
 * 2. Two admins creating the same role name at once. Both pass the name
 *    lookup, the second INSERT hits the unique index, and the unhandled P2002
 *    reached the operator as "Internal server error". It is a 409 now, with the
 *    sentence the lookup itself uses.
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
  /** When set, `adminRole.create` throws this instead of writing. */
  createFails?: unknown;
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
        if (store.createFails !== undefined) throw store.createFails;
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
        for (const row of data) store.permissions.push(row);
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

function service(store: Store): RbacService {
  return new RbacService(prismaDouble(store) as never);
}

/** The seeded `finance` role, as the database holds it. */
function financeStore(): Store {
  return {
    roles: [
      {
        id: 'role-finance',
        name: 'finance',
        displayName: 'Finance',
        description: 'Платежи, выводы, тарифы и финансовая аналитика.',
        isSystem: true,
        createdAt: stamp,
        updatedAt: stamp,
      },
    ],
    permissions: [
      { roleId: 'role-finance', resource: 'payments', action: 'view' },
      { roleId: 'role-finance', resource: 'payment_gateways', action: 'edit' },
    ],
  };
}

/** Can open the role editor and save; holds neither of finance's permissions. */
const ROLE_EDITOR_ONLY: ReadonlySet<string> = new Set(['rbac_roles:view', 'rbac_roles:edit']);

function outcome(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (err: unknown) => err,
  );
}

describe('RbacService: renaming a system role', () => {
  it('was refused when the editor re-sent the role’s own permissions', async () => {
    const store = financeStore();
    const error = await outcome(
      service(store).updateRole('role-finance', {
        displayName: 'Бухгалтерия',
        description: null,
        permissions: [
          { resource: 'payments', action: 'view' },
          { resource: 'payment_gateways', action: 'edit' },
        ],
        actorPermissions: ROLE_EDITOR_ONLY,
      }),
    );

    assert.ok(error instanceof ForbiddenException, `expected Forbidden, got ${String(error)}`);
    assert.match(error.message, /Cannot grant permissions you do not hold/);
    assert.equal(store.roles[0].displayName, 'Finance', 'nothing may be written when the save is refused');
  });

  it('renames it when no permissions are sent, and leaves its permissions exactly as they were', async () => {
    const store = financeStore();
    const updated = await service(store).updateRole('role-finance', {
      displayName: 'Бухгалтерия',
      description: 'Наша финансовая служба',
      permissions: [],
      actorPermissions: ROLE_EDITOR_ONLY,
    });

    assert.equal(updated.displayName, 'Бухгалтерия');
    assert.equal(updated.description, 'Наша финансовая служба');
    // An empty list is not "remove everything" for a system role: its matrix
    // is not the editor's to write.
    assert.deepStrictEqual(
      store.permissions,
      [
        { roleId: 'role-finance', resource: 'payments', action: 'view' },
        { roleId: 'role-finance', resource: 'payment_gateways', action: 'edit' },
      ],
    );
  });
});

describe('RbacService: two admins creating the same role name', () => {
  it('answers the losing insert with 409 and the name, not an unhandled error', async () => {
    const store: Store = {
      roles: [],
      permissions: [],
      // What the INSERT raises once the other admin's row has committed.
      createFails: new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`name`)', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    };
    const error = await outcome(
      service(store).createRole({
        name: 'ops_lead',
        displayName: 'Ops lead',
        description: null,
        permissions: [],
        actorPermissions: ROLE_EDITOR_ONLY,
      }),
    );

    assert.ok(error instanceof ConflictException, `expected Conflict, got ${String(error)}`);
    assert.equal(error.getStatus(), 409);
    assert.equal(error.message, 'Role with name "ops_lead" already exists');
  });

  it('still refuses a name that already exists before any insert, as before', async () => {
    const store = financeStore();
    store.roles.push({ ...store.roles[0], id: 'role-ops', name: 'ops_lead', isSystem: false });
    const error = await outcome(
      service(store).createRole({
        name: 'ops_lead',
        displayName: 'Ops lead',
        description: null,
        permissions: [],
        actorPermissions: ROLE_EDITOR_ONLY,
      }),
    );

    assert.ok(error instanceof BadRequestException, `expected BadRequest, got ${String(error)}`);
    assert.equal(error.message, 'Role with name "ops_lead" already exists');
  });

  it('does not dress any other failure up as a conflict', async () => {
    const boom = new Error('connection reset');
    const store: Store = { roles: [], permissions: [], createFails: boom };
    const error = await outcome(
      service(store).createRole({
        name: 'ops_lead',
        displayName: 'Ops lead',
        description: null,
        permissions: [],
        actorPermissions: ROLE_EDITOR_ONLY,
      }),
    );

    assert.equal(error, boom);
  });
});
