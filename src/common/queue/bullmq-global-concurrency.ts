export const SERIAL_QUEUE_GLOBAL_CONCURRENCY = 1;
export const BULLMQ_GLOBAL_CONCURRENCY_TIMEOUT_MS = 1000;

export interface BullMqGlobalConcurrencyQueue {
  setGlobalConcurrency(concurrency: number): Promise<number>;
}

export async function applySerialBullMqGlobalConcurrency(
  queue: BullMqGlobalConcurrencyQueue,
  timeoutMs = BULLMQ_GLOBAL_CONCURRENCY_TIMEOUT_MS,
): Promise<void> {
  await runBullMqGlobalConcurrencyWithTimeout(
    () => queue.setGlobalConcurrency(SERIAL_QUEUE_GLOBAL_CONCURRENCY).then((): void => undefined),
    timeoutMs,
  );
}

export async function runBullMqGlobalConcurrencyWithTimeout(
  operation: () => Promise<void>,
  timeoutMs = BULLMQ_GLOBAL_CONCURRENCY_TIMEOUT_MS,
): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  const boundedOperation = Promise.resolve()
    .then(operation)
    .catch((): never => {
      throw new BullMqGlobalConcurrencyError();
    });

  await Promise.race([
    boundedOperation,
    new Promise<void>((_, reject) => {
      timeout = setTimeout(() => {
        reject(new BullMqGlobalConcurrencyError());
      }, timeoutMs);
    }),
  ]).finally(() => {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  });
}

export class BullMqGlobalConcurrencyError extends Error {
  public constructor() {
    super('Unable to apply BullMQ global concurrency policy.');
    this.name = 'BullMqGlobalConcurrencyError';
    this.stack = '';
  }
}
