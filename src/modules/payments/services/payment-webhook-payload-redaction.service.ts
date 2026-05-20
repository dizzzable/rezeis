import { Injectable } from '@nestjs/common';

const SENSITIVE_FIELD_PATTERN =
  /(token|secret|signature|password|authorization|api[-_]?key|cookie|hash|sign|credential)/i;

@Injectable()
export class PaymentWebhookPayloadRedactionService {
  public redact(value: unknown): unknown {
    return redactRecursive(value);
  }
}

function redactRecursive(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactRecursive(item));
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  const result: Record<string, unknown> = {};
  for (const [key, currentValue] of Object.entries(value)) {
    if (SENSITIVE_FIELD_PATTERN.test(key)) {
      result[key] = '***redacted***';
      continue;
    }
    result[key] = redactRecursive(currentValue);
  }
  return result;
}
