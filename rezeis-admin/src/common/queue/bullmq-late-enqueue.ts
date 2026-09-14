import { BullMqEnqueueError, runBullMqEnqueueWithTimeout } from './bullmq-enqueue-options';

/**
 * An enqueue that timed out is not an enqueue that failed
 * ═══════════════════════════════════════════════════════
 * `runBullMqEnqueueWithTimeout` stops WAITING for an add after a second; it
 * cannot stop the add. ioredis holds a command it could not send in its offline
 * queue (and re-sends one that was in flight) and replays both once the
 * connection is back. So during a Redis blip a producer's "one direct attempt"
 * fallback and the job it gave up on can BOTH deliver: an operator card sent
 * twice, or — on the relay, where the cabinet dedups the key — a direct attempt
 * answered 503 "a send with this key is still in flight", recorded as
 * undelivered and reported as a failure while the job was delivering it.
 *
 * These helpers are what a producer does about that, and only for a KEYED job:
 * without a custom id there is no name to look the job up by.
 *
 *  - Before the direct attempt: `probeLateJob`. If the job is there, the queue
 *    has it and there is nothing to send.
 *  - After a direct attempt that delivered: `withdrawLateJob`, so the job, if
 *    it lands, does not deliver a second time.
 *  - After one that did not: `probeLateJob` again. A job that landed meanwhile
 *    owns the message — its own retries, and its own record if those fail — so
 *    the fallback's miss is not a loss.
 *
 * ── Why asking Redis after a timeout is a real answer ────────────────────────
 *
 * The add and the probe go down the same connection, in that order, and Redis
 * runs one connection's commands in the order they arrive. So when the probe
 * gets an answer at all, the add ahead of it has already run: "not there" means
 * it is not coming. A probe that gets NO answer in time is `unknown`, and then
 * the add may still land — which is what `withdrawLateJob` is for.
 */

export type LateJobProbe = 'landed' | 'absent' | 'unknown';

/** The part of a BullMQ `Queue` the helpers use. */
export interface LateJobQueue {
  getJob(id: string): Promise<unknown>;
  remove(id: string): Promise<number>;
}

/** The `landed` promise of an add that timed out, or `null` for any other failure. */
export function lateEnqueueOf(err: unknown): Promise<boolean> | null {
  return err instanceof BullMqEnqueueError && err.reason === 'timeout' && err.landed !== undefined
    ? err.landed
    : null;
}

/** Is the job under this id in the queue? Bounded like the add was. */
export async function probeLateJob(queue: LateJobQueue, id: string): Promise<LateJobProbe> {
  try {
    const job = await runBullMqEnqueueWithTimeout(() => queue.getJob(id));
    return job === undefined || job === null ? 'absent' : 'landed';
  } catch {
    return 'unknown';
  }
}

/**
 * The message went out another way: make sure the timed-out job does not send
 * it again.
 *
 * TWO withdrawals, and the first is the one that holds. It is issued at once.
 * When Redis was unreachable, the add and this withdrawal wait in the same
 * offline queue and are replayed in that order, so the removal runs right after
 * the add lands — before a worker can move the job, because a worker's request
 * to take it only arrives after both. Its answer is not waited for past the
 * usual bound: during an outage it simply stays queued in its place.
 *
 * The second waits for the add to land and withdraws again. It covers an add
 * that had not reached the connection yet when the first went out. Both are a
 * race with the workers when Redis was merely SLOW — the add was already on the
 * wire, and a worker can take the job first. Then the message goes out twice,
 * and that is logged, because it is the one duplicate this cannot prevent.
 *
 * ── How a lost race shows itself ────────────────────────────────────────────
 *
 * NOT as an error. `Queue.remove` refuses a job a worker holds by resolving 0
 * (bullmq 5.76 `removeJob-2.lua`: `return 0` when the job is locked), and it
 * removes a job a worker already FINISHED without complaint — the message was
 * sent all the same. So each withdrawal reads the job in the same breath as it
 * removes it: a job a worker has started carries `processedOn` (set by
 * `prepareJobForProcessing` when a worker takes it), and a removal answered 0
 * is a job a worker holds right now. Either is the duplicate, and says so. The
 * read goes first on the connection, so on the replayed path both see the job
 * as the add left it: waiting, and removed without a word.
 *
 * Resolves once the first withdrawal has answered or timed out; the second runs
 * in the background and never rejects.
 */
export async function withdrawLateJob(
  queue: LateJobQueue,
  id: string,
  landed: Promise<boolean>,
  warn: (message: string) => void,
): Promise<void> {
  // One job, one duplicate: the second withdrawal must not say it again.
  let warned = false;
  const warnOnce = (message: string): void => {
    if (warned) return;
    warned = true;
    warn(message);
  };
  const withdrawOnce = async (): Promise<void> => {
    // Issued together, read first: see "How a lost race shows itself".
    const [seen, removal] = await Promise.allSettled([
      runBullMqEnqueueWithTimeout(() => queue.getJob(id)),
      runBullMqEnqueueWithTimeout(() => queue.remove(id)),
    ]);
    if (removal.status === 'rejected') {
      // A removal that timed out is still queued behind the add, which is
      // exactly where it should be. Anything else is a withdrawal that did not
      // happen.
      const err: unknown = removal.reason;
      if (err instanceof BullMqEnqueueError && err.reason === 'timeout') return;
      warnOnce(
        `Could not withdraw job ${id} after delivering its message directly — it may be ` +
          `delivered a second time: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    const started = seen.status === 'fulfilled' && workerStarted(seen.value);
    if (removal.value === 0 || started) {
      warnOnce(
        `Job ${id} was ${removal.value === 0 ? 'held by a worker' : 'already taken by a worker'} when ` +
          'its message had been delivered directly — the message was probably delivered twice',
      );
    }
  };
  await withdrawOnce();
  void landed.then(async (didLand) => {
    if (didLand) await withdrawOnce();
  });
}

/** Whether a worker has taken this job at least once (`Job.processedOn`). */
function workerStarted(job: unknown): boolean {
  if (typeof job !== 'object' || job === null) return false;
  const processedOn = (job as { processedOn?: unknown }).processedOn;
  return typeof processedOn === 'number' && processedOn > 0;
}
