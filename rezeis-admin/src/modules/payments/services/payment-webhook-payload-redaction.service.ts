import { Injectable } from '@nestjs/common';

import { redactPaymentDiagnosticMessage } from '../utils/payment-provider-error.util';

const SENSITIVE_FIELD_PATTERN =
  /(token|secret|signature|password|authorization|api[-_]?key|cookie|hash|sign|credential)/i;
const SENSITIVE_IDENTIFIER_FIELD_PATTERN = /^(?:id|uuid|ref|reference)$/i;
const SENSITIVE_IDENTIFIER_SUFFIX_PATTERN = /(?:Id|UUID|Ref|Reference)$/;
const SENSITIVE_IDENTIFIER_SNAKE_SUFFIX_PATTERN = /[-_](?:id|uuid|ref|reference)$/i;
const SENSITIVE_IDENTIFIER_CONTEXT_PATTERN =
  /(account|customer|external|gateway|invoice|order|payer|payment|provider|subscription|transaction|user)/i;

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
  if (typeof value === 'string') {
    return redactPaymentDiagnosticMessage(value) ?? '';
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  const result: Record<string, unknown> = {};
  for (const [key, currentValue] of Object.entries(value)) {
    if (shouldRedactField(key)) {
      result[key] = '***redacted***';
      continue;
    }
    result[key] = redactRecursive(currentValue);
  }
  return result;
}

function shouldRedactField(key: string): boolean {
  if (key === 'paymentId') {
    return false;
  }
  if (SENSITIVE_FIELD_PATTERN.test(key) || SENSITIVE_IDENTIFIER_FIELD_PATTERN.test(key)) {
    return true;
  }
  if (SENSITIVE_IDENTIFIER_SNAKE_SUFFIX_PATTERN.test(key)) {
    return true;
  }
  return SENSITIVE_IDENTIFIER_SUFFIX_PATTERN.test(key) && SENSITIVE_IDENTIFIER_CONTEXT_PATTERN.test(key);
}
