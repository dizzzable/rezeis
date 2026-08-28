import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RemnawaveWebhookService } from '../src/modules/remnawave/services/remnawave-webhook.service';

/**
 * Remnawave webhook payload sanitization
 * ─────────────────────────────────────
 * `RemnawaveWebhookEvent.payload` is served verbatim to the admin Activity
 * Feed by `getRecentEvents`, so a credential that reaches the column reaches
 * a browser response body. The panel nests the user object under `data`
 * (user events) and under `data.user` (hwid-device and torrent-blocker
 * events), so sanitization has to happen at every depth, not at the root.
 *
 * Every fixture below is shaped from the `RemnawaveWebhook*Dto` schemas in the
 * Remnawave API v3.2.1 OpenAPI document — same property names, same nesting,
 * same value formats — so a shape change in the panel shows up here.
 */

interface StoredEvent {
  readonly eventType: string;
  readonly payload: Record<string, unknown>;
}

interface ReconcileCall {
  readonly where: Record<string, unknown>;
  readonly data: Record<string, unknown>;
}

interface EmittedEvent {
  readonly type: string;
  readonly metadata?: Record<string, unknown>;
}

function buildService(): {
  service: RemnawaveWebhookService;
  stored: StoredEvent[];
  reconciled: ReconcileCall[];
  emitted: EmittedEvent[];
} {
  const stored: StoredEvent[] = [];
  const reconciled: ReconcileCall[] = [];
  const emitted: EmittedEvent[] = [];

  const prisma = {
    remnawaveWebhookEvent: {
      create: async (args: { data: StoredEvent }) => {
        stored.push(args.data);
        return {};
      },
    },
    subscription: {
      updateMany: async (args: ReconcileCall) => {
        reconciled.push(args);
        return { count: 1 };
      },
      findFirst: async () => null,
    },
    user: {
      updateMany: async () => ({ count: 0 }),
      findUnique: async () => null,
    },
  };
  const systemEvents = {
    emit: (event: EmittedEvent) => emitted.push(event),
    info: (type: string, _category: string, _message: string, metadata?: Record<string, unknown>) =>
      emitted.push({ type, metadata }),
  };

  const service = new RemnawaveWebhookService(
    prisma as never,
    { webhookSecret: null } as never,
    systemEvents as never,
    { getPanelUserUsage: async () => null } as never,
    // Notice builder + notification sink. Inert here: the traffic-limit
    // notice has its own spec, and these cases are about reconciliation.
    { build: async () => ({}) } as never,
    { create: async () => undefined } as never,
  );
  return { service, stored, reconciled, emitted };
}

/** Reads a dotted path out of a stored payload, `undefined` when absent. */
function at(payload: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((node, key) => {
    if (node === null || typeof node !== 'object') return undefined;
    return (node as Record<string, unknown>)[key];
  }, payload);
}

/**
 * `RemnawaveWebhookUserEventsDto` — the panel's user object lives directly
 * under `data`, credentials included.
 */
function userEventPayload(): Record<string, unknown> {
  return {
    scope: 'user',
    event: 'user.expired',
    timestamp: '2026-08-05T09:14:22.000Z',
    data: {
      id: 4821,
      // 3.x identity is the numeric `id`; `uuid` is the 2.x spelling that
      // `Subscription.remnawaveId` still holds and that reconcile matches on.
      uuid: '9d2f4c1e-7b3a-4f6d-9c58-2e1a7b4c9d30',
      shortUuid: 'aH3kQ9zR2mVt',
      username: 'anna_vpn',
      status: 'EXPIRED',
      trafficLimitBytes: 53_687_091_200,
      trafficLimitStrategy: 'MONTH',
      expireAt: '2026-08-05T09:00:00.000Z',
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
      userTraffic: {
        usedTrafficBytes: 53_687_091_200,
        lifetimeUsedTrafficBytes: 161_061_273_600,
        onlineAt: '2026-08-05T09:11:03.000Z',
        firstConnectedAt: '2026-01-14T11:40:09.000Z',
        lastConnectedNodeUuid: '5b9c0e34-2a71-4d8f-9b06-1c7a4e2d8f50',
      },
    },
    meta: { expiration: 0 },
  };
}

/**
 * `RemnawaveWebhookTorrentBlockerEventsDto` — same user object one level
 * deeper (`data.user`), plus the enforcement report carrying the customer's
 * real IP and the address they were reaching.
 */
function torrentBlockerPayload(): Record<string, unknown> {
  const user = userEventPayload()['data'] as Record<string, unknown>;
  return {
    scope: 'torrent_blocker',
    event: 'torrent_blocker.user_blocked',
    timestamp: '2026-08-05T09:20:00.000Z',
    data: {
      node: {
        uuid: '2a6f8d13-4e07-4b95-8c2d-9f1e3a5b7c60',
        id: 12,
        name: 'de-frankfurt-01',
        address: '10.20.30.40',
        port: 2222,
        proxyUrl: 'socks5://panel:pr0xy-p4ss@10.20.30.40:1080',
        isConnected: true,
        isDisabled: false,
        countryCode: 'DE',
        configProfile: {
          activeConfigProfileUuid: '8f3b1c26-7a94-4d0e-b153-2c6a9e4f8d71',
          activeInbounds: [
            {
              uuid: '4d7e2a05-1c83-4f6b-9a20-5e8c3b1d7f94',
              tag: 'VLESS_REALITY',
              type: 'vless',
              network: 'tcp',
              security: 'reality',
              port: 443,
              rawInbound: { privateKey: 'REALITY-PRIVATE-KEY', shortIds: ['a1b2c3d4'] },
            },
          ],
        },
        provider: {
          uuid: '6b2c9f41-3d58-4a17-8e06-1f4b7d2a9c53',
          name: 'Hetzner',
          loginUrl: 'https://provider.example.com/auto-login?token=pr0v1der-t0ken',
        },
        usersOnline: 87,
      },
      user,
      report: {
        actionReport: {
          blocked: true,
          ip: '203.0.113.77',
          blockDuration: 3600,
          willUnblockAt: '2026-08-05T10:20:00.000Z',
          userId: '4821',
          processedAt: '2026-08-05T09:20:00.000Z',
        },
        xrayReport: {
          email: '4821.anna_vpn',
          level: 0,
          protocol: 'vless',
          network: 'tcp',
          source: '203.0.113.77:51544',
          destination: 'tracker.example-torrents.org:6969',
          routeTarget: 'tracker.example-torrents.org:6969',
          originalTarget: 'tracker.example-torrents.org:6969',
          inboundTag: 'VLESS_REALITY',
          inboundName: 'de-frankfurt-01',
          inboundLocal: '10.20.30.40:443',
          outboundTag: 'BLOCK',
          ts: 1785921600,
        },
      },
    },
  };
}

describe('RemnawaveWebhookService payload sanitization — user events', () => {
  it('strips the VLESS, Trojan and Shadowsocks credentials nested under data', async () => {
    const { service, stored } = buildService();
    await service.handleEvent('user.expired', userEventPayload(), null);

    const payload = stored[0]!.payload;
    // The three protocol credentials that authenticate the customer.
    assert.notEqual(at(payload, 'data.trojanPassword'), 'Tr0jan-l1ve-s3cret');
    assert.notEqual(at(payload, 'data.vlessUuid'), '7c4e1b90-5d62-4a3f-8e19-4b7d0c2a6f85');
    assert.notEqual(at(payload, 'data.ssPassword'), 'Sh4d0wS0cks-l1ve-s3cret');
    // No credential value survives anywhere in the serialized column.
    const serialized = JSON.stringify(payload);
    assert.equal(serialized.includes('Tr0jan-l1ve-s3cret'), false);
    assert.equal(serialized.includes('7c4e1b90-5d62-4a3f-8e19-4b7d0c2a6f85'), false);
    assert.equal(serialized.includes('Sh4d0wS0cks-l1ve-s3cret'), false);
  });

  it('strips the subscription link and the shortUuid it is built from', async () => {
    const { service, stored } = buildService();
    await service.handleEvent('user.expired', userEventPayload(), null);

    // Either one hands the full config — server list and keys — to whoever
    // holds it, so neither may sit in a column the Activity Feed renders.
    const serialized = JSON.stringify(stored[0]!.payload);
    assert.equal(serialized.includes('https://sub.example.com/aH3kQ9zR2mVt'), false);
    assert.equal(serialized.includes('aH3kQ9zR2mVt'), false);
  });

  it('keeps the identifiers and runtime state the Activity Feed and cards read', async () => {
    const { service, stored, emitted } = buildService();
    await service.handleEvent('user.expired', userEventPayload(), null);

    const payload = stored[0]!.payload;
    // `vlessUuid` goes but `uuid` / `id` stay — they are identity, not access.
    assert.equal(at(payload, 'data.uuid'), '9d2f4c1e-7b3a-4f6d-9c58-2e1a7b4c9d30');
    assert.equal(at(payload, 'data.id'), 4821);
    assert.equal(at(payload, 'data.username'), 'anna_vpn');
    assert.equal(at(payload, 'data.status'), 'EXPIRED');
    assert.equal(at(payload, 'data.telegramId'), 858568447);
    assert.equal(at(payload, 'data.userTraffic.usedTrafficBytes'), 53_687_091_200);
    assert.deepEqual(at(payload, 'data.activeInternalSquads'), [
      { uuid: '3e8a2d17-9f04-4c6b-a512-8d0f3b7e1c94', name: 'EU-Premium' },
    ]);

    // The card metadata is built from the RAW payload and is unaffected.
    assert.equal(emitted[0]?.metadata?.['remnawaveUsername'], 'anna_vpn');
    assert.equal(emitted[0]?.metadata?.['remnawaveId'], '9d2f4c1e-7b3a-4f6d-9c58-2e1a7b4c9d30');
    // …including the counter read out of the nested `userTraffic` container,
    // which is where both supported panel versions put it. The formatter only
    // renders the traffic line when this key is a number, so leaving it unset
    // silently strips consumption from every Remnawave card.
    assert.equal(emitted[0]?.metadata?.['usedTrafficBytes'], 53_687_091_200);
    // `meta.expiration` is 0 here on purpose: 0 is a legitimate value and a
    // truthiness check would drop it.
    assert.equal(emitted[0]?.metadata?.['remnawaveExpiration'], 0);
  });

  it('reconciles the subscription end to end from the fields it needs', async () => {
    const { service, stored, reconciled } = buildService();
    await service.handleEvent('user.expired', userEventPayload(), null);

    // Reconcile runs off the raw payload, after sanitization — the ordering
    // in `handleEvent` only holds while `sanitizePayload` stays non-mutating.
    assert.equal(reconciled.length, 1);
    assert.deepEqual(reconciled[0]!.where, {
      remnawaveId: '9d2f4c1e-7b3a-4f6d-9c58-2e1a7b4c9d30',
      status: { not: 'DELETED' },
    });
    assert.equal(reconciled[0]!.data['status'], 'EXPIRED');
    assert.deepEqual(reconciled[0]!.data['expiresAt'], new Date('2026-08-05T09:00:00.000Z'));
    assert.equal(reconciled[0]!.data['trafficLimit'], 50);
    assert.equal(reconciled[0]!.data['deviceLimit'], 3);

    // …and the same fields survive into the stored payload.
    const payload = stored[0]!.payload;
    assert.equal(at(payload, 'data.expireAt'), '2026-08-05T09:00:00.000Z');
    assert.equal(at(payload, 'data.trafficLimitBytes'), 53_687_091_200);
    assert.equal(at(payload, 'data.hwidDeviceLimit'), 3);
  });

  it('does not mutate the raw payload the reconcile and card paths read', async () => {
    const { service } = buildService();
    const payload = userEventPayload();
    const before = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;

    await service.handleEvent('user.expired', payload, null);

    assert.deepEqual(payload, before);
  });
});

describe('RemnawaveWebhookService payload sanitization — nested user objects', () => {
  it('strips the credentials two levels down at data.user in a torrent-blocker event', async () => {
    const { service, stored } = buildService();
    await service.handleEvent('torrent_blocker.user_blocked', torrentBlockerPayload(), null);

    const payload = stored[0]!.payload;
    assert.notEqual(at(payload, 'data.user.trojanPassword'), 'Tr0jan-l1ve-s3cret');
    assert.notEqual(at(payload, 'data.user.vlessUuid'), '7c4e1b90-5d62-4a3f-8e19-4b7d0c2a6f85');
    assert.notEqual(at(payload, 'data.user.ssPassword'), 'Sh4d0wS0cks-l1ve-s3cret');

    const serialized = JSON.stringify(payload);
    assert.equal(serialized.includes('Tr0jan-l1ve-s3cret'), false);
    assert.equal(serialized.includes('7c4e1b90-5d62-4a3f-8e19-4b7d0c2a6f85'), false);
    assert.equal(serialized.includes('Sh4d0wS0cks-l1ve-s3cret'), false);
    assert.equal(serialized.includes('https://sub.example.com/aH3kQ9zR2mVt'), false);
    // Identity survives at depth too, so the feed can still name the user.
    assert.equal(at(payload, 'data.user.username'), 'anna_vpn');
  });

  it('keeps the customer IP and the address they reached out of the column', async () => {
    const { service, stored } = buildService();
    await service.handleEvent('torrent_blocker.user_blocked', torrentBlockerPayload(), null);

    const payload = stored[0]!.payload;
    const serialized = JSON.stringify(payload);
    // Nothing consumes either today (anti-fraud takes its IPs live from the
    // panel `ip-control` API), and both are the records a VPN must not keep.
    assert.equal(serialized.includes('203.0.113.77'), false);
    assert.equal(serialized.includes('tracker.example-torrents.org'), false);
    // The enforcement decision itself is still auditable.
    assert.equal(at(payload, 'data.report.actionReport.blocked'), true);
    assert.equal(at(payload, 'data.report.actionReport.userId'), '4821');
    assert.equal(at(payload, 'data.report.actionReport.blockDuration'), 3600);
    assert.equal(at(payload, 'data.report.xrayReport.outboundTag'), 'BLOCK');
  });

  it('strips node-side secrets carried alongside the user object', async () => {
    const { service, stored } = buildService();
    await service.handleEvent('torrent_blocker.user_blocked', torrentBlockerPayload(), null);

    const serialized = JSON.stringify(stored[0]!.payload);
    // Reality private material, the proxy URL's embedded password and the
    // provider auto-login link are secrets even though no customer owns them.
    assert.equal(serialized.includes('REALITY-PRIVATE-KEY'), false);
    assert.equal(serialized.includes('pr0xy-p4ss'), false);
    assert.equal(serialized.includes('pr0v1der-t0ken'), false);
    // Node identity the feed labels rows with is untouched.
    assert.equal(at(stored[0]!.payload, 'data.node.name'), 'de-frankfurt-01');
    assert.equal(at(stored[0]!.payload, 'data.node.countryCode'), 'DE');
  });
});

describe('RemnawaveWebhookService payload sanitization — allow-list behaviour', () => {
  it('stores a payload that carries no secrets unchanged', async () => {
    const { service, stored } = buildService();
    // `RemnawaveWebhookNodeEventsDto`, credential-free subset.
    const payload = {
      scope: 'node',
      event: 'node.connection_lost',
      timestamp: '2026-08-05T09:30:00.000Z',
      data: {
        uuid: '2a6f8d13-4e07-4b95-8c2d-9f1e3a5b7c60',
        id: 12,
        name: 'de-frankfurt-01',
        address: '10.20.30.40',
        port: 2222,
        isConnected: false,
        isDisabled: false,
        isConnecting: true,
        countryCode: 'DE',
        lastStatusChange: '2026-08-05T09:29:58.000Z',
        lastStatusMessage: 'connection refused',
        trafficLimitBytes: 0,
        trafficUsedBytes: 8_589_934_592,
        tags: ['eu', 'premium'],
        usersOnline: 0,
        versions: { xray: '25.3.6', node: '2.1.4' },
        system: {
          info: { arch: 'x86_64', cpus: 8, cpuModel: 'AMD EPYC 7502P', hostname: 'fra-01' },
          stats: { memoryFree: 2_147_483_648, memoryUsed: 6_442_450_944, uptime: 918_273, loadAvg: [0.4, 0.7, 0.9] },
        },
      },
    };

    await service.handleEvent('node.connection_lost', payload, null);

    assert.deepEqual(stored[0]!.payload, payload);
  });

  it('withholds a field the allow-list does not know, instead of storing it', async () => {
    const { service, stored } = buildService();
    // The failure mode a deny-list has and an allow-list does not: whatever
    // the next panel release adds is withheld until a human vets it.
    await service.handleEvent(
      'user.modified',
      {
        event: 'user.modified',
        data: {
          uuid: '9d2f4c1e-7b3a-4f6d-9c58-2e1a7b4c9d30',
          username: 'anna_vpn',
          hysteriaObfsPassword: 'a-credential-remnawave-has-not-shipped-yet',
        },
      },
      null,
    );

    const payload = stored[0]!.payload;
    assert.equal(
      JSON.stringify(payload).includes('a-credential-remnawave-has-not-shipped-yet'),
      false,
    );
    // The key stays so an operator can see something was withheld.
    assert.equal(at(payload, 'data.hysteriaObfsPassword'), '[redacted]');
    assert.equal(at(payload, 'data.username'), 'anna_vpn');
  });

  it('strips the panel admin password from a service login-attempt event', async () => {
    const { service, stored } = buildService();
    // `RemnawaveWebhookServiceEventsDto` — `data.loginAttempt.password` is an
    // ADMIN credential, and the old root-only sanitizer never saw it.
    await service.handleEvent(
      'service.login_attempt_failed',
      {
        scope: 'service',
        event: 'service.login_attempt_failed',
        timestamp: '2026-08-05T09:40:00.000Z',
        data: {
          loginAttempt: {
            username: 'root-admin',
            ip: '198.51.100.9',
            userAgent: 'Mozilla/5.0 (X11; Linux x86_64)',
            description: 'invalid password',
            password: 'Adm1n-Pa55w0rd!',
          },
        },
      },
      null,
    );

    const payload = stored[0]!.payload;
    const serialized = JSON.stringify(payload);
    assert.equal(serialized.includes('Adm1n-Pa55w0rd!'), false);
    assert.equal(serialized.includes('198.51.100.9'), false);
    assert.equal(at(payload, 'data.loginAttempt.username'), 'root-admin');
    assert.equal(at(payload, 'data.loginAttempt.description'), 'invalid password');
  });

  it('strips the device binding id and request IP from an hwid-device event', async () => {
    const { service, stored } = buildService();
    // `RemnawaveWebhookUserHwidDevicesEventsDto` — user at `data.user`, the
    // device fingerprint at `data.hwidUserDevice`.
    await service.handleEvent(
      'user_hwid_devices.added',
      {
        scope: 'user_hwid_devices',
        event: 'user_hwid_devices.added',
        timestamp: '2026-08-05T09:50:00.000Z',
        data: {
          user: userEventPayload()['data'],
          hwidUserDevice: {
            hwid: 'HWID-9f4c2a10-device-binding-secret',
            userId: 4821,
            platform: 'iOS',
            osVersion: '18.2',
            deviceModel: 'iPhone 15 Pro',
            userAgent: 'Happ/2.4 (iOS 18.2)',
            requestIp: '203.0.113.77',
            createdAt: '2026-08-05T09:50:00.000Z',
            updatedAt: '2026-08-05T09:50:00.000Z',
          },
        },
      },
      null,
    );

    const payload = stored[0]!.payload;
    const serialized = JSON.stringify(payload);
    assert.equal(serialized.includes('HWID-9f4c2a10-device-binding-secret'), false);
    assert.equal(serialized.includes('203.0.113.77'), false);
    assert.equal(serialized.includes('iPhone 15 Pro'), false);
    assert.equal(serialized.includes('Tr0jan-l1ve-s3cret'), false);
    // Enough is left to render the row: which panel user, when.
    assert.equal(at(payload, 'data.hwidUserDevice.userId'), 4821);
    assert.equal(at(payload, 'data.user.username'), 'anna_vpn');
  });
});
