import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isFinalProcessorAttempt } from '../src/modules/backup/backup-delivery-retry.util';
import { BROADCAST_JOBS } from '../src/modules/broadcast/broadcast.constants';
import { BroadcastProcessor } from '../src/modules/broadcast/broadcast.processor';

/**
 * The wiring between a BullMQ job and `BroadcastDeliveryService`
 * ═════════════════════════════════════════════════════════════
 * Both decisions this file pins live in the processor and nowhere else, and
 * both are invisible to the delivery-service specs, which call `deliverBatch`
 * and `retryBatch` directly.
 *
 *  1. AN UNRESOLVED COUNT MUST THROW. `attempts: 3` on these jobs retries a
 *     processor that THROWS; a processor that returns a tally for every
 *     outcome has attempts that never fire — the exact defect the backup relay
 *     already paid for once. `deliverBatch` reports the rows it deliberately
 *     left PENDING after a transient relay failure as `unresolved`, and those
 *     rows are what a retry is for: the re-run reads PENDING rows, so nothing
 *     already proven is re-sent.
 *
 *  2. `isFinalAttempt` MUST BE THE REAL PREDICATE. It is the service's answer
 *     to "is a re-run coming?", and on the last attempt it is what turns the
 *     stragglers into FAILED rows. Wire a constant `false` in by accident and
 *     the last attempt leaves them PENDING; `checkAndFinalize` returns early
 *     on `pendingCount > 0`; the broadcast sits in PROCESSING forever with no
 *     job left in the queue that could ever move it. Nothing throws, nothing
 *     is logged, and the only symptom is a broadcast that never finishes.
 *
 * `isFinalProcessorAttempt` itself is pinned against the installed BullMQ's
 * own `Job.shouldRetryJob` in `test/backup-telegram-delivery-retry.spec.ts`.
 * What is unguarded — and what this file guards — is the two call sites that
 * hand its answer to the service.
 */

interface DeliveryCall {
  readonly method: 'deliverBatch' | 'retryBatch';
  readonly broadcastId: string;
  readonly messageIds: readonly string[];
  readonly options?: { readonly isFinalAttempt?: boolean };
}

interface BatchResult {
  readonly sent: number;
  readonly failed: number;
  readonly unresolved: number;
}

function buildProcessor(result: BatchResult) {
  const calls: DeliveryCall[] = [];
  const progress: unknown[] = [];
  const events: Array<readonly unknown[]> = [];

  const delivery = {
    deliverBatch: async (
      broadcastId: string,
      messageIds: readonly string[],
      options?: { readonly isFinalAttempt?: boolean },
    ) => {
      calls.push({ method: 'deliverBatch', broadcastId, messageIds, options });
      return result;
    },
    retryBatch: async (
      broadcastId: string,
      messageIds: readonly string[],
      options?: { readonly isFinalAttempt?: boolean },
    ) => {
      calls.push({ method: 'retryBatch', broadcastId, messageIds, options });
      return result;
    },
  };

  // Neither job kind stages or enqueues anything; a stub that recorded a call
  // would hide one, so this refuses it.
  const queue = {
    enqueueBatch: async () => {
      throw new Error('a delivery job must not enqueue further jobs');
    },
  };

  const processor = new BroadcastProcessor(delivery as never, queue as never, {
    info: (...args: readonly unknown[]) => events.push(args),
  } as never);

  return { processor, calls, progress, events };
}

function job(
  name: string,
  attemptsMade: number,
  attempts: number,
  progress: unknown[],
): never {
  return {
    id: 'job-1',
    name,
    data: { broadcastId: 'broadcast-1', messageIds: ['message-1', 'message-2'] },
    attemptsMade,
    opts: { attempts },
    updateProgress: async (value: unknown) => {
      progress.push(value);
    },
  } as never;
}

describe('a broadcast batch job reports what is still owed by failing', () => {
  it('throws when the batch left rows unresolved, so BullMQ runs it again', async () => {
    // Returning here is how `attempts: 3` becomes decoration: the rows the
    // relay could not resolve stay PENDING and no further job ever looks at
    // them.
    const { processor, progress } = buildProcessor({ sent: 1, failed: 0, unresolved: 2 });

    await assert.rejects(
      () => processor.process(job(BROADCAST_JOBS.DELIVER_BATCH, 0, 3, progress)),
      /2 message\(s\) unresolved/,
      'an unresolved count is precisely what a retry exists to pick up',
    );
  });

  it('completes when the batch resolved everything', async () => {
    const { processor, progress } = buildProcessor({ sent: 2, failed: 0, unresolved: 0 });

    const out = await processor.process(job(BROADCAST_JOBS.DELIVER_BATCH, 0, 3, progress));

    assert.deepStrictEqual(out, { sent: 2, failed: 0, unresolved: 0 });
    assert.deepStrictEqual(progress, [{ sent: 2, failed: 0, total: 2 }]);
  });

  it('throws on the retry job too, on the same rule', async () => {
    // `broadcast.retry-failed` is the operator-driven path and carries its own
    // attempts. It had the same shape of bug and needs the same exit.
    const { processor, progress } = buildProcessor({ sent: 0, failed: 1, unresolved: 3 });

    await assert.rejects(
      () => processor.process(job(BROADCAST_JOBS.RETRY_FAILED, 0, 3, progress)),
      /3 message\(s\) unresolved on retry/,
    );
  });

  it('completes the retry job when nothing is left owed', async () => {
    const { processor, progress } = buildProcessor({ sent: 1, failed: 1, unresolved: 0 });

    const out = await processor.process(job(BROADCAST_JOBS.RETRY_FAILED, 0, 3, progress));

    assert.deepStrictEqual(out, { sent: 1, failed: 1, unresolved: 0 });
  });
});

describe('a broadcast job tells delivery whether a re-run is coming', () => {
  /**
   * Every shape the counter takes, checked against the predicate rather than
   * against a literal.
   *
   * A table of expected booleans written out by hand would agree with a
   * processor that hard-codes `false`, as long as whoever wrote the table
   * made the same mistake. Comparing against `isFinalProcessorAttempt` — the
   * function BullMQ's own retry gate is pinned to — means the assertion fails
   * the moment the call site stops asking it.
   */
  const shapes: ReadonlyArray<{ readonly attemptsMade: number; readonly attempts: number }> = [
    { attemptsMade: 0, attempts: 1 },
    { attemptsMade: 0, attempts: 3 },
    { attemptsMade: 1, attempts: 3 },
    { attemptsMade: 2, attempts: 3 },
    { attemptsMade: 3, attempts: 3 },
  ];

  for (const jobName of [BROADCAST_JOBS.DELIVER_BATCH, BROADCAST_JOBS.RETRY_FAILED] as const) {
    it(`hands ${jobName} the answer isFinalProcessorAttempt gives, on every attempt`, async () => {
      for (const shape of shapes) {
        const { processor, calls, progress } = buildProcessor({ sent: 2, failed: 0, unresolved: 0 });

        await processor.process(job(jobName, shape.attemptsMade, shape.attempts, progress));

        const expected = isFinalProcessorAttempt({
          attemptsMade: shape.attemptsMade,
          opts: { attempts: shape.attempts },
        });
        assert.equal(
          calls[0]?.options?.isFinalAttempt,
          expected,
          `${jobName} attempt ${shape.attemptsMade + 1}/${shape.attempts}: the service was told ` +
            `${String(calls[0]?.options?.isFinalAttempt)} where the predicate says ${String(expected)}`,
        );
      }
    });
  }

  it('says a re-run is coming while attempts remain', async () => {
    // Spelled out as well as derived: if `isFinalProcessorAttempt` itself were
    // ever inverted, the table above would follow it into the wrong answer.
    const { processor, calls, progress } = buildProcessor({ sent: 2, failed: 0, unresolved: 0 });

    await processor.process(job(BROADCAST_JOBS.DELIVER_BATCH, 0, 3, progress));

    assert.equal(calls[0]?.options?.isFinalAttempt, false);
  });

  it('says none is coming on the last attempt, so nothing is left PENDING forever', async () => {
    // The failure this guards: with `false` here, the last attempt leaves the
    // unresolved rows PENDING, `checkAndFinalize` bails on `pendingCount > 0`,
    // and the broadcast is stuck in PROCESSING with no job left to move it.
    const { processor, calls, progress } = buildProcessor({ sent: 2, failed: 0, unresolved: 0 });

    await processor.process(job(BROADCAST_JOBS.RETRY_FAILED, 2, 3, progress));

    assert.equal(calls[0]?.method, 'retryBatch');
    assert.equal(calls[0]?.options?.isFinalAttempt, true);
  });

  it('routes each job name to its own delivery method', async () => {
    // The dispatch itself: `deliver-batch` must not reach `retryBatch`, which
    // would silently reset FAILED rows to PENDING on an ordinary delivery.
    const { processor, calls, progress } = buildProcessor({ sent: 2, failed: 0, unresolved: 0 });

    await processor.process(job(BROADCAST_JOBS.DELIVER_BATCH, 0, 3, progress));
    await processor.process(job(BROADCAST_JOBS.RETRY_FAILED, 0, 3, progress));

    assert.deepStrictEqual(
      calls.map((call) => call.method),
      ['deliverBatch', 'retryBatch'],
    );
    assert.deepStrictEqual(calls[0]?.messageIds, ['message-1', 'message-2']);
    assert.equal(calls[0]?.broadcastId, 'broadcast-1');
  });
});
