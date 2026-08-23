import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ModuleRef } from '@nestjs/core';
import { UserRole } from '@prisma/client';

import { AdminAuthService } from '../src/modules/auth/services/admin-auth.service';
import { PasswordHashService } from '../src/modules/auth/services/password-hash.service';
import { BlockedIpService } from '../src/modules/blocked-ips/services/blocked-ip.service';
import { PasskeyService } from '../src/modules/oauth/services/passkey.service';
import {
  REALTIME_EVENT,
  REALTIME_READY,
} from '../src/modules/realtime/realtime.constants';
import { RealtimeGateway } from '../src/modules/realtime/realtime.gateway';
import { AdminIpAllowlistService } from '../src/modules/two-factor/services/admin-ip-allowlist.service';
import type { RealtimeEventInterface } from '../src/modules/realtime/interfaces/realtime-event.interface';

/**
 * DEFECT 1 — revocation that does not revoke, one surface further out.
 *
 * `RealtimeGateway.disconnectAdmin()` is documented as the lever for "password
 * change, role demotion" and had ZERO callers: `grep -rn disconnectAdmin src/`
 * returned the definition, one doc reference and a `Pick<>` union, and nothing
 * else. Meanwhile `tokenVersion` is compared in exactly one place on the socket
 * path — `handleConnection` — so an already-open stream kept delivering admin
 * events after the bump that killed every HTTP session.
 *
 * These tests assert the OUTCOME, never the call. What is checked is that the
 * revoked admin's socket stops existing and stops receiving broadcasts, and —
 * the anti-vacuity control that matters most here — that a DIFFERENT admin's
 * socket survives the same revocation and keeps receiving them. Without that
 * control, "disconnect everything" would pass every assertion above it.
 */

// ── Socket double ──────────────────────────────────────────────────────────

interface RecordedEmit {
  readonly event: string;
  readonly payload: unknown;
}

interface SocketDouble {
  readonly id: string;
  data?: unknown;
  readonly emitted: RecordedEmit[];
  /** Every `disconnect()` call, with the `close` flag it was given. */
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

/**
 * A socket double that behaves like the transport in the one way this test
 * depends on: closing it takes it out of the gateway's map. Socket.IO reaches
 * `handleDisconnect` through the adapter; here the double calls it directly, so
 * "was it really closed?" can be asked as "does a later broadcast still reach
 * it?" rather than as "was `disconnect` called?".
 */
function makeSocket(gateway: RealtimeGateway, id: string): SocketDouble {
  const socket: SocketDouble = {
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
      auth: { token: `jwt-for-${id}` },
      headers: {},
      query: {},
      address: '198.51.100.20',
    },
  };
  return socket;
}

// ── Gateway wired to two live admins ───────────────────────────────────────

const ADMINS: Record<string, { id: string; login: string; tokenVersion: number }> = {
  'admin-1': { id: 'admin-1', login: 'target', tokenVersion: 3 },
  'admin-2': { id: 'admin-2', login: 'bystander', tokenVersion: 3 },
};

/** Handed to the gateway so the Defect-3 handshake gate is satisfied, not skipped. */
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

function buildGateway(): RealtimeGateway {
  const jwtService = {
    verifyAsync: async (token: string) => {
      const id = token.replace('jwt-for-', '').replace(/^s\d-/, '');
      return { sub: id, tokenVersion: 3 };
    },
  };
  const prisma = {
    adminUser: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const row = ADMINS[where.id];
        if (!row) return null;
        return {
          id: row.id,
          login: row.login,
          isActive: true,
          tokenVersion: row.tokenVersion,
          role: UserRole.DEV,
          rbacRoleId: null,
        };
      },
    },
  };
  const rbac = { hasPermission: async () => true };
  return new RealtimeGateway(
    jwtService as never,
    prisma as never,
    { jwtSecret: 'x' } as never,
    rbac as never,
    undefined,
    permissiveIpStores(),
  );
}

/** Connects one socket per admin id and returns them keyed by admin id. */
async function connectBoth(
  gateway: RealtimeGateway,
): Promise<{ target: SocketDouble; bystander: SocketDouble }> {
  const target = makeSocket(gateway, 'admin-1');
  const bystander = makeSocket(gateway, 'admin-2');
  await gateway.handleConnection(target as never);
  await gateway.handleConnection(bystander as never);
  assert.equal(
    gateway.connectedCount(),
    2,
    'both sockets must be live before the revocation, or the test proves nothing',
  );
  assert.ok(
    target.emitted.some((e) => e.event === REALTIME_READY),
    'the target socket never completed a handshake',
  );
  return { target, bystander };
}

const SAMPLE_EVENT: RealtimeEventInterface = {
  type: 'user.created',
  category: 'USER',
  severity: 'INFO',
  message: 'a user appeared',
  timestamp: '2026-08-21T00:00:00.000Z',
};

function eventsSeenBy(socket: SocketDouble): RecordedEmit[] {
  return socket.emitted.filter((e) => e.event === REALTIME_EVENT);
}

/**
 * The shared outcome assertion: the target is gone from the stream, the
 * bystander is untouched and still fed. Both halves run on every path.
 */
function assertRevoked(
  gateway: RealtimeGateway,
  target: SocketDouble,
  bystander: SocketDouble,
  reason: string,
): void {
  assert.deepEqual(
    target.disconnects,
    [true],
    'the revoked admin’s socket must be force-closed exactly once',
  );
  const errors = target.emitted.filter((e) => e.event === 'error');
  assert.equal(errors.length, 1, 'the client must be told why the socket closed');
  assert.equal((errors[0]?.payload as { reason: string }).reason, reason);

  assert.equal(
    gateway.connectedCount(),
    1,
    'the revoked socket must be out of the gateway’s map, not merely signalled',
  );

  // ANTI-VACUITY CONTROL. A `disconnectAdmin` that dropped every socket would
  // satisfy everything above. The bystander is a different admin, unaffected by
  // this revocation, and must still be receiving.
  assert.deepEqual(bystander.disconnects, [], 'a bystander admin was disconnected too');
  const before = eventsSeenBy(bystander).length;
  gateway.broadcast(SAMPLE_EVENT);
  assert.equal(
    eventsSeenBy(bystander).length,
    before + 1,
    'the bystander stopped receiving events — the revocation was indiscriminate',
  );
  assert.equal(
    eventsSeenBy(target).length,
    0,
    'the revoked socket is still being delivered events',
  );
}

// ── changePassword ─────────────────────────────────────────────────────────

const PROFILE = {
  id: 'admin-1',
  login: 'target',
  loginNormalized: 'target',
  email: null,
  name: null,
  role: UserRole.DEV,
  isActive: true,
  tokenVersion: 4,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  lastLoginAt: null,
  lastLoginIp: null,
  rbacRoleId: null,
  mustChangePassword: false,
};

function buildAuthService(gateway: RealtimeGateway | null, passwordHash: string): AdminAuthService {
  const tx = {
    adminUser: { update: async () => PROFILE },
    adminAuditLog: { create: async () => ({}) },
  };
  const prisma = {
    adminUser: {
      findUnique: async () => ({
        ...PROFILE,
        tokenVersion: 3,
        passwordHash,
      }),
    },
    $transaction: async (fn: (client: unknown) => Promise<unknown>) => fn(tx),
  };
  const moduleRef = {
    get: (token: unknown): unknown => {
      const name = (token as { name?: string } | undefined)?.name;
      if (name === 'RealtimeGateway' && gateway) return gateway;
      throw new Error(`provider ${String(name)} is not registered`);
    },
  } as unknown as ModuleRef;
  return new AdminAuthService(
    { jwtSecret: 'x', jwtExpiresIn: '24h' } as never,
    { signAsync: async () => 'fresh-jwt' } as never,
    new PasswordHashService(),
    prisma as never,
    moduleRef,
  );
}

const REQUEST_METADATA = {
  requestId: 'req-1',
  remoteAddress: '198.51.100.20',
  userAgent: 'test',
};

describe('changing an admin password ends their realtime stream', () => {
  it('force-closes the admin’s socket and leaves other admins connected', async () => {
    const gateway = buildGateway();
    const { target, bystander } = await connectBoth(gateway);

    const hash = await new PasswordHashService().hashPassword({
      plainTextPassword: 'correct horse battery staple',
      audience: 'admin',
    });
    const service = buildAuthService(gateway, hash);

    const result = await service.changePassword({
      adminId: 'admin-1',
      currentPassword: 'correct horse battery staple',
      newPassword: 'a different passphrase entirely',
      requestMetadata: REQUEST_METADATA,
    });

    assert.equal(result.accessToken, 'fresh-jwt', 'the caller still gets a usable session back');
    assertRevoked(gateway, target, bystander, 'password_changed');
  });

  it('still rotates the password when no realtime gateway exists at all', async () => {
    // The worker runtime has no gateway. Revocation is best-effort by design;
    // it must never turn a completed password change into an error.
    const hash = await new PasswordHashService().hashPassword({
      plainTextPassword: 'correct horse battery staple',
      audience: 'admin',
    });
    const service = buildAuthService(null, hash);

    const result = await service.changePassword({
      adminId: 'admin-1',
      currentPassword: 'correct horse battery staple',
      newPassword: 'a different passphrase entirely',
      requestMetadata: REQUEST_METADATA,
    });

    assert.equal(result.accessToken, 'fresh-jwt');
  });
});

// ── deletePasskey ──────────────────────────────────────────────────────────

function buildPasskeyService(gateway: RealtimeGateway | null, deletedCount: number): PasskeyService {
  const prisma = {
    adminPasskey: { deleteMany: async () => ({ count: deletedCount }) },
    adminUser: {
      update: async () => ({
        id: 'admin-1',
        login: 'target',
        role: UserRole.DEV,
        tokenVersion: 4,
        rbacRoleId: null,
      }),
    },
    adminAuditLog: { create: async () => ({}) },
  };
  const moduleRef = {
    get: (token: unknown): unknown => {
      const name = (token as { name?: string } | undefined)?.name;
      if (name === 'RealtimeGateway' && gateway) return gateway;
      throw new Error(`provider ${String(name)} is not registered`);
    },
  } as unknown as ModuleRef;
  return new PasskeyService(
    prisma as never,
    { get: async () => null, set: async () => undefined, del: async () => undefined } as never,
    { signAsync: async () => 'fresh-jwt' } as never,
    { jwtSecret: 'x', jwtExpiresIn: '24h' } as never,
    moduleRef,
  );
}

describe('removing a passkey ends the realtime stream it opened', () => {
  it('force-closes the admin’s socket and leaves other admins connected', async () => {
    const gateway = buildGateway();
    const { target, bystander } = await connectBoth(gateway);
    const service = buildPasskeyService(gateway, 1);

    const removal = await service.deletePasskey('admin-1', 'pk-1');

    assert.equal(removal.removed, true);
    assertRevoked(gateway, target, bystander, 'passkey_removed');
  });

  it('leaves every socket alone when the id matched no credential', async () => {
    // ANTI-VACUITY CONTROL for the other direction: `deletePasskey` deliberately
    // does NOT bump `tokenVersion` when nothing was deleted, because a
    // stranger's id must not be able to log an admin out. The realtime call has
    // to inherit that restraint rather than fire unconditionally.
    const gateway = buildGateway();
    const { target, bystander } = await connectBoth(gateway);
    const service = buildPasskeyService(gateway, 0);

    const removal = await service.deletePasskey('admin-1', 'not-mine');

    assert.equal(removal.removed, false);
    assert.deepEqual(target.disconnects, [], 'a no-op removal closed a socket');
    assert.deepEqual(bystander.disconnects, []);
    assert.equal(gateway.connectedCount(), 2);
  });
});
