import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BroadcastMessageStatus, BroadcastStatus } from '@prisma/client';

import { BroadcastDeliveryService } from '../src/modules/broadcast/services/broadcast-delivery.service';
import { RELAY_CIRCUIT_BREAKER_THRESHOLD } from '../src/modules/broadcast/broadcast.constants';

/**
 * What a broadcast row is allowed to claim
 * ════════════════════════════════════════
 * `SENT` used to mean `feedOk` — that `userNotifications.create()` returned.
 * That call writes a row in the panel's OWN database and then fires the
 * Telegram fanout with `void this.fanout(...)`, so the value it returns is
 * evidence of a local insert and nothing else. A broadcast reported success
 * whether or not anything crossed the network to the cabinet, let alone
 * reached Telegram. The proof was already in hand and discarded: the reiwa bot
 * echoes back Telegram's own message id.
 *
 * These tests pin the replacement rule and its three edges. They are written
 * against `deliverBatch` rather than against a helper, because a rule about
 * what a status means is only worth anything at the point the status is
 * written — a unit test of a predicate would pass just as happily with the
 * predicate wired to nothing.
 *
 * The distinctions that matter, and why each needs its own test:
 *
 *  - `unconfirmed` is not a delivery. It is a 2xx with no message id, which on
 *    this path means the recipient blocked the bot, their `telegramId` is not
 *    a Telegram id, or the bot refused the payload. All three mean the message
 *    did not arrive. Marking it SENT is the original defect in miniature.
 *  - `timeout` is not a verdict at all — another attempt can still change it,
 *    so the row must stay PENDING rather than be written off.
 *  - `disabled` is not a failure. Nothing was attempted, so nothing unproven
 *    is being claimed, and the cabinet feed is a real delivery surface.
 */

interface MessageUpdate {
  readonly where: { readonly id: string };
  readonly data: Record<string, unknown>;
}

interface FeedRow {
  readonly userId: string;
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

function harness(input: {
  readonly recipients: number;
  readonly relayStatus: string;
  readonly messageId?: number | null;
  readonly feedOk?: boolean;
  readonly telegramId?: bigint | null;
  /**
   * Message ids whose recipient ALREADY has the cabinet-feed row for this
   * broadcast — the state a re-run finds, whatever put it there.
   */
  readonly feedRowsFor?: readonly string[];
  /** Message rows that start FAILED, i.e. what `retryBatch` re-drives. */
  readonly startFailed?: boolean;
}) {
  const updates: MessageUpdate[] = [];
  const updateManyCalls: Array<Record<string, unknown>> = [];
  const relayCalls: Array<{ eventId?: string }> = [];
  const feedCreates: unknown[] = [];
  const ids = Array.from({ length: input.recipients }, (_, i) => `message-${i + 1}`);
  const status = input.relayStatus;
  const messageId = input.messageId ?? null;

  /**
   * The cabinet feed, modelled rather than stubbed to a boolean: `create`
   * writes into it and the service's lookup reads back out of it, so "did this
   * recipient get a second row" is answered by the same table on both sides.
   */
  const feedRows: FeedRow[] = (input.feedRowsFor ?? []).map((id) => ({
    userId: `user-${ids.indexOf(id) + 1}`,
    type: 'broadcast',
    payload: { broadcastId: 'broadcast-1', broadcastMessageId: id, text: 'Hello' },
  }));

  // Rows the service has not written a terminal status for are still PENDING;
  // the circuit-breaker branch counts exactly those.
  const settled = new Set<string>();

  const prisma = {
    userNotificationEvent: {
      findMany: async (args: {
        readonly where: {
          readonly userId: { readonly in: readonly string[] };
          readonly type: string;
          readonly payload: { readonly path: readonly string[]; readonly equals: string };
        };
      }) => {
        const { where } = args;
        return feedRows
          .filter(
            (row) =>
              where.userId.in.includes(row.userId) &&
              row.type === where.type &&
              row.payload[where.payload.path[0]] === where.payload.equals,
          )
          .map((row) => ({ payload: row.payload }));
      },
    },
    broadcast: {
      findUnique: async (args: { readonly select?: { readonly payload?: boolean } }) => {
        if (args.select?.payload) {
          return {
            id: 'broadcast-1',
            status: BroadcastStatus.PROCESSING,
            payload: { text: 'Hello', mediaType: 'none', parseMode: 'HTML' },
            promoCode: null,
          };
        }
        return { status: BroadcastStatus.PROCESSING };
      },
      update: async () => undefined,
    },
    broadcastMessage: {
      findMany: async () => ids.map((id, i) => ({ id, userId: `user-${i + 1}` })),
      update: async (args: MessageUpdate) => {
        if (typeof args.data['status'] === 'string') settled.add(args.where.id);
        updates.push(args);
      },
      updateMany: async (args: { readonly data: Record<string, unknown> }) => {
        // `retryBatch` resets FAILED rows to PENDING before re-delivering.
        // That is the opposite of a settlement, so it must not be recorded as
        // one — the circuit-breaker bookkeeping below counts what is still
        // owed, and treating the reset as a settlement would zero it.
        if (args.data['status'] === BroadcastMessageStatus.PENDING) {
          for (const id of ids) settled.delete(id);
          return { count: ids.length };
        }
        updateManyCalls.push(args.data);
        const count = ids.length - settled.size;
        for (const id of ids) settled.add(id);
        return { count };
      },
      count: async (args: { readonly where: { readonly status: BroadcastMessageStatus } }) => {
        if (args.where.status === BroadcastMessageStatus.PENDING) {
          return ids.length - settled.size;
        }
        return 0;
      },
    },
    user: {
      findUnique: async () => ({
        telegramId: input.telegramId === undefined ? 12345n : input.telegramId,
        email: null,
      }),
    },
  };

  const service = new BroadcastDeliveryService(
    prisma as never,
    { get: () => null } as never,
    { info: () => undefined } as never,
    {
      create: async (call: { userId: string; type: string; payload: Record<string, unknown> }) => {
        feedCreates.push(call);
        if (input.feedOk === false) throw new Error('feed down');
        feedRows.push({ userId: call.userId, type: call.type, payload: call.payload });
        return `evt-${feedCreates.length}`;
      },
    } as never,
    { getDecryptedBotToken: async () => null } as never,
    {
      isEnabled: status !== 'disabled',
      notifyUser: async (call: { eventId?: string }) => {
        relayCalls.push(call);
        return {
          status,
          messageId,
          httpStatus: status === 'confirmed' ? 200 : status === 'unconfirmed' ? 204 : null,
          detail: null,
        };
      },
    } as never,
    // The relay queue producer. `deliverBatch` never reaches it (the channel
    // post belongs to staging), but the service now requires it, and a stub
    // that records nothing would hide a call rather than fail on one.
    {
      isEnabled: true,
      enqueue: async (event: string) => {
        throw new Error(`deliverBatch must not enqueue relay events (got ${event})`);
      },
    } as never,
  );

  if (input.startFailed === true) for (const id of ids) settled.add(id);

  return { service, updates, updateManyCalls, relayCalls, feedCreates, feedRows, ids };
}

const statusesWritten = (updates: MessageUpdate[]): unknown[] =>
  updates.map((u) => u.data['status']).filter((s) => s !== undefined);

describe('a broadcast row only claims what the relay proved', () => {
  it('marks SENT on a confirmed relay and keeps the Telegram message id', async () => {
    const h = harness({ recipients: 1, relayStatus: 'confirmed', messageId: 777 });

    const result = await h.service.deliverBatch('broadcast-1', h.ids);

    assert.deepStrictEqual(result, { sent: 1, failed: 0, unresolved: 0 });
    assert.equal(h.updates[0]?.data['status'], BroadcastMessageStatus.SENT);
    assert.equal(h.updates[0]?.data['telegramMessageId'], 777n);
  });

  it('marks FAILED on an unconfirmed relay even though the cabinet feed row landed', async () => {
    // The exact shape of the old defect: `feedOk` is true, so this row used to
    // be SENT. The relay answered 2xx with no message id, which on this path
    // means blocked bot / bad id / refused payload — the subscriber got
    // nothing on Telegram.
    const h = harness({ recipients: 1, relayStatus: 'unconfirmed' });

    const result = await h.service.deliverBatch('broadcast-1', h.ids);

    assert.deepStrictEqual(result, { sent: 0, failed: 1, unresolved: 0 });
    assert.deepStrictEqual(statusesWritten(h.updates), [BroadcastMessageStatus.FAILED]);
  });

  it('leaves a timed-out relay PENDING so a re-run of the batch can still deliver it', async () => {
    // A timeout is not a verdict — the cabinet may be mid-restart. Writing the
    // row off as FAILED here would be as wrong as writing it up as SENT: both
    // are claims, and neither attempt has finished.
    const h = harness({ recipients: 1, relayStatus: 'timeout' });

    const result = await h.service.deliverBatch('broadcast-1', h.ids);

    assert.deepStrictEqual(result, { sent: 0, failed: 0, unresolved: 1 });
    assert.deepStrictEqual(statusesWritten(h.updates), [], 'no status may be written yet');
    // The attempt is still recorded on the row so an operator looking at a
    // stuck broadcast can see why.
    assert.equal(h.updates[0]?.data['errorMessage'], 'telegram_relay_timeout');
  });

  it('writes the stragglers off as FAILED once the caller says no re-run is coming', async () => {
    // Otherwise `checkAndFinalize` never finalizes: it refuses to complete a
    // broadcast while any row is PENDING, so an unresolved row would leave the
    // broadcast PROCESSING forever.
    const h = harness({ recipients: 1, relayStatus: 'timeout' });

    const result = await h.service.deliverBatch('broadcast-1', h.ids, { isFinalAttempt: true });

    assert.deepStrictEqual(result, { sent: 0, failed: 1, unresolved: 0 });
    assert.deepStrictEqual(statusesWritten(h.updates), [BroadcastMessageStatus.FAILED]);
  });

  it('marks SENT via the feed when the relay was never configured, recording the skip', async () => {
    // `disabled` means the client returned without making a request. Nothing
    // was attempted, so there is no unproven claim — and the cabinet feed plus
    // web-push are a real surface. Marking a whole broadcast FAILED because a
    // deployment has no REIWA_URL would be a lie in the other direction.
    const h = harness({ recipients: 1, relayStatus: 'disabled' });

    const result = await h.service.deliverBatch('broadcast-1', h.ids);

    assert.deepStrictEqual(result, { sent: 1, failed: 0, unresolved: 0 });
    assert.equal(h.updates[0]?.data['status'], BroadcastMessageStatus.SENT);
    assert.equal(h.updates[0]?.data['telegramMessageId'], null);
    // The green row still says the Telegram leg did not happen.
    assert.equal(h.updates[0]?.data['errorMessage'], 'telegram_skipped_disabled');
  });
});

describe('re-running a batch does not re-deliver what it already delivered', () => {
  it('keys the Telegram relay on the broadcast message, not on the feed row', async () => {
    // The cabinet event id was the natural key while a batch could only run
    // once: one feed row, one notify, same CUID. Retries break that — a re-run
    // mints a NEW feed row and therefore a new CUID, and the reiwa bot's
    // idempotency cache is the only thing standing between a false-negative
    // timeout and a second copy of the same broadcast in someone's Telegram.
    // An id it has never seen is an id it will happily deliver.
    const h = harness({ recipients: 1, relayStatus: 'confirmed', messageId: 5 });

    await h.service.deliverBatch('broadcast-1', h.ids);

    assert.equal(h.relayCalls[0]?.eventId, 'broadcast:message-1');
  });

  it('does not write a second cabinet-feed row when the batch is re-run', async () => {
    // The recipient already has their feed row — a previous pass wrote it and
    // only the Telegram hop timed out. Writing another would give the
    // subscriber the same broadcast twice in their in-app feed because a
    // network hop failed once.
    //
    // Seeded as a FEED ROW, not as an `errorMessage` on the message. The row
    // is the fact; the message-row reason was a proxy for it, and a proxy an
    // operator can clear (`retryBatch` does exactly that) is a proxy that
    // answers "no feed row" while one is sitting right there.
    const h = harness({
      recipients: 1,
      relayStatus: 'confirmed',
      messageId: 5,
      feedRowsFor: ['message-1'],
    });

    const result = await h.service.deliverBatch('broadcast-1', h.ids);

    assert.deepStrictEqual(h.feedCreates, [], 'the feed row already exists');
    // The Telegram leg still runs — that is the leg that failed last time.
    assert.equal(h.relayCalls.length, 1);
    assert.deepStrictEqual(result, { sent: 1, failed: 0, unresolved: 0 });
  });

  it('still writes the feed row on a first attempt', async () => {
    // The counterpart: the skip must key on a row that exists, not fire
    // whenever the evidence is merely absent-ish.
    const h = harness({ recipients: 1, relayStatus: 'confirmed', messageId: 5 });

    await h.service.deliverBatch('broadcast-1', h.ids);

    assert.equal(h.feedCreates.length, 1);
    // And it stamps the message id, which is what makes the lookup on the next
    // pass exact rather than "someone got something about this broadcast".
    const created = h.feedCreates[0] as { readonly payload: Record<string, unknown> };
    assert.equal(created.payload['broadcastMessageId'], 'message-1');
  });

  it('mints no feed row when an operator presses "retry failed"', async () => {
    // The operator-driven path, and the one the `errorMessage` proxy could not
    // survive: `retryBatch` CLEARS `errorMessage` before re-delivering, so
    // every row that had already been delivered to the cabinet looked like a
    // first attempt and got a second feed entry.
    //
    // What made it unbounded is that the press cannot deliver anything in
    // exchange. The relay key `broadcast:${message.id}` is stable across
    // attempts by design, so the bot recognises the replay, answers 204, and
    // the outcome reads `unconfirmed` — not retryable, straight back to FAILED
    // and eligible for the next press. One duplicate per press, forever.
    const h = harness({
      recipients: 1,
      relayStatus: 'unconfirmed',
      startFailed: true,
      feedRowsFor: ['message-1'],
    });

    const result = await h.service.retryBatch('broadcast-1', h.ids);

    assert.deepStrictEqual(
      h.feedCreates,
      [],
      'the subscriber already has this broadcast in their feed; a retry is not a re-send',
    );
    assert.equal(h.feedRows.length, 1, 'exactly one feed row survives the retry');
    // The retry still ATTEMPTS the leg that failed; it just cannot prove one.
    assert.equal(h.relayCalls.length, 1);
    assert.deepStrictEqual(result, { sent: 0, failed: 1, unresolved: 0 });
  });

  it('does write the feed row on a retry of a recipient who never got one', async () => {
    // The other half, and the reason the prefix heuristic the review proposed
    // was not enough: `telegram_relay_circuit_open` is stamped by `updateMany`
    // over rows the breaker never reached, so its `telegram_relay_` prefix sits
    // on rows with no feed row at all. Keying on the string would skip the feed
    // write here and leave the subscriber with a Telegram message and nothing
    // in the cabinet.
    const h = harness({ recipients: 1, relayStatus: 'confirmed', messageId: 5, startFailed: true });

    const result = await h.service.retryBatch('broadcast-1', h.ids);

    assert.equal(h.feedCreates.length, 1, 'nothing was ever written for this recipient');
    assert.deepStrictEqual(result, { sent: 1, failed: 0, unresolved: 0 });
  });
});

describe('the delivery circuit breaker', () => {
  it('stops the batch after a run of transport failures instead of timing out per recipient', async () => {
    // `deliverBatch` awaits one relay call per recipient, so an unreachable
    // cabinet used to cost `recipients x timeout` — and the timeout just went
    // from 4s to 10s. Ten thousand recipients would be over a day of a worker
    // slot spent proving the same thing ten thousand times.
    const recipients = RELAY_CIRCUIT_BREAKER_THRESHOLD + 7;
    const h = harness({ recipients, relayStatus: 'timeout' });

    const result = await h.service.deliverBatch('broadcast-1', h.ids);

    assert.equal(
      h.relayCalls.length,
      RELAY_CIRCUIT_BREAKER_THRESHOLD,
      'the run must stop at the threshold, not grind through the list',
    );
    // Everything is still owed: the five that timed out plus the seven never
    // attempted. None of them is SENT and none is written off.
    assert.deepStrictEqual(result, { sent: 0, failed: 0, unresolved: recipients });
    assert.deepStrictEqual(statusesWritten(h.updates), []);
  });

  it('fails the untouched remainder rather than hanging the broadcast on the last attempt', async () => {
    const recipients = RELAY_CIRCUIT_BREAKER_THRESHOLD + 7;
    const h = harness({ recipients, relayStatus: 'timeout' });

    const result = await h.service.deliverBatch('broadcast-1', h.ids, { isFinalAttempt: true });

    assert.equal(h.relayCalls.length, RELAY_CIRCUIT_BREAKER_THRESHOLD);
    assert.equal(result.sent, 0);
    assert.equal(result.unresolved, 0);
    assert.equal(result.failed, recipients);
    assert.equal(h.updateManyCalls[0]?.['errorMessage'], 'telegram_relay_circuit_open');
  });

  it('does not trip on recipients who merely blocked the bot', async () => {
    // A queue of `unconfirmed` outcomes is a queue of per-recipient facts, not
    // an outage. Counting them would let normal churn abort a healthy
    // broadcast — the failure this breaker must not introduce.
    const recipients = RELAY_CIRCUIT_BREAKER_THRESHOLD + 7;
    const h = harness({ recipients, relayStatus: 'unconfirmed' });

    const result = await h.service.deliverBatch('broadcast-1', h.ids);

    assert.equal(h.relayCalls.length, recipients, 'every recipient must still be attempted');
    assert.deepStrictEqual(result, { sent: 0, failed: recipients, unresolved: 0 });
  });
});
