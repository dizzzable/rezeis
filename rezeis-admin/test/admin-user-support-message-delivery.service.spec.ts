import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { AdminUserManagementController } from '../src/modules/users/controllers/admin-user-management.controller';
import { PointsWalletService } from '../src/modules/points/services/points-wallet.service';

/**
 * The admin support-message route, pinned at the CONTROLLER boundary.
 *
 * This spec used to assert the old contract exactly — `{ sent: true }` as the
 * whole response and a `deepStrictEqual` on the `create()` call — and that
 * exactness is the property worth keeping, so the assertions below are equally
 * literal about the contract that replaced it.
 *
 * What changed and why the old assertions could not survive:
 *
 *   - The route no longer calls `create()`. `create()` fans out through
 *     `void this.fanout(...)`, so it returns before a single byte leaves the
 *     process; a route built on it can only ever answer "a row was written".
 *     That is exactly how `{ sent: true }` came to be a literal — there was no
 *     delivery outcome in scope to report. The route now calls
 *     `sendOperatorMessage`, which is awaited.
 *   - The response is `{ eventId, outcomes[], sent }`, and `sent` is derived.
 *
 * The `create()`-was-not-called assertion below is not bookkeeping: it is what
 * stops the route quietly regressing to the fire-and-forget path, where every
 * assertion about `sent` would go vacuous because nothing could ever fail.
 */

const DELIVERED_TELEGRAM = {
  channel: 'telegram' as const,
  status: 'delivered' as const,
  reason: null,
  delivered: null,
  attempted: null,
};

const DELIVERED_WEBPUSH = {
  channel: 'webpush' as const,
  status: 'delivered' as const,
  reason: null,
  delivered: 2,
  attempted: 2,
};

describe('AdminUserManagementController support notifications', () => {
  it('keeps the current admin support-message routes on the management controller', () => {
    assert.equal(
      Reflect.getMetadata(PATH_METADATA, AdminUserManagementController.prototype.sendNotification),
      ':telegramId/notify',
    );
    assert.equal(
      Reflect.getMetadata(METHOD_METADATA, AdminUserManagementController.prototype.sendNotification),
      RequestMethod.POST,
    );
    // The availability probe the send dialog reads before it offers a channel.
    // Pinned here because the dialog is unusable without it: with no answer the
    // operator is offered nothing, which reads as "this user has no channels".
    assert.equal(
      Reflect.getMetadata(PATH_METADATA, AdminUserManagementController.prototype.getNotifyChannels),
      ':telegramId/notify/channels',
    );
    assert.equal(
      Reflect.getMetadata(
        METHOD_METADATA,
        AdminUserManagementController.prototype.getNotifyChannels,
      ),
      RequestMethod.GET,
    );
  });

  it('hands the operator message and channel selection to UserNotificationsService', async () => {
    const harness = createHarness({
      outcomes: [DELIVERED_TELEGRAM, DELIVERED_WEBPUSH],
    });

    const response = await harness.controller.sendNotification('12345', {
      message: 'Support answer',
    });

    // Exactly what reached the notification service — the property the old
    // assertion had and the reason it was worth keeping. An omitted `channels`
    // field means every channel, which is what a pre-selector SPA build posts.
    assert.deepStrictEqual(harness.state.operatorMessageCalls, [
      {
        userId: 'user-1',
        text: 'Support answer',
        channels: ['telegram', 'webpush'],
      },
    ]);
    // Exactly what the route answered.
    assert.deepStrictEqual(response, {
      eventId: 'event-1',
      outcomes: [DELIVERED_TELEGRAM, DELIVERED_WEBPUSH],
      sent: true,
    });
    // And it did NOT go down the fire-and-forget path. `create()` returns
    // before delivery starts, so a route using it has no outcome to report and
    // every `sent` assertion in this file would become unfalsifiable.
    assert.deepStrictEqual(harness.state.createCalls, []);
  });

  it('carries an explicit channel selection through untouched', async () => {
    const harness = createHarness({ outcomes: [DELIVERED_TELEGRAM] });

    await harness.controller.sendNotification('12345', {
      message: 'Telegram only',
      channels: ['telegram'],
    });

    assert.deepStrictEqual(harness.state.operatorMessageCalls, [
      { userId: 'user-1', text: 'Telegram only', channels: ['telegram'] },
    ]);
  });

  it('answers sent:false when delivery was requested and nothing got through', async () => {
    // THE assertion this route was missing. The shipped version returned a
    // literal `{ sent: true }`, so a dead Telegram relay and a push every
    // browser rejected both reached the operator as a green "Notification
    // sent" toast — the SPA takes its wording from this field.
    const harness = createHarness({
      outcomes: [
        {
          channel: 'telegram',
          status: 'failed',
          reason: 'relayUnavailable',
          delivered: null,
          attempted: null,
        },
        {
          channel: 'webpush',
          status: 'failed',
          reason: 'pushRejected',
          delivered: 0,
          attempted: 3,
        },
      ],
    });

    const response = await harness.controller.sendNotification('12345', {
      message: 'Nobody hears this',
      channels: ['telegram', 'webpush'],
    });

    assert.equal(response.sent, false);
    // The reasons survive to the operator rather than collapsing into one
    // boolean — the response is what the dialog renders per channel.
    assert.deepStrictEqual(
      response.outcomes.map((outcome) => [outcome.channel, outcome.status, outcome.reason]),
      [
        ['telegram', 'failed', 'relayUnavailable'],
        ['webpush', 'failed', 'pushRejected'],
      ],
    );
  });

  it('answers sent:false when every requested channel was unavailable', async () => {
    // A channel the user cannot receive on is not a delivery. Separated from
    // the case above because `unavailable` and `failed` are different statuses
    // and a rule that only recognised `failed` would report this as sent.
    const harness = createHarness({
      outcomes: [
        {
          channel: 'telegram',
          status: 'unavailable',
          reason: 'noTelegramId',
          delivered: null,
          attempted: null,
        },
        {
          channel: 'webpush',
          status: 'unavailable',
          reason: 'noSubscription',
          delivered: null,
          attempted: null,
        },
      ],
    });

    const response = await harness.controller.sendNotification('12345', {
      message: 'Unreachable',
      channels: ['telegram', 'webpush'],
    });

    assert.equal(response.sent, false);
  });

  it('answers sent:true when one of several channels got through', async () => {
    // Partial success is success for the operator's purpose: the subscriber has
    // the message. Also an anti-vacuity control for the two cases above — a
    // rule that answered `false` whenever anything was not delivered would
    // satisfy both of them and be wrong here.
    const harness = createHarness({
      outcomes: [
        DELIVERED_TELEGRAM,
        {
          channel: 'webpush',
          status: 'failed',
          reason: 'pushRejected',
          delivered: 0,
          attempted: 1,
        },
      ],
    });

    const response = await harness.controller.sendNotification('12345', {
      message: 'Half arrived',
      channels: ['telegram', 'webpush'],
    });

    assert.equal(response.sent, true);
  });

  it('answers sent:true for a feed-only send, where nothing was requested', async () => {
    // "Record it, tell nobody" is a supported operator choice. Nothing was
    // asked for, so nothing failed — this must not be reported as an error, and
    // it is the case that separates the real rule ("nothing requested, or
    // something delivered") from the simpler wrong one ("something delivered").
    const harness = createHarness({
      outcomes: [
        {
          channel: 'telegram',
          status: 'notSelected',
          reason: null,
          delivered: null,
          attempted: null,
        },
        {
          channel: 'webpush',
          status: 'notSelected',
          reason: null,
          delivered: null,
          attempted: null,
        },
      ],
    });

    const response = await harness.controller.sendNotification('12345', {
      message: 'Quietly recorded',
      channels: [],
    });

    assert.deepStrictEqual(harness.state.operatorMessageCalls, [
      { userId: 'user-1', text: 'Quietly recorded', channels: [] },
    ]);
    assert.equal(response.sent, true);
  });
});

// ── Harness ─────────────────────────────────────────────────────────────────

interface Outcome {
  readonly channel: 'telegram' | 'webpush';
  readonly status: 'delivered' | 'failed' | 'unavailable' | 'notSelected';
  readonly reason: string | null;
  readonly delivered: number | null;
  readonly attempted: number | null;
}

function createHarness(input: { readonly outcomes: readonly Outcome[] }) {
  const state = {
    operatorMessageCalls: [] as unknown[],
    /** Populated only if the route regresses to the fire-and-forget path. */
    createCalls: [] as unknown[],
  };

  const notifications = {
    sendOperatorMessage: async (call: unknown) => {
      state.operatorMessageCalls.push(call);
      return { eventId: 'event-1', outcomes: input.outcomes };
    },
    create: async (call: unknown) => {
      state.createCalls.push(call);
      return 'event-1';
    },
  };

  const controller = new AdminUserManagementController(
    {
      user: {
        findFirst: async (args: unknown) => {
          assert.deepStrictEqual(args, { where: { telegramId: 12345n } });
          return { id: 'user-1', telegramId: 12345n };
        },
      },
    } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    notifications as never,
    // RbacService (users:view_registration on Analytics detail)
    { hasPermission: async () => false } as never,
    {} as never,
    {} as never,
    {} as never, // PlansAdminService
    undefined as never, // UserBlockService
    { listForUser: async () => [], clear: async () => undefined } as never, // DeviceIntelligenceService
    new PointsWalletService(),
    { listForUser: async () => ({ items: [], nextCursor: null }) } as never,
  );

  return { controller, state };
}
