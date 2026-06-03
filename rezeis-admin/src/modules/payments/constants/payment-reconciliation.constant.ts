export const PAYMENT_RECONCILIATION_QUEUE = 'payment-reconciliation';
export const PAYMENT_RECONCILIATION_JOB = 'reconcile-payment';
export const PAYMENT_RECONCILIATION_ENQUEUE_FAILED = 'FAILED';

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
