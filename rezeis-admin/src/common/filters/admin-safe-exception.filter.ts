import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Request, Response } from 'express';

import { isSafeRequestId, sanitizePath } from './filter-utils';

interface SafeErrorResponse {
  timestamp: string;
  path: string;
  requestId: string | null;
  statusCode: number;
  message: string | string[];
  errorCode: string;
  /**
   * Stable product code from intentional HttpException bodies
   * (`{ code: 'SUBSCRIPTION_LIMIT_REACHED', message: '...' }`). Allowlisted —
   * never forwards arbitrary exception fields.
   */
  code?: string;
  error?: string;
}

const GENERIC_INTERNAL_ERROR_MESSAGE = 'Internal server error';
const GENERIC_INTERNAL_ERROR_CODE = 'INTERNAL_SERVER_ERROR';
/**
 * Product codes that BFF/SPA may branch on. Only these survive the safe filter
 * when thrown as `new BadRequestException({ code, message })`.
 */
const SAFE_PRODUCT_CODES = new Set<string>([
  'SUBSCRIPTION_LIMIT_REACHED',
  'REGISTRATION_DISABLED',
  'INVITE_REQUIRED',
  // Sits with its two neighbours above for the same reason: all three are
  // registration refusals at 403, and without the code the BFF cannot tell
  // them apart. Collapsed into one message, "accept the terms" reaches the
  // visitor as "registration is disabled" — false whenever registration is in
  // fact enabled, and nothing they can act on.
  'LEGAL_CONSENT_REQUIRED',
  'SERVICE_RESTRICTED',
  'PURCHASES_DISABLED',
  'PAYMENT_DRAFT_QUOTE_NOT_ELIGIBLE',
  'PAYMENT_DRAFT_TRIAL_UNSUPPORTED',
  'PARTNER_BALANCE_DISABLED',
  'PARTNER_BALANCE_NOT_AVAILABLE',
  'USER_DELETE_PROTECTED_HISTORY',
  // The two paid-trial refusals ask the buyer for opposite things — one is
  // final, the other is resolvable by abandoning their own unfinished
  // checkout. Without both here the filter strips the code and the BFF can
  // only report a generic failure, which is the very confusion these codes
  // were split apart to end.
  'TRIAL_ALREADY_USED',
  'TRIAL_PENDING_CHECKOUT_STALE',
  // Abandon refusals. Both mean "not now, and here is why" — collapsed into an
  // untyped 400 the buyer would just see a cancel button that does nothing.
  'PAYMENT_ALREADY_AT_PROVIDER',
  'PAYMENT_PROVIDER_CREATE_IN_FLIGHT',
  // The three renewal-checkout outcomes the reiwa BFF maps in
  // `api/routes/payments-errors.ts` (`RENEWAL_ERROR_MESSAGES`). It reads the
  // `code` field off the upstream body and nothing else, so a stripped code
  // is not a degraded message — it is a different one, or none at all.
  //
  // `QUOTE_CHANGED` and `IDEMPOTENCY_KEY_CONFLICT` are both 409, and the BFF
  // falls back to QUOTE_CHANGED for *any* untyped 409. So the key conflict
  // did not go missing; it arrived wearing the other one's name and told the
  // buyer to refresh a quote that was never the problem, while the retry key
  // that actually blocked them stayed bound to someone else's renewal.
  //
  // `PROVIDER_CHECKOUT_CREATION_UNRESOLVED` is worse, because it is 503: no
  // fallback catches it, the BFF finds no contract and reports a generic
  // "failed to create renewal checkout". The one thing that warning exists to
  // say — the payment may already exist at the provider, check before
  // retrying — never reached the buyer at all, and a blind retry can charge
  // them twice. The filter reads the code independently of status, so 503
  // carries it exactly as 401 and 409 do; the allowlist was the only gate.
  'QUOTE_CHANGED',
  'IDEMPOTENCY_KEY_CONFLICT',
  'PROVIDER_CHECKOUT_CREATION_UNRESOLVED',
  // The panel's own second-factor pivot, and the only entry here that is not
  // SCREAMING_SNAKE: the label is the wire value the sign-in form compares
  // against, so it is spelled the way the client reads it, not the way the
  // neighbours are spelled. Do not 'tidy' the case.
  //
  // Without it the filter strips the code from the 401 the login endpoint
  // returns when 2FA is on and no code was supplied. The form then never
  // reaches its second step, and every operator who enabled 2FA is locked
  // out of the panel with no way in.
  'totp_required',
]);
const SENSITIVE_HTTP_TEXT_PATTERNS = [
  /\b(?:postgres|mysql|mongodb|redis|amqp|http|https):\/\/\S+/iu,
  /\b(?:auth|authorization|bearer|cookie|credential|password|profile|secret|token)\b/iu,
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/u,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/iu,
  /\b[0-9a-f]{24,}\b/iu,
  /\b(?:acct|cus|evt|gw|in|pay|pi|pm|price|prod|re|rfnd|seti|si|sub|txn|wh)_[A-Za-z0-9][A-Za-z0-9_-]{3,}\b/iu,
];

/**
 * Keeps HTTP error responses predictable without exposing unexpected exception internals.
 *
 * Intentional HttpExceptions keep their status/message for compatibility with existing API
 * contracts. Unexpected exceptions are reduced to a stable generic 500 response. The filter
 * never includes stack traces, raw query strings, request/response bodies, or headers.
 */
@Catch()
export class AdminSafeExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(AdminSafeExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const response = context.getResponse<Response>();
    const request = context.getRequest<Request>();
    const responseBody = this.buildResponseBody(exception, request);

    if (exception instanceof HttpException) {
      this.logger.warn(
        [
          `requestId=${responseBody.requestId ?? 'unknown'}`,
          `status=${responseBody.statusCode}`,
          `path=${responseBody.path}`,
          `errorCode=${responseBody.errorCode}`,
        ].join(' '),
      );
    } else {
      this.logger.error(
        [
          `requestId=${responseBody.requestId ?? 'unknown'}`,
          `status=${responseBody.statusCode}`,
          `path=${responseBody.path}`,
          `errorCode=${responseBody.errorCode}`,
        ].join(' '),
      );
      // Phase E2E: surface the underlying exception name + message + the
      // first few stack frames so server logs aren't a black hole on 500s.
      // We deliberately log to stdout (not into the safe response body)
      // so CI-style aggregation picks it up while clients still see a
      // generic 500.
      const err = exception as { name?: string; message?: string; stack?: string };
      const stackPreview = (err.stack ?? '')
        .split('\n')
        .slice(0, 6)
        .join(' | ');
      this.logger.error(
        `unhandled: ${err?.name ?? 'unknown'}: ${err?.message ?? '(no message)'} :: ${stackPreview}`,
      );
    }

    response.status(responseBody.statusCode).json(responseBody);
  }

  private buildResponseBody(exception: unknown, request: Request): SafeErrorResponse {
    const requestId = resolveResponseRequestId(request.headers['x-request-id']);
    const path = sanitizePath(request.originalUrl ?? request.url);
    const timestamp = new Date().toISOString();

    if (exception instanceof HttpException) {
      const statusCode = exception.getStatus();
      const response = exception.getResponse();
      const message = extractHttpExceptionMessage(response, exception.message, statusCode);
      const error = extractHttpExceptionError(response, statusCode);
      const productCode = extractSafeProductCode(response);
      return {
        timestamp,
        path,
        requestId,
        statusCode,
        message,
        // Prefer the stable product code for BFF branching when present;
        // otherwise keep the generic status-derived code.
        errorCode: productCode ?? mapStatusToErrorCode(statusCode),
        ...(productCode ? { code: productCode } : {}),
        ...(error ? { error } : {}),
      };
    }

    return {
      timestamp,
      path,
      requestId,
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: GENERIC_INTERNAL_ERROR_MESSAGE,
      errorCode: GENERIC_INTERNAL_ERROR_CODE,
      error: 'Internal Server Error',
    };
  }
}

function extractHttpExceptionMessage(response: string | object, fallback: string, statusCode: number): string | string[] {
  if (typeof response === 'string') {
    return sanitizeHttpExceptionMessage(response, statusCode);
  }
  if (isRecord(response) && 'message' in response) {
    const message = response.message;
    if (typeof message === 'string') {
      return sanitizeHttpExceptionMessage(message, statusCode);
    }
    if (Array.isArray(message)) {
      const sanitizedMessages = message
        .filter((item): item is string => typeof item === 'string')
        .map((item) => sanitizeHttpExceptionMessage(item, statusCode));
      return sanitizedMessages.length > 0 ? sanitizedMessages : safeHttpMessageForStatus(statusCode);
    }
  }
  return sanitizeHttpExceptionMessage(fallback, statusCode);
}

function extractHttpExceptionError(response: string | object, statusCode: number): string | undefined {
  if (isRecord(response) && typeof response.error === 'string') {
    return sanitizeHttpExceptionError(response.error, statusCode);
  }
  return undefined;
}

/**
 * Pull a stable product `code` from intentional HttpException object bodies.
 * Nested Nest shape `{ message: { code, message } }` is also accepted.
 */
function extractSafeProductCode(response: string | object): string | undefined {
  if (!isRecord(response)) return undefined;
  const direct = response.code;
  if (typeof direct === 'string' && SAFE_PRODUCT_CODES.has(direct)) {
    return direct;
  }
  const nested = response.message;
  if (isRecord(nested) && typeof nested.code === 'string' && SAFE_PRODUCT_CODES.has(nested.code)) {
    return nested.code;
  }
  return undefined;
}

function sanitizeHttpExceptionMessage(message: string, statusCode: number): string {
  return containsSensitiveHttpText(message) ? safeHttpMessageForStatus(statusCode) : message;
}

function sanitizeHttpExceptionError(error: string, statusCode: number): string {
  return containsSensitiveHttpText(error) ? safeHttpErrorForStatus(statusCode) : error;
}

function containsSensitiveHttpText(value: string): boolean {
  return SENSITIVE_HTTP_TEXT_PATTERNS.some((pattern) => pattern.test(value));
}

function safeHttpMessageForStatus(statusCode: number): string {
  if (statusCode >= 500) {
    return GENERIC_INTERNAL_ERROR_MESSAGE;
  }
  return 'Request failed';
}

function safeHttpErrorForStatus(statusCode: number): string {
  switch (statusCode) {
    case HttpStatus.BAD_REQUEST:
      return 'Bad Request';
    case HttpStatus.UNAUTHORIZED:
      return 'Unauthorized';
    case HttpStatus.FORBIDDEN:
      return 'Forbidden';
    case HttpStatus.NOT_FOUND:
      return 'Not Found';
    case HttpStatus.CONFLICT:
      return 'Conflict';
    case HttpStatus.TOO_MANY_REQUESTS:
      return 'Too Many Requests';
    default:
      return statusCode >= 500 ? 'Internal Server Error' : 'Error';
  }
}

function mapStatusToErrorCode(statusCode: number): string {
  switch (statusCode) {
    case HttpStatus.BAD_REQUEST:
      return 'BAD_REQUEST';
    case HttpStatus.UNAUTHORIZED:
      return 'UNAUTHORIZED';
    case HttpStatus.FORBIDDEN:
      return 'FORBIDDEN';
    case HttpStatus.NOT_FOUND:
      return 'NOT_FOUND';
    case HttpStatus.CONFLICT:
      return 'CONFLICT';
    case HttpStatus.TOO_MANY_REQUESTS:
      return 'TOO_MANY_REQUESTS';
    default:
      if (statusCode >= 500) {
        return GENERIC_INTERNAL_ERROR_CODE;
      }
      return `HTTP_${statusCode}`;
  }
}

function resolveResponseRequestId(headerValue: string | string[] | undefined): string | null {
  const candidate = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  return isSafeRequestId(candidate) ? candidate : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
