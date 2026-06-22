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
