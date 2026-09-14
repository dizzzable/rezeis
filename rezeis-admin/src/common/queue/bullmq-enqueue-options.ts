import { JobsOptions } from 'bullmq';

export const BULLMQ_RETAINED_COMPLETED_JOBS = 100;
export const BULLMQ_RETAINED_FAILED_JOBS = 100;
export const BULLMQ_ENQUEUE_TIMEOUT_MS = 1_000;

/** Longest cause text kept in the message. Redis and BullMQ say it in far less. */
const MAX_ENQUEUE_FAILURE_DETAIL = 300;

/**
 * Any `scheme://…` run. Redis and BullMQ do not put connection strings in their
 * errors, but a `redis://user:password@host` is exactly what must never reach a
 * log line if one ever does, so the whole URL goes — host included, which is
 * infrastructure detail the reason does not need.
 */
const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;

export type BullMqEnqueueFailure =
  | { readonly reason: 'rejected'; readonly cause: unknown }
  | {
      readonly reason: 'timeout';
      readonly timeoutMs: number;
      /** See `BullMqEnqueueError.landed`. */
      readonly landed?: Promise<boolean>;
    };

/**
 * An enqueue that did not happen, and WHY.
 *
 * It used to carry one constant sentence, "BullMQ enqueue operation failed",
 * whatever had happened. That is how every Telegram job in the panel could be
 * refused for a malformed id — BullMQ said "Custom Id cannot contain :" every
 * single time — while the only trace in the log was a sentence that named no
 * reason, and every caller took its Redis-is-down fallback for a Redis that
 * was perfectly healthy.
 *
 * So the cause's own text is kept, in `message`, because `message` is what
 * every caller already logs. What is NOT kept, deliberately:
 *
 *  - URLs — see `URL_PATTERN`;
 *  - the stack — this helper's frames say nothing about the enqueue, and a
 *    500 logged by the exception filter would print them as if they did;
 *  - an enumerable copy of the cause. `JSON.stringify(error)` is what a
 *    structured logger or a careless response serialiser emits, and it stays
 *    `{ name, reason }`.
 */
export class BullMqEnqueueError extends Error {
  /** `rejected`: BullMQ or Redis refused the add. `timeout`: nobody answered in time. */
  public readonly reason: BullMqEnqueueFailure['reason'];

  /**
   * `timeout` only: the add this error gave up on, which was NOT cancelled.
   *
   * Giving up is not cancelling. ioredis keeps a command it could not send in
   * its offline queue and replays it once the connection is back, so an add
   * that "timed out" during a Redis blip can land seconds later — after the
   * caller has already sent the message another way. Resolves `true` if the
   * add lands, `false` if it finally fails; never rejects. A caller that sent
   * the message itself uses it to withdraw the job (`withdrawLateJob`).
   *
   * Non-enumerable, like everything else about the cause: it is not part of
   * what a structured logger serialises.
   */
  public declare readonly landed?: Promise<boolean>;

  public constructor(failure: BullMqEnqueueFailure) {
    super(describeEnqueueFailure(failure));
    this.name = 'BullMqEnqueueError';
    this.reason = failure.reason;
    this.stack = '';
    if (failure.reason === 'timeout' && failure.landed !== undefined) {
      Object.defineProperty(this, 'landed', { value: failure.landed, enumerable: false });
    }
  }
}

function describeEnqueueFailure(failure: BullMqEnqueueFailure): string {
  if (failure.reason === 'timeout') {
    return `BullMQ enqueue operation timed out after ${failure.timeoutMs}ms`;
  }
  const cause = failure.cause;
  const raw =
    cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '';
  const detail = raw.replace(URL_PATTERN, '[url]').replace(/\s+/g, ' ').trim();
  if (detail.length === 0) return 'BullMQ enqueue operation failed';
  const clipped =
    detail.length > MAX_ENQUEUE_FAILURE_DETAIL
      ? `${detail.slice(0, MAX_ENQUEUE_FAILURE_DETAIL)}…`
      : detail;
  return `BullMQ enqueue operation failed: ${clipped}`;
}

export interface BoundedBullMqEnqueueOptionsInput {
  readonly jobId: string;
}

export function buildBoundedBullMqDefaultJobOptions(): JobsOptions {
  return {
    removeOnComplete: BULLMQ_RETAINED_COMPLETED_JOBS,
    removeOnFail: BULLMQ_RETAINED_FAILED_JOBS,
  };
}

export function buildBoundedBullMqEnqueueOptions(input: BoundedBullMqEnqueueOptionsInput): JobsOptions {
  return {
    jobId: input.jobId,
    ...buildBoundedBullMqDefaultJobOptions(),
  };
}

export async function runBullMqEnqueueWithTimeout<T>(enqueueOperation: () => Promise<T>, timeoutMs = BULLMQ_ENQUEUE_TIMEOUT_MS): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | undefined;
  const boundedEnqueue = Promise.resolve()
    .then(enqueueOperation)
    .catch((cause: unknown) => { throw new BullMqEnqueueError({ reason: 'rejected', cause }); });
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(
        new BullMqEnqueueError({
          reason: 'timeout',
          timeoutMs,
          landed: boundedEnqueue.then(
            () => true,
            () => false,
          ),
        }),
      );
    }, timeoutMs);
  });

  try {
    return await Promise.race([boundedEnqueue, timeout]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}
