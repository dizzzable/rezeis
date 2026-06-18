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

function buildService(): { service: RemnawaveWebhookService; stored: string[]; emitted: EmittedEvent[] } {
  const stored: string[] = [];
  const emitted: EmittedEvent[] = [];

  const prisma = {
    remnawaveWebhookEvent: {
      create: async (args: { data: { eventType: string } }) => {
        stored.push(args.data.eventType);
        return {};
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
  return { service, stored, emitted };
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
