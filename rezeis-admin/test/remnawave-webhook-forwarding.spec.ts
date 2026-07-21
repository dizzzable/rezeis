import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RemnawaveWebhookService } from '../src/modules/remnawave/services/remnawave-webhook.service';

/**
 * Remnawave webhook → system-event forwarding
 * ───────────────────────────────────────────
 * Only curated event names become system events (Telegram cards); noisy/unknown
 * names are stored in the activity feed only. Node-down maps to NODE + ERROR.
 */

interface EmittedEvent {
  type: string;
  category: string;
  severity: string;
  metadata?: Record<string, unknown>;
}

interface ReconcileCall {
  where: Record<string, unknown>;
  data: Record<string, unknown>;
}

function buildService(): {
  service: RemnawaveWebhookService;
  stored: string[];
  emitted: EmittedEvent[];
  reconciled: ReconcileCall[];
} {
  const stored: string[] = [];
  const emitted: EmittedEvent[] = [];
  const reconciled: ReconcileCall[] = [];

  const prisma = {
    remnawaveWebhookEvent: {
      create: async (args: { data: { eventType: string } }) => {
        stored.push(args.data.eventType);
        return {};
      },
    },
    subscription: {
      updateMany: async (args: ReconcileCall) => {
        reconciled.push(args);
        return { count: 1 };
      },
    },
  };
  const config = { webhookSecret: null };
  const systemEvents = {
    emit: (event: EmittedEvent) => {
      emitted.push(event);
    },
  };

  const service = new RemnawaveWebhookService(
    prisma as never,
    config as never,
    systemEvents as never,
  );
  return { service, stored, emitted, reconciled };
}

describe('RemnawaveWebhookService forwarding', () => {
  it('forwards a mapped user.expired event with remnawave metadata', async () => {
    const { service, stored, emitted } = buildService();
    await service.handleEvent(
      'user.expired',
      { event: 'user.expired', data: { username: 'anna_vpn', uuid: 'uuid-1', telegramId: 858568447 } },
      null,
    );
    assert.deepEqual(stored, ['user.expired']);
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0]!.category, 'REMNAWAVE');
    assert.equal(emitted[0]!.severity, 'WARNING');
    assert.equal(emitted[0]!.metadata?.['remnawaveUsername'], 'anna_vpn');
    assert.equal(emitted[0]!.metadata?.['remnawaveId'], 'uuid-1');
    assert.equal(emitted[0]!.metadata?.['telegramId'], '858568447');
  });

  it('maps node-down (both spellings) to NODE + WARNING', async () => {
    for (const name of ['node.connection_lost', 'node.offline', 'NODE_CONNECTION_LOST']) {
      const { service, emitted } = buildService();
      await service.handleEvent(name, { data: { name: 'DE-1', countryCode: 'DE' } }, null);
      assert.equal(emitted.length, 1, `expected emit for ${name}`);
      assert.equal(emitted[0]!.category, 'NODE');
      assert.equal(emitted[0]!.severity, 'WARNING');
      assert.equal(emitted[0]!.metadata?.['nodeName'], 'DE-1');
    }
  });

  it('stores but does NOT forward noisy/unknown events', async () => {
    const { service, stored, emitted } = buildService();
    for (const name of ['user.online', 'user.created', 'user.updated', 'totally.unknown']) {
      await service.handleEvent(name, { data: {} }, null);
    }
    assert.equal(stored.length, 4);
    assert.equal(emitted.length, 0);
  });
});

describe('RemnawaveWebhookService reconcile (panel → rezeis)', () => {
  it('overlays status + expiry + limits onto the matching subscription on user.modified', async () => {
    const { service, reconciled } = buildService();
    await service.handleEvent(
      'user.modified',
      {
        data: {
          uuid: 'uuid-1',
          status: 'DISABLED',
          expireAt: '2027-01-01T00:00:00.000Z',
          trafficLimitBytes: 0,
          hwidDeviceLimit: 3,
        },
      },
      null,
    );
    assert.equal(reconciled.length, 1);
    assert.equal(reconciled[0]!.where['remnawaveId'], 'uuid-1');
    assert.equal(reconciled[0]!.data['status'], 'DISABLED');
    assert.equal(reconciled[0]!.data['deviceLimit'], 3);
    // 0 bytes (panel "unlimited") → null (local "unlimited").
    assert.equal(reconciled[0]!.data['trafficLimit'], null);
    assert.ok(reconciled[0]!.data['expiresAt'] instanceof Date);
  });

  it('converts a positive byte cap to GB', async () => {
    const { service, reconciled } = buildService();
    await service.handleEvent(
      'user.modified',
      { data: { uuid: 'uuid-2', trafficLimitBytes: 50 * 1024 ** 3 } },
      null,
    );
    assert.equal(reconciled.length, 1);
    assert.equal(reconciled[0]!.data['trafficLimit'], 50);
  });

  it('derives status from the event name when the payload omits it', async () => {
    const { service, reconciled } = buildService();
    await service.handleEvent('user.expired', { data: { uuid: 'uuid-3' } }, null);
    assert.equal(reconciled.length, 1);
    assert.equal(reconciled[0]!.data['status'], 'EXPIRED');
  });

  it('skips reconcile when the payload carries no user uuid', async () => {
    const { service, reconciled } = buildService();
    await service.handleEvent('user.modified', { data: { status: 'ACTIVE' } }, null);
    assert.equal(reconciled.length, 0);
  });
});
describe('RemnawaveWebhookService first traffic usage', () => {
  function buildTrafficService(options?: {
    readonly subscription?: Record<string, unknown> | null;
    readonly userByTelegram?: Record<string, unknown> | null;
  }) {
    const emitted: EmittedEvent[] = [];
    let firstTrafficClaimed = false;
    let firstTrafficUpdates = 0;
    const claimWheres: Array<Record<string, unknown>> = [];
    const prisma = {
      remnawaveWebhookEvent: { create: async () => ({}) },
      subscription: {
        updateMany: async () => ({ count: 0 }),
        findFirst: async () =>
          options && 'subscription' in options
            ? options.subscription
            : {
                id: 'sub-1',
                status: 'ACTIVE',
                trafficLimit: 50,
                deviceLimit: 3,
                expiresAt: new Date('2027-01-01T00:00:00.000Z'),
                user: { id: 'user-1', telegramId: 858568447n, name: 'Anna', username: 'anna' },
              },
      },
      user: {
        updateMany: async (args: { where: Record<string, unknown> }) => {
          firstTrafficUpdates += 1;
          claimWheres.push(args.where);
          // Simulate atomic claim: only one concurrent winner gets count=1.
          if (firstTrafficClaimed) return { count: 0 };
          firstTrafficClaimed = true;
          return { count: 1 };
        },
        findUnique: async () => options?.userByTelegram ?? null,
      },
    };
    const systemEvents = {
      emit: (event: EmittedEvent) => emitted.push(event),
      info: (type: string, category: string, _message: string, metadata?: Record<string, unknown>) => {
        emitted.push({ type, category, severity: 'INFO', metadata });
      },
    };
    return {
      service: new RemnawaveWebhookService(prisma as never, { webhookSecret: null } as never, systemEvents as never),
      emitted,
      getFirstTrafficUpdates: () => firstTrafficUpdates,
      claimWheres,
    };
  }

  it('emits a USER card only once after traffic becomes positive', async () => {
    const { service, emitted, getFirstTrafficUpdates, claimWheres } = buildTrafficService();
    const payload = { data: { uuid: 'uuid-traffic-1', username: 'anna_vpn', usedTrafficBytes: 1_024, trafficLimitBytes: 50 * 1024 ** 3 } };
    await service.handleEvent('user.modified', payload, null);
    await service.handleEvent('user.modified', payload, null);
    const firstTrafficEvents = emitted.filter((event) => event.type === 'user.first_traffic');
    assert.equal(firstTrafficEvents.length, 1);
    assert.equal(firstTrafficEvents[0]?.category, 'USER');
    assert.equal(firstTrafficEvents[0]?.metadata?.['userId'], 'user-1');
    assert.equal(firstTrafficEvents[0]?.metadata?.['subscriptionId'], 'sub-1');
    assert.equal(firstTrafficEvents[0]?.metadata?.['usedTrafficBytes'], 1_024);
    assert.equal(getFirstTrafficUpdates(), 2);
    assert.deepEqual(claimWheres[0], { id: 'user-1', firstTrafficAt: null });
  });

  it('accepts string usedTraffic values from panel JSON', async () => {
    // Real Remnawave webhooks are JSON — counters often arrive as strings.
    // BigInt is not JSON-serializable and never reaches handleEvent storage.
    const { service, emitted } = buildTrafficService();
    await service.handleEvent('user.modified', {
      data: { uuid: 'uuid-traffic-str', usedTrafficBytes: '2048', trafficLimitBytes: '107374182400' },
    }, null);
    const events = emitted.filter((event) => event.type === 'user.first_traffic');
    assert.equal(events.length, 1);
    assert.equal(events[0]?.metadata?.['usedTrafficBytes'], 2048);
    assert.equal(events[0]?.metadata?.['trafficLimitBytes'], 107374182400);
  });

  it('emits only once under concurrent webhooks racing the claim', async () => {
    const { service, emitted, getFirstTrafficUpdates } = buildTrafficService();
    const payload = { data: { uuid: 'uuid-race', usedTrafficBytes: 500 } };
    await Promise.all([
      service.handleEvent('user.modified', payload, null),
      service.handleEvent('user.modified', payload, null),
      service.handleEvent('user.modified', payload, null),
    ]);
    assert.equal(emitted.filter((event) => event.type === 'user.first_traffic').length, 1);
    assert.equal(getFirstTrafficUpdates(), 3);
  });

  it('does not claim or emit first traffic for zero usage', async () => {
    const { service, emitted, getFirstTrafficUpdates } = buildTrafficService();
    await service.handleEvent('user.modified', { data: { uuid: 'uuid-traffic-0', usedTraffic: 0 } }, null);
    assert.equal(emitted.filter((event) => event.type === 'user.first_traffic').length, 0);
    assert.equal(getFirstTrafficUpdates(), 0);
  });

  it('does not emit when local user cannot be resolved', async () => {
    const { service, emitted, getFirstTrafficUpdates } = buildTrafficService({
      subscription: null,
      userByTelegram: null,
    });
    await service.handleEvent('user.modified', {
      data: { uuid: 'unknown-uuid', usedTrafficBytes: 999 },
    }, null);
    assert.equal(emitted.filter((event) => event.type === 'user.first_traffic').length, 0);
    assert.equal(getFirstTrafficUpdates(), 0);
  });
});
