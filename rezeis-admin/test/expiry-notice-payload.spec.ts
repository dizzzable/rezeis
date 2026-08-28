import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SubscriptionStatus } from '@prisma/client';

import { AutoRenewService } from '../src/modules/auto-renew/auto-renew.service';

/**
 * The facts an expiry notice carries, and the notices that never fired.
 *
 * ── The gap ──────────────────────────────────────────────────────────────
 *
 * Six templates in the expiry family shipped with the bot-map module —
 * editable, toggleable, each with its own buttons, all wired into the
 * notification target resolver. Exactly two were ever created:
 * `expires_in_3_days` and `expires_in_1_days`. An operator could write the
 * copy for "your subscription has ended", switch it on, and no customer would
 * receive it, because nothing in the product created that row.
 *
 * ── The facts ────────────────────────────────────────────────────────────
 *
 * The message shows what the customer has — profile, plan, devices, traffic,
 * deadline. Only the first is local; the rest come from the VPN panel, which
 * can be down. Every case below that concerns the panel is about the same
 * rule: a missing figure is omitted, never guessed.
 */

const NOW = Date.now();

function subscriptionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub-1',
    userId: 'user-1',
    expiresAt: new Date(NOW + 3 * 24 * 60 * 60 * 1000),
    planSnapshot: { name: 'Standard' },
    trafficLimit: 50,
    deviceLimit: 3,
    remnawaveId: '4711',
    remnawavePanelId: 4711,
    remnawavePanelUsername: 'dizzable-w',
    ...overrides,
  };
}

function buildService(options: {
  readonly rows?: ReadonlyArray<Record<string, unknown>>;
  /** `null` makes every panel read fail, as an unreachable panel would. */
  readonly usage?: Record<string, unknown> | null;
  readonly devices?: number | null;
} = {}) {
  const created: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const queries: Array<Record<string, unknown>> = [];

  const prisma = {
    subscription: {
      findMany: async (args: { where: Record<string, unknown> }) => {
        queries.push(args.where);
        return options.rows ?? [subscriptionRow()];
      },
    },
    userNotificationEvent: { findMany: async () => [] },
  };

  const remnawave = {
    getPanelUserUsage: async () =>
      options.usage === undefined
        ? {
            username: 'dizzable-w',
            usedTrafficBytes: 12.4 * 1024 ** 3,
            status: 'ACTIVE',
            expireAt: null,
            trafficLimitBytes: 50 * 1024 ** 3,
            hwidDeviceLimit: 3,
          }
        : options.usage,
    strictListUserDevices: async () =>
      options.devices === null
        ? { kind: 'unavailable', retryAfterMs: null }
        : {
            kind: 'ok',
            value: {
              devices: Array.from({ length: options.devices ?? 2 }, (_v, i) => ({
                hwid: `hwid-${i}`,
              })),
            },
          },
  };

  const service = new AutoRenewService(
    prisma as never,
    {
      create: async (input: { type: string; payload: Record<string, unknown> }) => {
        created.push(input);
      },
    } as never,
    {} as never,
    { findPreferredForCharge: async () => null } as never,
    remnawave as never,
  );
  return { service, created, queries };
}

describe('the notices that never fired', () => {
  it('creates an "expired" notice for a subscription that just ended', async () => {
    const { service, created } = buildService({
      rows: [subscriptionRow({ expiresAt: new Date(NOW - 60 * 60 * 1000) })],
    });

    const count = await service.createExpiredNotices({
      daysAgo: 0,
      notificationType: 'expired',
    });

    assert.equal(count, 1);
    assert.equal(created[0].type, 'expired');
  });

  it('looks only at rows already marked EXPIRED, inside a bounded window', async () => {
    // A bare `status = EXPIRED` filter would re-notify somebody who left a year
    // ago, every time the 20-hour throttle aged out. The window is what stops
    // that, exactly as the warnings bound themselves to a horizon.
    const { service, queries } = buildService();
    await service.createExpiredNotices({ daysAgo: 1, notificationType: 'expired_1_day_ago' });

    assert.equal(queries[0]['status'], SubscriptionStatus.EXPIRED);
    const window = queries[0]['expiresAt'] as { gt: Date; lte: Date };
    assert.ok(window.gt instanceof Date && window.lte instanceof Date);
    // Roughly a day back, and three hours wide.
    assert.ok(window.lte.getTime() < NOW);
    assert.equal(window.lte.getTime() - window.gt.getTime(), 3 * 60 * 60 * 1000);
  });
});

describe('the facts a notice carries', () => {
  it('carries raw numbers, never rendered words', async () => {
    // The words are locale-dependent and the locale is not known here. Storing
    // "Безлимит" would send Russian to an English-speaking customer.
    const { service, created } = buildService();
    await service.createExpiryWarnings({ daysAhead: 3, notificationType: 'expires_in_3_days' });

    const payload = created[0].payload;
    assert.equal(payload['profile'], 'dizzable-w');
    assert.equal(payload['plan'], 'Standard');
    assert.equal(payload['trafficLimitGb'], 50);
    assert.equal(payload['trafficUsedGb'], 12.4);
    assert.equal(payload['deviceLimit'], 3);
    assert.equal(payload['devicesUsed'], 2);
    assert.equal(typeof payload['expiresAt'], 'string');
  });

  it('still sends the notice when the VPN panel is unreachable', async () => {
    // The local row knows the plan, the allowances and the deadline. Losing the
    // panel costs the used-traffic line; it must not cost the message.
    const { service, created } = buildService({ usage: null, devices: null });
    await service.createExpiryWarnings({ daysAhead: 3, notificationType: 'expires_in_3_days' });

    assert.equal(created.length, 1);
    const payload = created[0].payload;
    assert.equal(payload['trafficLimitGb'], 50);
    assert.equal(payload['deviceLimit'], 3);
    assert.equal('trafficUsedGb' in payload, false, 'an unmeasured figure must be absent');
    assert.equal('devicesUsed' in payload, false);
    // The profile name survives from the local column even with no panel.
    assert.equal(payload['profile'], 'dizzable-w');
  });

  it('does not count devices for an unlimited plan', async () => {
    // Counting bound devices against an unlimited allowance answers a question
    // nobody asked, and spends a second panel call per notification to do it.
    let deviceCalls = 0;
    const { service } = buildService({
      rows: [subscriptionRow({ deviceLimit: 0 })],
      usage: {
        username: 'dizzable-w',
        usedTrafficBytes: null,
        status: 'ACTIVE',
        expireAt: null,
        trafficLimitBytes: null,
        hwidDeviceLimit: 0,
      },
    });
    (service as unknown as { remnawaveApiService: { strictListUserDevices: () => unknown } })
      .remnawaveApiService.strictListUserDevices = () => {
      deviceCalls += 1;
      return { kind: 'ok', value: { devices: [] } };
    };

    await service.createExpiryWarnings({ daysAhead: 3, notificationType: 'expires_in_3_days' });
    assert.equal(deviceCalls, 0);
  });

  it('prefers the panel limits over the local snapshot', async () => {
    // Editing a profile directly in the VPN panel is a supported thing to do,
    // and a notice quoting the stale local number would contradict the cabinet
    // the customer is about to open.
    const { service, created } = buildService({
      usage: {
        username: 'renamed-profile',
        usedTrafficBytes: 1024 ** 3,
        status: 'ACTIVE',
        expireAt: null,
        trafficLimitBytes: 200 * 1024 ** 3,
        hwidDeviceLimit: 10,
      },
    });
    await service.createExpiryWarnings({ daysAhead: 3, notificationType: 'expires_in_3_days' });

    const payload = created[0].payload;
    assert.equal(payload['profile'], 'renamed-profile');
    assert.equal(payload['trafficLimitGb'], 200);
    assert.equal(payload['deviceLimit'], 10);
  });
});
