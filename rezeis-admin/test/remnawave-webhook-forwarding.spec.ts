import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { Logger } from '@nestjs/common';

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
      // No snapshot to patch, and no row of this profile in the term model:
      // these cases are about the mirror every other subscription gets.
      findMany: async () => [],
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
    // Notice builder + notification sink. Inert here: the traffic-limit
    // notice has its own spec, and these cases are about reconciliation.
    { build: async () => ({}) } as never,
    { create: async () => undefined } as never,
  );
  return { service, stored, emitted, reconciled, usageCalls };
}

/**
 * A real `RemnawaveWebhookUserEventsDto` envelope.
 *
 * Shaped from the OpenAPI documents of the panels rezeis serves
 * (`Remnawave API v3.3.2.json` / `v3.4.3.json`, identical here): every name in
 * `data.required` is present and nothing else — no user `uuid`, which 3.x
 * deleted — and the traffic counters sit where the panel actually puts them,
 * inside the required `userTraffic` container. No version defines a top-level
 * `data.usedTrafficBytes`, so no fixture here may invent one: a test built on
 * a payload shape the panel does not send proves nothing about production.
 */
function userEventPayload(options: {
  readonly event: string;
  readonly usedTrafficBytes?: number | string;
  readonly meta?: Record<string, unknown> | null;
  readonly id?: number;
  /** Replaces the whole traffic block (the connection evidence). */
  readonly userTraffic?: Record<string, unknown>;
  /** The envelope's time; the fixture's own by default. */
  readonly timestamp?: string;
}): Record<string, unknown> {
  return {
    scope: 'user',
    event: options.event,
    timestamp: options.timestamp ?? '2026-08-05T09:14:22.000Z',
    data: {
      id: options.id ?? 4821,
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
      // The ONLY place any spec puts the used-traffic counter.
      userTraffic: options.userTraffic ?? {
        usedTrafficBytes: options.usedTrafficBytes ?? 1_024,
        lifetimeUsedTrafficBytes: 161_061_273_600,
        onlineAt: '2026-08-05T09:11:03.000Z',
        firstConnectedAt: '2026-01-14T11:40:09.000Z',
        lastConnectedNodeUuid: '5b9c0e34-2a71-4d8f-9b06-1c7a4e2d8f50',
      },
    },
    // `meta` is required and nullable, `{ notConnectedAfterHours, expiration }`.
    meta: options.meta === undefined ? { notConnectedAfterHours: null, expiration: null } : options.meta,
  };
}

describe('RemnawaveWebhookService forwarding', () => {
  it('forwards a mapped user.expired event with remnawave metadata', async () => {
    const { service, stored, emitted } = buildService();
    await service.handleEvent(
      'user.expired',
      { event: 'user.expired', data: { username: 'anna_vpn', id: 4821, telegramId: 858568447 } },
      null,
    );
    assert.deepEqual(stored, ['user.expired']);
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0]!.category, 'REMNAWAVE');
    assert.equal(emitted[0]!.severity, 'WARNING');
    assert.equal(emitted[0]!.metadata?.['remnawaveUsername'], 'anna_vpn');
    assert.equal(emitted[0]!.metadata?.['remnawaveId'], '4821');
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

  it('files the panel start under REMNAWAVE, where its tick-box is', async () => {
    // It went out as NODE — into the operator's node topic — while the page
    // offers it under «Remnawave» and the constant sits in that block.
    const { service, emitted } = buildService();
    await service.handleEvent('service.panel_started', { data: {} }, null);
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0]!.type, 'remnawave.panel.started');
    assert.equal(emitted[0]!.category, 'REMNAWAVE');
  });

  it('forwards every mapped panel event under the category the operator ticks it in', async () => {
    // The category picks the forum topic; the catalogue is where the operator
    // chose that topic's contents. They have to be the same answer for every
    // name the map forwards, not only for the one that drifted.
    const catalogue = readCatalogueCategories();
    const names = [
      'user.first_connected', 'user.expired', 'user.limited', 'user.enabled', 'user.disabled',
      'user.traffic_reset', 'user.expiration',
      'user.bandwidth_usage_threshold_reached',
      'node.connection_lost', 'node.connection_restored', 'node.created', 'node.modified',
      'node.enabled', 'node.disabled', 'node.traffic_notify',
      'service.panel_started',
    ];
    const disagreements: string[] = [];
    for (const name of names) {
      const { service, emitted } = buildService();
      await service.handleEvent(name, { data: {} }, null);
      assert.equal(emitted.length, 1, `${name} was not forwarded — the list above is stale`);
      const ticked = catalogue.get(emitted[0]!.type);
      if (ticked !== emitted[0]!.category) {
        disagreements.push(`${name} → ${emitted[0]!.type}: emitted ${emitted[0]!.category}, ticked under ${ticked}`);
      }
    }
    assert.deepStrictEqual(disagreements, []);
  });
});

/** `event type → category` as the operator's catalogue in the SPA groups them. */
function readCatalogueCategories(): Map<string, string> {
  const source = readFileSync(
    join(__dirname, '..', 'web', 'src', 'features', 'notifications', 'notifications-page.tsx'),
    'utf8',
  );
  const start = source.indexOf('const EVENT_TYPE_CATALOG');
  assert.ok(start >= 0, 'EVENT_TYPE_CATALOG not found');
  // The literal's closing brace alone on its line. CRLF or LF: a Windows
  // working copy is CRLF under `core.autocrlf`, and a miss here would read the
  // rest of the file as one more category.
  const close = /\r?\n\}\r?\n/.exec(source.slice(start));
  assert.ok(close !== null, 'EVENT_TYPE_CATALOG literal end not found');
  const end = start + close.index;
  const byType = new Map<string, string>();
  let category: string | null = null;
  for (const line of source.slice(start, end).split(/\r?\n/)) {
    const heading = /^\s{2}([A-Z]+): \[/.exec(line);
    if (heading) category = heading[1]!;
    const body = line.replace(/\/\/.*$/, '');
    for (const match of body.matchAll(/'([a-z_][a-z0-9_.]*)'/g)) {
      if (category !== null) byType.set(match[1]!, category);
    }
  }
  assert.ok(
    byType.get('node.connection_lost') === 'NODE' && byType.size > 50,
    `parsed ${byType.size} types — the parse, not the catalogue, is wrong`,
  );
  return byType;
}

describe('RemnawaveWebhookService reconcile (panel → rezeis)', () => {
  it('overlays status + expiry + limits onto the matching subscription on user.modified', async () => {
    const { service, reconciled } = buildService();
    await service.handleEvent(
      'user.modified',
      {
        data: {
          id: 4821,
          status: 'DISABLED',
          expireAt: '2027-01-01T00:00:00.000Z',
          trafficLimitBytes: 0,
          hwidDeviceLimit: 3,
        },
      },
      null,
    );
    assert.equal(reconciled.length, 1);
    assert.deepEqual(reconciled[0]!.where['OR'], [{ remnawaveId: '4821' }, { remnawavePanelId: 4821 }]);
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
      { data: { id: 4822, trafficLimitBytes: 50 * 1024 ** 3 } },
      null,
    );
    assert.equal(reconciled.length, 1);
    assert.equal(reconciled[0]!.data['trafficLimit'], 50);
  });

  it('derives status from the event name when the payload omits it', async () => {
    const { service, reconciled } = buildService();
    await service.handleEvent('user.expired', { data: { id: 4823 } }, null);
    assert.equal(reconciled.length, 1);
    assert.equal(reconciled[0]!.data['status'], 'EXPIRED');
  });

  it('skips reconcile when the payload carries no user identity', async () => {
    const { service, reconciled } = buildService();
    await service.handleEvent('user.modified', { data: { status: 'ACTIVE' } }, null);
    assert.equal(reconciled.length, 0);
  });
});

/**
 * WHO the webhook is about.
 *
 * 3.x DELETED the user's uuid column and keys every user by the numeric `id`,
 * so a panel rezeis serves sends no user uuid anywhere — and the extractor once
 * only ever looked for one. `meta.remnawaveId` was therefore never set and the
 * three consumers that key off it all did nothing, with no error and no log:
 * reconcile returned, the reverse lookup never ran, and the first-connection
 * card omitted its counter.
 *
 * The value has to be what `Subscription.remnawaveId` HOLDS on 3.x — the id in
 * decimal — because that is the column every one of those consumers compares
 * against. These pin the rule and, just as importantly, its edges: a `uuid`
 * key beside the id names nobody, and a uuid-shaped string in the id slot must
 * never be parsed into a number.
 */
describe('panel user identity', () => {
  /**
   * A real Remnawave 3.x `RemnawaveWebhookUserEvents` envelope of a profile
   * that never connected, whose `id` the case chooses.
   *
   * Shaped from `ExtendedUsersSchema` as the 3.x contracts declare it (e.g.
   * `@remnawave/contract-panel-3.2.3`, a devDependency): `id` is a number and
   * the schema has NO `uuid` property at all. That absence is the whole point of
   * this fixture — nothing here may add a uuid "for completeness", or the test
   * stops being about a 3.x panel.
   */
  function payloadWithId(options: {
    readonly event: string;
    readonly id?: unknown;
    readonly usedTrafficBytes?: number;
  }): Record<string, unknown> {
    return {
      scope: 'user',
      event: options.event,
      timestamp: '2026-08-05T09:14:22.000Z',
      data: {
        id: options.id === undefined ? 4821 : options.id,
        shortUuid: 'aH3kQ9zR2mVt',
        username: 'anna_vpn',
        status: 'ACTIVE',
        trafficLimitBytes: 53_687_091_200,
        trafficLimitStrategy: 'MONTH',
        expireAt: '2026-08-08T09:00:00.000Z',
        telegramId: 858568447,
        email: 'anna@example.com',
        description: null,
        tag: 'RETAIL',
        hwidDeviceLimit: 3,
        externalSquadUuid: null,
        trojanPassword: 'Tr0jan-l1ve-s3cret',
        vlessUuid: '7c4e1b90-5d62-4a3f-8e19-4b7d0c2a6f85',
        ssPassword: 'Sh4d0wS0cks-l1ve-s3cret',
        lastTriggeredThreshold: 0,
        subRevokedAt: null,
        lastTrafficResetAt: null,
        createdAt: '2026-01-14T11:02:41.000Z',
        updatedAt: '2026-08-05T09:14:22.000Z',
        subscriptionUrl: 'https://sub.example.com/aH3kQ9zR2mVt',
        activeInternalSquads: [],
        userTraffic: {
          usedTrafficBytes: options.usedTrafficBytes ?? 0,
          lifetimeUsedTrafficBytes: 0,
          onlineAt: null,
          firstConnectedAt: null,
          lastConnectedNodeUuid: null,
        },
      },
      meta: { notConnectedAfterHours: null, expiration: null },
    };
  }

  /**
   * Records every place an identity leaves this service: the reconcile
   * `updateMany`, the reverse `findFirst`, the card metadata and the panel
   * read. All four have to agree, so all four are watched at once.
   */
  function buildIdentityProbe(): {
    service: RemnawaveWebhookService;
    emitted: EmittedEvent[];
    reconciled: ReconcileCall[];
    lookups: Array<Record<string, unknown>>;
    usageCalls: string[];
  } {
    const emitted: EmittedEvent[] = [];
    const reconciled: ReconcileCall[] = [];
    const lookups: Array<Record<string, unknown>> = [];
    const usageCalls: string[] = [];

    const prisma = {
      remnawaveWebhookEvent: { create: async () => ({}) },
      subscription: {
        updateMany: async (args: ReconcileCall) => {
          reconciled.push(args);
          return { count: 1 };
        },
        findFirst: async (args: { where: Record<string, unknown> }) => {
          lookups.push(args.where);
          return {
            id: 'sub-1',
            status: 'ACTIVE',
            trafficLimit: 50,
            deviceLimit: 3,
            expiresAt: new Date('2027-01-01T00:00:00.000Z'),
            user: { id: 'user-1', telegramId: 858568447n, name: 'Anna', username: 'anna' },
          };
        },
        // No snapshot to patch, and no row of this profile in the term model.
        findMany: async () => [],
      },
      user: { updateMany: async () => ({ count: 0 }), findUnique: async () => null },
    };
    const systemEvents = {
      emit: (event: EmittedEvent) => emitted.push(event),
      info: (type: string, category: string, _message: string, metadata?: Record<string, unknown>) => {
        emitted.push({ type, category, severity: 'INFO', metadata });
      },
    };
    const remnawaveApi = {
      getPanelUserUsage: async (ref: string) => {
        usageCalls.push(ref);
        return null;
      },
    };

    return {
      service: new RemnawaveWebhookService(
        prisma as never,
        { webhookSecret: null } as never,
        systemEvents as never,
        remnawaveApi as never,
        // Notice builder + notification sink. Inert here: the traffic-limit
        // notice has its own spec, and these cases are about reconciliation.
        { build: async () => ({}) } as never,
        { create: async () => undefined } as never,
      ),
      emitted,
      reconciled,
      lookups,
      usageCalls,
    };
  }

  /** Collects `logger.warn` lines for the duration of one test. */
  function captureWarns(): { readonly warns: string[]; restore(): void } {
    const warns: string[] = [];
    const originalWarn = Logger.prototype.warn;
    Logger.prototype.warn = function patched(message: unknown): void {
      warns.push(String(message));
    } as typeof Logger.prototype.warn;
    return {
      warns,
      restore(): void {
        Logger.prototype.warn = originalWarn;
      },
    };
  }

  it('names a profile by its numeric id, which is what remnawaveId holds', async () => {
    // The panel row has no uuid to offer, so `String(id)` IS the identity —
    // the same string `parsePanelUserRow` stores when it reads that row over
    // REST, which is why the reverse lookups still match.
    const { service, emitted, reconciled, lookups } = buildIdentityProbe();
    await service.handleEvent(
      'user.first_connected',
      payloadWithId({ event: 'user.first_connected' }),
      null,
    );

    assert.equal(reconciled.length, 1, 'a 3.x event must still reconcile');
    // A numeric identity is matched on BOTH recorded angles: the string in
    // `remnawaveId` (a profile created on 3.x) and the number in
    // `remnawavePanelId` (one created on 2.x before the panel was upgraded,
    // whose `remnawaveId` still holds the now-dead uuid and would never match).
    const expectedWhere = [{ remnawaveId: '4821' }, { remnawavePanelId: 4821 }];
    assert.deepEqual(reconciled[0]?.where['OR'], expectedWhere);
    assert.deepEqual(lookups[0]?.['OR'], expectedWhere);
    assert.equal(emitted[0]?.metadata?.['remnawaveId'], '4821');
    // Attribution succeeded, so the card carries the local profile too.
    assert.equal(emitted[0]?.metadata?.['userId'], 'user-1');
  });

  it('accepts a numeric id that arrived as a string', async () => {
    // A webhook body is whatever the sender serialized: a relay that
    // round-trips it through a string-typed store quotes the number.
    const { service, emitted, reconciled } = buildIdentityProbe();
    await service.handleEvent(
      'user.expired',
      payloadWithId({ event: 'user.expired', id: '4821' }),
      null,
    );

    assert.deepEqual(reconciled[0]?.where['OR'], [
      { remnawaveId: '4821' },
      { remnawavePanelId: 4821 },
    ]);
    assert.equal(emitted[0]?.metadata?.['remnawaveId'], '4821');
  });

  it('reads no user uuid: a payload that still carries one is named by its id', async () => {
    // No panel rezeis serves has a user uuid to send. Whatever still puts one
    // beside the id — usable or not — is named by the id like every other
    // payload, which `panelIdentityWhere` also matches on `remnawavePanelId`,
    // the number a row created on 2.x recorded. A reader that let the uuid win
    // would name nobody on a 3.x install; one that let a broken uuid win would
    // drop the event.
    const expectedWhere = [{ remnawaveId: '4821' }, { remnawavePanelId: 4821 }];
    for (const uuid of ['9d2f4c1e-7b3a-4f6d-9c58-2e1a7b4c9d30', '', null]) {
      const { service, emitted, reconciled, lookups } = buildIdentityProbe();
      await service.handleEvent(
        'user.expired',
        { scope: 'user', event: 'user.expired', data: { uuid, id: 4821, username: 'anna_vpn' } },
        null,
      );

      const label = `uuid ${JSON.stringify(uuid)}`;
      assert.deepEqual(reconciled[0]?.where['OR'], expectedWhere, label);
      assert.deepEqual(lookups[0]?.['OR'], expectedWhere, label);
      assert.equal(emitted[0]?.metadata?.['remnawaveId'], '4821', label);
    }
  });

  it('refuses a uuid-shaped string in the id slot rather than parsing it to 330', async () => {
    // `Number.parseInt('330f2b38-…')` answers 330 — a valid-looking id owned by
    // somebody else. Anything but a whole decimal string is not an id.
    const { service, emitted, reconciled, lookups } = buildIdentityProbe();
    await service.handleEvent(
      'user.expired',
      payloadWithId({ event: 'user.expired', id: '330f2b38-9c41-4c7e-9c50-6bd0c1f2a7e4' }),
      null,
    );

    assert.equal(emitted[0]?.metadata?.['remnawaveId'], undefined);
    assert.notEqual(emitted[0]?.metadata?.['remnawaveId'], '330');
    assert.equal(reconciled.length, 0);
    assert.equal(lookups.length, 0);
  });

  it('refuses ids that are not whole non-negative decimals', async () => {
    // Every one of these would stringify into something
    // `isNumericPanelIdentity` (panel-user-address.ts) reads as a link no 3.x
    // panel issued, so the profile would be named by an id no panel answers to.
    for (const id of ['1e3', '12.0', '-5', ' ', '0x10', 9_007_199_254_740_993n.toString(), -5, 12.5]) {
      const { service, reconciled } = buildIdentityProbe();
      await service.handleEvent('user.expired', payloadWithId({ event: 'user.expired', id }), null);
      assert.equal(reconciled.length, 0, `id ${String(id)} must not name a profile`);
    }
  });

  it('asks the panel with the 3.x numeric id when the payload carries no counter', async () => {
    // The first-connection traffic read goes through `getPanelUserUsage`, which
    // takes a stored `remnawaveId` and builds the address for the panel's own
    // era — so the numeric form is routable, and this is the path that read
    // `null` and skipped the call entirely before.
    const { service, usageCalls } = buildIdentityProbe();
    await service.handleEvent(
      'user.first_connected',
      { scope: 'user', event: 'user.first_connected', data: { id: 4821, username: 'anna_vpn' } },
      null,
    );
    assert.deepEqual(usageCalls, ['4821']);
  });

  it('warns once, naming the event, when the payload names nobody', async () => {
    // Silence is what made the 3.x defect invisible for a whole panel version:
    // three consumers doing nothing, none of them saying so.
    const captured = captureWarns();
    try {
      const { service } = buildIdentityProbe();
      await service.handleEvent(
        'user.expired',
        { scope: 'user', event: 'user.expired', data: { username: 'anna_vpn' } },
        null,
      );
      const identityWarns = captured.warns.filter((line) => line.includes('no panel user identity'));
      assert.equal(identityWarns.length, 1, 'one line per webhook, not one per consumer');
      assert.ok(
        identityWarns[0]?.includes('user.expired'),
        `expected the event type in the warn, got: ${identityWarns[0]}`,
      );
    } finally {
      captured.restore();
    }
  });

  it('stays quiet when the identity was read', async () => {
    const captured = captureWarns();
    try {
      const { service } = buildIdentityProbe();
      await service.handleEvent('user.expired', payloadWithId({ event: 'user.expired' }), null);
      assert.deepEqual(
        captured.warns.filter((line) => line.includes('no panel user identity')),
        [],
      );
    } finally {
      captured.restore();
    }
  });

  it('names a node by the uuid every node row keeps', async () => {
    // 3.x deleted the USER's uuid, not the node's: 3.3.2 and 3.4.3 still send
    // one on every node event, and the card and the feed label the node by it.
    const { service, emitted, lookups } = buildIdentityProbe();
    await service.handleEvent(
      'node.connection_lost',
      {
        scope: 'node',
        event: 'node.connection_lost',
        data: { uuid: '2a6f8d13-4e07-4b95-8c2d-9f1e3a5b7c60', id: 12, name: 'DE-1' },
      },
      null,
    );
    assert.equal(emitted[0]?.metadata?.['nodeUuid'], '2a6f8d13-4e07-4b95-8c2d-9f1e3a5b7c60');
    assert.deepEqual(lookups, [], 'a node event looks no customer up');
  });

  it('never mints a user identity from a node id', async () => {
    // A node row keeps its `uuid` in every supported version, so the numeric
    // fallback has nothing to do on node events — and must not fire: a node
    // `id: 12` and a customer `id: 12` are the same string in `remnawaveId`.
    const { service, emitted } = buildIdentityProbe();
    await service.handleEvent(
      'node.connection_lost',
      { scope: 'node', event: 'node.connection_lost', data: { id: 12, name: 'DE-1' } },
      null,
    );
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0]?.metadata?.['remnawaveId'], undefined);
    assert.equal(emitted[0]?.metadata?.['nodeUuid'], undefined);
    assert.equal(emitted[0]?.metadata?.['nodeName'], 'DE-1');
  });
});
describe('RemnawaveWebhookService first traffic usage', () => {
  /**
   * The claim follows the connection EVIDENCE rule (`connectEvidenceOf`), not a
   * positive `usedTrafficBytes` alone, and it stores the evidence's own time.
   * `user.first_traffic` is emitted only by the claim winner and only for
   * evidence at most a day old — a customer who connected months ago and is
   * only now heard about must not produce a "started using traffic" card.
   */
  function buildTrafficService(options?: {
    readonly subscription?: Record<string, unknown> | null;
    readonly userByTelegram?: Record<string, unknown> | null;
  }) {
    const emitted: EmittedEvent[] = [];
    let firstTrafficClaimed = false;
    let firstTrafficUpdates = 0;
    const claimWheres: Array<Record<string, unknown>> = [];
    const claimData: Array<Record<string, unknown>> = [];
    const prisma = {
      remnawaveWebhookEvent: { create: async () => ({}) },
      subscription: {
        updateMany: async () => ({ count: 0 }),
        // The connection-state writer's fan-out read: nothing local here, so
        // it writes nothing — this spec is about the person's claim.
        findMany: async () => [],
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
        updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          firstTrafficUpdates += 1;
          claimWheres.push(args.where);
          claimData.push(args.data);
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
        // Notice builder + notification sink. Inert here: the traffic-limit
        // notice has its own spec, and these cases are about reconciliation.
        { build: async () => ({}) } as never,
        { create: async () => undefined } as never,
      ),
      emitted,
      getFirstTrafficUpdates: () => firstTrafficUpdates,
      claimWheres,
      claimData,
    };
  }

  /** A first connection the panel saw `minutesAgo` minutes ago, reported now. */
  function freshConnection(minutesAgo: number, usedTrafficBytes: number | string): {
    readonly timestamp: string;
    readonly userTraffic: Record<string, unknown>;
    readonly connectedAt: Date;
  } {
    const connectedAt = new Date(Date.now() - minutesAgo * 60_000);
    return {
      timestamp: new Date().toISOString(),
      connectedAt,
      userTraffic: {
        usedTrafficBytes,
        lifetimeUsedTrafficBytes: typeof usedTrafficBytes === 'number' ? usedTrafficBytes : Number(usedTrafficBytes),
        onlineAt: connectedAt.toISOString(),
        firstConnectedAt: connectedAt.toISOString(),
        lastConnectedNodeUuid: '5b9c0e34-2a71-4d8f-9b06-1c7a4e2d8f50',
      },
    };
  }

  it('claims first traffic once from the nested counter', async () => {
    // `data.userTraffic` is where the panel puts the counter and the connection times.
    const { service, emitted, getFirstTrafficUpdates, claimWheres, claimData } = buildTrafficService();
    const fresh = freshConnection(7, 1_024);
    const payload = userEventPayload({ event: 'user.modified', ...fresh });
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
    // The column takes the panel's own first-connection time, not "now".
    assert.deepEqual(claimData[0], { firstTrafficAt: fresh.connectedAt });
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
    // Here the STRING counter is the only evidence of the connection: no
    // first-connection time, no online time, a string lifetime counter.
    const { service, emitted, claimData } = buildTrafficService();
    const timestamp = new Date(Date.now() - 60_000).toISOString();
    await service.handleEvent(
      'user.modified',
      userEventPayload({
        event: 'user.modified',
        timestamp,
        userTraffic: {
          usedTrafficBytes: '2048',
          lifetimeUsedTrafficBytes: '2048',
          onlineAt: null,
          firstConnectedAt: null,
          lastConnectedNodeUuid: null,
        },
      }),
      null,
    );
    const events = emitted.filter((event) => event.type === 'user.first_traffic');
    assert.equal(events.length, 1);
    assert.equal(events[0]?.metadata?.['usedTrafficBytes'], 2048);
    assert.equal(events[0]?.metadata?.['trafficLimitBytes'], 53_687_091_200);
    // With no time of its own, the evidence is dated by the event.
    assert.deepEqual(claimData[0], { firstTrafficAt: new Date(timestamp) });
  });

  it('emits only once under concurrent webhooks racing the claim', async () => {
    const { service, emitted, getFirstTrafficUpdates } = buildTrafficService();
    const payload = userEventPayload({ event: 'user.modified', ...freshConnection(1, 500) });
    await Promise.all([
      service.handleEvent('user.modified', payload, null),
      service.handleEvent('user.modified', payload, null),
      service.handleEvent('user.modified', payload, null),
    ]);
    assert.equal(emitted.filter((event) => event.type === 'user.first_traffic').length, 1);
    assert.equal(getFirstTrafficUpdates(), 3);
  });

  it('does not claim or emit first traffic for a profile that never connected', async () => {
    const { service, emitted, getFirstTrafficUpdates } = buildTrafficService();
    await service.handleEvent(
      'user.modified',
      userEventPayload({
        event: 'user.modified',
        userTraffic: {
          usedTrafficBytes: 0,
          lifetimeUsedTrafficBytes: 0,
          onlineAt: null,
          firstConnectedAt: null,
          lastConnectedNodeUuid: null,
        },
      }),
      null,
    );
    assert.equal(emitted.filter((event) => event.type === 'user.first_traffic').length, 0);
    assert.equal(getFirstTrafficUpdates(), 0);
  });

  it('fills the column with a months-old first connection and announces nothing', async () => {
    // The default envelope: the counter was reset (0 used), but the panel
    // remembers a first connection in January and 150 GB lifetime. The old rule
    // (a positive `usedTrafficBytes`) saw no traffic at all here; the new one
    // sees the connection — and knows it is not news.
    const { service, emitted, getFirstTrafficUpdates, claimData } = buildTrafficService();
    await service.handleEvent(
      'user.modified',
      userEventPayload({ event: 'user.modified', usedTrafficBytes: 0 }),
      null,
    );
    assert.equal(getFirstTrafficUpdates(), 1);
    assert.deepEqual(claimData[0], { firstTrafficAt: new Date('2026-01-14T11:40:09.000Z') });
    assert.equal(emitted.filter((event) => event.type === 'user.first_traffic').length, 0);
  });

  it('announces a first connection 23 hours old, and not one 25 hours old', async () => {
    for (const [hoursAgo, expected] of [
      [23, 1],
      [25, 0],
    ] as const) {
      const { service, emitted, getFirstTrafficUpdates } = buildTrafficService();
      await service.handleEvent(
        'user.modified',
        userEventPayload({ event: 'user.modified', ...freshConnection(hoursAgo * 60, 700) }),
        null,
      );
      assert.equal(getFirstTrafficUpdates(), 1, `${hoursAgo} h: the claim must be made either way`);
      assert.equal(
        emitted.filter((event) => event.type === 'user.first_traffic').length,
        expected,
        `${hoursAgo} h old`,
      );
    }
  });

  it('does not emit when local user cannot be resolved', async () => {
    const { service, emitted, getFirstTrafficUpdates } = buildTrafficService({
      subscription: null,
      userByTelegram: null,
    });
    await service.handleEvent(
      'user.modified',
      userEventPayload({ event: 'user.modified', ...freshConnection(2, 999), id: 9999 }),
      null,
    );
    assert.equal(emitted.filter((event) => event.type === 'user.first_traffic').length, 0);
    assert.equal(getFirstTrafficUpdates(), 0);
  });
});

/**
 * Expiry-warning events.
 *
 * Every panel rezeis serves raises ONE name for them, `user.expiration`, at the
 * hours the operator configured in Remnawave, carrying the distinguishing
 * number in the envelope `meta.expiration` rather than in `data` or in the
 * name. The four discrete names 2.7.4 raised instead
 * (`user.expires_in_72_hours`, `…_48_hours`, `…_24_hours`,
 * `user.expired_24_hours_ago`) are no longer mapped.
 */
describe('RemnawaveWebhookService expiry warnings', () => {
  it('stores the discrete names 2.7.4 raised and forwards none of them', async () => {
    for (const name of [
      'user.expires_in_72_hours',
      'user.expires_in_48_hours',
      'user.expires_in_24_hours',
      'user.expired_24_hours_ago',
    ]) {
      const { service, stored, emitted } = buildService();
      await service.handleEvent(name, userEventPayload({ event: name, usedTrafficBytes: 0 }), null);
      assert.deepEqual(stored, [name], `${name} still reaches the Activity Feed`);
      assert.deepEqual(emitted, [], `${name} was forwarded`);
    }
  });

  it('never tells a subscription with no end that it ends soon', async () => {
    // A row with no end takes no date from Remnawave (`withLocalOpenEndKept`),
    // and with it no report ABOUT the date: an expiry warning that reached only
    // such rows is stored and not forwarded — no card, no pop-up, no outbound
    // webhook. The double answers the dated statement with no row and the one
    // for rows with no end with one, which is what a lifetime subscription's
    // profile produces.
    for (const event of ['user.expiration', 'user.expired']) {
      const emitted: EmittedEvent[] = [];
      const service = new RemnawaveWebhookService(
        {
          remnawaveWebhookEvent: { create: async () => ({}) },
          subscription: {
            updateMany: async (args: ReconcileCall) => ({ count: args.where['expiresAt'] === null ? 1 : 0 }),
            findMany: async () => [],
            findFirst: async () => null,
          },
          user: { updateMany: async () => ({ count: 0 }), findUnique: async () => null },
        } as never,
        { webhookSecret: null } as never,
        { emit: (card: EmittedEvent) => emitted.push(card) } as never,
        { getPanelUserUsage: async () => null } as never,
        { build: async () => ({}) } as never,
        { create: async () => undefined } as never,
      );
      await service.handleEvent(
        event,
        userEventPayload({ event, usedTrafficBytes: 0, meta: { notConnectedAfterHours: null, expiration: 24 } }),
        null,
      );
      assert.deepEqual(emitted, [], `${event} about a subscription with no end was forwarded`);
    }
  });

  it('maps user.expiration to the expire-soon card', async () => {
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
    assert.equal(card.metadata?.['remnawaveId'], '4821');
    assert.equal(card.metadata?.['expireAt'], '2026-08-08T09:00:00.000Z');
  });

  it('carries the envelope meta.expiration onto the card', async () => {
    // The warning window travels in `meta.expiration`, not in `data`; mapping
    // the name alone would drop it, since nothing else reads `meta`.
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
    // The spec declares `meta` nullable, so the read must not throw.
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
 * panel is down, and must not make a REST call it has no id for.
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
      { event: 'user.first_connected', data: { id: 9, username: 'anna_vpn' } },
      null,
    );

    assert.deepEqual(usageCalls, ['9'], 'the panel is asked exactly once, for this profile');
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
      { event: 'user.first_connected', data: { id: 9 } },
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
      { event: 'user.first_connected', data: { id: 9, username: 'anna_vpn' } },
      null,
    );
    assert.deepEqual(usageCalls, ['9']);
    assert.deepEqual(stored, ['user.first_connected']);
    assert.equal(emitted.length, 1, 'the card is delivered anyway');
    assert.equal(emitted[0]!.metadata?.['usedTrafficBytes'], undefined);
    assert.equal(emitted[0]!.metadata?.['remnawaveUsername'], 'anna_vpn');
  });

  it('makes no panel call for a payload with no id to ask about', async () => {
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
    await service.handleEvent('user.expired', { data: { id: 9 } }, null);
    await service.handleEvent('user.disabled', { data: { id: 9 } }, null);
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
      // Notice builder + notification sink. Inert here: the traffic-limit
      // notice has its own spec, and these cases are about reconciliation.
      { build: async () => ({}) } as never,
      { create: async () => undefined } as never,
    );

    const startedAt = Date.now();
    await service.handleEvent(
      'user.first_connected',
      { event: 'user.first_connected', data: { id: 7, username: 'anna_vpn' } },
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
