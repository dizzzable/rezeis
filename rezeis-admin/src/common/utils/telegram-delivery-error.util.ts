export type TelegramDeliveryFailureCode =
  | 'TELEGRAM_DELIVERY_FAILED'
  | 'TELEGRAM_RECIPIENT_UNAVAILABLE';

export function readTelegramResponseStatusCode(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) {
    return null;
  }
  const errorRecord = error as { readonly response?: { readonly status?: unknown } };
  return typeof errorRecord.response?.status === 'number' ? errorRecord.response.status : null;
}

export function resolveTelegramDeliveryFailureCode(error: unknown): TelegramDeliveryFailureCode {
  const statusCode = readTelegramResponseStatusCode(error);
  if (statusCode === 400 || statusCode === 403) {
    return 'TELEGRAM_RECIPIENT_UNAVAILABLE';
  }
  return 'TELEGRAM_DELIVERY_FAILED';
}

export function buildSafeTelegramDeliveryWarning(input: {
  readonly operation: string;
  readonly error: unknown;
}): string {
  const statusCode = readTelegramResponseStatusCode(input.error);
  const statusSegment = statusCode === null ? 'status unknown' : `status ${statusCode}`;
  return `${input.operation}: ${resolveTelegramDeliveryFailureCode(input.error)} (${statusSegment})`;
}
