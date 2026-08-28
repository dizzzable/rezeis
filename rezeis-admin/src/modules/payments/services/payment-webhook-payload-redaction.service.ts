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

/**
 * Identifiers that survive redaction, because hiding them costs more than
 * showing them.
 *
 * The two charge ids are REFUND HANDLES. `refundStarPayment(userId, chargeId)`
 * takes the first, and neither is usable without the bot token — they are
 * addresses, not credentials. They also live in exactly one place: inside the
 * webhook envelope this service redacts. Nothing extracts them to a column, so
 * masking them here removed the only way an operator could reach them, and
 * refunding a Stars payment meant querying Postgres by hand.
 *
 * They were never named — `telegram_payment_charge_id` matched the generic
 * "ends in `_id`" rule, which is why the loss was silent.
 */
const NEVER_REDACTED = new Set([
  'paymentId',
  'telegram_payment_charge_id',
  'provider_payment_charge_id',
]);

function shouldRedactField(key: string): boolean {
  if (NEVER_REDACTED.has(key)) {
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
