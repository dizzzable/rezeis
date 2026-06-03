import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Request, Response } from 'express';

import { sanitizePath } from '../src/common/filters/filter-utils';
import { CORRELATION_ID_HEADER } from '../src/common/logger';
import { CorrelationIdMiddleware } from '../src/common/middlewares/correlation-id.middleware';
import { RequestLoggerMiddleware } from '../src/common/middlewares/request-logger.middleware';

interface CapturedResponse {
  readonly headers: Record<string, string>;
  readonly finishHandlers: Array<() => void>;
  statusCode: number;
}

function createResponse(statusCode: number = 200): Response & CapturedResponse {
  const response: CapturedResponse & {
    setHeader(name: string, value: string): void;
    on(eventName: string, handler: () => void): void;
  } = {
    headers: {},
    finishHandlers: [],
    statusCode,
    setHeader(name: string, value: string): void {
      this.headers[name.toLowerCase()] = value;
    },
    on(eventName: string, handler: () => void): void {
      if (eventName === 'finish') {
        this.finishHandlers.push(handler);
      }
    },
  };
  return response as unknown as Response & CapturedResponse;
}

describe('request correlation and logging middlewares', () => {
  it('preserves safe correlation ids and writes the response header', () => {
    const middleware = new CorrelationIdMiddleware();
    const request = {
      headers: { [CORRELATION_ID_HEADER]: 'ops-request-01' },
    } as unknown as Request;
    const response = createResponse(204);
    let nextCalled = false;

    middleware.use(request, response, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, true);
    assert.equal(request['correlationId'], 'ops-request-01');
    assert.equal(response.headers[CORRELATION_ID_HEADER], 'ops-request-01');
  });

  it('generates a safe correlation id when the incoming header is unsafe', () => {
    const middleware = new CorrelationIdMiddleware();
    const request = {
      headers: { [CORRELATION_ID_HEADER]: 'unsafe id with spaces and bearer-token-secret' },
    } as unknown as Request;
    const response = createResponse();

    middleware.use(request, response, () => undefined);

    assert.match(request['correlationId'] as string, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    assert.equal(response.headers[CORRELATION_ID_HEADER], request['correlationId']);
    assert.notEqual(request['correlationId'], 'unsafe id with spaces and bearer-token-secret');
  });

  it('logs sanitized paths without query strings or sensitive path segments', () => {
    const logs: Array<{ level: string; message: string; meta: unknown }> = [];
    const middleware = new RequestLoggerMiddleware();
    (middleware as unknown as { logger: { log: (message: string, meta: unknown) => void; warn: (message: string, meta: unknown) => void } }).logger = {
      log: (message: string, meta: unknown): void => {
        logs.push({ level: 'log', message, meta });
      },
      warn: (message: string, meta: unknown): void => {
        logs.push({ level: 'warn', message, meta });
      },
    };
    const request = {
      headers: { 'user-agent': 'test-agent' },
      method: 'GET',
      originalUrl: '/api/users/12345/accounts/user@example.com/subscriptions/sub_secret123?token=raw-secret-token',
      ip: '127.0.0.1',
      correlationId: 'ops-request-01',
    } as unknown as Request;
    const response = createResponse(204);

    middleware.use(request, response, () => undefined);
    response.finishHandlers.forEach((handler) => handler());

    assert.equal(logs.length, 1);
    assert.equal(logs[0]!.level, 'log');
    assert.match(logs[0]!.message, /^GET \/api\/users\/:redacted\/accounts\/:redacted\/subscriptions\/:redacted 204 - \d+ms$/);
    assert.doesNotMatch(logs[0]!.message, /raw-secret-token|user@example\.com|sub_secret123|\?/);
    assert.deepStrictEqual(logs[0]!.meta, {
      correlationId: 'ops-request-01',
      method: 'GET',
      url: '/api/users/:redacted/accounts/:redacted/subscriptions/:redacted',
      statusCode: 204,
      duration: (logs[0]!.meta as { duration: number }).duration,
      userAgent: 'test-agent',
      ip: '127.0.0.1',
    });
  });

  it('redacts high-cardinality and sensitive path segments before logging', () => {
    const rawPath =
      '/api/admin/users/12345/accounts/user@example.com/subscriptions/550e8400-e29b-41d4-a716-446655440000/devices/0123456789abcdef0123456789abcdef/payment/sub_secret123/intent/pi_secret456/price/price_secret789?profileUrl=https://provider.example/profile/token-secret';

    const sanitizedPath = sanitizePath(rawPath);

    assert.equal(
      sanitizedPath,
      '/api/admin/users/:redacted/accounts/:redacted/subscriptions/:redacted/devices/:redacted/payment/:redacted/intent/:redacted/price/:redacted',
    );
    assert.doesNotMatch(sanitizedPath, /12345/);
    assert.doesNotMatch(sanitizedPath, /user@example\.com/);
    assert.doesNotMatch(sanitizedPath, /550e8400/);
    assert.doesNotMatch(sanitizedPath, /0123456789abcdef/);
    assert.doesNotMatch(sanitizedPath, /sub_secret123/);
    assert.doesNotMatch(sanitizedPath, /pi_secret456/);
    assert.doesNotMatch(sanitizedPath, /price_secret789/);
    assert.doesNotMatch(sanitizedPath, /profileUrl/);
    assert.doesNotMatch(sanitizedPath, /token-secret/);
  });
});
