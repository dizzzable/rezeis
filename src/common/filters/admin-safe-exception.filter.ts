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
  error?: string;
}

const GENERIC_INTERNAL_ERROR_MESSAGE = 'Internal server error';
const GENERIC_INTERNAL_ERROR_CODE = 'INTERNAL_SERVER_ERROR';
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
      return {
        timestamp,
        path,
        requestId,
        statusCode,
        message,
        errorCode: mapStatusToErrorCode(statusCode),
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
