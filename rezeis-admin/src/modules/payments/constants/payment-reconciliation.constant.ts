export const PAYMENT_RECONCILIATION_QUEUE = 'payment-reconciliation';
export const PAYMENT_RECONCILIATION_JOB = 'reconcile-payment';
export const PAYMENT_RECONCILIATION_ENQUEUE_FAILED = 'FAILED';

/**
 * Worker concurrency for payment webhook reconciliation. Tunable via
 * `PAYMENT_RECONCILIATION_CONCURRENCY` so a burst of simultaneous purchases
 * (e.g. 1000 buyers) is reconciled in parallel instead of one-at-a-time. Read
 * from env at import time (decorator evaluation), default 10, clamped [1, 100].
 */
export const PAYMENT_RECONCILIATION_CONCURRENCY = ((): number => {
  const parsed = Number(process.env.PAYMENT_RECONCILIATION_CONCURRENCY);
  if (!Number.isInteger(parsed) || parsed < 1) return 10;
  return Math.min(parsed, 100);
})();

const DEFAULT_QUEUE_OPERATION_TIMEOUT_MS = 5_000;

export class PaymentReconciliationEnqueueError extends Error {
  public constructor() {
    super('PAYMENT_RECONCILIATION_ENQUEUE_FAILED');
    this.name = 'PaymentReconciliationEnqueueError';
    this.stack = '';
  }
}

export async function runPaymentReconciliationEnqueueWithTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs = DEFAULT_QUEUE_OPERATION_TIMEOUT_MS,
): Promise<T> {
  return runQueueOperationWithTimeout(
    operation,
    timeoutMs,
    () => new PaymentReconciliationEnqueueError(),
  );
}

export async function runQueueOperationWithTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  buildError: () => Error,
): Promise<T> {
  try {
    return await Promise.race([
      operation(),
      new Promise<T>((_resolve, reject) => {
        setTimeout(() => reject(buildError()), timeoutMs);
      }),
    ]);
  } catch {
    throw buildError();
  }
}
