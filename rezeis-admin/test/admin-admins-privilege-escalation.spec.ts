import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ForbiddenException } from '@nestjs/common';
import { UserRole } from '@prisma/client';

import { CurrentAdminInterface } from '../src/modules/auth/interfaces/current-admin.interface';
import { AdminAdminsController } from '../src/modules/rbac/controllers/admin-admins.controller';
import { getAllPermissions } from '../src/modules/rbac/rbac.resources';
import { RbacService } from '../src/modules/rbac/services/rbac.service';

/**
 * `admins:edit` used to be indistinguishable from superuser.
 *
 * The controller accepted `role` from `['DEV', 'ADMIN']` on
 * `PATCH /admin/admins/:adminId`, applied it unconditionally, and guarded
 * self-targeting only for `isActive === false`. `RbacService.hasPermission`
 * returns `true` for `UserRole.DEV` before consulting anything, so an admin
 * whose entire grant was `admins:edit` could PATCH their OWN id with
 * `{"role":"DEV"}` and hold everything one request later.
 * `{"rbacRoleId":"<superadmin>"}` was the same move by another name, since the
 * only check on that field was that the row existed.
 *
 * The second half is the account nobody owned: nothing marked the bootstrap
 * admin, so the same `admins:edit` could reset any other admin's password -
 * which also bumps their `tokenVersion` and ends their sessions - and then sign
 * in as them.
 *
 * These tests drive the real `RbacService` over an in-memory store rather than
 * a stubbed `hasPermission`, because the defect lived in the seam between the
 * two: every individual check passed, and the escalation was what they did not
 * ask between them.
 */

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

interface RoleRow {
  id: string;
  name: string;
  displayName: string;
  description: string | null;
  isSystem: boolean;
  permissions: Array<{ resource: string; action: string }>;
}

interface Store {
  admins: AdminRow[];
  roles: RoleRow[];
  /** Every write the controller reached. Empty means the guard fired first. */
  writes: string[];
}

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

function withRbacRole(row: AdminRow, store: Store): AdminRow & { rbacRole: unknown } {
  const role = store.roles.find((r) => r.id === row.rbacRoleId) ?? null;
  return { ...row, rbacRole: role === null ? null : { id: role.id, displayName: role.displayName } };
}

/**
 * The narrow slice of Prisma this controller touches. `select` is ignored and
 * whole rows come back: every field the controller reads is present, and a
 * projection double that silently dropped one would make a missing field look
 * like a `null` the code handles.
 */
function prismaDouble(store: Store): unknown {
  return {
    adminUser: {
      findUnique: async ({ where }: { where: { id?: string; loginNormalized?: string } }) => {
        const row = store.admins.find(
          (a) =>
            (where.id !== undefined && a.id === where.id)
            || (where.loginNormalized !== undefined && a.loginNormalized === where.loginNormalized),
        );
        return row === undefined ? null : withRbacRole(row, store);
      },
      findFirst: async ({ orderBy }: { orderBy?: unknown }) => {
        const sorted = [...store.admins].sort(
          (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
        );
        assert.ok(orderBy !== undefined, 'owner lookup must be ordered, not arbitrary');
        return sorted.length === 0 ? null : withRbacRole(sorted[0]!, store);
      },
      findMany: async () => store.admins.map((a) => withRbacRole(a, store)),
      count: async () => store.admins.filter((a) => a.isActive).length,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        store.writes.push(`create:${String(data['login'])}`);
        const row = admin({
          id: `created-${store.admins.length}`,
          createdAt: new Date('2030-01-01T00:00:00.000Z'),
          login: String(data['login']),
          loginNormalized: String(data['loginNormalized']),
          role: data['role'] as UserRole,
          rbacRoleId: (data['rbacRoleId'] as string | null) ?? null,
        });
        store.admins.push(row);
        return withRbacRole(row, store);
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        store.writes.push(`update:${where.id}:${Object.keys(data).sort().join(',')}`);
        const row = store.admins.find((a) => a.id === where.id)!;
        if (typeof data['role'] === 'string') row.role = data['role'] as UserRole;
        return withRbacRole(row, store);
      },
      delete: async ({ where }: { where: { id: string } }) => {
        store.writes.push(`delete:${where.id}`);
        store.admins = store.admins.filter((a) => a.id !== where.id);
        return null;
      },
    },
    adminRole: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        store.roles.find((r) => r.id === where.id) ?? null,
    },
    adminAuditLog: { create: async () => null },
  };
}

function build(store: Store): AdminAdminsController {
  const prisma = prismaDouble(store);
  return new AdminAdminsController(
    prisma as never,
    { hashPassword: async () => 'new-hash' } as never,
    new RbacService(prisma as never),
  );
}

function actorFrom(row: AdminRow): CurrentAdminInterface {
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

const superadminRole: RoleRow = {
  id: 'role-superadmin',
  name: 'superadmin',
  displayName: 'Superadmin',
  description: null,
  isSystem: true,
  permissions: getAllPermissions().map((p) => ({ resource: p.resource, action: p.action })),
};

const adminsEditorRole: RoleRow = {
  id: 'role-admins-editor',
  name: 'admins_editor',
  displayName: 'Admins editor',
  description: null,
  isSystem: false,
  permissions: [
    { resource: 'admins', action: 'view' },
    { resource: 'admins', action: 'create' },
    { resource: 'admins', action: 'edit' },
    { resource: 'admins', action: 'delete' },
  ],
};

/** The bootstrap account: oldest row, DEV, as `bootstrapFirstAdmin` writes it. */
const ownerRow = admin({
  id: 'owner',
  createdAt: new Date('2020-01-01T00:00:00.000Z'),
  role: UserRole.DEV,
});

function freshStore(extra: AdminRow[] = [], roles: RoleRow[] = []): Store {
  return {
    admins: [ownerRow, ...extra].map((r) => ({ ...r })),
    roles: [superadminRole, adminsEditorRole, ...roles],
    writes: [],
  };
}

/** The attacker: `admins:*` and nothing else, created after the owner. */
function attackerRow(): AdminRow {
  return admin({
    id: 'attacker',
    createdAt: new Date('2024-06-01T00:00:00.000Z'),
    rbacRoleId: adminsEditorRole.id,
  });
}

async function refused(
  run: () => Promise<unknown>,
  store: Store,
  what: string,
): Promise<ForbiddenException> {
  const error = await run().then(
    () => null,
    (err: unknown) => err,
  );
  assert.ok(
    error instanceof ForbiddenException,
    `${what}: expected a ForbiddenException, got ${String(error)}`,
  );
  assert.deepStrictEqual(
    store.writes,
    [],
    `${what}: the request was refused but a write had already landed - the guard runs too late`,
  );
  return error;
}

describe('AdminAdminsController privilege escalation', () => {
  it('refuses to let an actor promote their own account to DEV', async () => {
    const attacker = attackerRow();
    const store = freshStore([attacker]);
    const controller = build(store);

    await refused(
      () => controller.update(attacker.id, { role: 'DEV' } as never, actorFrom(attacker), request),
      store,
      'self-promotion to DEV',
    );
    assert.equal(
      store.admins.find((a) => a.id === attacker.id)!.role,
      UserRole.ADMIN,
      'the stored role must be untouched',
    );
  });

  it('refuses to let an actor point their own account at the superadmin role', async () => {
    const attacker = attackerRow();
    const store = freshStore([attacker]);
    const controller = build(store);

    await refused(
      () =>
        controller.update(
          attacker.id,
          { rbacRoleId: superadminRole.id } as never,
          actorFrom(attacker),
          request,
        ),
      store,
      'self-assignment of superadmin',
    );
  });

  it('still lets an actor edit the harmless fields of their own account', async () => {
    const attacker = attackerRow();
    const store = freshStore([attacker]);
    const controller = build(store);

    await controller.update(attacker.id, { name: 'Renamed' } as never, actorFrom(attacker), request);
    assert.deepStrictEqual(
      store.writes,
      ['update:attacker:name'],
      'the self-targeting guard must be about authority, not a blanket ban on self-edits',
    );
  });

  it('refuses a self-authority change even when the actor could grant it to somebody else', async () => {
    // The subset rule and the DEV rule both let this through: the owner is a
    // DEV, so every grant is within its reach and the target is itself. Only
    // the self-targeting rule refuses it - which is the point. An actor
    // rewriting its own authority has no second pair of eyes on the change,
    // and the escalation this file is named for was exactly that request.
    const store = freshStore([], [
      {
        id: 'role-narrow',
        name: 'narrow',
        displayName: 'Narrow',
        description: null,
        isSystem: false,
        permissions: [{ resource: 'users', action: 'view' }],
      },
    ]);
    const controller = build(store);

    await refused(
      () =>
        controller.update(
          ownerRow.id,
          { rbacRoleId: 'role-narrow' } as never,
          actorFrom(ownerRow),
          request,
        ),
      store,
      'a DEV repointing its own rbacRoleId',
    );
    await refused(
      () =>
        controller.update(ownerRow.id, { role: 'ADMIN' } as never, actorFrom(ownerRow), request),
      store,
      'a DEV demoting itself',
    );
  });

  it('refuses DEV to an actor holding every permission but not the DEV enum', async () => {
    // `UserRole.DEV` short-circuits `hasPermission` before any permission set is
    // consulted, so "holds the whole catalog" is not the same authority and the
    // subset rule cannot stand in for this check.
    const fullyPrivileged = admin({
      id: 'full',
      createdAt: new Date('2024-02-01T00:00:00.000Z'),
      rbacRoleId: superadminRole.id,
    });
    const victim = admin({ id: 'victim', createdAt: new Date('2024-07-01T00:00:00.000Z') });
    const store = freshStore([fullyPrivileged, victim]);

    const error = await refused(
      () =>
        build(store).update(
          victim.id,
          { role: 'DEV' } as never,
          actorFrom(fullyPrivileged),
          request,
        ),
      store,
      'a superadmin-roled ADMIN granting DEV',
    );
    assert.match(error.message, /DEV/);
  });

  it('refuses to let a non-DEV grant DEV to anybody, on PATCH or on POST', async () => {
    const attacker = attackerRow();
    const victim = admin({ id: 'victim', createdAt: new Date('2024-07-01T00:00:00.000Z') });
    const patchStore = freshStore([attacker, victim]);
    await refused(
      () =>
        build(patchStore).update(
          victim.id,
          { role: 'DEV' } as never,
          actorFrom(attacker),
          request,
        ),
      patchStore,
      'granting DEV to another account',
    );

    // The create path reached the same place with one fewer step: nothing
    // stopped `role: 'DEV'` in the body, so an actor who could not escalate
    // itself could mint a DEV and sign in as it.
    const createStore = freshStore([attacker]);
    await refused(
      () =>
        build(createStore).create(
          { username: 'newdev', password: 'password123', role: 'DEV' } as never,
          actorFrom(attacker),
          request,
        ),
      createStore,
      'creating a DEV account',
    );
  });

  it('refuses to let an actor hand out a role that outranks their own', async () => {
    const attacker = attackerRow();
    // The victim starts out holding EXACTLY what the attacker holds, so every
    // other rail is satisfied: not the owner, not a DEV, and no more privileged
    // than the actor. The only thing wrong with the request is where it would
    // leave the account, which is the question this check exists to ask.
    const victim = admin({
      id: 'victim',
      createdAt: new Date('2024-07-01T00:00:00.000Z'),
      rbacRoleId: adminsEditorRole.id,
    });
    const store = freshStore([attacker, victim]);

    await refused(
      () =>
        build(store).update(
          victim.id,
          { rbacRoleId: superadminRole.id } as never,
          actorFrom(attacker),
          request,
        ),
      store,
      'assigning superadmin to a puppet account',
    );
  });

  it('refuses to let an actor delete a more privileged admin', async () => {
    // `delete` takes no body, so nothing about the request describes a grant -
    // the only question available is whether the actor outranks the target.
    // Removing a more privileged colleague is also the quiet half of a takeover:
    // it thins the set of people who could undo the rest.
    const attacker = attackerRow();
    const privileged = admin({
      id: 'privileged',
      createdAt: new Date('2024-07-01T00:00:00.000Z'),
      rbacRoleId: superadminRole.id,
    });
    const store = freshStore([attacker, privileged]);

    await refused(
      () => build(store).delete(privileged.id, actorFrom(attacker), request),
      store,
      'deleting a superadmin',
    );
    assert.ok(store.admins.some((a) => a.id === privileged.id), 'the row must survive');
  });

  it('refuses to let an actor reset the password of a more privileged admin', async () => {
    const attacker = attackerRow();
    const privileged = admin({
      id: 'privileged',
      createdAt: new Date('2024-07-01T00:00:00.000Z'),
      rbacRoleId: superadminRole.id,
    });
    const store = freshStore([attacker, privileged]);

    // A password reset also bumps `tokenVersion`, so this is not "edit a field
    // on someone else's row" - it is taking the account.
    await refused(
      () =>
        build(store).update(
          privileged.id,
          { password: 'attacker-chosen-password' } as never,
          actorFrom(attacker),
          request,
        ),
      store,
      'password reset against a superadmin',
    );
  });

  it('refuses to let a non-DEV act on a DEV even when it holds every permission', async () => {
    // `UserRole.DEV` is not a permission set: `hasPermission` returns true for
    // it before consulting anything, which is strictly more than holding the
    // whole catalog. So it is guarded on itself, not on a subset check.
    const fullyPrivileged = admin({
      id: 'full',
      createdAt: new Date('2024-02-01T00:00:00.000Z'),
      rbacRoleId: superadminRole.id,
    });
    const otherDev = admin({
      id: 'other-dev',
      createdAt: new Date('2024-08-01T00:00:00.000Z'),
      role: UserRole.DEV,
    });
    const store = freshStore([fullyPrivileged, otherDev]);

    const error = await refused(
      () =>
        build(store).update(
          otherDev.id,
          { role: 'ADMIN' } as never,
          actorFrom(fullyPrivileged),
          request,
        ),
      store,
      'demoting a DEV from a non-DEV account',
    );
    assert.match(error.message, /DEV/);
  });
});

describe('AdminAdminsController protected owner', () => {
  it('treats the earliest-created admin as the owner and shields it from edits', async () => {
    const otherDev = admin({
      id: 'other-dev',
      createdAt: new Date('2024-08-01T00:00:00.000Z'),
      role: UserRole.DEV,
    });
    const store = freshStore([otherDev]);

    // Even another DEV - the most privileged thing this panel has - cannot
    // reset the bootstrap account's password and inherit the panel.
    const error = await refused(
      () =>
        build(store).update(
          ownerRow.id,
          { password: 'taken-over' } as never,
          actorFrom(otherDev),
          request,
        ),
      store,
      'password reset against the owner',
    );
    assert.match(error.message, /owner/i);
  });

  it('shields the owner from deletion by anyone else', async () => {
    const otherDev = admin({
      id: 'other-dev',
      createdAt: new Date('2024-08-01T00:00:00.000Z'),
      role: UserRole.DEV,
    });
    const store = freshStore([otherDev]);

    await refused(
      () => build(store).delete(ownerRow.id, actorFrom(otherDev), request),
      store,
      'deleting the owner',
    );
    assert.ok(
      store.admins.some((a) => a.id === ownerRow.id),
      'the owner row must survive',
    );
  });

  it('lets the owner edit its own account, so the shield is not a lockout', async () => {
    const store = freshStore();
    await build(store).update(
      ownerRow.id,
      { name: 'Panel owner' } as never,
      actorFrom(ownerRow),
      request,
    );
    assert.deepStrictEqual(store.writes, ['update:owner:name']);
  });

  it('derives the owner from creation order, so a newer account cannot claim it', async () => {
    // The rule has to be robust against the one thing an attacker with
    // `admins:create` controls: making more accounts. `createdAt` is written by
    // the database and is not settable through this controller, so a later row
    // is always later.
    const newer = admin({
      id: 'newer-dev',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      role: UserRole.DEV,
    });
    const store = freshStore([newer]);

    // The newer DEV cannot touch the owner...
    await refused(
      () => build(store).delete(ownerRow.id, actorFrom(newer), request),
      store,
      'newer DEV deleting the owner',
    );
    // ...while the owner can still act on the newer account.
    await build(store).delete(newer.id, actorFrom(ownerRow), request);
    assert.deepStrictEqual(store.writes, ['delete:newer-dev']);
  });
});
