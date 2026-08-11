import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { OlcrtcProvisioningService } from '../src/modules/olcrtc/olcrtc-provisioning.service';
import { encryptOlcrtcSecret } from '../src/modules/olcrtc/utils/olcrtc-secret-cipher';

const APP_CONFIG = {
  domain: 'localhost',
  host: '0.0.0.0',
  port: 8000,
  docsEnabled: false,
  corsOrigins: [],
  trustProxy: false,
  locales: ['en'],
  defaultLocale: 'en',
  cryptKey: 'test-crypt-key',
  serviceName: 'rezeis-admin',
} as never;

const OLC_ENABLED = {
  enabled: true,
  subscriptionName: 'Restricted',
  defaultRefreshSeconds: 120,
} as never;

const OLC_DISABLED = {
  enabled: false,
  subscriptionName: 'Restricted',
  defaultRefreshSeconds: 120,
} as never;

describe('OlcrtcProvisioningService', () => {
  it('returns disabled payload without touching user state when OLCRTC is off', async () => {
    const calls: string[] = [];
    const service = new OlcrtcProvisioningService(
      { user: { findUnique: async () => calls.push('user.findUnique') } } as never,
      APP_CONFIG,
      OLC_DISABLED,
    );

    const payload = await service.getSubscription({ userId: 'cmolcrtcuser000000000000001' });

    assert.deepEqual(payload, {
      enabled: false,
      eligible: false,
      status: 'DISABLED',
      reason: 'olcrtc_disabled',
      subscription: null,
    });
    assert.deepEqual(calls, []);
  });

  it('returns no-active-subscription for eligible users without active subscriptions', async () => {
    const service = new OlcrtcProvisioningService(
      {
        user: { findUnique: async () => ({ id: 'user-1' }) },
        subscription: { findFirst: async () => null },
      } as never,
      APP_CONFIG,
      OLC_ENABLED,
    );

    const payload = await service.getSubscription({ userId: 'cmolcrtcuser000000000000001' });

    assert.equal(payload.enabled, true);
    assert.equal(payload.eligible, false);
    assert.equal(payload.status, 'NO_ACTIVE_SUBSCRIPTION');
    assert.equal(payload.reason, 'no_active_subscription');
    assert.equal(payload.subscription, null);
  });

  it('lazily creates a Jitsi-backed pending-agent session', async () => {
    const calls: Array<{ name: string; args: unknown }> = [];
    const prisma = {
      user: { findUnique: async () => ({ id: 'user-1' }) },
      subscription: {
        findFirst: async () => ({ id: 'sub-1', expiresAt: new Date('2027-01-01T00:00:00.000Z') }),
      },
      olcProfile: {
        findFirst: async () => ({
          id: 'profile-1',
          name: 'Jitsi fallback',
          provider: 'JITSI',
          transport: 'VP8CHANNEL',
          roomTemplate: 'https://meet.jit.si/rezeis-test-{random}',
          transportOptions: { fps: 12, batchSize: 4 },
        }),
      },
      olcGateway: {
        findFirst: async () => ({ id: 'gateway-1' }),
      },
      olcRoom: {
        findFirst: async () => null,
        create: async (args: { readonly data: Record<string, unknown> }) => {
          calls.push({ name: 'olcRoom.create', args });
          return { id: 'room-1', ...args.data };
        },
        update: async (args: unknown) => {
          calls.push({ name: 'olcRoom.update', args });
          return { id: 'room-1' };
        },
      },
      olcSession: {
        findFirst: async () => null,
        create: async (args: { readonly data: Record<string, unknown> }) => {
          calls.push({ name: 'olcSession.create', args });
          return { id: 'session-1', ...args.data };
        },
      },
    };
    const service = new OlcrtcProvisioningService(prisma as never, APP_CONFIG, OLC_ENABLED);

    const payload = await service.getSubscription({ userId: 'cmolcrtcuser000000000000001' });

    assert.equal(payload.status, 'READY');
    assert.equal(payload.subscription?.sessionId, 'session-1');
    assert.equal(payload.subscription?.provider, 'jitsi');
    assert.equal(payload.subscription?.transport, 'vp8channel');
    assert.match(payload.subscription?.url ?? '', /^#name: Restricted\n#update: 2147483647\n#refresh: 120\nolcrtc:\/\/jitsi\?vp8channel/);
    assert.equal(calls.some((call) => call.name === 'olcRoom.update'), true);
  });

  it('claims pending sessions for the requested active gateway', async () => {
    const encryptedCryptoKey = encryptOlcrtcSecret('session-crypto-key', 'test-crypt-key');
    const updates: unknown[] = [];
    const service = new OlcrtcProvisioningService(
      {
        olcGateway: {
          findFirst: async () => ({ id: 'gateway-1', name: 'agent-a' }),
        },
        olcSession: {
          findFirst: async () => ({
            id: 'session-1',
            userId: 'user-1',
            subscriptionId: 'sub-1',
            profileId: 'profile-1',
            gatewayId: 'gateway-1',
            status: 'PENDING_AGENT',
            provider: 'JITSI',
            transport: 'VP8CHANNEL',
            cryptoKeyEnc: encryptedCryptoKey,
            subscriptionUri: 'olcrtc://jitsi?vp8channel@room#key$name',
            metadata: {},
            expiresAt: new Date('2027-01-01T00:00:00.000Z'),
          }),
          update: async (args: { readonly data: Record<string, unknown> }) => {
            updates.push(args);
            return {
              id: 'session-1',
              userId: 'user-1',
              subscriptionId: 'sub-1',
              profileId: 'profile-1',
              provider: 'JITSI',
              transport: 'VP8CHANNEL',
              cryptoKeyEnc: encryptedCryptoKey,
              subscriptionUri: 'olcrtc://jitsi?vp8channel@room#key$name',
              expiresAt: new Date('2027-01-01T00:00:00.000Z'),
              ...args.data,
            };
          },
        },
        olcRoom: {
          findFirst: async () => ({
            id: 'room-1',
            externalRoomId: 'https://meet.jit.si/rezeis-room',
            externalUrl: 'https://meet.jit.si/rezeis-room',
          }),
        },
      } as never,
      APP_CONFIG,
      OLC_ENABLED,
    );

    const claim = await service.claimAgentSession({ gatewayName: 'agent-a' });

    assert.equal(claim?.sessionId, 'session-1');
    assert.equal(claim?.cryptoKey, 'session-crypto-key');
    assert.equal(claim?.provider, 'jitsi');
    assert.equal(claim?.transport, 'vp8channel');
    assert.equal((claim?.room as { readonly externalRoomId: string }).externalRoomId, 'https://meet.jit.si/rezeis-room');
    assert.equal(updates.length, 1);
  });

  it('upserts gateway heartbeat as active and stores health snapshot', async () => {
    let upsertArgs: unknown;
    const service = new OlcrtcProvisioningService(
      {
        olcGateway: {
          upsert: async (args: unknown) => {
            upsertArgs = args;
            return { id: 'gateway-1' };
          },
        },
      } as never,
      APP_CONFIG,
      OLC_ENABLED,
    );

    await service.recordGatewayHeartbeat({
      name: 'agent-a',
      managementUrl: 'http://agent-a:9090',
      version: '0.1.0',
      capacity: 100,
      activeSessions: 7,
      health: { ok: true },
      metadata: { region: 'eu' },
    });

    assert.deepEqual(
      normalizeDynamicDates(upsertArgs),
      {
        where: { name: 'agent-a' },
        create: {
          name: 'agent-a',
          managementUrl: 'http://agent-a:9090',
          status: 'ACTIVE',
          capacity: 100,
          activeSessions: 7,
          version: '0.1.0',
          lastSeenAt: '<date>',
          health: { ok: true },
          metadata: { region: 'eu' },
        },
        update: {
          managementUrl: 'http://agent-a:9090',
          status: 'ACTIVE',
          capacity: 100,
          activeSessions: 7,
          version: '0.1.0',
          lastSeenAt: '<date>',
          health: { ok: true },
          metadata: { region: 'eu' },
        },
      },
    );
  });

  it('reports agent session status and merges metadata', async () => {
    let updateArgs: { readonly data: Record<string, unknown> } | undefined;
    const service = new OlcrtcProvisioningService(
      {
        olcSession: {
          findFirst: async () => ({
            id: 'session-1',
            agentSessionId: 'agent-session-1',
            metadata: { claimedBy: 'agent-a' },
            stoppedAt: null,
          }),
          update: async (args: { readonly data: Record<string, unknown> }) => {
            updateArgs = args;
            return { id: 'session-1', ...args.data };
          },
        },
      } as never,
      APP_CONFIG,
      OLC_ENABLED,
    );

    await service.reportAgentSession('session-1', {
      status: 'FAILED',
      lastError: 'publisher exited',
      metadata: { exitCode: 1 },
    });

    assert.equal(updateArgs?.data.status, 'FAILED');
    assert.equal(updateArgs?.data.agentSessionId, 'agent-session-1');
    assert.equal(updateArgs?.data.lastError, 'publisher exited');
    assert.deepEqual(updateArgs?.data.metadata, { claimedBy: 'agent-a', exitCode: 1 });
    assert.ok(updateArgs?.data.lastSeenAt instanceof Date);
    assert.ok(updateArgs?.data.stoppedAt instanceof Date);
  });

  it('records traffic with idempotency upsert and returns JSON-safe byte strings', async () => {
    let upsertArgs: unknown;
    const service = new OlcrtcProvisioningService(
      {
        olcTrafficLedger: {
          upsert: async (args: unknown) => {
            upsertArgs = args;
            return {
              id: 'ledger-1',
              sessionId: 'session-1',
              rxBytes: 123n,
              txBytes: 456n,
              source: 'agent-a',
              observedAt: new Date('2027-01-01T00:00:00.000Z'),
              idempotencyKey: 'idem-1',
            };
          },
        },
      } as never,
      APP_CONFIG,
      OLC_ENABLED,
    );

    const result = await service.recordTraffic('session-1', {
      rxBytes: '123',
      txBytes: '456',
      source: 'agent-a',
      idempotencyKey: 'idem-1',
      observedAt: '2027-01-01T00:00:00.000Z',
      metadata: { intervalSeconds: 60 },
    });

    assert.deepEqual(result, {
      id: 'ledger-1',
      sessionId: 'session-1',
      rxBytes: '123',
      txBytes: '456',
      source: 'agent-a',
      observedAt: '2027-01-01T00:00:00.000Z',
      idempotencyKey: 'idem-1',
    });
    assert.deepEqual(normalizeDynamicDates(upsertArgs), {
      where: { idempotencyKey: 'idem-1' },
      create: {
        sessionId: 'session-1',
        rxBytes: 123n,
        txBytes: 456n,
        source: 'agent-a',
        observedAt: '<date>',
        idempotencyKey: 'idem-1',
        metadata: { intervalSeconds: 60 },
      },
      update: {},
    });
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
