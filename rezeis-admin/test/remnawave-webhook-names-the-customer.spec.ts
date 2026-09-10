import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SubscriptionStatus } from '@prisma/client';

import { RemnawaveWebhookService } from '../src/modules/remnawave/services/remnawave-webhook.service';

/**
 * EVERY USER-SCOPED WEBHOOK EVENT HAS TO NAME OUR CUSTOMER, NOT ONLY THE PANEL'S
 * PROFILE.
 *
 * Remnawave is the only party that knows a subscription is about to expire, has
 * expired, or has run through its traffic — there is no clock on our side that
 * could work it out. Its webhook is therefore the source of the three moments a
 * retention pop-up is actually for.
 *
 * Those events used to arrive carrying `remnawaveId` and `telegramId` and
 * nothing else. `resolveTriggerUserId` reads neither, so `show_hint` refused
 * every one of them, and three of the eight ready-made pop-up templates were
 * aimed at exactly these moments and could never fire. The local customer WAS
 * being resolved — one indexed query, already written — but only for
 * `user.first_connected`, and thrown away for everything else.
 *
 * These cases pin the property rather than the branch: any user-scoped event
 * the forwarder maps must carry `userId`. A future event added to the map gets
 * it without anybody remembering to, and removing the enrichment fails here
 * rather than in a customer's silence.
 */

interface Emitted {
  readonly type: string;
  readonly metadata: Record<string, unknown>;
}

const SUBSCRIPTION = {
  id: 'sub-1',
  status: SubscriptionStatus.ACTIVE,
  trafficLimit: 50,
  deviceLimit: 3,
  expiresAt: new Date('2026-09-19T00:00:00.000Z'),
  user: { id: 'user-1', telegramId: BigInt(4242), name: 'Дима', username: 'dizzable' },
};

function buildService(options: { readonly resolves: boolean } = { resolves: true }) {
  const emitted: Emitted[] = [];

  /** Every identity lookup the handler made — see the node-event case. */
  const lookups: string[] = [];

  const prisma = {
    remnawaveWebhookEvent: { create: async () => ({}) },
    subscription: {
      // The identity lookup `resolveLocalUserContext` makes.
      findFirst: async () => {
        lookups.push('subscription.findFirst');
        return options.resolves ? SUBSCRIPTION : null;
      },
      findMany: async () => [],
      updateMany: async () => ({ count: 0 }),
      update: async () => ({}),
    },
    user: { findUnique: async () => null, updateMany: async () => ({ count: 0 }) },
  };

  const service = new RemnawaveWebhookService(
    prisma as never,
    { webhookSecret: 'secret' } as never,
    {
      emit: (event: Emitted) => {
        emitted.push(event);
      },
      info: (type: string, _category: string, _message: string, metadata: Record<string, unknown>) => {
        emitted.push({ type, metadata });
      },
      warn: () => undefined,
      error: () => undefined,
    } as never,
    {} as never,
    { build: async () => ({}) } as never,
    { create: async () => undefined } as never,
  );

  return { service, emitted, lookups };
}

/** The forwarding path, as the controller calls it. */
function handle(
  service: RemnawaveWebhookService,
  event: string,
  payload: Record<string, unknown>,
): Promise<void> {
  return service.handleEvent(event, payload, null);
}

/** Remnawave 2.x flat shape: the profile id the local identity is found by. */
const PAYLOAD = { data: { id: 4711, username: 'rz_one', telegramId: '4242' } };

describe('a user-scoped event the panel forwards', () => {
  const RETENTION = [
    ['user.expires_in_24_hours', 'remnawave.user.expire_soon'],
    ['user.expired', 'remnawave.user.expired'],
    ['user.bandwidth_usage_threshold_reached', 'remnawave.user.bandwidth_threshold'],
    ['user.limited', 'remnawave.user.limited'],
  ] as const;

  for (const [incoming, forwarded] of RETENTION) {
    it(`names the customer on ${forwarded}`, async () => {
      const { service, emitted } = buildService();

      await handle(service, incoming, PAYLOAD);

      const event = emitted.find((candidate) => candidate.type === forwarded);
      assert.ok(event, `${incoming} was not forwarded as ${forwarded}`);
      assert.equal(
        event.metadata['userId'],
        'user-1',
        `${forwarded} carries no userId, so show_hint would refuse it`,
      );
    });
  }

  it('still carries the panel identity beside our own', async () => {
    // The operator card reads these. Naming our customer is an addition, not a
    // replacement — a card that stopped saying which profile it was about would
    // be a worse card.
    const { service, emitted } = buildService();

    await handle(service, 'user.expired', PAYLOAD);

    const event = emitted.find((candidate) => candidate.type === 'remnawave.user.expired');
    assert.ok(event);
    assert.equal(event.metadata['remnawaveId'], '4711');
  });

  it('forwards unchanged when the profile matches no local customer', async () => {
    // A profile created directly in the panel has no row here. That is an
    // ordinary state, not an error: the event still reaches the audit log and
    // the operator card, and only the pop-up half is unavailable.
    const { service, emitted } = buildService({ resolves: false });

    await handle(service, 'user.expired', PAYLOAD);

    const event = emitted.find((candidate) => candidate.type === 'remnawave.user.expired');
    assert.ok(event, 'the event was dropped when the customer could not be resolved');
    assert.equal(event.metadata['userId'], undefined);
  });

  it('leaves events that are not about a customer alone', async () => {
    // A node going offline names no customer and must not pay for a lookup.
    //
    // COUNTING THE LOOKUP, not just checking the metadata. Asserting only that
    // `userId` is absent made this case vacuous against its own stated claim:
    // widening `wantsCustomer` to fire for EVERY event still left it green,
    // because the enrichment is separately gated on the `user.` prefix. It
    // watched the outcome and not the cost it says it is about — and the cost
    // is one database read per node event, on an installation with hundreds of
    // node events per node per day.
    const { service, emitted, lookups } = buildService();

    // THE PAYLOAD MATTERS AS MUCH AS THE EVENT. `resolveLocalUserContext`
    // returns before touching Prisma unless the payload carries a
    // `remnawaveId` or a numeric `telegramId`, so a node event with neither
    // records no lookup WHATEVER the gate does — which is how the counter that
    // replaced the last vacuous version of this case was itself vacuous. This
    // one carries both, so a widened gate has something to look up.
    await handle(service, 'node.connection_lost', {
      data: { name: 'de-1', uuid: 'remna-1', telegramId: 4242 },
    });

    const event = emitted.find((candidate) => candidate.type === 'node.connection_lost');
    assert.ok(event);
    assert.equal(event.metadata['userId'], undefined);
    assert.deepEqual(lookups, [], 'a node event paid for a customer lookup');
  });

  it('still pays for the lookup on a customer event, so the count means something', async () => {
    // The anti-emptiness half. A fake that recorded nothing would satisfy the
    // case above for every event, which is the same shape of vacuity it was
    // just rescued from.
    const { service, lookups } = buildService();

    await handle(service, 'user.expired', { data: { uuid: 'remna-1' } });

    assert.deepEqual(lookups, ['subscription.findFirst']);
  });
});
