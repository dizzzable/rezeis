import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { OlcrtcLifecycleService } from '../src/modules/olcrtc/olcrtc-lifecycle.service';

describe('OlcrtcLifecycleService', () => {
  it('marks stale gateways and expired/stuck sessions in one sweep', async () => {
    const calls: Array<{ delegate: string; args: unknown }> = [];
    const prisma = {
      olcGateway: {
        updateMany: async (args: unknown) => {
          calls.push({ delegate: 'olcGateway', args });
          return { count: 2 };
        },
      },
      olcSession: {
        updateMany: async (args: unknown) => {
          calls.push({ delegate: 'olcSession', args });
          return { count: calls.filter((call) => call.delegate === 'olcSession').length };
        },
      },
      olcRoom: {
        updateMany: async (args: unknown) => {
          calls.push({ delegate: 'olcRoom', args });
          return { count: 3 };
        },
      },
    };
    const service = new OlcrtcLifecycleService(prisma as never);
    const now = new Date('2027-01-01T00:30:00.000Z');

    const result = await service.runOnce(now);

    assert.deepEqual(result, {
      staleGateways: 2,
      expiredSessions: 1,
      stuckSessions: 2,
      expiredRooms: 3,
    });
    assert.deepEqual(normalizeDynamicDates(calls), [
      {
        delegate: 'olcGateway',
        args: {
          where: {
            status: 'ACTIVE',
            OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: '<date>' } }],
          },
          data: { status: 'UNHEALTHY' },
        },
      },
      {
        delegate: 'olcSession',
        args: {
          where: {
            status: { in: ['PROVISIONING', 'PENDING_AGENT', 'STARTING', 'ACTIVE', 'IDLE'] },
            expiresAt: { not: null, lt: '<date>' },
          },
          data: { status: 'EXPIRED', stoppedAt: '<date>', lastSeenAt: '<date>' },
        },
      },
      {
        delegate: 'olcSession',
        args: {
          where: {
            status: { in: ['PROVISIONING', 'PENDING_AGENT', 'STARTING'] },
            createdAt: { lt: '<date>' },
          },
          data: {
            status: 'FAILED',
            lastError: 'OLCRTC agent did not claim/start the session in time',
            stoppedAt: '<date>',
            lastSeenAt: '<date>',
          },
        },
      },
      {
        delegate: 'olcRoom',
        args: {
          where: {
            status: { in: ['READY', 'IN_USE'] },
            expiresAt: { not: null, lt: '<date>' },
          },
          data: { status: 'EXPIRED', leaseSessionId: null },
        },
      },
    ]);
  });
});

function normalizeDynamicDates(value: unknown): unknown {
  if (value instanceof Date) return '<date>';
  if (Array.isArray(value)) return value.map(normalizeDynamicDates);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, normalizeDynamicDates(entry)]),
    );
  }
  return value;
}
