import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';

import { BroadcastDeliveryService } from '../src/modules/broadcast/services/broadcast-delivery.service';
import { BroadcastService } from '../src/modules/broadcast/services/broadcast.service';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { SystemEventsService } from '../src/common/services/system-events.service';
import { UserNotificationsService } from '../src/modules/notifications/services/user-notifications.service';
import { SettingsService } from '../src/modules/settings/services/settings.service';
import { BotNotifierClient } from '../src/modules/notifications/services/bot-notifier.client';
import { ReiwaRelayQueueService } from '../src/modules/notifications/services/reiwa-relay-queue.service';

/**
 * The promo gate is a REQUIRED dependency, and this proves Nest can supply it.
 *
 * ── Why a test exists for a constructor ───────────────────────────────────
 *
 * The re-check of a broadcast's promo code at the moment it fires lives in
 * `stageRecipients` and calls `BroadcastService`. Declared `@Optional()`, that
 * call would be skipped wherever the injector failed to provide it — and the
 * only symptom would be scheduled broadcasts quietly going out again behind a
 * dead button, which is precisely the defect it was added to stop. Required
 * means Nest refuses to start instead of running without the guard, so the
 * thing worth guarding is that Nest CAN start.
 *
 * The rest of the constructor is mocked; only this one dependency is asserted
 * to be the real class.
 */
describe('the delivery service can be constructed by the injector', () => {
  it('resolves the promo gate to the real BroadcastService', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [BroadcastDeliveryService, BroadcastService],
    })
      .useMocker((token) => {
        if (token === ConfigService) return { get: () => undefined };
        if (token === SystemEventsService) {
          return { info: () => undefined, warn: () => undefined, error: () => undefined };
        }
        if (token === SettingsService) return { getSettings: async () => ({}) };
        if (token === ReiwaRelayQueueService) return { isEnabled: false };
        if (
          token === PrismaService ||
          token === UserNotificationsService ||
          token === BotNotifierClient
        ) {
          return {};
        }
        return {};
      })
      .compile();

    const delivery = moduleRef.get(BroadcastDeliveryService);
    const gate = (delivery as unknown as { broadcastService?: unknown }).broadcastService;

    assert.ok(
      gate instanceof BroadcastService,
      'the promo gate dependency did not resolve to the real service',
    );
    assert.equal(
      typeof (gate as BroadcastService).checkPromoCodeDispatchable,
      'function',
      'the resolved dependency cannot answer the question staging asks it',
    );

    await moduleRef.close();
  });

  it('REFUSES to construct without it, rather than running without the guard', async () => {
    // The mutation this file exists for. Marked `@Optional()`, the injector
    // hands over `undefined`, the module compiles happily, and every scheduled
    // broadcast goes out with its promo unchecked — silently, because nothing
    // anywhere reports a dependency that was allowed to be missing.
    //
    // Everything is mocked here EXCEPT the promo gate, so the only thing that
    // can fail resolution is the dependency under test.
    const compiling = Test.createTestingModule({ providers: [BroadcastDeliveryService] })
      .useMocker((token) => {
        if (token === BroadcastService) return undefined;
        if (token === ConfigService) return { get: () => undefined };
        if (token === SystemEventsService) {
          return { info: () => undefined, warn: () => undefined, error: () => undefined };
        }
        if (token === SettingsService) return { getSettings: async () => ({}) };
        if (token === ReiwaRelayQueueService) return { isEnabled: false };
        return {};
      })
      .compile();

    await assert.rejects(
      compiling,
      'Nest constructed the delivery service with no promo gate at all',
    );
  });
});
