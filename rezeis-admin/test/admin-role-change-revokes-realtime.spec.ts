import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ModuleRef } from '@nestjs/core';
import { UserRole } from '@prisma/client';

import type { CurrentAdminInterface } from '../src/modules/auth/interfaces/current-admin.interface';
import { BlockedIpService } from '../src/modules/blocked-ips/services/blocked-ip.service';
import { AdminAdminsController } from '../src/modules/rbac/controllers/admin-admins.controller';
import { RbacService } from '../src/modules/rbac/services/rbac.service';
import {
  REALTIME_EVENT,
  REALTIME_READY,
} from '../src/modules/realtime/realtime.constants';
import { RealtimeGateway } from '../src/modules/realtime/realtime.gateway';
import { AdminIpAllowlistService } from '../src/modules/two-factor/services/admin-ip-allowlist.service';
import type { RealtimeEventInterface } from '../src/modules/realtime/interfaces/realtime-event.interface';

/**
 * A demoted admin's realtime stream must stop carrying what they can no longer
 * open in the panel.
 *
 * `RealtimeGateway` resolves `allowedTopics` ONCE, in `handleConnection`, and
 * `broadcast()` tests that connect-time snapshot. Nothing refreshes it.
 * `admin-admins.controller.ts` called `rbacService.invalidateCacheForAdmin()`
 * after a role change, which fixes the HTTP side — `RbacGuard` re-reads on the
 * next request — but a socket has no next request. So an operator could demote
 * an admin out of `payments:view` and that admin's open stream kept delivering
 * PAYMENT events, at exactly the moment the operator was most likely watching.
 *
 * This is not a stale-session bug like the other two revocation sites: those
 * leak access the admin used to have, this leaks data to someone an operator
 * has just deliberately demoted.
 *
 * The tests drive the REAL controller and the REAL `RbacService` over one
 * in-memory store, so a demotion is genuinely observable in the topic set
 * rather than stubbed. The last assertion of the first test is the point of the
 * whole file: after the reconnect the gateway advertises a NARROWER set, which
 * is what proves the snapshot was stale and that dropping the socket is what
 * repairs it.
 */

// ── Store ──────────────────────────────────────────────────────────────────

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
  isSystem: boolean;
  permissions: Array<{ resource: string; action: string }>;
}

const WIDE_PERMISSIONS = [
  { resource: 'payments', action: 'view' },
  { resource: 'fraud_signals', action: 'view' },
  { resource: 'support_tickets', action: 'view' },
  { resource: 'dashboard', action: 'view' },
];
const NARROW_PERMISSIONS = [
  { resource: 'support_tickets', action: 'view' },
  { resource: 'dashboard', action: 'view' },
];

function makeStore(): { admins: AdminRow[]; roles: RoleRow[] } {
  const base = {
    name: null,
    isActive: true,
    mustChangePassword: false,
    totpEnabled: false,
    lastLoginAt: null,
    passwordHash: 'stored-hash',
    tokenVersion: 1,
  };
  return {
    admins: [
      {
        ...base,
        id: 'owner-1',
        login: 'owner',
        loginNormalized: 'owner',
        role: UserRole.DEV,
        rbacRoleId: null,
        createdAt: new Date('2020-01-01T00:00:00.000Z'),
        updatedAt: new Date('2020-01-01T00:00:00.000Z'),
      },
      {
        ...base,
        id: 'target-1',
        login: 'target',
        loginNormalized: 'target',
        role: UserRole.ADMIN,
        rbacRoleId: 'role-wide',
        createdAt: new Date('2021-01-01T00:00:00.000Z'),
        updatedAt: new Date('2021-01-01T00:00:00.000Z'),
      },
      {
        ...base,
        id: 'bystander-1',
        login: 'bystander',
        loginNormalized: 'bystander',
        role: UserRole.ADMIN,
        rbacRoleId: 'role-wide',
        createdAt: new Date('2022-01-01T00:00:00.000Z'),
        updatedAt: new Date('2022-01-01T00:00:00.000Z'),
      },
    ],
    roles: [
      {
        id: 'role-wide',
        name: 'wide',
        displayName: 'Wide',
        isSystem: false,
        permissions: WIDE_PERMISSIONS,
      },
      {
        id: 'role-narrow',
        name: 'narrow',
        displayName: 'Narrow',
        isSystem: false,
        permissions: NARROW_PERMISSIONS,
      },
    ],
  };
}

type Store = ReturnType<typeof makeStore>;

function withRbacRole(row: AdminRow, store: Store): unknown {
  const role = store.roles.find((r) => r.id === row.rbacRoleId) ?? null;
  return { ...row, rbacRole: role === null ? null : { id: role.id, displayName: role.displayName } };
}

function prismaDouble(store: Store): unknown {
  return {
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
      count: async () => store.admins.filter((a) => a.isActive).length,
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = store.admins.find((a) => a.id === where.id)!;
        if (typeof data['role'] === 'string') row.role = data['role'] as UserRole;
        if (typeof data['isActive'] === 'boolean') row.isActive = data['isActive'];
        if ('name' in data) row.name = data['name'] as string | null;
        if (typeof data['mustChangePassword'] === 'boolean') {
          row.mustChangePassword = data['mustChangePassword'];
        }
        if (typeof data['passwordHash'] === 'string') row.passwordHash = data['passwordHash'];
        const rbacRole = data['rbacRole'] as
          | { connect?: { id: string }; disconnect?: boolean }
          | undefined;
        if (rbacRole?.connect) row.rbacRoleId = rbacRole.connect.id;
        if (rbacRole?.disconnect) row.rbacRoleId = null;
        const tokenVersion = data['tokenVersion'] as { increment?: number } | undefined;
        if (tokenVersion?.increment) row.tokenVersion += tokenVersion.increment;
        return withRbacRole(row, store);
      },
      delete: async ({ where }: { where: { id: string } }) => {
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
  emit(event: string, payload: unknown): void;
  disconnect(close?: boolean): void;
  readonly handshake: {
    readonly auth: { readonly token: string };
    readonly headers: Record<string, string>;
    readonly query: Record<string, string>;
    readonly address: string;
  };
}

/** Closing it removes it from the gateway's map, as the real transport does. */
function makeSocket(gateway: RealtimeGateway, id: string, adminId: string): SocketDouble {
  return {
    id,
    emitted: [],
    disconnects: [],
    emit(event, payload) {
      this.emitted.push({ event, payload });
    },
    disconnect(close?: boolean) {
      this.disconnects.push(close === true);
      gateway.handleDisconnect(this as never);
    },
    handshake: {
      auth: { token: adminId },
      headers: {},
      query: {},
      address: '198.51.100.20',
    },
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
  readonly controller: AdminAdminsController;
  readonly actor: CurrentAdminInterface;
}

function buildHarness(options?: { withGateway?: boolean }): Harness {
  const store = makeStore();
  const prisma = prismaDouble(store);
  const rbacService = new RbacService(prisma as never);

  const jwtService = {
    // The handshake token IS the admin id; the payload's tokenVersion is read
    // live from the store so a password reset really does invalidate it.
    verifyAsync: async (token: string) => ({
      sub: token,
      tokenVersion: store.admins.find((a) => a.id === token)?.tokenVersion ?? -1,
    }),
  };

  const gateway = new RealtimeGateway(
    jwtService as never,
    prisma as never,
    { jwtSecret: 'x' } as never,
    rbacService,
    undefined,
    permissiveIpStores(),
  );

  const controllerModuleRef = {
    get: (token: unknown): unknown => {
      const name = (token as { name?: string } | undefined)?.name;
      if (name === 'RealtimeGateway' && options?.withGateway !== false) return gateway;
      throw new Error(`provider ${String(name)} is not registered`);
    },
  } as unknown as ModuleRef;

  const controller = new AdminAdminsController(
    prisma as never,
    { hashPassword: async () => 'new-hash' } as never,
    rbacService,
    controllerModuleRef,
  );

  const ownerRow = store.admins.find((a) => a.id === 'owner-1')!;
  const actor: CurrentAdminInterface = {
    id: ownerRow.id,
    login: ownerRow.login,
    email: null,
    name: null,
    role: ownerRow.role,
    isActive: true,
    tokenVersion: ownerRow.tokenVersion,
    createdAt: ownerRow.createdAt,
    lastLoginAt: null,
    lastLoginIp: null,
    rbacRoleId: ownerRow.rbacRoleId,
    mustChangePassword: false,
  };

  return { store, gateway, controller, actor };
}

const REQUEST = {
  headers: { 'user-agent': 'test' },
  ip: '203.0.113.1',
  socket: { remoteAddress: '203.0.113.1' },
};

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

function paymentEventsSeenBy(socket: SocketDouble): number {
  return socket.emitted.filter(
    (e) => e.event === REALTIME_EVENT
      && (e.payload as RealtimeEventInterface).category === 'PAYMENT',
  ).length;
}

async function connectBoth(
  harness: Harness,
): Promise<{ target: SocketDouble; bystander: SocketDouble }> {
  const target = makeSocket(harness.gateway, 's-target', 'target-1');
  const bystander = makeSocket(harness.gateway, 's-bystander', 'bystander-1');
  await harness.gateway.handleConnection(target as never);
  await harness.gateway.handleConnection(bystander as never);
  assert.equal(harness.gateway.connectedCount(), 2, 'both sockets must be live to start');
  assert.ok(
    readyTopics(target).includes('PAYMENT'),
    'the target must start with PAYMENT, or the demotion narrows nothing',
  );
  assert.ok(readyTopics(bystander).includes('PAYMENT'));
  return { target, bystander };
}

/**
 * The control that every revocation test runs. A bystander admin whose role did
 * NOT change must still be connected and still receiving; without it,
 * "disconnect everyone on any PATCH" passes each assertion above it.
 */
function assertBystanderUntouched(harness: Harness, bystander: SocketDouble): void {
  assert.deepEqual(bystander.disconnects, [], 'an unrelated admin was disconnected');
  const before = paymentEventsSeenBy(bystander);
  harness.gateway.broadcast(PAYMENT_EVENT);
  assert.equal(
    paymentEventsSeenBy(bystander),
    before + 1,
    'the unrelated admin stopped receiving — the revocation was indiscriminate',
  );
}

function assertRevoked(
  harness: Harness,
  target: SocketDouble,
  bystander: SocketDouble,
  reason: string,
): void {
  assert.deepEqual(target.disconnects, [true], 'the target socket was not force-closed');
  const errors = target.emitted.filter((e) => e.event === 'error');
  assert.equal(errors.length, 1);
  assert.equal((errors[0]?.payload as { reason: string }).reason, reason);
  assert.equal(harness.gateway.connectedCount(), 1, 'the target is still in the gateway map');
  assertBystanderUntouched(harness, bystander);
  assert.equal(paymentEventsSeenBy(target), 0, 'the revoked socket is still being delivered');
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('demoting an admin ends the realtime stream that outranks them', () => {
  it('drops the socket on an rbacRoleId change, and the reconnect narrows the topics', async () => {
    const harness = buildHarness();
    const { target, bystander } = await connectBoth(harness);

    await harness.controller.update(
      'target-1',
      { rbacRoleId: 'role-narrow' } as never,
      harness.actor,
      REQUEST as never,
    );

    assertRevoked(harness, target, bystander, 'admin_role_changed');

    // THE POINT OF THE FILE. Reconnecting re-runs `resolveAllowedTopics`, and
    // the set it advertises is now narrower. Before the fix the old socket
    // simply stayed open carrying the wider set.
    const reconnected = makeSocket(harness.gateway, 's-target-2', 'target-1');
    await harness.gateway.handleConnection(reconnected as never);
    const after = readyTopics(reconnected);
    assert.ok(!after.includes('PAYMENT'), 'the demotion did not actually narrow PAYMENT');
    assert.ok(!after.includes('FRAUD'), 'the demotion did not actually narrow FRAUD');
    assert.ok(after.includes('SUPPORT'), 'the demotion narrowed more than it should have');
  });

  it('drops the socket when the RBAC role is detached entirely', async () => {
    const harness = buildHarness();
    const { target, bystander } = await connectBoth(harness);

    await harness.controller.update(
      'target-1',
      { rbacRoleId: '' } as never,
      harness.actor,
      REQUEST as never,
    );

    assert.equal(harness.store.admins.find((a) => a.id === 'target-1')?.rbacRoleId, null);
    assertRevoked(harness, target, bystander, 'admin_role_changed');
  });

  it('drops the socket on a legacy `role` enum change', async () => {
    const harness = buildHarness();
    const { target, bystander } = await connectBoth(harness);

    await harness.controller.update(
      'target-1',
      { role: UserRole.DEV } as never,
      harness.actor,
      REQUEST as never,
    );

    assertRevoked(harness, target, bystander, 'admin_role_changed');
  });

  it('drops the socket when the account is deactivated', async () => {
    // `handleConnection` refuses an inactive admin — but only at handshake. The
    // socket opened while they were active survives deactivation otherwise.
    const harness = buildHarness();
    const { target, bystander } = await connectBoth(harness);

    await harness.controller.update(
      'target-1',
      { isActive: false } as never,
      harness.actor,
      REQUEST as never,
    );

    assertRevoked(harness, target, bystander, 'admin_deactivated');
  });

  it('drops the socket when an operator resets the password', async () => {
    // The third `tokenVersion` bump site. The HTTP half already died at the
    // next request; this is the half that did not.
    const harness = buildHarness();
    const { target, bystander } = await connectBoth(harness);
    const before = harness.store.admins.find((a) => a.id === 'target-1')!.tokenVersion;

    await harness.controller.update(
      'target-1',
      { password: 'a brand new temporary password' } as never,
      harness.actor,
      REQUEST as never,
    );

    assert.equal(
      harness.store.admins.find((a) => a.id === 'target-1')!.tokenVersion,
      before + 1,
      'the password reset did not bump tokenVersion',
    );
    assertRevoked(harness, target, bystander, 'admin_password_reset');
  });

  it('drops the socket when the account is deleted outright', async () => {
    const harness = buildHarness();
    const { target, bystander } = await connectBoth(harness);

    await harness.controller.delete('target-1', harness.actor, REQUEST as never);

    assert.equal(harness.store.admins.find((a) => a.id === 'target-1'), undefined);
    assertRevoked(harness, target, bystander, 'admin_deleted');
  });
});

describe('edits that change nothing about permissions must drop nobody', () => {
  it('leaves every socket alone on a display-name-only edit', async () => {
    // ANTI-VACUITY CONTROL. `name` cannot move `allowedTopics`. A revocation
    // that fired on any PATCH would satisfy every test above while kicking an
    // operator off their stream for renaming an account.
    const harness = buildHarness();
    const { target, bystander } = await connectBoth(harness);

    await harness.controller.update(
      'target-1',
      { name: 'Renamed Operator' } as never,
      harness.actor,
      REQUEST as never,
    );

    assert.equal(harness.store.admins.find((a) => a.id === 'target-1')?.name, 'Renamed Operator');
    assert.deepEqual(target.disconnects, [], 'a rename dropped the admin’s socket');
    assert.deepEqual(bystander.disconnects, []);
    assert.equal(harness.gateway.connectedCount(), 2);
    harness.gateway.broadcast(PAYMENT_EVENT);
    assert.equal(paymentEventsSeenBy(target), 1, 'a rename silently ended the stream');
    assert.equal(paymentEventsSeenBy(bystander), 1);
  });

  it('leaves every socket alone on a mustChangePassword-only edit', async () => {
    const harness = buildHarness();
    const { target, bystander } = await connectBoth(harness);

    await harness.controller.update(
      'target-1',
      { mustChangePassword: true } as never,
      harness.actor,
      REQUEST as never,
    );

    assert.deepEqual(target.disconnects, []);
    assert.deepEqual(bystander.disconnects, []);
    assert.equal(harness.gateway.connectedCount(), 2);
  });

  it('leaves every socket alone when the role is PATCHed to the value it already has', async () => {
    // ANTI-VACUITY CONTROL for the trigger's precision: the decision is made
    // against the row as it was BEFORE the write, not against the mere presence
    // of the field in the DTO.
    const harness = buildHarness();
    const { target, bystander } = await connectBoth(harness);

    await harness.controller.update(
      'target-1',
      { role: UserRole.ADMIN, rbacRoleId: 'role-wide' } as never,
      harness.actor,
      REQUEST as never,
    );

    assert.deepEqual(target.disconnects, [], 'a no-op role PATCH dropped the socket');
    assert.deepEqual(bystander.disconnects, []);
    assert.equal(harness.gateway.connectedCount(), 2);
    harness.gateway.broadcast(PAYMENT_EVENT);
    assert.equal(paymentEventsSeenBy(target), 1, 'a no-op PATCH silently ended the stream');
    assert.equal(paymentEventsSeenBy(bystander), 1);
  });
});

describe('the revocation degrades rather than failing the request', () => {
  it('still applies the demotion when no realtime gateway exists', async () => {
    const harness = buildHarness({ withGateway: false });

    const updated = await harness.controller.update(
      'target-1',
      { rbacRoleId: 'role-narrow' } as never,
      harness.actor,
      REQUEST as never,
    );

    assert.equal(updated.rbacRoleId, 'role-narrow');
  });
});
