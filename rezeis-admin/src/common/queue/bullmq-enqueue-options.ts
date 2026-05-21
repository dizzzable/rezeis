import { JobsOptions } from 'bullmq';

export const BULLMQ_RETAINED_COMPLETED_JOBS = 100;
export const BULLMQ_RETAINED_FAILED_JOBS = 100;
export const BULLMQ_ENQUEUE_TIMEOUT_MS = 1_000;

export class BullMqEnqueueError extends Error {
  public constructor() {
    super('BullMQ enqueue operation failed');
    this.name = 'BullMqEnqueueError';
    this.stack = '';
  }
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
    .catch(() => { throw new BullMqEnqueueError(); });
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => { reject(new BullMqEnqueueError()); }, timeoutMs);
  });

  try {
    return await Promise.race([boundedEnqueue, timeout]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}
