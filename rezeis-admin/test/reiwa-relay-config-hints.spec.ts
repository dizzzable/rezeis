import 'reflect-metadata';

import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import { GLOBAL_MODULE_METADATA, OPTIONAL_DEPS_METADATA, SELF_DECLARED_DEPS_METADATA } from '@nestjs/common/constants';

import { BotConfigModule } from '../src/modules/bot-config/bot-config.module';
import { ConfigVersionsModule } from '../src/modules/bot-config/config-versions/config-versions.module';
import {
  CONFIG_DELIVERY_TRACKER,
  HINT_GROUPS,
  type ConfigDeliveryTracker,
  type ConfigHintEvent,
} from '../src/modules/bot-config/config-versions/config-versions.constants';
import { ReiwaCacheInvalidatorService } from '../src/modules/bot-config/services/reiwa-cache-invalidator.service';
import type { ReiwaRelayEvent } from '../src/modules/notifications/reiwa-relay.constants';
import { ReiwaRelayModule } from '../src/modules/notifications/reiwa-relay.module';
import { emitRelayUndelivered, ReiwaRelayProcessor } from '../src/modules/notifications/reiwa-relay.processor';
import type { NotifyDeliveryResult } from '../src/modules/notifications/services/bot-notifier.client';
import { RELAY_UNDELIVERED_RECORDER } from '../src/modules/notifications/undelivered-record';

/**
 * Cache hints and the settings delivery check
 * ═══════════════════════════════════════════
 * A cache hint that ran out of attempts used to raise a card on the spot. The
 * owner's rule replaced that (24.09.2026): a card only when, two minutes after
 * the save, the cabinet still does not hold it — the delivery check decides
 * (`config-delivery-check.service.ts`). What is pinned here is the wiring that
 * rule depends on: every hint reaches the check, the relay reports how each
 * hint ended instead of carding it, and nothing else on the relay changed.
 */

function outcome(status: NotifyDeliveryResult['status'], extra: Partial<NotifyDeliveryResult> = {}): NotifyDeliveryResult {
  return { status, messageId: null, httpStatus: null, detail: null, ...extra };
}

function recordingTracker() {
  const sent: Array<{ event: ConfigHintEvent; reason: string }> = [];
  const settled: Array<{ event: ConfigHintEvent; delivered: boolean; status: string }> = [];
  const tracker: ConfigDeliveryTracker = {
    hintSent: async (event, reason) => {
      sent.push({ event, reason });
    },
    hintSettled: async (event, delivered, status) => {
      settled.push({ event, delivered, status });
    },
  };
  return { tracker, sent, settled };
}

function processor(result: NotifyDeliveryResult, tracker?: ConfigDeliveryTracker) {
  const emitted: Array<{ type: string; metadata?: Record<string, unknown> }> = [];
  const relay = new ReiwaRelayProcessor(
    { deliverRelayEvent: async () => result } as never,
    (record) =>
      emitRelayUndelivered(
        {
          warn: (type: string, _category: string, _message: string, metadata?: Record<string, unknown>) => {
            emitted.push({ type, metadata });
          },
        },
        record,
      ),
    { broadcast: { updateMany: async () => ({ count: 0 }) } } as never,
    tracker,
  );
  return { relay, emitted };
}

function job(event: ReiwaRelayEvent, attemptsMade: number, attempts: number) {
  return { id: 'job-1', data: { event, metadata: { reason: 'operator-save' } }, attemptsMade, opts: { attempts } } as never;
}

describe('the relay and a cache hint', () => {
  it('a hint out of attempts raises no card of its own; its outcome goes to the delivery check', async () => {
    for (const event of Object.keys(HINT_GROUPS) as ConfigHintEvent[]) {
      const { tracker, settled } = recordingTracker();
      const { relay, emitted } = processor(outcome('timeout'), tracker);

      // Out of attempts, it still fails: the retained failed set keeps it.
      await assert.rejects(() => relay.process(job(event, 1, 2)));

      assert.deepEqual(emitted, [], `${event}: the check decides, two minutes after the save`);
      assert.deepEqual(settled, [{ event, delivered: false, status: 'timeout' }]);
    }
  });

  it('a delivered hint is reported delivered', async () => {
    const { tracker, settled } = recordingTracker();
    const { relay, emitted } = processor(outcome('unconfirmed', { httpStatus: 204 }), tracker);

    const done = await relay.process(job('reiwa.branding.invalidate', 0, 2));

    assert.equal(done.delivered, true);
    assert.deepEqual(settled, [{ event: 'reiwa.branding.invalidate', delivered: true, status: 'unconfirmed' }]);
    assert.deepEqual(emitted, []);
  });

  it('a hint with attempts left is retried, and reports nothing yet', async () => {
    const { tracker, settled } = recordingTracker();
    const { relay } = processor(outcome('timeout'), tracker);
    await assert.rejects(() => relay.process(job('reiwa.landing.invalidate', 0, 2)));
    assert.deepEqual(settled, []);
  });

  it('without the check wired in, the hint cards the old way', async () => {
    const { relay, emitted } = processor(outcome('timeout'));
    await assert.rejects(() => relay.process(job('reiwa.bot.invalidate', 1, 2)));
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0]?.type, 'reiwa.relay_undelivered');
  });

  it('every other relay still cards as it did — the check is about settings only', async () => {
    const { tracker, settled } = recordingTracker();
    const { relay, emitted } = processor(outcome('timeout'), tracker);
    await assert.rejects(() => relay.process(job('reiwa.dev.notify', 3, 4)));
    assert.equal(emitted.length, 1);
    assert.deepEqual(settled, []);
  });
});

describe('the invalidator tells the check about every hint', () => {
  const env = { url: process.env['REIWA_URL'], secret: process.env['WEBHOOK_SECRET_HEADER'] };

  afterEach(() => {
    mock.restoreAll();
    if (env.url === undefined) delete process.env['REIWA_URL'];
    else process.env['REIWA_URL'] = env.url;
    if (env.secret === undefined) delete process.env['WEBHOOK_SECRET_HEADER'];
    else process.env['WEBHOOK_SECRET_HEADER'] = env.secret;
  });

  function invalidator(tracker?: ConfigDeliveryTracker) {
    const order: string[] = [];
    const queue = {
      enqueue: async (event: string, metadata: Record<string, unknown>) => {
        order.push(`enqueue ${event} ${String(metadata['reason'])}`);
        return true;
      },
    };
    const wrapped: ConfigDeliveryTracker | undefined =
      tracker === undefined
        ? undefined
        : {
            hintSent: async (event, reason) => {
              order.push(`hintSent ${event}`);
              await tracker.hintSent(event, reason);
            },
            hintSettled: tracker.hintSettled,
          };
    return { service: new ReiwaCacheInvalidatorService(queue as never, wrapped), order };
  }

  it('each hint goes to the relay and to the check — the check first, so the versions are busted before the hint', async () => {
    const { tracker, sent } = recordingTracker();
    const { service, order } = invalidator(tracker);

    await service.invalidate('bot-config.buttons');
    await service.invalidatePolicy('platform.accessMode');
    await service.invalidateBranding('branding.primary');
    await service.invalidateLanding('publish');
    await service.invalidateConnectPage('connect-page catalog saved');

    assert.deepEqual(sent, [
      { event: 'reiwa.bot.invalidate', reason: 'bot-config.buttons' },
      { event: 'reiwa.platform.policy_invalidated', reason: 'platform.accessMode' },
      { event: 'reiwa.branding.invalidate', reason: 'branding.primary' },
      { event: 'reiwa.landing.invalidate', reason: 'publish' },
      { event: 'reiwa.connect-page.invalidate', reason: 'connect-page catalog saved' },
    ]);
    assert.deepEqual(order.slice(0, 2), ['hintSent reiwa.bot.invalidate', 'enqueue reiwa.bot.invalidate bot-config.buttons']);
  });

  it('the manual refresh is checked too, and reports how its direct attempt ended', async () => {
    process.env['REIWA_URL'] = 'https://cabinet.example';
    process.env['WEBHOOK_SECRET_HEADER'] = 'w'.repeat(32);
    mock.method(globalThis, 'fetch', async () => new Response(null, { status: 204 }));
    const { tracker, sent, settled } = recordingTracker();

    const ok = await invalidator(tracker).service.invalidateNow('admin-manual');

    assert.equal(ok, true);
    assert.deepEqual(sent, [{ event: 'reiwa.bot.invalidate', reason: 'admin-manual' }]);
    assert.deepEqual(settled, [{ event: 'reiwa.bot.invalidate', delivered: true, status: 'delivered' }]);
  });

  it('with the webhook not configured, the manual refresh reports no outcome — none was attempted', async () => {
    delete process.env['REIWA_URL'];
    delete process.env['WEBHOOK_SECRET_HEADER'];
    const { tracker, sent, settled } = recordingTracker();

    assert.equal(await invalidator(tracker).service.invalidateNow('admin-manual'), false);
    assert.equal(sent.length, 1, 'the cabinet’s poll still delivers it, and the check still looks');
    assert.deepEqual(settled, []);
  });

  it('works without the check: a module built without it keeps its old behaviour', async () => {
    const { service, order } = invalidator();
    await service.invalidateBranding('branding.primary');
    assert.deepEqual(order, ['enqueue reiwa.branding.invalidate branding.primary']);
  });
});

describe('the wiring', () => {
  const optionalByToken = (target: object, token: symbol): boolean => {
    const declared = (Reflect.getMetadata(SELF_DECLARED_DEPS_METADATA, target) ?? []) as Array<{ index: number; param: unknown }>;
    const optional = (Reflect.getMetadata(OPTIONAL_DEPS_METADATA, target) ?? []) as number[];
    const slot = declared.find((dep) => dep.param === token);
    return slot !== undefined && optional.includes(slot.index);
  };

  it('the tracker comes from a global module, and is taken optionally, by token', () => {
    // Seven modules declare the invalidator; none of them imports the tracker's
    // module. Global + `@Optional()` is what lets all of them boot.
    assert.equal(Reflect.getMetadata(GLOBAL_MODULE_METADATA, ConfigVersionsModule), true);
    assert.ok(((Reflect.getMetadata('exports', ConfigVersionsModule) ?? []) as unknown[]).includes(CONFIG_DELIVERY_TRACKER));
    assert.ok(((Reflect.getMetadata('imports', BotConfigModule) ?? []) as unknown[]).includes(ConfigVersionsModule));
    assert.ok(optionalByToken(ReiwaCacheInvalidatorService, CONFIG_DELIVERY_TRACKER));
    assert.ok(optionalByToken(ReiwaRelayProcessor, CONFIG_DELIVERY_TRACKER));
  });

  it('the relay lends the check its recorder, so the check’s card shares the relay’s alert windows', () => {
    assert.ok(((Reflect.getMetadata('exports', ReiwaRelayModule) ?? []) as unknown[]).includes(RELAY_UNDELIVERED_RECORDER));
    assert.ok(((Reflect.getMetadata('imports', ConfigVersionsModule) ?? []) as unknown[]).includes(ReiwaRelayModule));
  });
});
