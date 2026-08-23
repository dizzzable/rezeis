import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ModuleRef } from '@nestjs/core';
import { UserRole } from '@prisma/client';

import { BlockedIpService } from '../src/modules/blocked-ips/services/blocked-ip.service';
import { getAllPermissions } from '../src/modules/rbac/rbac.resources';
import { RbacService } from '../src/modules/rbac/services/rbac.service';
import {
  REALTIME_EVENT,
  REALTIME_READY,
} from '../src/modules/realtime/realtime.constants';
import { RealtimeGateway } from '../src/modules/realtime/realtime.gateway';
import { AdminIpAllowlistService } from '../src/modules/two-factor/services/admin-ip-allowlist.service';
import type { RealtimeEventInterface } from '../src/modules/realtime/interfaces/realtime-event.interface';

/**
 * Narrowing a ROLE's permission matrix must end the realtime stream of every
 * admin holding it.
 *
 * `RbacService.updateRole` rewrote the matrix and called `invalidateAllCache()`.
 * That repairs the HTTP side — `RbacGuard` re-reads on the next request — but
 * `RealtimeGateway` resolves `allowedTopics` once, at connect, and `broadcast()`
 * tests that snapshot. No `admin_user` row is touched here, so one request could
 * leave EVERY holder of the edited role over-subscribed, with nothing in
 * `admin_user` recording that it had happened. It is the same leak as a single
 * admin's demotion, fanned out.
 *
 * This is the first revocation site that drops many sockets at once, so the
 * bystander control matters more here than anywhere else: "drop everyone" would
 * satisfy every positive assertion in the file.
 */

// ── Store ──────────────────────────────────────────────────────────────────

interface Permission {
  resource: string;
  action: string;
}

interface RoleRow {
  id: string;
  name: string;
  displayName: string;
  description: string | null;
  isSystem: boolean;
  permissions: Permission[];
  createdAt: Date;
  updatedAt: Date;
}

interface AdminRow {
  id: string;
  login: string;
  role: UserRole;
  isActive: boolean;
  tokenVersion: number;
  rbacRoleId: string | null;
}

const WIDE: Permission[] = [
  { resource: 'payments', action: 'view' },
  { resource: 'fraud_signals', action: 'view' },
  { resource: 'support_tickets', action: 'view' },
  { resource: 'dashboard', action: 'view' },
];
const NARROWED: Permission[] = [
  { resource: 'support_tickets', action: 'view' },
  { resource: 'dashboard', action: 'view' },
];
const WIDENED: Permission[] = [...WIDE, { resource: 'users', action: 'view' }];

const ACTOR_PERMISSIONS: ReadonlySet<string> = new Set(
  getAllPermissions().map((p) => `${p.resource}:${p.action}`),
);

interface Store {
  roles: RoleRow[];
  admins: AdminRow[];
}

function makeStore(): Store {
  const stamp = new Date('2026-01-01T00:00:00.000Z');
  const role = (over: Omit<RoleRow, 'createdAt' | 'updatedAt'>): RoleRow => ({
    ...over,
    createdAt: stamp,
    updatedAt: stamp,
  });
  return {
    roles: [
      role({
        id: 'role-wide',
        name: 'wide',
        displayName: 'Wide',
        description: null,
        isSystem: false,
        permissions: [...WIDE],
      }),
      role({
        id: 'role-other',
        name: 'other',
        displayName: 'Other',
        description: null,
        isSystem: false,
        permissions: [...WIDE],
      }),
      role({
        id: 'role-system',
        name: 'support',
        displayName: 'Support',
        description: null,
        isSystem: true,
        permissions: [...WIDE],
      }),
    ],
    admins: [
      { id: 'holder-a', login: 'a', role: UserRole.ADMIN, isActive: true, tokenVersion: 1, rbacRoleId: 'role-wide' },
      { id: 'holder-b', login: 'b', role: UserRole.ADMIN, isActive: true, tokenVersion: 1, rbacRoleId: 'role-wide' },
      { id: 'outsider', login: 'c', role: UserRole.ADMIN, isActive: true, tokenVersion: 1, rbacRoleId: 'role-other' },
    ],
  };
}

function roleOf(store: Store, id: string): RoleRow {
  const row = store.roles.find((r) => r.id === id);
  assert.ok(row, `no role ${id}`);
  return row;
}

function prismaDouble(store: Store): unknown {
  const roleApi = {
    findUnique: async ({ where }: { where: { id: string } }) => {
      const row = store.roles.find((r) => r.id === where.id);
      return row === undefined ? null : { ...row, permissions: [...row.permissions] };
    },
    findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
      const row = roleOf(store, where.id);
      return {
        ...row,
        permissions: [...row.permissions],
        _count: { admins: store.admins.filter((a) => a.rbacRoleId === row.id).length },
      };
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = roleOf(store, where.id);
      if (typeof data['displayName'] === 'string') row.displayName = data['displayName'];
      if ('description' in data) row.description = data['description'] as string | null;
      return row;
    },
  };
  const permissionApi = {
    deleteMany: async ({ where }: { where: { roleId: string } }) => {
      roleOf(store, where.roleId).permissions = [];
      return { count: 0 };
    },
    createMany: async ({ data }: { data: Array<Permission & { roleId: string }> }) => {
      for (const p of data) {
        roleOf(store, p.roleId).permissions.push({ resource: p.resource, action: p.action });
      }
      return { count: data.length };
    },
  };
  const tx = { adminRole: roleApi, adminPermission: permissionApi };
  return {
    adminRole: roleApi,
    adminPermission: permissionApi,
    adminUser: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        store.admins.find((a) => a.id === where.id) ?? null,
      findMany: async ({ where }: { where: { rbacRoleId: string } }) =>
        store.admins.filter((a) => a.rbacRoleId === where.rbacRoleId).map((a) => ({ id: a.id })),
    },
    $transaction: async (fn: (client: unknown) => Promise<unknown>) => fn(tx),
  };
}

// ── Socket double ──────────────────────────────────────────────────────────

interface RecordedEmit {
  readonly event: string;
  readonly payload: unknown;
}

interface SocketDouble {
  readonly id: string;
  data?: unknown;
  readonly emitted: RecordedEmit[];
  readonly disconnects: boolean[];
  /** Set by the ordering test: what the store held at the instant of the drop. */
  matrixAtDisconnect: string[] | null;
  emit(event: string, payload: unknown): void;
  disconnect(close?: boolean): void;
  readonly handshake: {
    readonly auth: { readonly token: string };
    readonly headers: Record<string, string>;
    readonly query: Record<string, string>;
    readonly address: string;
  };
}

function makeSocket(
  gateway: RealtimeGateway,
  store: Store,
  id: string,
  adminId: string,
): SocketDouble {
  return {
    id,
    emitted: [],
    disconnects: [],
    matrixAtDisconnect: null,
    emit(event, payload) {
      this.emitted.push({ event, payload });
    },
    disconnect(close?: boolean) {
      this.disconnects.push(close === true);
      // Read the world at the moment the socket is dropped. If the revocation
      // ran before the commit, this snapshot shows the OLD matrix.
      this.matrixAtDisconnect = roleOf(store, 'role-wide')
        .permissions.map((p) => `${p.resource}:${p.action}`)
        .sort();
      gateway.handleDisconnect(this as never);
    },
    handshake: { auth: { token: adminId }, headers: {}, query: {}, address: '198.51.100.20' },
  };
}

// ── Harness ────────────────────────────────────────────────────────────────

function permissiveIpStores(): ModuleRef {
  return {
    get: (token: unknown): unknown => {
      const name = (token as { name?: string } | undefined)?.name;
      if (name === BlockedIpService.name) return { isBlocked: async () => ({ blocked: false }) };
      if (name === AdminIpAllowlistService.name) return { isRequestAllowed: async () => true };
      throw new Error(`provider ${String(name)} is not registered`);
    },
  } as unknown as ModuleRef;
}

interface Harness {
  readonly store: Store;
  readonly gateway: RealtimeGateway;
  readonly rbac: RbacService;
}

function buildHarness(options?: { withGateway?: boolean }): Harness {
  const store = makeStore();
  const prisma = prismaDouble(store);

  const gatewayHolder: { current: RealtimeGateway | null } = { current: null };
  const rbacModuleRef = {
    get: (token: unknown): unknown => {
      const name = (token as { name?: string } | undefined)?.name;
      if (name === 'RealtimeGateway' && options?.withGateway !== false && gatewayHolder.current) {
        return gatewayHolder.current;
      }
      throw new Error(`provider ${String(name)} is not registered`);
    },
  } as unknown as ModuleRef;

  const rbac = new RbacService(prisma as never, rbacModuleRef);

  const gateway = new RealtimeGateway(
    {
      verifyAsync: async (token: string) => ({
        sub: token,
        tokenVersion: store.admins.find((a) => a.id === token)?.tokenVersion ?? -1,
      }),
    } as never,
    prisma as never,
    { jwtSecret: 'x' } as never,
    rbac,
    undefined,
    permissiveIpStores(),
  );
  gatewayHolder.current = gateway;

  return { store, gateway, rbac };
}

const PAYMENT_EVENT: RealtimeEventInterface = {
  type: 'payment.completed',
  category: 'PAYMENT',
  severity: 'INFO',
  message: 'paid',
  timestamp: '2026-08-21T00:00:00.000Z',
};

function readyTopics(socket: SocketDouble): string[] {
  const ready = socket.emitted.find((e) => e.event === REALTIME_READY);
  return ready === undefined ? [] : (ready.payload as { topics: string[] }).topics;
}

function paymentsSeenBy(socket: SocketDouble): number {
  return socket.emitted.filter(
    (e) => e.event === REALTIME_EVENT
      && (e.payload as RealtimeEventInterface).category === 'PAYMENT',
  ).length;
}

interface Connected {
  readonly holderA: SocketDouble;
  readonly holderB: SocketDouble;
  readonly outsider: SocketDouble;
}

async function connectAll(harness: Harness): Promise<Connected> {
  const holderA = makeSocket(harness.gateway, harness.store, 's-a', 'holder-a');
  const holderB = makeSocket(harness.gateway, harness.store, 's-b', 'holder-b');
  const outsider = makeSocket(harness.gateway, harness.store, 's-c', 'outsider');
  await harness.gateway.handleConnection(holderA as never);
  await harness.gateway.handleConnection(holderB as never);
  await harness.gateway.handleConnection(outsider as never);
  assert.equal(harness.gateway.connectedCount(), 3, 'all three sockets must start live');
  for (const [label, socket] of [
    ['holderA', holderA],
    ['holderB', holderB],
    ['outsider', outsider],
  ] as const) {
    assert.ok(
      readyTopics(socket).includes('PAYMENT'),
      `${label} must start with PAYMENT, or the narrowing narrows nothing`,
    );
  }
  return { holderA, holderB, outsider };
}

function updateWide(
  harness: Harness,
  permissions: Permission[],
  displayName = 'Wide',
): Promise<unknown> {
  return harness.rbac.updateRole('role-wide', {
    displayName,
    description: null,
    permissions,
    actorPermissions: ACTOR_PERMISSIONS,
  });
}

/**
 * The control that every test in this file runs. `outsider` holds a DIFFERENT
 * role, which was not edited, and must be untouched and still fed. With fan-out
 * this is the assertion standing between a targeted revocation and a
 * panel-wide sign-out.
 */
function assertOutsiderUntouched(harness: Harness, outsider: SocketDouble): void {
  assert.deepEqual(outsider.disconnects, [], 'an admin on a different role was signed out');
  const before = paymentsSeenBy(outsider);
  harness.gateway.broadcast(PAYMENT_EVENT);
  assert.equal(
    paymentsSeenBy(outsider),
    before + 1,
    'an admin on a different role stopped receiving — the revocation was indiscriminate',
  );
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('narrowing a role matrix ends every holder’s realtime stream', () => {
  it('drops all holders at once and leaves other roles connected', async () => {
    const harness = buildHarness();
    const { holderA, holderB, outsider } = await connectAll(harness);

    await updateWide(harness, NARROWED);

    for (const [label, socket] of [['holderA', holderA], ['holderB', holderB]] as const) {
      assert.deepEqual(socket.disconnects, [true], `${label} was not force-closed`);
      const errors = socket.emitted.filter((e) => e.event === 'error');
      assert.equal(errors.length, 1, `${label} was not told why`);
      assert.equal(
        (errors[0]?.payload as { reason: string }).reason,
        'role_permissions_narrowed',
      );
      assert.equal(paymentsSeenBy(socket), 0, `${label} is still being delivered PAYMENT`);
    }
    assert.equal(harness.gateway.connectedCount(), 1, 'only the outsider should remain');

    assertOutsiderUntouched(harness, outsider);

    // The leak, demonstrated: reconnecting re-runs `resolveAllowedTopics` and
    // the advertised set is now narrower. Before the fix the old sockets simply
    // stayed open carrying the wider one.
    const reconnected = makeSocket(harness.gateway, harness.store, 's-a2', 'holder-a');
    await harness.gateway.handleConnection(reconnected as never);
    const after = readyTopics(reconnected);
    assert.ok(!after.includes('PAYMENT'), 'the narrowing did not actually remove PAYMENT');
    assert.ok(!after.includes('FRAUD'), 'the narrowing did not actually remove FRAUD');
    assert.ok(after.includes('SUPPORT'), 'the narrowing removed more than it should have');
  });

  it('drops the sockets only AFTER the new matrix is committed', async () => {
    // Ordering is the bug in miniature: revoking before the write commits would
    // have every client reconnect onto the OLD snapshot. The socket double
    // records the stored matrix at the instant it is dropped.
    const harness = buildHarness();
    const { holderA } = await connectAll(harness);

    await updateWide(harness, NARROWED);

    assert.deepEqual(
      holderA.matrixAtDisconnect,
      ['dashboard:view', 'support_tickets:view'],
      'the socket was dropped while the store still held the old matrix',
    );
  });

  it('does not fail the role edit when no realtime gateway exists', async () => {
    const harness = buildHarness({ withGateway: false });

    await updateWide(harness, NARROWED);

    assert.deepEqual(
      roleOf(harness.store, 'role-wide').permissions.map((p) => `${p.resource}:${p.action}`).sort(),
      ['dashboard:view', 'support_tickets:view'],
    );
  });

  it('touches nobody once the holders are unbound — rbacRoleId is the only binding', async () => {
    // THE HOLDER-BINDING ANSWER, ASSERTED. `AdminUser.rbacRoleId` is a plain FK
    // (the `rbacRoleId` column and the `rbacRole` relation on `model AdminUser`
    // in `prisma/schema.prisma`, back-relation `admins AdminUser[]` on
    // `AdminRole`, no join table) and it is the ONLY thing that binds an admin
    // to a STORED matrix:
    // the legacy `role` enum resolves to `LEGACY_ADMIN_ALLOWED_RESOURCES`, a
    // compile-time constant `updateRole` cannot reach, and `DEV` short-circuits
    // inside `hasPermission` before any lookup. So one `findMany` on that column
    // covers the whole surface — and clearing it (the UI's "No role") takes
    // these two out of the blast radius while they are still bare `ADMIN`s and
    // still connected. Were the holder query ever widened to sweep by anything
    // else, this is the assertion that would notice.
    const harness = buildHarness();
    const { holderA, holderB, outsider } = await connectAll(harness);
    for (const row of harness.store.admins) {
      if (row.rbacRoleId === 'role-wide') row.rbacRoleId = null;
    }

    await updateWide(harness, NARROWED);

    assert.deepEqual(holderA.disconnects, [], 'an admin bound to no role was signed out');
    assert.deepEqual(holderB.disconnects, []);
    assert.equal(harness.gateway.connectedCount(), 3);
    assertOutsiderUntouched(harness, outsider);
  });
});

describe('role edits that take nothing away must sign nobody out', () => {
  it('leaves every holder connected when the matrix only GAINS a permission', async () => {
    // ANTI-VACUITY CONTROL, and a decision. The snapshot is equally stale after
    // a widening — the holders under-receive until they reconnect — but a drop
    // is a forced sign-out for every holder (see `disconnectAdmin`), so paying
    // a panel-wide logout to deliver a topic sooner is the wrong trade.
    const harness = buildHarness();
    const { holderA, holderB, outsider } = await connectAll(harness);

    await updateWide(harness, WIDENED);

    assert.deepEqual(holderA.disconnects, [], 'a widening signed a holder out');
    assert.deepEqual(holderB.disconnects, []);
    assert.equal(harness.gateway.connectedCount(), 3);
    harness.gateway.broadcast(PAYMENT_EVENT);
    assert.equal(paymentsSeenBy(holderA), 1, 'a widening silently ended the stream');
    assert.equal(paymentsSeenBy(holderB), 1);
    assert.equal(paymentsSeenBy(outsider), 1);
  });

  it('leaves every holder connected on a display-name-only edit', async () => {
    // ANTI-VACUITY CONTROL. Firing unconditionally would sign out every operator
    // in the company for renaming a role.
    const harness = buildHarness();
    const { holderA, holderB, outsider } = await connectAll(harness);

    await updateWide(harness, WIDE, 'Wide (renamed)');

    assert.equal(roleOf(harness.store, 'role-wide').displayName, 'Wide (renamed)');
    assert.deepEqual(holderA.disconnects, [], 'a rename signed a holder out');
    assert.deepEqual(holderB.disconnects, []);
    assert.equal(harness.gateway.connectedCount(), 3);
    harness.gateway.broadcast(PAYMENT_EVENT);
    assert.equal(paymentsSeenBy(holderA), 1);
    assert.equal(paymentsSeenBy(holderB), 1);
    assert.equal(paymentsSeenBy(outsider), 1);
  });

  it('leaves every holder connected when the same matrix is resubmitted', async () => {
    const harness = buildHarness();
    const { holderA, holderB } = await connectAll(harness);

    // Same tokens, different order — the comparison is on sets, not sequence.
    await updateWide(harness, [...WIDE].reverse());

    assert.deepEqual(holderA.disconnects, [], 'a no-op matrix resubmit signed a holder out');
    assert.deepEqual(holderB.disconnects, []);
    assert.equal(harness.gateway.connectedCount(), 3);
  });

  it('leaves system-role holders connected — their matrix is immutable here', async () => {
    // `updateRole` edits only display metadata on a system role. The set
    // comparison therefore reports no change on its own, with no `isSystem`
    // special case to drift out of sync with that branch.
    const harness = buildHarness();
    const { holderA, holderB, outsider } = await connectAll(harness);

    await harness.rbac.updateRole('role-system', {
      displayName: 'Support (renamed)',
      description: null,
      permissions: NARROWED,
      actorPermissions: ACTOR_PERMISSIONS,
    });

    assert.deepEqual(
      roleOf(harness.store, 'role-system').permissions.map((p) => `${p.resource}:${p.action}`).sort(),
      ['dashboard:view', 'fraud_signals:view', 'payments:view', 'support_tickets:view'],
      'a system role’s matrix was rewritten, which this branch must never do',
    );
    assert.deepEqual(holderA.disconnects, []);
    assert.deepEqual(holderB.disconnects, []);
    assert.deepEqual(outsider.disconnects, []);
    assert.equal(harness.gateway.connectedCount(), 3);
  });
});
