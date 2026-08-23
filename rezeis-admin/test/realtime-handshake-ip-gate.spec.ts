import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ModuleRef } from '@nestjs/core';
import { UserRole } from '@prisma/client';

import { BlockedIpService } from '../src/modules/blocked-ips/services/blocked-ip.service';
import {
  REALTIME_CLOSE,
  REALTIME_EVENT,
  REALTIME_READY,
} from '../src/modules/realtime/realtime.constants';
import { RealtimeGateway } from '../src/modules/realtime/realtime.gateway';
import { AdminIpAllowlistService } from '../src/modules/two-factor/services/admin-ip-allowlist.service';
import type { RealtimeEventInterface } from '../src/modules/realtime/interfaces/realtime-event.interface';

/**
 * DEFECT 3 — the realtime surface sat outside both IP lists.
 *
 * Measured before the fix, with a raw engine.io client against a real Nest app
 * carrying both `APP_GUARD`s: an address the operator had blocked got `403` from
 * `/api/admin/*` and, in the same run, a completed handshake plus a `ready`
 * packet listing every topic its role allows. Same for an address excluded from
 * the allowlist, whose docstring claims it restricts "the entire `/api/admin/*`
 * surface".
 *
 * The reason is deeper than the `/api/socket.io` path prefix or `AdminIoAdapter`
 * attaching engine.io ahead of Express. Nest does not wire `APP_GUARD` into the
 * WebSocket pipeline AT ALL: `SocketModule.getContextCreator()` constructs
 * `new GuardsContextCreator(container)` without the `ApplicationConfig`
 * (`@nestjs/websockets@11.1.23`), so `getGlobalMetadata()` returns `[]`. An
 * `APP_GUARD` that records every context it is handed never saw a single `ws`
 * context. No guard placement could have fixed this; the handshake is the only
 * place either list can be asked.
 */

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

function makeSocket(
  gateway: RealtimeGateway,
  id: string,
  address: string,
  headers: Record<string, string> = {},
): SocketDouble {
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
    handshake: { auth: { token: 'valid-jwt' }, headers, query: {}, address },
  };
}

interface IpStores {
  readonly blocked?: { isBlocked: (ip: string) => Promise<{ blocked: boolean }> };
  readonly allowlist?: { isRequestAllowed: (ip: string) => Promise<boolean> };
}

interface Harness {
  readonly gateway: RealtimeGateway;
  /** Addresses the two stores were actually asked about, in order. */
  readonly asked: string[];
  /** How many times the handshake got as far as verifying a JWT. */
  readonly jwtVerifications: () => number;
}

function buildHarness(stores: IpStores, trustProxy?: string): Harness {
  const asked: string[] = [];
  let verifications = 0;

  const jwtService = {
    verifyAsync: async () => {
      verifications += 1;
      return { sub: 'admin-1', tokenVersion: 7 };
    },
  };
  const prisma = {
    adminUser: {
      findUnique: async () => ({
        id: 'admin-1',
        login: 'op',
        isActive: true,
        tokenVersion: 7,
        role: UserRole.DEV,
        rbacRoleId: null,
      }),
    },
  };
  const rbac = { hasPermission: async () => true };

  const moduleRef = {
    get: (token: unknown): unknown => {
      const name = (token as { name?: string } | undefined)?.name;
      if (name === BlockedIpService.name && stores.blocked) {
        return {
          isBlocked: async (ip: string) => {
            asked.push(`blocked:${ip}`);
            return stores.blocked!.isBlocked(ip);
          },
        };
      }
      if (name === AdminIpAllowlistService.name && stores.allowlist) {
        return {
          isRequestAllowed: async (ip: string) => {
            asked.push(`allowlist:${ip}`);
            return stores.allowlist!.isRequestAllowed(ip);
          },
        };
      }
      throw new Error(`provider ${String(name)} is not registered`);
    },
  } as unknown as ModuleRef;

  const gateway = new RealtimeGateway(
    jwtService as never,
    prisma as never,
    { jwtSecret: 'x' } as never,
    rbac as never,
    trustProxy === undefined ? undefined : ({ trustProxy } as never),
    moduleRef,
  );
  return { gateway, asked, jwtVerifications: () => verifications };
}

const ALLOW_ALL: IpStores = {
  blocked: { isBlocked: async () => ({ blocked: false }) },
  allowlist: { isRequestAllowed: async () => true },
};

const SAMPLE_EVENT: RealtimeEventInterface = {
  type: 'user.created',
  category: 'USER',
  severity: 'INFO',
  message: 'a user appeared',
  timestamp: '2026-08-21T00:00:00.000Z',
};

function refusalReason(socket: SocketDouble): string | null {
  const error = socket.emitted.find((e) => e.event === 'error');
  if (!error) return null;
  return (error.payload as { reason: string }).reason;
}

function connected(socket: SocketDouble): boolean {
  return socket.emitted.some((e) => e.event === REALTIME_READY);
}

/**
 * The positive control every refusal test runs against: an address neither list
 * objects to must complete the handshake AND keep receiving. Without it,
 * "refuse every handshake" satisfies each assertion below.
 */
async function assertHealthyConnectionStillWorks(stores: IpStores): Promise<void> {
  const { gateway } = buildHarness(stores);
  const socket = makeSocket(gateway, 's-ok', '198.51.100.7');

  await gateway.handleConnection(socket as never);

  assert.ok(connected(socket), 'an allowed address failed to connect');
  assert.deepEqual(socket.disconnects, [], 'an allowed address was disconnected');
  assert.equal(gateway.connectedCount(), 1);
  gateway.broadcast(SAMPLE_EVENT);
  assert.equal(
    socket.emitted.filter((e) => e.event === REALTIME_EVENT).length,
    1,
    'the allowed socket is connected but receiving nothing',
  );
}

describe('realtime handshake — blocked addresses', () => {
  it('refuses the handshake and never establishes the stream', async () => {
    const stores: IpStores = {
      blocked: { isBlocked: async (ip) => ({ blocked: ip === '203.0.113.5' }) },
      allowlist: { isRequestAllowed: async () => true },
    };
    const { gateway, asked, jwtVerifications } = buildHarness(stores);
    const socket = makeSocket(gateway, 's-blocked', '203.0.113.5');

    await gateway.handleConnection(socket as never);

    assert.equal(connected(socket), false, 'a blocked address received a ready packet');
    assert.equal(refusalReason(socket), 'ip_blocked');
    assert.equal(
      (socket.emitted.find((e) => e.event === 'error')?.payload as { code: number }).code,
      REALTIME_CLOSE.AUTH_FAILURE,
    );
    assert.deepEqual(socket.disconnects, [true], 'the socket was not force-closed');
    assert.equal(gateway.connectedCount(), 0);
    assert.deepEqual(asked, ['blocked:203.0.113.5'], 'the allowlist ran after a refusal');
    assert.equal(
      jwtVerifications(),
      0,
      'the address gate must run before the auth store is consulted, as it does on HTTP',
    );

    await assertHealthyConnectionStillWorks(stores);
  });

  it('refuses only the blocked socket, leaving a healthy one connected', async () => {
    // ANTI-VACUITY CONTROL inside one gateway: both sockets go through the same
    // gate in the same instance, and only one of them may be refused.
    const { gateway } = buildHarness({
      blocked: { isBlocked: async (ip) => ({ blocked: ip === '203.0.113.5' }) },
      allowlist: { isRequestAllowed: async () => true },
    });
    const refused = makeSocket(gateway, 's-blocked', '203.0.113.5');
    const kept = makeSocket(gateway, 's-ok', '198.51.100.7');

    await gateway.handleConnection(refused as never);
    await gateway.handleConnection(kept as never);

    assert.equal(connected(refused), false);
    assert.equal(connected(kept), true);
    assert.equal(gateway.connectedCount(), 1);
    gateway.broadcast(SAMPLE_EVENT);
    assert.equal(refused.emitted.filter((e) => e.event === REALTIME_EVENT).length, 0);
    assert.equal(kept.emitted.filter((e) => e.event === REALTIME_EVENT).length, 1);
  });
});

describe('realtime handshake — the admin IP allowlist', () => {
  it('refuses an address the operator excluded', async () => {
    const stores: IpStores = {
      blocked: { isBlocked: async () => ({ blocked: false }) },
      allowlist: { isRequestAllowed: async (ip) => ip === '198.51.100.7' },
    };
    const { gateway, asked } = buildHarness(stores);
    const socket = makeSocket(gateway, 's-offlist', '203.0.113.5');

    await gateway.handleConnection(socket as never);

    assert.equal(connected(socket), false, 'an off-list address received a ready packet');
    assert.equal(refusalReason(socket), 'ip_not_allowed');
    assert.deepEqual(socket.disconnects, [true]);
    assert.equal(gateway.connectedCount(), 0);
    assert.deepEqual(asked, ['blocked:203.0.113.5', 'allowlist:203.0.113.5']);

    await assertHealthyConnectionStillWorks(stores);
  });
});

describe('realtime handshake — client address behind a reverse proxy', () => {
  /**
   * The outage this guards against. `handshake.address` is the raw TCP peer
   * (`socket.io/dist/socket.js:135`), which behind the reverse proxy this panel
   * normally runs behind is the PROXY. Testing the allowlist against it would
   * refuse every handshake the moment an operator adds their first entry —
   * realtime dies panel-wide for a list nobody is actually off.
   */
  it('tests the forwarded client, not the proxy, when the peer is trusted', async () => {
    const { gateway, asked } = buildHarness(
      {
        blocked: { isBlocked: async () => ({ blocked: false }) },
        // The operator listed their own address. The proxy is NOT on the list,
        // and must not need to be.
        allowlist: { isRequestAllowed: async (ip) => ip === '203.0.113.9' },
      },
      'loopback',
    );
    const socket = makeSocket(gateway, 's-proxied', '127.0.0.1', {
      'x-forwarded-for': '203.0.113.9',
    });

    await gateway.handleConnection(socket as never);

    assert.ok(connected(socket), 'the operator was refused because the proxy is not on the list');
    assert.deepEqual(
      asked,
      ['blocked:203.0.113.9', 'allowlist:203.0.113.9'],
      'the gate asked about the proxy address instead of the operator’s',
    );
  });

  it('refuses the forwarded client when it is the one excluded', async () => {
    // The control for the test above: proves the forwarded address is what is
    // actually being tested, rather than the gate having simply allowed.
    const { gateway, asked } = buildHarness(
      {
        blocked: { isBlocked: async () => ({ blocked: false }) },
        allowlist: { isRequestAllowed: async (ip) => ip === '127.0.0.1' },
      },
      'loopback',
    );
    const socket = makeSocket(gateway, 's-proxied', '127.0.0.1', {
      'x-forwarded-for': '203.0.113.9',
    });

    await gateway.handleConnection(socket as never);

    assert.equal(connected(socket), false);
    assert.equal(refusalReason(socket), 'ip_not_allowed');
    assert.deepEqual(asked, ['blocked:203.0.113.9', 'allowlist:203.0.113.9']);
  });

  it('ignores X-Forwarded-For when the peer is not a trusted proxy', async () => {
    const { gateway, asked } = buildHarness(
      {
        blocked: { isBlocked: async (ip) => ({ blocked: ip === '203.0.113.5' }) },
        allowlist: { isRequestAllowed: async () => true },
      },
      'disabled',
    );
    const socket = makeSocket(gateway, 's-spoofer', '203.0.113.5', {
      'x-forwarded-for': '198.51.100.7',
    });

    await gateway.handleConnection(socket as never);

    assert.equal(connected(socket), false, 'a spoofed header opened a stream from a blocked address');
    assert.equal(refusalReason(socket), 'ip_blocked');
    assert.deepEqual(asked, ['blocked:203.0.113.5']);
  });
});

describe('realtime handshake — the gate fails open, exactly as both guards do', () => {
  it('connects when the allowlist store throws', async () => {
    // A Postgres hiccup must not take realtime down for every operator; both
    // HTTP guards make the same trade-off explicitly.
    const { gateway } = buildHarness({
      blocked: { isBlocked: async () => ({ blocked: false }) },
      allowlist: {
        isRequestAllowed: async () => {
          throw new Error('connection terminated unexpectedly');
        },
      },
    });
    const socket = makeSocket(gateway, 's-dbdown', '203.0.113.5');

    await gateway.handleConnection(socket as never);

    assert.ok(connected(socket), 'a DB error refused the handshake');
    assert.deepEqual(socket.disconnects, []);
  });

  it('connects when neither store exists in the container', async () => {
    // The worker runtime, and any container where the HTTP guards are absent
    // too. The socket must not be stricter than the surface it mirrors.
    const { gateway, asked } = buildHarness({});
    const socket = makeSocket(gateway, 's-noStores', '203.0.113.5');

    await gateway.handleConnection(socket as never);

    assert.ok(connected(socket));
    assert.deepEqual(asked, []);
  });

  it('connects when the handshake carries no address at all', async () => {
    const { gateway, asked } = buildHarness(ALLOW_ALL);
    const socket = makeSocket(gateway, 's-noAddr', '');

    await gateway.handleConnection(socket as never);

    assert.ok(connected(socket), 'no derivable IP is the documented fail-open');
    assert.deepEqual(asked, []);
  });
});
