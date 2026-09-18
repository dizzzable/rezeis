import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { HintAudienceService } from '../src/modules/user-hints/services/hint-audience.service';

/**
 * Hinting the people something did NOT happen to
 * ══════════════════════════════════════════════
 *
 * Every other hint follows an event. The most useful one follows a non-event —
 * the customer paid a day ago and has still never connected — and nothing emits
 * an event for a thing not occurring. So it is a query.
 *
 * ── The failure this file is mostly about ─────────────────────────────────
 *
 * `User.firstTrafficAt` is the only marker of "has connected", and exactly one
 * thing writes it: the Remnawave webhook. On an install where webhooks were
 * never configured, or where they broke, the column is NULL for everybody.
 *
 * Read naively that says every customer who ever paid has never connected, and
 * the rule sends "here is how to connect" to the entire customer base —
 * including people connected for months. That is not a smaller version of
 * working; it is the worst thing the hint feature can do, because it teaches
 * every customer at once that our hints are noise.
 */

const NOW = new Date('2026-08-29T12:00:00.000Z');

function build(options: {
  readonly anyConnected?: boolean;
  readonly matches?: number;
}) {
  const queries: Array<Record<string, unknown>> = [];
  /**
   * What the resolve did, in order: `begin`/`commit` for the transaction,
   * `tx.<method>` for a read made THROUGH the transaction client, and
   * `root.<method>` for one that went past it and took its own connection.
   */
  const ops: string[] = [];
  /** The options every `$transaction` was opened with, in order. */
  const transactionOptions: unknown[] = [];
  /** Greater than zero while the transaction client is delegating to the root one. */
  let delegating = 0;
  const prisma = {
    user: {
      count: async () => {
        if (delegating === 0) ops.push('root.count');
        return options.anyConnected === false ? 0 : 1;
      },
      findMany: async (args: Record<string, unknown>) => {
        if (delegating === 0) ops.push('root.findMany');
        queries.push(args);
        return Array.from({ length: options.matches ?? 0 }, (_, i) => ({ id: `u-${i}` }));
      },
    },
    $transaction: async (run: (tx: unknown) => Promise<unknown>, txOptions?: unknown) => {
      transactionOptions.push(txOptions);
      ops.push('begin');
      const result = await run(transactionClient);
      ops.push('commit');
      return result;
    },
  };
  const transactionClient = {
    ...prisma,
    user: {
      count: async () => {
        ops.push('tx.count');
        delegating += 1;
        try {
          return await prisma.user.count();
        } finally {
          delegating -= 1;
        }
      },
      findMany: async (args: Record<string, unknown>) => {
        ops.push('tx.findMany');
        delegating += 1;
        try {
          return await prisma.user.findMany(args);
        } finally {
          delegating -= 1;
        }
      },
    },
  };
  return { service: new HintAudienceService(prisma as never), queries, ops, transactionOptions };
}

describe('standing down when the signal is not working', () => {
  it('refuses to name anybody when NO account has ever reported traffic', async () => {
    // THE case. Answering with the whole customer base here is the disaster.
    const { service, queries } = build({ anyConnected: false, matches: 999 });

    const outcome = await service.resolve({ audience: 'paid-not-connected', now: NOW });

    assert.equal(outcome.kind, 'blind');
    // And it does not even run the audience query — there is nothing that
    // query could return that would be safe to act on.
    assert.deepStrictEqual(queries, []);
  });

  it('names the webhook in the reason, because that is what an operator must fix', async () => {
    const { service } = build({ anyConnected: false });

    const outcome = await service.resolve({ audience: 'paid-not-connected', now: NOW });

    assert.equal(outcome.kind, 'blind');
    assert.match(String((outcome as { reason: string }).reason), /webhook/i);
  });

  it('proceeds once at least one account has connected', async () => {
    // The positive control: the refusal is about the signal being dead, not
    // about the service refusing everything.
    const { service } = build({ anyConnected: true, matches: 3 });

    const outcome = await service.resolve({ audience: 'paid-not-connected', now: NOW });

    assert.equal(outcome.kind, 'ok');
    assert.equal((outcome as { userIds: readonly string[] }).userIds.length, 3);
  });

  it('refuses an empty window instead of quietly matching nobody', async () => {
    // `afterHours >= beforeHours` selects an empty range. Silently returning
    // zero users would look exactly like "nobody qualifies", and the operator
    // would never learn their hours are backwards.
    const { service } = build({ anyConnected: true, matches: 5 });

    const outcome = await service.resolve({
      audience: 'paid-not-connected',
      afterHours: 72,
      beforeHours: 24,
      now: NOW,
    });

    assert.equal(outcome.kind, 'blind');
  });
});

describe('the query it builds', () => {
  it('asks for a WINDOW, not everything older than a day', async () => {
    // An open-ended lower bound re-scans the whole history every run, leaving
    // the hint's own once-only rule as the only thing between that and a daily
    // sweep of every customer who ever failed to connect.
    const { service, queries } = build({ anyConnected: true, matches: 1 });

    await service.resolve({
      audience: 'paid-not-connected',
      afterHours: 24,
      beforeHours: 72,
      now: NOW,
    });

    const where = queries[0].where as {
      subscriptions: { some: { createdAt: { gte: Date; lte: Date } } };
    };
    const range = where.subscriptions.some.createdAt;
    assert.equal(range.gte.getTime(), NOW.getTime() - 72 * 60 * 60 * 1000);
    assert.equal(range.lte.getTime(), NOW.getTime() - 24 * 60 * 60 * 1000);
  });

  it('only names accounts with no traffic and no block', async () => {
    const { service, queries } = build({ anyConnected: true, matches: 1 });

    await service.resolve({ audience: 'paid-not-connected', now: NOW });

    const where = queries[0].where as { firstTrafficAt: unknown; isBlocked: boolean };
    assert.equal(where.firstTrafficAt, null);
    assert.equal(where.isBlocked, false);
  });

  it('takes the longest-waiting first, so a capped run is not an arbitrary slice', async () => {
    const { service, queries } = build({ anyConnected: true, matches: 1 });

    await service.resolve({ audience: 'paid-not-connected', now: NOW });

    assert.deepStrictEqual(queries[0].orderBy, { createdAt: 'asc' });
  });

  it('reports truncation when more matched than one run may take', async () => {
    // 501 rows come back for a 500 ceiling — the extra row is how the service
    // learns there were more without counting them all.
    const { service } = build({ anyConnected: true, matches: 501 });

    const outcome = await service.resolve({ audience: 'paid-not-connected', now: NOW });

    assert.equal(outcome.kind, 'ok');
    const ok = outcome as { userIds: readonly string[]; truncated: boolean };
    assert.equal(ok.truncated, true);
    assert.equal(ok.userIds.length, 500);
  });

  it('does not claim truncation at exactly the ceiling', async () => {
    const { service } = build({ anyConnected: true, matches: 500 });

    const outcome = await service.resolve({ audience: 'paid-not-connected', now: NOW });

    assert.equal((outcome as { truncated: boolean }).truncated, false);
  });
});

describe('the wait nothing downstream can stop', () => {
  /**
   * An ordinary Prisma query's wait for a pooled connection is bounded by the
   * pool alone: `connectionTimeoutMillis` of 15 s, set in `PrismaService`
   * (`DB_CONNECTION_TIMEOUT_MS`). Before that was set it had no timer at all,
   * and on a pool held by an export or a plan migration this resolve did not
   * fail — it hung.
   *
   * That is worse here than anywhere else in a run. The cohort is resolved
   * BEFORE the audience loop exists, so the loop's wall-clock budget and its
   * failure streak — the two things that stop a slow run — have nothing to
   * count yet. A run hung here produces no counts, no `audience_partial` and
   * no panel log line; the operator's request is answered 408 at 120 s while
   * the job still holds a worker.
   *
   * Inside a transaction, `maxWait` covers the checkout itself: Prisma races
   * `startTransaction`, which is what acquires the connection, against that
   * timer — 10 s, so it binds before the pool's 15 s, which stays the backstop
   * behind it. The numbers are the raise path's, argued over
   * `RAISE_TRANSACTION_OPTIONS` in `user-hint-delivery.service.ts`.
   */
  const BOUND = { maxWait: 10_000, timeout: 20_000 };

  it('resolves the cohort inside one bounded transaction', async () => {
    const { service, ops, transactionOptions } = build({ matches: 2 });

    const outcome = await service.resolve({ audience: 'paid-not-connected', now: NOW });

    assert.equal(outcome.kind, 'ok');
    assert.deepStrictEqual(ops, ['begin', 'tx.count', 'tx.findMany', 'commit']);
    assert.equal(
      ops.filter((op) => op.startsWith('root.')).length,
      0,
      `a read went past the transaction and waited on its own checkout: ${ops.join(" ")}`,
    );
    assert.deepStrictEqual(transactionOptions, [BOUND]);
  });

  it('keeps the blindness probe inside it, because that read is the one that queues first', async () => {
    // It is one cheap count, but it is the FIRST statement of the run — the
    // one that waits for the connection. A count that never returns looks
    // exactly like a cohort that is slow to build.
    const { service, ops, queries, transactionOptions } = build({ anyConnected: false, matches: 999 });

    const outcome = await service.resolve({ audience: 'paid-not-connected', now: NOW });

    assert.equal(outcome.kind, 'blind');
    assert.deepStrictEqual(ops, ['begin', 'tx.count', 'commit']);
    assert.deepStrictEqual(queries, [], 'the cohort query ran after all');
    assert.deepStrictEqual(transactionOptions, [BOUND]);
  });

  it('opens no transaction at all for a window that cannot match anybody', async () => {
    // The backwards window is refused from its arguments. Taking a connection
    // to say so would be the one wait this file exists to remove.
    const { service, ops } = build({ matches: 5 });

    const outcome = await service.resolve({
      audience: 'paid-not-connected',
      afterHours: 72,
      beforeHours: 24,
      now: NOW,
    });

    assert.equal(outcome.kind, 'blind');
    assert.deepStrictEqual(ops, []);
  });
});
