import { Queue } from 'bullmq';

export const BULLMQ_DUPLICATE_INSPECTION_TIMEOUT_MS = 1000;

export async function isBullMqJobAlreadyQueued(
  queue: Pick<Queue, 'getJob'>,
  jobId: string,
  timeoutMs = BULLMQ_DUPLICATE_INSPECTION_TIMEOUT_MS,
): Promise<boolean> {
  let timeout: NodeJS.Timeout | undefined;
  const inspection = Promise.resolve()
    .then(() => queue.getJob(jobId))
    .then((job) => job !== null && job !== undefined)
    .catch(() => false);
  const timeoutFallback = new Promise<boolean>((resolve) => {
    timeout = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([inspection, timeoutFallback]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
