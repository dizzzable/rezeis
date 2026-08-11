import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { OlcrtcAdminService } from '../src/modules/olcrtc/olcrtc-admin.service';
import { decryptOlcrtcSecret } from '../src/modules/olcrtc/utils/olcrtc-secret-cipher';

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

describe('OlcrtcAdminService', () => {
  it('returns overview without provider credentials or session crypto keys', async () => {
    const calls: Array<{ delegate: string; method: string; args?: unknown }> = [];
    const delegate = (name: string, rows: readonly Record<string, unknown>[], count = 0) => ({
      findMany: async (args: unknown) => {
        calls.push({ delegate: name, method: 'findMany', args });
        return rows;
      },
      count: async (args?: unknown) => {
        calls.push({ delegate: name, method: 'count', args });
        return count;
      },
    });
    const service = new OlcrtcAdminService(
      {
        olcProviderAccount: delegate('olcProviderAccount', [{ id: 'account-1', credentialHint: 'Session_id: abc...' }], 1),
        olcProfile: delegate('olcProfile', [{ id: 'profile-1' }], 1),
        olcGateway: delegate('olcGateway', [{ id: 'gateway-1' }], 2),
        olcRoom: delegate('olcRoom', [{ id: 'room-1' }], 3),
        olcSession: delegate('olcSession', [{ id: 'session-1' }], 4),
        olcTrafficLedger: delegate('olcTrafficLedger', [], 5),
      } as never,
      { runOnce: async () => ({ staleGateways: 0, expiredSessions: 0, stuckSessions: 0, expiredRooms: 0 }) } as never,
      APP_CONFIG,
    );

    const overview = await service.getOverview();

    assert.deepEqual(overview.providerAccounts, [{ id: 'account-1', credentialHint: 'Session_id: abc...' }]);
    assert.deepEqual(overview.profiles, [{ id: 'profile-1' }]);
    assert.equal(overview.counts.trafficLedger, 5);
    const accountList = calls.find((call) => call.delegate === 'olcProviderAccount' && call.method === 'findMany');
    const sessionList = calls.find((call) => call.delegate === 'olcSession' && call.method === 'findMany');
    assert.equal(JSON.stringify(accountList?.args).includes('credentialsEnc'), false);
    assert.equal(JSON.stringify(sessionList?.args).includes('cryptoKeyEnc'), false);
    assert.equal(JSON.stringify(sessionList?.args).includes('cryptoKeyFingerprint'), false);
  });

  it('delegates manual lifecycle runs', async () => {
    let runs = 0;
    const service = new OlcrtcAdminService(
      {} as never,
      {
        runOnce: async () => {
          runs += 1;
          return { staleGateways: 1, expiredSessions: 2, stuckSessions: 3, expiredRooms: 4 };
        },
      } as never,
      APP_CONFIG,
    );

    const result = await service.runLifecycleOnce();

    assert.equal(runs, 1);
    assert.deepEqual(result, { staleGateways: 1, expiredSessions: 2, stuckSessions: 3, expiredRooms: 4 });
  });

  it('creates provider accounts with encrypted credentials and safe select', async () => {
    let createArgs: { data: { credentialHint?: string | null; credentialsEnc?: string }; select?: Record<string, boolean> } | undefined;
    const service = new OlcrtcAdminService(
      {
        olcProviderAccount: {
          create: async (args: { data: { credentialHint?: string | null; credentialsEnc?: string }; select?: Record<string, boolean> }) => {
            createArgs = args;
            return { id: 'account-1' };
          },
          update: async () => ({ id: 'account-1' }),
        },
      } as never,
      { runOnce: async () => ({ staleGateways: 0, expiredSessions: 0, stuckSessions: 0, expiredRooms: 0 }) } as never,
      APP_CONFIG,
    );

    await service.createProviderAccount({
      provider: 'TELEMOST',
      name: 'Telemost ops',
      credentials: { sessionId: 'secret-session' },
      metadata: { owner: 'ops' },
    });

    assert.ok(createArgs?.data.credentialsEnc);
    assert.notEqual(createArgs.data.credentialsEnc, JSON.stringify({ sessionId: 'secret-session' }));
    assert.equal(decryptOlcrtcSecret(createArgs.data.credentialsEnc, 'test-crypt-key'), '{"sessionId":"secret-session"}');
    assert.equal(createArgs.data.credentialHint, 'keys:sessionId');
    assert.equal(createArgs.select?.credentialsEnc, undefined);
  });

  it('updates provider accounts without touching credentials unless supplied', async () => {
    const updates: unknown[] = [];
    const service = new OlcrtcAdminService(
      {
        olcProviderAccount: {
          create: async () => ({ id: 'account-1' }),
          update: async (args: unknown) => {
            updates.push(args);
            return { id: 'account-1' };
          },
        },
      } as never,
      { runOnce: async () => ({ staleGateways: 0, expiredSessions: 0, stuckSessions: 0, expiredRooms: 0 }) } as never,
      APP_CONFIG,
    );

    await service.updateProviderAccount('account-1', { name: 'Renamed' });
    await service.updateProviderAccount('account-1', { credentials: null });

    assert.deepEqual(updates[0], {
      where: { id: 'account-1' },
      data: { name: 'Renamed' },
      select: {
        id: true,
        provider: true,
        name: true,
        credentialHint: true,
        isEnabled: true,
        lastValidatedAt: true,
        lastValidationError: true,
        metadata: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    assert.deepEqual(updates[1], {
      where: { id: 'account-1' },
      data: { credentialsEnc: null, credentialHint: null },
      select: {
        id: true,
        provider: true,
        name: true,
        credentialHint: true,
        isEnabled: true,
        lastValidatedAt: true,
        lastValidationError: true,
        metadata: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  });

  it('creates profiles with safe defaults for optional operator fields', async () => {
    let createArgs: unknown;
    const service = new OlcrtcAdminService(
      {
        olcProfile: {
          create: async (args: unknown) => {
            createArgs = args;
            return { id: 'profile-1' };
          },
          update: async () => ({ id: 'profile-1' }),
        },
      } as never,
      { runOnce: async () => ({ staleGateways: 0, expiredSessions: 0, stuckSessions: 0, expiredRooms: 0 }) } as never,
      APP_CONFIG,
    );

    await service.createProfile({
      name: 'Jitsi fallback',
      provider: 'JITSI',
      transport: 'VP8CHANNEL',
      roomTemplate: 'https://meet.jit.si/rezeis-{random}',
    });

    assert.deepEqual(createArgs, {
      data: {
        name: 'Jitsi fallback',
        provider: 'JITSI',
        transport: 'VP8CHANNEL',
        providerAccountId: null,
        roomTemplate: 'https://meet.jit.si/rezeis-{random}',
        transportOptions: {},
        priority: 100,
        isEnabled: true,
        metadata: {},
      },
    });
  });

  it('updates profiles with only explicitly supplied fields', async () => {
    let updateArgs: unknown;
    const service = new OlcrtcAdminService(
      {
        olcProfile: {
          create: async () => ({ id: 'profile-1' }),
          update: async (args: unknown) => {
            updateArgs = args;
            return { id: 'profile-1' };
          },
        },
      } as never,
      { runOnce: async () => ({ staleGateways: 0, expiredSessions: 0, stuckSessions: 0, expiredRooms: 0 }) } as never,
      APP_CONFIG,
    );

    await service.updateProfile('profile-1', {
      priority: 10,
      isEnabled: false,
      transportOptions: { fps: 12 },
    });

    assert.deepEqual(updateArgs, {
      where: { id: 'profile-1' },
      data: { priority: 10, isEnabled: false, transportOptions: { fps: 12 } },
    });
  });

  it('updates gateways with operator-controlled fields only', async () => {
    let updateArgs: unknown;
    const service = new OlcrtcAdminService(
      {
        olcGateway: {
          create: async () => ({ id: 'gateway-1' }),
          update: async (args: unknown) => {
            updateArgs = args;
            return { id: 'gateway-1' };
          },
        },
      } as never,
      { runOnce: async () => ({ staleGateways: 0, expiredSessions: 0, stuckSessions: 0, expiredRooms: 0 }) } as never,
      APP_CONFIG,
    );

    await service.updateGateway('gateway-1', {
      status: 'DRAINING',
      capacity: 25,
      health: { operator: 'draining for deploy' },
    });

    assert.deepEqual(updateArgs, {
      where: { id: 'gateway-1' },
      data: {
        status: 'DRAINING',
        capacity: 25,
        health: { operator: 'draining for deploy' },
      },
    });
  });

  it('updates rooms with lease release and timestamp conversion', async () => {
    let updateArgs: unknown;
    const service = new OlcrtcAdminService(
      {
        olcRoom: {
          create: async () => ({ id: 'room-1' }),
          update: async (args: unknown) => {
            updateArgs = args;
            return { id: 'room-1' };
          },
        },
      } as never,
      { runOnce: async () => ({ staleGateways: 0, expiredSessions: 0, stuckSessions: 0, expiredRooms: 0 }) } as never,
      APP_CONFIG,
    );

    await service.updateRoom('room-1', {
      status: 'INVALID',
      leaseSessionId: null,
      expiresAt: '2027-01-01T00:00:00.000Z',
      lastVerifiedAt: null,
      metadata: { operatorReason: 'provider room closed' },
    });

    assert.deepEqual(normalizeDynamicDates(updateArgs), {
      where: { id: 'room-1' },
      data: {
        status: 'INVALID',
        leaseSessionId: null,
        expiresAt: '<date>',
        lastVerifiedAt: null,
        metadata: { operatorReason: 'provider room closed' },
      },
    });
  });

  it('updates sessions and stamps stoppedAt for terminal operator statuses', async () => {
    let updateArgs: unknown;
    const service = new OlcrtcAdminService(
      {
        olcSession: {
          create: async () => ({ id: 'session-1' }),
          update: async (args: unknown) => {
            updateArgs = args;
            return { id: 'session-1' };
          },
        },
      } as never,
      { runOnce: async () => ({ staleGateways: 0, expiredSessions: 0, stuckSessions: 0, expiredRooms: 0 }) } as never,
      APP_CONFIG,
    );

    await service.updateSession('session-1', {
      status: 'FAILED',
      lastError: 'operator stopped stuck publisher',
      expiresAt: null,
      metadata: { operatorAction: 'force-failed' },
    });

    assert.deepEqual(normalizeDynamicDates(updateArgs), {
      where: { id: 'session-1' },
      data: {
        status: 'FAILED',
        lastError: 'operator stopped stuck publisher',
        expiresAt: null,
        metadata: { operatorAction: 'force-failed' },
        stoppedAt: '<date>',
      },
    });
  });

  it('lists traffic ledger with JSON-safe byte strings', async () => {
    const findManyArgs: unknown[] = [];
    const service = new OlcrtcAdminService(
      {
        olcTrafficLedger: {
          findMany: async (args: unknown) => {
            findManyArgs.push(args);
            return [
              {
                id: 'ledger-1',
                sessionId: 'session-1',
                rxBytes: 123n,
                txBytes: 456n,
                source: 'agent-a',
                observedAt: new Date('2027-01-01T00:00:00.000Z'),
                idempotencyKey: findManyArgs.length === 1 ? 'idem-1' : null,
                metadata: findManyArgs.length === 1 ? { intervalSeconds: 60 } : null,
                createdAt: new Date('2027-01-01T00:00:01.000Z'),
              },
            ];
          },
          count: async () => 1,
        },
      } as never,
      { runOnce: async () => ({ staleGateways: 0, expiredSessions: 0, stuckSessions: 0, expiredRooms: 0 }) } as never,
      APP_CONFIG,
    );

    const result = await service.listTrafficLedger({ sessionId: 'session-1', take: 10 });
    const defaultResult = await service.listTrafficLedger({});

    assert.deepEqual(findManyArgs[0], {
      where: { sessionId: 'session-1' },
      orderBy: { observedAt: 'desc' },
      take: 10,
    });
    assert.deepEqual(findManyArgs[1], {
      where: {},
      orderBy: { observedAt: 'desc' },
      take: 100,
    });
    assert.deepEqual(result, {
      items: [
        {
          id: 'ledger-1',
          sessionId: 'session-1',
          rxBytes: '123',
          txBytes: '456',
          source: 'agent-a',
          observedAt: '2027-01-01T00:00:00.000Z',
          idempotencyKey: 'idem-1',
          metadata: { intervalSeconds: 60 },
          createdAt: '2027-01-01T00:00:01.000Z',
        },
      ],
    });
    assert.deepEqual(defaultResult.items[0]?.metadata, {});
    assert.equal(defaultResult.items[0]?.idempotencyKey, null);
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
