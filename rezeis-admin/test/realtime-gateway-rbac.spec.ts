import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { UserRole } from '@prisma/client';

import { RealtimeGateway } from '../src/modules/realtime/realtime.gateway';
import {
  REALTIME_EVENT,
  REALTIME_READY,
} from '../src/modules/realtime/realtime.constants';
import type { RealtimeEventInterface } from '../src/modules/realtime/interfaces/realtime-event.interface';

/**
 * HIGH #10: the realtime socket must not leak events an admin can't view.
 * A restricted operator (only support_tickets:view) subscribing to — or
 * defaulting into — the firehose must NOT receive PAYMENT / FRAUD / PARTNER
 * events. RBAC gates both `ready` advertising and `broadcast`.
 */

interface FakeSocket {
  id: string;
  data?: unknown;
  emitted: Array<{ event: string; payload: unknown }>;
  emit(event: string, payload: unknown): void;
  disconnect(): void;
  handshake: { auth: { token: string }; headers: Record<string, string>; query: Record<string, string> };
}

function makeSocket(id: string): FakeSocket {
  return {
    id,
    emitted: [],
    emit(event, payload) {
      this.emitted.push({ event, payload });
    },
    disconnect() {},
    handshake: { auth: { token: 'jwt' }, headers: {}, query: {} },
  };
}

function buildGateway(grantedTokens: ReadonlySet<string>, admin: {
  id: string;
  role: UserRole;
  rbacRoleId: string | null;
}): RealtimeGateway {
  const jwtService = {
    verifyAsync: async () => ({ sub: admin.id, tokenVersion: 7 }),
  };
  const prisma = {
    adminUser: {
      findUnique: async () => ({
        id: admin.id,
        login: 'op',
        isActive: true,
        tokenVersion: 7,
        role: admin.role,
        rbacRoleId: admin.rbacRoleId,
      }),
    },
  };
  const rbac = {
    hasPermission: async (
      a: unknown,
      resource: string,
      action: string,
    ): Promise<boolean> => grantedTokens.has(`${resource}:${action}`),
  };
  return new RealtimeGateway(
    jwtService as never,
    prisma as never,
    { jwtSecret: 'x' } as never,
    rbac as never,
  );
}

function readyTopics(socket: FakeSocket): string[] {
  const ready = socket.emitted.find((e) => e.event === REALTIME_READY);
  return (ready?.payload as { topics: string[] }).topics;
}

describe('RealtimeGateway RBAC topic gating', () => {
  it('advertises only topics the admin can view (restricted operator)', async () => {
    const gateway = buildGateway(new Set(['support_tickets:view', 'dashboard:view']), {
      id: 'op-1',
      role: UserRole.ADMIN,
      rbacRoleId: 'role-op',
    });
    const socket = makeSocket('s1');
    await gateway.handleConnection(socket as never);

    const topics = readyTopics(socket);
    assert.ok(topics.includes('SUPPORT'));
    assert.ok(topics.includes('SYSTEM'));
    assert.ok(!topics.includes('PAYMENT'));
    assert.ok(!topics.includes('FRAUD'));
    assert.ok(!topics.includes('PARTNER'));
  });

  it('never broadcasts a disallowed category even to a default (empty-sub) socket', async () => {
    const gateway = buildGateway(new Set(['support_tickets:view', 'dashboard:view']), {
      id: 'op-1',
      role: UserRole.ADMIN,
      rbacRoleId: 'role-op',
    });
    const socket = makeSocket('s1');
    await gateway.handleConnection(socket as never);
    socket.emitted.length = 0; // ignore the ready packet

    const payment: RealtimeEventInterface = {
      type: 'payment.completed',
      category: 'PAYMENT',
      severity: 'INFO',
      message: 'paid',
      timestamp: new Date().toISOString(),
    };
    const support: RealtimeEventInterface = {
      type: 'support.ticket_created',
      category: 'SUPPORT',
      severity: 'INFO',
      message: 'ticket',
      timestamp: new Date().toISOString(),
    };

    gateway.broadcast(payment);
    gateway.broadcast(support);

    const events = socket.emitted.filter((e) => e.event === REALTIME_EVENT);
    assert.equal(events.length, 1);
    assert.equal((events[0].payload as RealtimeEventInterface).category, 'SUPPORT');
  });

  it('drops a spoofed subscribe to a disallowed topic', async () => {
    const gateway = buildGateway(new Set(['support_tickets:view', 'dashboard:view']), {
      id: 'op-1',
      role: UserRole.ADMIN,
      rbacRoleId: 'role-op',
    });
    const socket = makeSocket('s1');
    await gateway.handleConnection(socket as never);

    const res = gateway.handleSubscribe(socket as never, ['PAYMENT', 'SUPPORT', 'FRAUD']);
    assert.ok(res.ok);
    assert.deepEqual(res.topics.sort(), ['SUPPORT']);
  });

  it('DEV receives every topic', async () => {
    // hasPermission short-circuits true for DEV, so our fake grants nothing
    // yet the gateway must still allow all topics.
    const gateway = buildGateway(new Set<string>(), {
      id: 'dev-1',
      role: UserRole.DEV,
      rbacRoleId: null,
    });
    // Override rbac to mimic real DEV short-circuit.
    const socket = makeSocket('s1');
    // Rebuild with a DEV-aware fake.
    const devGateway = new RealtimeGateway(
      { verifyAsync: async () => ({ sub: 'dev-1', tokenVersion: 7 }) } as never,
      {
        adminUser: {
          findUnique: async () => ({
            id: 'dev-1',
            login: 'dev',
            isActive: true,
            tokenVersion: 7,
            role: UserRole.DEV,
            rbacRoleId: null,
          }),
        },
      } as never,
      { jwtSecret: 'x' } as never,
      { hasPermission: async () => true } as never,
    );
    void gateway;
    await devGateway.handleConnection(socket as never);
    const topics = readyTopics(socket);
    assert.ok(topics.includes('PAYMENT'));
    assert.ok(topics.includes('FRAUD'));
    assert.ok(topics.includes('PARTNER'));
    assert.ok(topics.includes('REMNAWAVE'));
  });
});
