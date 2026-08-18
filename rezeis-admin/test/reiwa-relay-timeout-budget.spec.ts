import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { REIWA_RELAY_EVENTS } from '../src/modules/notifications/reiwa-relay.constants';
import {
  BotNotifierClient,
  relayRequestTimeoutMs,
} from '../src/modules/notifications/services/bot-notifier.client';

/**
 * The panel must not give up before the cabinet does
 * ══════════════════════════════════════════════════
 * This request is nested inside another one. The cabinet answers it only after
 * its own call to the bot settles, and it budgets that call per route. So the
 * panel's deadline is the OUTER one, and the rule it has to obey is:
 *
 *     panel deadline  >  cabinet deadline for the SAME route  +  network slack
 *
 * Violate it and the panel aborts a request the cabinet is still serving,
 * reads its own abort as `timeout`, and `isRetryableRelayOutcome` calls that
 * transient — so the queue re-sends a delivery that was never failing and the
 * bot, which finished, posts it twice. The panel's impatience IS the duplicate.
 *
 * One flat 10s budget covered both routes while the cabinet allowed inline
 * documents 30s, which made "dev document upload takes eleven seconds" a
 * guaranteed duplicate rather than an unlucky one.
 *
 * The cabinet's numbers are pinned here as constants rather than imported: the
 * two repositories deploy as a pair but are not a single build, and a spec that
 * needed `../../reiwa` on disk would not run at all. Their source of truth is
 * `reiwa/src/api/routes/webhooks.ts`; if these drift, the assertions below are
 * the place that says so out loud.
 */

/** `reiwa/src/api/routes/webhooks.ts` — `BOT_RELAY_TIMEOUT_MS`. */
const CABINET_MESSAGE_TIMEOUT_MS = 8_000;
/** `reiwa/src/api/routes/webhooks.ts` — `BOT_RELAY_DOCUMENT_TIMEOUT_MS`. */
const CABINET_DOCUMENT_TIMEOUT_MS = 30_000;
/**
 * `reiwa/src/api/routes/webhooks.ts` — `relayToBot(..., null)` for
 * `/notify-backup-document`. Not an oversight there, and not one here either:
 * the bot streams a multi-gigabyte file before answering, and any total
 * deadline short enough to catch a wedged bot also cuts a legitimate upload.
 */
const CABINET_BACKUP_TIMEOUT_MS = null;

/** The relay whose bytes do NOT travel inline — it carries a download token. */
const BACKUP_EVENT = 'reiwa.backup.document';

describe('the panel relay deadline outlasts the cabinet deadline for the same route', () => {
  it('covers every event on the queue, plus the backup relay that is not on it', () => {
    // Anti-emptiness anchor. A resolver asked about nothing agrees with any
    // implementation, including one that returns 0 for everything.
    assert.equal(REIWA_RELAY_EVENTS.length, 9);
    for (const event of [...REIWA_RELAY_EVENTS, BACKUP_EVENT]) {
      const budget = relayRequestTimeoutMs(event);
      assert.ok(
        budget === null || budget > 0,
        `${event}: a route with no answer here silently inherits someone else's number`,
      );
    }
  });

  it('gives message routes more than the cabinet gives the bot for them', () => {
    const messageEvents = REIWA_RELAY_EVENTS.filter((e) => !e.endsWith('.document'));
    assert.equal(messageEvents.length, 7);
    for (const event of messageEvents) {
      const budget = relayRequestTimeoutMs(event);
      assert.equal(budget, 10_000, event);
      assert.ok(
        budget !== null && budget > CABINET_MESSAGE_TIMEOUT_MS,
        `${event}: ${String(budget)}ms does not outlast the cabinet's ${CABINET_MESSAGE_TIMEOUT_MS}ms`,
      );
      assert.ok(
        budget !== null && budget - CABINET_MESSAGE_TIMEOUT_MS >= 2_000,
        `${event}: the margin has to cover TLS, both hops, and the cabinet's HMAC + zod parse, ` +
          'all of which run before its own clock starts',
      );
    }
  });

  it('gives inline-document routes more than the cabinet gives the bot for them', () => {
    // Derived from the event names rather than listed, so a tenth event ending
    // in `.document` cannot be added to the queue and quietly inherit the
    // message budget — the exact shape of the bug this fixes.
    const documentEvents = REIWA_RELAY_EVENTS.filter((e) => e.endsWith('.document'));
    assert.deepStrictEqual(
      [...documentEvents],
      ['reiwa.channel.broadcast.document', 'reiwa.dev.notify.document'],
      'the routes whose bytes travel inline in the webhook body',
    );
    for (const event of documentEvents) {
      const budget = relayRequestTimeoutMs(event);
      assert.equal(budget, 35_000, event);
      assert.ok(
        budget !== null && budget > CABINET_DOCUMENT_TIMEOUT_MS,
        `${event}: ${String(budget)}ms is inside the cabinet's ${CABINET_DOCUMENT_TIMEOUT_MS}ms, so ` +
          'every upload slower than that is read as a timeout and re-sent as a second document',
      );
      assert.ok(
        budget !== null && budget - CABINET_DOCUMENT_TIMEOUT_MS >= 5_000,
        `${event}: a megabyte of body crosses the hop before the cabinet's clock starts`,
      );
    }
  });

  it('leaves the backup relay without a total deadline, exactly as the cabinet does', () => {
    assert.equal(
      relayRequestTimeoutMs(BACKUP_EVENT),
      CABINET_BACKUP_TIMEOUT_MS,
      'a total deadline here recreates on the panel side the harm the cabinet refused to cause: ' +
        'the abort surfaces as `timeout`, `isRetryableRelayOutcome` retries it, the backup queue ' +
        'has attempts: 3, and one slow backup becomes three multi-gigabyte copies in the topic',
    );
  });

  it('never lets a route be shorter than the one it is nested inside', () => {
    // The invariant stated once, over the whole table, so a future route
    // cannot satisfy the specific assertions above by not being covered.
    const cabinet = (event: string): number | null => {
      if (event === BACKUP_EVENT) return CABINET_BACKUP_TIMEOUT_MS;
      return event.endsWith('.document') ? CABINET_DOCUMENT_TIMEOUT_MS : CABINET_MESSAGE_TIMEOUT_MS;
    };
    for (const event of [...REIWA_RELAY_EVENTS, BACKUP_EVENT]) {
      const inner = cabinet(event);
      const outer = relayRequestTimeoutMs(event);
      if (inner === null) {
        assert.equal(outer, null, `${event}: the cabinet waits indefinitely; the panel must too`);
        continue;
      }
      assert.ok(
        outer !== null && outer > inner,
        `${event}: panel ${String(outer)}ms vs cabinet ${inner}ms — the panel gives up first`,
      );
    }
  });
});

// ── the resolver is actually wired into the request ─────────────────────────

interface FetchCall {
  readonly signal: AbortSignal | undefined;
  settle: (() => void) | null;
}

/**
 * A `fetch` that never answers on its own. The only way a call completes is
 * the abort the client armed — which is precisely the thing under test, so a
 * client that armed nothing leaves the promise pending and the assertions
 * about "still waiting" mean what they say.
 */
function stubFetch(calls: FetchCall[]): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = ((_input: unknown, init: { signal?: AbortSignal }) => {
    return new Promise<unknown>((resolve, reject) => {
      const call: FetchCall = {
        signal: init.signal,
        settle: () => {
          resolve({ ok: true, status: 204, statusText: 'No Content' });
        },
      };
      calls.push(call);
      init.signal?.addEventListener('abort', () => {
        reject(new Error('The operation was aborted'));
      });
    });
  }) as unknown as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = original;
  };
}

/** Drain microtasks plus one macrotask turn; `setImmediate` stays real. */
async function drain(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe('the deadline the resolver names is the deadline the request arms', () => {
  let restoreFetch: (() => void) | null = null;
  let savedUrl: string | undefined;
  let savedSecret: string | undefined;
  let calls: FetchCall[] = [];

  beforeEach(() => {
    savedUrl = process.env.REIWA_URL;
    savedSecret = process.env.WEBHOOK_SECRET_HEADER;
    process.env.REIWA_URL = 'https://cabinet.invalid';
    process.env.WEBHOOK_SECRET_HEADER = 'test-secret';
    calls = [];
    restoreFetch = stubFetch(calls);
    // Only `setTimeout`: the client's own timer is the subject, while
    // `setImmediate` has to stay real for `drain()` to advance anything.
    mock.timers.enable({ apis: ['setTimeout'] });
  });

  afterEach(() => {
    mock.timers.reset();
    restoreFetch?.();
    restoreFetch = null;
    if (savedUrl === undefined) delete process.env.REIWA_URL;
    else process.env.REIWA_URL = savedUrl;
    if (savedSecret === undefined) delete process.env.WEBHOOK_SECRET_HEADER;
    else process.env.WEBHOOK_SECRET_HEADER = savedSecret;
  });

  it('aborts a message route at 10s, and not a millisecond earlier', async () => {
    const client = new BotNotifierClient();
    let settled: { status: string; detail: string | null } | null = null;
    const pending = client.deliverRelayEvent('reiwa.dev.notify', { text: 'card' }).then((out) => {
      settled = { status: out.status, detail: out.detail };
      return out;
    });
    await drain();

    mock.timers.tick(9_999);
    await drain();
    assert.equal(settled, null, 'still inside the budget');

    mock.timers.tick(2);
    await drain();
    const outcome = await pending;
    assert.equal(outcome.status, 'timeout');
    assert.equal(outcome.detail, 'timed out after 10000ms');
  });

  it('does NOT abort a dev document at 10s — the cabinet is still working until 30s', async () => {
    // The regression in one assertion. Before the split, the client aborted
    // every route at 10s, so a document upload that the cabinet was happily
    // waiting on until 30s came back `timeout`, got retried, and arrived twice.
    const client = new BotNotifierClient();
    let settled = false;
    const pending = client
      .deliverRelayEvent('reiwa.dev.notify.document', { filename: 'error_0.txt', content: 'x' })
      .then((out) => {
        settled = true;
        return out;
      });
    await drain();

    mock.timers.tick(10_001);
    await drain();
    assert.equal(settled, false, 'ten seconds is the cabinet still uploading, not a failure');

    mock.timers.tick(24_998);
    await drain();
    assert.equal(settled, false, 'and 34.999s is still inside the document budget');

    mock.timers.tick(2);
    await drain();
    const outcome = await pending;
    assert.equal(outcome.status, 'timeout');
    assert.equal(outcome.detail, 'timed out after 35000ms');
  });

  it('arms no signal at all for the backup relay', async () => {
    const client = new BotNotifierClient();
    let settled = false;
    // Through the typed method rather than `deliverRelayEvent`: the backup
    // relay is deliberately NOT on the queue's event union, and this is the
    // path `BackupService` actually takes.
    const pending = client
      .relayBackupDocument({
        recordId: 'r1',
        token: 'download-token',
        filename: 'backup.sql.gz',
        caption: 'nightly',
        chatId: '-1001234567890',
      })
      .then((out) => {
        settled = true;
        return out;
      });
    await drain();

    assert.equal(calls.length, 1);
    assert.equal(
      calls[0]?.signal,
      undefined,
      'a signal here is a total deadline, and a total deadline cuts a legitimate ' +
        'multi-gigabyte upload — which the backup queue then retries into a second copy',
    );

    // Ten minutes of ticks change nothing: there is no timer to fire.
    mock.timers.tick(600_000);
    await drain();
    assert.equal(settled, false);

    // Let the request finish so the promise is not left dangling.
    calls[0]?.settle?.();
    const outcome = await pending;
    assert.equal(outcome.status, 'unconfirmed');
  });
});
