import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';

import { RemnawaveWebhookController } from '../src/modules/remnawave/controllers/admin-remnawave.controller';
import { RemnawaveWebhookService } from '../src/modules/remnawave/services/remnawave-webhook.service';

/**
 * Remnawave webhook receiver.
 *
 * The Activity Feed only fills when inbound panel webhooks pass HMAC
 * verification. The signature MUST be checked over the exact raw bytes the
 * panel signed — re-serialising the parsed body can reorder keys / change
 * spacing and break the HMAC, silently dropping every event.
 */

function buildService(webhookSecret: string | null): RemnawaveWebhookService {
  const prisma = {
    remnawaveWebhookEvent: { create: async () => undefined },
    subscription: { updateMany: async () => ({ count: 0 }) },
  };
  const systemEvents = { emit: () => undefined };
  return new RemnawaveWebhookService(prisma as never, { webhookSecret } as never, systemEvents as never);
}

describe('RemnawaveWebhookService.validateSignature', () => {
  it('accepts a correct HMAC-SHA256 over the raw body', () => {
    const service = buildService('panel-secret');
    const rawBody = '{"event":"user.created","data":{"id":1}}';
    const signature = createHmac('sha256', 'panel-secret').update(rawBody).digest('hex');
    assert.equal(service.validateSignature(rawBody, signature), true);
  });

  it('rejects a wrong signature', () => {
    const service = buildService('panel-secret');
    assert.equal(service.validateSignature('{"event":"x"}', 'deadbeef'), false);
  });

  it('rejects when a secret is configured but no signature is sent', () => {
    const service = buildService('panel-secret');
    assert.equal(service.validateSignature('{"event":"x"}', undefined), false);
  });

  it('accepts everything in open mode (no secret configured)', () => {
    const service = buildService(null);
    assert.equal(service.validateSignature('{"event":"x"}', undefined), true);
  });
});

describe('RemnawaveWebhookController.handleWebhook', () => {
  interface Recorded {
    rawBody?: string;
    eventType?: string;
  }

  function buildController(recorded: Recorded, accept: boolean): RemnawaveWebhookController {
    const service = {
      validateSignature: (rawBody: string) => {
        recorded.rawBody = rawBody;
        return accept;
      },
      logRejectedSignature: () => undefined,
      handleEvent: async (eventType: string) => {
        recorded.eventType = eventType;
      },
    } as unknown as RemnawaveWebhookService;
    return new RemnawaveWebhookController(service);
  }

  it('verifies the signature over req.rawBody, not the re-serialised body', async () => {
    const recorded: Recorded = {};
    const controller = buildController(recorded, true);
    // Raw bytes the panel signed: compact, specific key order.
    const raw = '{"event":"node.connection_lost","timestamp":"2026-01-01T00:00:00Z","data":{"uuid":"n1"}}';
    const req = {
      headers: { 'x-remnawave-signature': 'sig' },
      rawBody: Buffer.from(raw, 'utf8'),
      ip: '10.0.0.1',
      // A parsed body whose JSON.stringify would differ from `raw` (reordered).
    } as never;
    const body = { data: { uuid: 'n1' }, event: 'node.connection_lost', timestamp: '2026-01-01T00:00:00Z' };

    const res = await controller.handleWebhook(req, body);
    assert.equal(res.ok, true);
    assert.equal(recorded.rawBody, raw);
    assert.equal(recorded.eventType, 'node.connection_lost');
  });

  it('returns ok:false and does not store when the signature is rejected', async () => {
    const recorded: Recorded = {};
    const controller = buildController(recorded, false);
    const req = {
      headers: {},
      rawBody: Buffer.from('{}', 'utf8'),
      ip: '10.0.0.1',
    } as never;

    const res = await controller.handleWebhook(req, {});
    assert.equal(res.ok, false);
    assert.equal(recorded.eventType, undefined);
  });
});
