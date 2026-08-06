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

/** What `getPanelUserUsage` answers, shaped as the real reader returns it. */
interface PanelUsage {
  username: string | null;
  usedTrafficBytes: number | null;
  status: string | null;
  expireAt: string | null;
  trafficLimitBytes: number | null;
  hwidDeviceLimit: number | null;
}

function buildService(panelUsage: PanelUsage | null = null): {
  service: RemnawaveWebhookService;
  stored: string[];
  emitted: EmittedEvent[];
  reconciled: ReconcileCall[];
  usageCalls: string[];
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

  // The panel read `user.first_connected` falls back to when its payload
  // carries no counter. Defaults to "the panel did not answer" so every test
  // that is not about traffic keeps exercising the no-counter path.
  const usageCalls: string[] = [];
  const remnawaveApi = {
    getPanelUserUsage: async (uuid: string) => {
      usageCalls.push(uuid);
      return panelUsage;
    },
  };

  const service = new RemnawaveWebhookService(
    prisma as never,
    config as never,
    systemEvents as never,
    remnawaveApi as never,
  );
  return { service, stored, emitted, reconciled, usageCalls };
}

/**
 * A real `RemnawaveWebhookUserEventsDto` envelope.
 *
 * Shaped from the OpenAPI documents (`Remnawave API v274.json` /
 * `v280.json`): every name in `data.required` is present, and the traffic
 * counters sit where the panel actually puts them — inside the required
 * `userTraffic` container. NEITHER version defines a top-level
 * `data.usedTrafficBytes`, so no fixture here may invent one: a test built on
 * a payload shape the panel does not send proves nothing about production.
 *
 * `data` is identical between 2.7.4 and 2.8.0. The versions differ only in the
 * envelope `meta` (2.8.0 added `expiration`) and in the `event` enum, so the
 * `meta` argument is what selects the panel version.
 */
function userEventPayload(options: {
  readonly event: string;
  readonly usedTrafficBytes?: number | string;
  readonly meta?: Record<string, unknown> | null;
  readonly uuid?: string;
}): Record<string, unknown> {
  return {
    scope: 'user',
    event: options.event,
    timestamp: '2026-08-05T09:14:22.000Z',
    data: {
      uuid: options.uuid ?? '9d2f4c1e-7b3a-4f6d-9c58-2e1a7b4c9d30',
      id: 4821,
      shortUuid: 'aH3kQ9zR2mVt',
      username: 'anna_vpn',
      status: 'ACTIVE',
      trafficLimitBytes: 53_687_091_200,
      trafficLimitStrategy: 'MONTH',
      expireAt: '2026-08-08T09:00:00.000Z',
      telegramId: 858568447,
      email: 'anna@example.com',
      description: 'renewed via bot',
      tag: 'RETAIL',
      hwidDeviceLimit: 3,
      externalSquadUuid: '1f0d9f6c-3a21-4b8e-bd47-6c5e2a9f0b13',
      trojanPassword: 'Tr0jan-l1ve-s3cret',
      vlessUuid: '7c4e1b90-5d62-4a3f-8e19-4b7d0c2a6f85',
      ssPassword: 'Sh4d0wS0cks-l1ve-s3cret',
      lastTriggeredThreshold: 80,
      subRevokedAt: null,
      lastTrafficResetAt: '2026-08-01T00:00:00.000Z',
      createdAt: '2026-01-14T11:02:41.000Z',
      updatedAt: '2026-08-05T09:14:22.000Z',
      subscriptionUrl: 'https://sub.example.com/aH3kQ9zR2mVt',
      activeInternalSquads: [
        { uuid: '3e8a2d17-9f04-4c6b-a512-8d0f3b7e1c94', name: 'EU-Premium' },
      ],
      // The ONLY place either spec puts the used-traffic counter.
      userTraffic: {
        usedTrafficBytes: options.usedTrafficBytes ?? 1_024,
        lifetimeUsedTrafficBytes: 161_061_273_600,
        onlineAt: '2026-08-05T09:11:03.000Z',
        firstConnectedAt: '2026-01-14T11:40:09.000Z',
        lastConnectedNodeUuid: '5b9c0e34-2a71-4d8f-9b06-1c7a4e2d8f50',
      },
    },
    // 2.7.4 `meta` carries only `notConnectedAfterHours`; 2.8.0 added
    // `expiration`. Both declare `meta` required and nullable.
    meta: options.meta === undefined ? { notConnectedAfterHours: null } : options.meta,
  };
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
      service: new RemnawaveWebhookService(
        prisma as never,
        { webhookSecret: null } as never,
        systemEvents as never,
        { getPanelUserUsage: async () => null } as never,
      ),
      emitted,
      getFirstTrafficUpdates: () => firstTrafficUpdates,
      claimWheres,
    };
  }

  it('claims first traffic once from the nested counter — 2.7.4 envelope', async () => {
    // `data.userTraffic.usedTrafficBytes` is the only spelling 2.7.4 sends.
    const { service, emitted, getFirstTrafficUpdates, claimWheres } = buildTrafficService();
    const payload = userEventPayload({ event: 'user.modified', usedTrafficBytes: 1_024 });
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

  it('claims first traffic once from the nested counter — 2.8.0 envelope', async () => {
    // 2.8.0 keeps `data` identical and only reshapes `meta`; the counter must
    // still be found, so one build serves both panel versions.
    const { service, emitted, getFirstTrafficUpdates } = buildTrafficService();
    const payload = userEventPayload({
      event: 'user.modified',
      usedTrafficBytes: 4_096,
      meta: { notConnectedAfterHours: null, expiration: null },
    });
    await service.handleEvent('user.modified', payload, null);
    await service.handleEvent('user.modified', payload, null);
    const firstTrafficEvents = emitted.filter((event) => event.type === 'user.first_traffic');
    assert.equal(firstTrafficEvents.length, 1);
    assert.equal(firstTrafficEvents[0]?.metadata?.['usedTrafficBytes'], 4_096);
    assert.equal(getFirstTrafficUpdates(), 2);
  });

  it('puts the nested counter on the bandwidth-threshold card metadata', async () => {
    // The whole purpose of `user.bandwidth_usage_threshold_reached` is to
    // report consumption, and the card formatter only renders the traffic
    // line when `meta.usedTrafficBytes` is a number.
    const { service, emitted } = buildTrafficService();
    await service.handleEvent(
      'user.bandwidth_usage_threshold_reached',
      userEventPayload({
        event: 'user.bandwidth_usage_threshold_reached',
        usedTrafficBytes: 42_949_672_960,
      }),
      null,
    );
    const card = emitted.find((event) => event.type === 'remnawave.user.bandwidth_threshold');
    assert.ok(card, 'expected a bandwidth threshold card');
    assert.equal(card.metadata?.['usedTrafficBytes'], 42_949_672_960);
    assert.equal(card.metadata?.['trafficLimitBytes'], 53_687_091_200);
  });

  it('accepts string counters from panel JSON', async () => {
    // Real Remnawave webhooks are JSON — counters often arrive as strings.
    // BigInt is not JSON-serializable and never reaches handleEvent storage.
    const { service, emitted } = buildTrafficService();
    await service.handleEvent(
      'user.modified',
      userEventPayload({ event: 'user.modified', usedTrafficBytes: '2048' }),
      null,
    );
    const events = emitted.filter((event) => event.type === 'user.first_traffic');
    assert.equal(events.length, 1);
    assert.equal(events[0]?.metadata?.['usedTrafficBytes'], 2048);
    assert.equal(events[0]?.metadata?.['trafficLimitBytes'], 53_687_091_200);
  });

  it('emits only once under concurrent webhooks racing the claim', async () => {
    const { service, emitted, getFirstTrafficUpdates } = buildTrafficService();
    const payload = userEventPayload({ event: 'user.modified', usedTrafficBytes: 500 });
    await Promise.all([
      service.handleEvent('user.modified', payload, null),
      service.handleEvent('user.modified', payload, null),
      service.handleEvent('user.modified', payload, null),
    ]);
    assert.equal(emitted.filter((event) => event.type === 'user.first_traffic').length, 1);
    assert.equal(getFirstTrafficUpdates(), 3);
  });

  it('does not claim or emit first traffic for zero nested usage', async () => {
    const { service, emitted, getFirstTrafficUpdates } = buildTrafficService();
    await service.handleEvent(
      'user.modified',
      userEventPayload({ event: 'user.modified', usedTrafficBytes: 0 }),
      null,
    );
    assert.equal(emitted.filter((event) => event.type === 'user.first_traffic').length, 0);
    assert.equal(getFirstTrafficUpdates(), 0);
  });

  it('does not emit when local user cannot be resolved', async () => {
    const { service, emitted, getFirstTrafficUpdates } = buildTrafficService({
      subscription: null,
      userByTelegram: null,
    });
    await service.handleEvent(
      'user.modified',
      userEventPayload({ event: 'user.modified', usedTrafficBytes: 999, uuid: 'unknown-uuid' }),
      null,
    );
    assert.equal(emitted.filter((event) => event.type === 'user.first_traffic').length, 0);
    assert.equal(getFirstTrafficUpdates(), 0);
  });
});

/**
 * Expiry-warning events across panel versions.
 *
 * 2.7.4 raises one of four discrete names (`user.expires_in_72_hours`,
 * `…_48_hours`, `…_24_hours`, `user.expired_24_hours_ago`). 2.8.0 removed all
 * four and raises a single `user.expiration`, carrying the distinguishing
 * number in the envelope `meta.expiration` rather than in `data`. One build
 * serves both panels, so both spellings must map.
 */
describe('RemnawaveWebhookService expiry warnings', () => {
  it('maps the 2.7.4 expire-soon events', async () => {
    for (const name of [
      'user.expires_in_72_hours',
      'user.expires_in_48_hours',
      'user.expires_in_24_hours',
    ]) {
      const { service, emitted } = buildService();
      await service.handleEvent(name, userEventPayload({ event: name, usedTrafficBytes: 0 }), null);
      const card = emitted.find((event) => event.type === 'remnawave.user.expire_soon');
      assert.ok(card, `expected an expire-soon card for ${name}`);
      assert.equal(card.category, 'REMNAWAVE');
      assert.equal(card.severity, 'INFO');
      assert.equal(card.metadata?.['remnawaveUsername'], 'anna_vpn');
      assert.equal(card.metadata?.['expireAt'], '2026-08-08T09:00:00.000Z');
    }
  });

  it('maps 2.8.0 user.expiration to the same expire-soon card', async () => {
    const { service, stored, emitted } = buildService();
    await service.handleEvent(
      'user.expiration',
      userEventPayload({
        event: 'user.expiration',
        usedTrafficBytes: 0,
        meta: { notConnectedAfterHours: null, expiration: 72 },
      }),
      null,
    );
    assert.deepEqual(stored, ['user.expiration']);
    const card = emitted.find((event) => event.type === 'remnawave.user.expire_soon');
    assert.ok(card, 'expected an expire-soon card for user.expiration');
    assert.equal(card.category, 'REMNAWAVE');
    assert.equal(card.severity, 'INFO');
    assert.equal(card.metadata?.['remnawaveUsername'], 'anna_vpn');
    assert.equal(card.metadata?.['remnawaveId'], '9d2f4c1e-7b3a-4f6d-9c58-2e1a7b4c9d30');
    assert.equal(card.metadata?.['expireAt'], '2026-08-08T09:00:00.000Z');
  });

  it('carries the 2.8.0 envelope meta.expiration onto the card', async () => {
    // 2.8.0 moved the warning window OUT of `data` into `meta.expiration`;
    // mapping the name alone would drop it, since nothing else reads `meta`.
    const { service, emitted } = buildService();
    await service.handleEvent(
      'user.expiration',
      userEventPayload({
        event: 'user.expiration',
        usedTrafficBytes: 0,
        meta: { notConnectedAfterHours: null, expiration: 48 },
      }),
      null,
    );
    const card = emitted.find((event) => event.type === 'remnawave.user.expire_soon');
    assert.ok(card, 'expected an expire-soon card');
    assert.equal(card.metadata?.['remnawaveExpiration'], 48);
  });

  it('tolerates a null meta envelope', async () => {
    // Both specs declare `meta` nullable, so the read must not throw.
    const { service, emitted } = buildService();
    await service.handleEvent(
      'user.expiration',
      userEventPayload({ event: 'user.expiration', usedTrafficBytes: 0, meta: null }),
      null,
    );
    const card = emitted.find((event) => event.type === 'remnawave.user.expire_soon');
    assert.ok(card, 'expected an expire-soon card');
    assert.equal(card.metadata?.['remnawaveExpiration'], undefined);
  });
});

/**
 * The traffic counter on a first-connection card.
 *
 * The card gates its «📊 Трафик» line on `usedTrafficBytes`, and that line is
 * the one an operator reads to tell "this customer is using the service" from
 * "this customer is merely pointed at it". When a `user.first_connected`
 * payload arrives without a counter the metadata had nothing to gate on, so the
 * card showed the profile and said nothing at all about usage.
 *
 * These pin the fallback and, just as importantly, its boundaries: it must not
 * override a number the webhook did carry, must not fail the webhook when the
 * panel is down, and must not make a REST call it has no uuid for.
 */
describe('first-connection traffic counter', () => {
  const usage = (over: Partial<PanelUsage> = {}): PanelUsage => ({
    username: 'anna_vpn',
    usedTrafficBytes: 0,
    status: 'ACTIVE',
    expireAt: '2026-09-03T18:40:21.000Z',
    trafficLimitBytes: 107_374_182_400,
    hwidDeviceLimit: 1,
    ...over,
  });

  it('asks the panel when the payload carries no counter, and keeps a zero', async () => {
    const { service, emitted, usageCalls } = buildService(usage({ usedTrafficBytes: 0 }));
    await service.handleEvent(
      'user.first_connected',
      { event: 'user.first_connected', data: { uuid: 'uuid-9', username: 'anna_vpn' } },
      null,
    );

    assert.deepEqual(usageCalls, ['uuid-9'], 'the panel is asked exactly once, for this uuid');
    assert.equal(emitted.length, 1);
    // Zero is the answer, not the absence of one: «0 Б / 100 ГБ» is what
    // "connected, nothing used yet" looks like, and it is the common case here.
    // A `?? fallback` or a truthiness check anywhere on this path drops it.
    assert.equal(emitted[0]!.metadata?.['usedTrafficBytes'], 0);
    assert.equal(emitted[0]!.metadata?.['trafficLimitBytes'], 107_374_182_400);
  });

  it('carries a non-zero counter through so the card can show real usage', async () => {
    const { service, emitted } = buildService(usage({ usedTrafficBytes: 954_204 }));
    await service.handleEvent(
      'user.first_connected',
      { event: 'user.first_connected', data: { uuid: 'uuid-9' } },
      null,
    );
    assert.equal(emitted[0]!.metadata?.['usedTrafficBytes'], 954_204);
  });

  it('prefers the counter the webhook carried and does not call the panel', async () => {
    // The payload's number is contemporaneous with the event; a REST read races
    // it. A fallback that fired unconditionally would quietly replace the truth
    // of the moment with the truth of a few milliseconds later.
    const { service, emitted, usageCalls } = buildService(usage({ usedTrafficBytes: 999_999_999 }));
    await service.handleEvent(
      'user.first_connected',
      userEventPayload({ event: 'user.first_connected', usedTrafficBytes: 4_096 }),
      null,
    );
    assert.deepEqual(usageCalls, [], 'no panel read when the payload already answered');
    assert.equal(emitted[0]!.metadata?.['usedTrafficBytes'], 4_096);
  });

  it('still delivers the card when the panel does not answer', async () => {
    // `getPanelUserUsage` swallows its own errors and returns null. A card is
    // not worth failing a webhook over, so the event must still be forwarded —
    // just without the traffic line.
    const { service, emitted, stored, usageCalls } = buildService(null);
    await service.handleEvent(
      'user.first_connected',
      { event: 'user.first_connected', data: { uuid: 'uuid-9', username: 'anna_vpn' } },
      null,
    );
    assert.deepEqual(usageCalls, ['uuid-9']);
    assert.deepEqual(stored, ['user.first_connected']);
    assert.equal(emitted.length, 1, 'the card is delivered anyway');
    assert.equal(emitted[0]!.metadata?.['usedTrafficBytes'], undefined);
    assert.equal(emitted[0]!.metadata?.['remnawaveUsername'], 'anna_vpn');
  });

  it('makes no panel call for a payload with no uuid to ask about', async () => {
    const { service, emitted, usageCalls } = buildService(usage());
    await service.handleEvent(
      'user.first_connected',
      { event: 'user.first_connected', data: { username: 'anna_vpn' } },
      null,
    );
    assert.deepEqual(usageCalls, []);
    assert.equal(emitted.length, 1);
  });

  it('leaves every other event alone — this is a first-connection affordance', async () => {
    // `user.expired` and friends already get their counter from the payload;
    // adding a REST read to each one would put a network call on the hot path
    // of the whole webhook firehose.
    const { service, usageCalls } = buildService(usage());
    await service.handleEvent('user.expired', { data: { uuid: 'uuid-9' } }, null);
    await service.handleEvent('user.disabled', { data: { uuid: 'uuid-9' } }, null);
    assert.deepEqual(usageCalls, []);
  });
});

describe('the first-connection panel read cannot hold the webhook open', () => {
  it('gives up on a hung panel and still forwards the card', async () => {
    // `handleEvent` is awaited inside the webhook request and the shared
    // outbound timeout is 45s, which is long enough for Remnawave to give up
    // and redeliver. A decorative traffic line must never buy a duplicated
    // webhook, so the read carries a deadline of its own.
    //
    // Real timers on purpose: the deadline is armed several `await`s deep, so a
    // mocked `tick()` fires before the `setTimeout` this test exists to check
    // has been created, and the assertion passes without the deadline existing.
    // Three seconds of wall clock is the honest price of proving it.
    const stored: string[] = [];
    const emitted: EmittedEvent[] = [];
    const service = new RemnawaveWebhookService(
      {
        remnawaveWebhookEvent: {
          create: async (args: { data: { eventType: string } }) => {
            stored.push(args.data.eventType);
            return {};
          },
        },
        subscription: { updateMany: async () => ({ count: 0 }) },
      } as never,
      { webhookSecret: null } as never,
      { emit: (event: EmittedEvent) => emitted.push(event) } as never,
      // Never settles — the panel accepted the connection and went quiet.
      { getPanelUserUsage: () => new Promise(() => {}) } as never,
    );

    const startedAt = Date.now();
    await service.handleEvent(
      'user.first_connected',
      { event: 'user.first_connected', data: { uuid: 'uuid-hung', username: 'anna_vpn' } },
      null,
    );
    const elapsed = Date.now() - startedAt;

    assert.deepEqual(stored, ['user.first_connected']);
    assert.equal(emitted.length, 1, 'the card is forwarded despite the panel never answering');
    assert.equal(emitted[0]!.metadata?.['usedTrafficBytes'], undefined);
    assert.equal(emitted[0]!.metadata?.['remnawaveUsername'], 'anna_vpn');
    // The upper bound is what fails if the deadline is removed: without it this
    // never returns at all. The lower bound is what fails if somebody "fixes"
    // the slowness by not reading the panel — then the test would pass while
    // proving nothing, which is the failure mode worth writing against.
    assert.ok(elapsed >= 2_500, `expected the read to be waited on; returned in ${elapsed}ms`);
    assert.ok(elapsed < 15_000, `expected the deadline to cut it short; took ${elapsed}ms`);
  });
});
