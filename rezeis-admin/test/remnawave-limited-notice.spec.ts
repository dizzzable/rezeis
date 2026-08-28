import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SubscriptionStatus } from '@prisma/client';

import { RemnawaveWebhookService } from '../src/modules/remnawave/services/remnawave-webhook.service';

/**
 * Telling a customer their traffic limit was reached.
 *
 * ── Why this could only ever live on the webhook ─────────────────────────
 *
 * The `limited` template has shipped since the bot-map module landed —
 * editable, toggleable, with its own buttons, wired into the notification
 * target resolver — and nothing ever created one. It could not have: a traffic
 * limit is reached by USAGE, so there is no clock a scheduled pass could watch.
 * The VPN panel is the only party that knows, and the webhook is where it says
 * so.
 *
 * ── The case that decides whether this is usable ─────────────────────────
 *
 * Remnawave repeats an event. Notifying on the state AFTER the write would
 * notify on every repeat, because by then every row reads LIMITED whether it
 * just got there or has been there a week. The transition is read before the
 * update for exactly that reason, and that is what the second test pins.
 */

function buildService(options: {
  readonly rows: ReadonlyArray<Record<string, unknown>>;
}) {
  const notifications: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];

  const prisma = {
    subscription: {
      findMany: async () => options.rows,
      updateMany: async (args: Record<string, unknown>) => {
        updates.push(args);
        return { count: options.rows.length };
      },
      update: async () => ({}),
    },
    remnawaveWebhookEvent: { create: async () => ({}) },
  };

  const service = new RemnawaveWebhookService(
    prisma as never,
    { webhookSecret: 'secret' } as never,
    { info: () => undefined, warn: () => undefined, error: () => undefined } as never,
    {} as never,
    { build: async () => ({ plan: 'Standard', trafficLimitGb: 50 }) } as never,
    {
      create: async (input: Record<string, unknown>) => {
        notifications.push(input);
      },
    } as never,
  );

  return { service, notifications, updates };
}

/** Drives the private reconciler the webhook handler calls. */
function reconcile(
  service: RemnawaveWebhookService,
  event: string,
  payload: Record<string, unknown>,
): Promise<void> {
  return (
    service as unknown as {
      reconcileSubscriptionFromEvent: (
        event: string,
        payload: Record<string, unknown>,
      ) => Promise<void>;
    }
  ).reconcileSubscriptionFromEvent(event, payload);
}

const SUBSCRIPTION = {
  id: 'sub-1',
  userId: 'user-1',
  expiresAt: new Date('2026-09-01T00:00:00.000Z'),
  planSnapshot: { name: 'Standard' },
  trafficLimit: 50,
  deviceLimit: 3,
  remnawaveId: '4711',
  remnawavePanelId: 4711,
  remnawavePanelUsername: 'rz_one',
};

describe('a subscription crossing into LIMITED', () => {
  it('notifies the customer', async () => {
    const { service, notifications } = buildService({
      rows: [{ ...SUBSCRIPTION, status: SubscriptionStatus.ACTIVE }],
    });

    await reconcile(service, 'user.limited', { data: { id: 4711 } });

    assert.equal(notifications.length, 1);
    assert.equal(notifications[0]['type'], 'limited');
    assert.equal(notifications[0]['userId'], 'user-1');
  });

  it('carries the same facts an expiry notice carries', async () => {
    // One builder for both, so a limit notice and an expiry notice describe the
    // same subscription in the same words. Two builders would drift the moment
    // one of them learned a new field.
    const { service, notifications } = buildService({
      rows: [{ ...SUBSCRIPTION, status: SubscriptionStatus.ACTIVE }],
    });

    await reconcile(service, 'user.limited', { data: { id: 4711 } });

    assert.deepStrictEqual(notifications[0]['payload'], {
      plan: 'Standard',
      trafficLimitGb: 50,
    });
  });

  it('says nothing on a repeat of the same event', async () => {
    // The case that decides whether this is usable at all. Remnawave repeats
    // events; a row already LIMITED has not crossed anything.
    const { service, notifications } = buildService({
      rows: [{ ...SUBSCRIPTION, status: SubscriptionStatus.LIMITED }],
    });

    await reconcile(service, 'user.limited', { data: { id: 4711 } });

    assert.deepStrictEqual(notifications, []);
  });

  it('still reconciles the row when the notice fails', async () => {
    // The webhook's job is to make our row agree with the panel, and that is
    // done by the time the notice is attempted. A customer left reading ACTIVE
    // while their access is restricted is a worse wrong than a missing message.
    const { service, updates } = buildService({
      rows: [{ ...SUBSCRIPTION, status: SubscriptionStatus.ACTIVE }],
    });
    (service as unknown as { userNotifications: { create: () => Promise<void> } })
      .userNotifications.create = () => Promise.reject(new Error('relay is down'));

    await reconcile(service, 'user.limited', { data: { id: 4711 } });

    assert.equal(updates.length, 1);
    assert.equal(
      (updates[0]['data'] as { status?: SubscriptionStatus }).status,
      SubscriptionStatus.LIMITED,
    );
  });
});

describe('other panel events', () => {
  it('does not send a limit notice for an expiry', async () => {
    // `expired` is emitted by the scheduled cycle, which dedups per user per
    // day. A second emitter here would send two messages for one event.
    const { service, notifications } = buildService({
      rows: [{ ...SUBSCRIPTION, status: SubscriptionStatus.ACTIVE }],
    });

    await reconcile(service, 'user.expired', { data: { id: 4711 } });

    assert.deepStrictEqual(notifications, []);
  });

  it('spends no extra read when the event cannot produce a notice', async () => {
    // The pre-update read exists only for the transition check. Doing it for
    // every panel event would add a query to the hottest path this service has.
    let reads = 0;
    const { service } = buildService({ rows: [] });
    (
      service as unknown as {
        prismaService: { subscription: { findMany: () => Promise<unknown[]> } };
      }
    ).prismaService.subscription.findMany = async () => {
      reads += 1;
      return [];
    };

    await reconcile(service, 'user.enabled', { data: { id: 4711 } });

    assert.equal(reads, 0);
  });
});
