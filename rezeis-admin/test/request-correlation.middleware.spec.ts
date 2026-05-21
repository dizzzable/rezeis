import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Request, Response } from 'express';

import {
  createRequestCorrelationMiddleware,
  resolveRequestId,
  sanitizePath,
} from '../src/common/middleware/request-correlation.middleware';

interface CapturedResponse {
  readonly headers: Record<string, string>;
  readonly finishHandlers: Array<() => void>;
  statusCode: number;
}

function createResponse(statusCode: number = 200): Response & CapturedResponse {
  const response: CapturedResponse & {
    setHeader(name: string, value: string): void;
    once(eventName: string, handler: () => void): void;
  } = {
    headers: {},
    finishHandlers: [],
    statusCode,
    setHeader(name: string, value: string): void {
      this.headers[name.toLowerCase()] = value;
    },
    once(eventName: string, handler: () => void): void {
      if (eventName === 'finish') {
        this.finishHandlers.push(handler);
      }
    },
  };
  return response as unknown as Response & CapturedResponse;
}

describe('request correlation middleware', () => {
  it('preserves safe caller request ids and writes the response header', () => {
    const logs: string[] = [];
    const middleware = createRequestCorrelationMiddleware({ log: (message) => logs.push(message) });
    const request = {
      headers: { 'x-request-id': 'ops-request-01' },
      method: 'GET',
      originalUrl: '/api/health/readiness?token=raw-secret-token',
    } as unknown as Request;
    const response = createResponse(204);
    let nextCalled = false;

    middleware(request, response, () => {
      nextCalled = true;
    });
    response.finishHandlers.forEach((handler) => handler());

    assert.equal(nextCalled, true);
    assert.equal(request.headers['x-request-id'], 'ops-request-01');
    assert.equal(response.headers['x-request-id'], 'ops-request-01');
    assert.equal(logs.length, 1);
    assert.match(logs[0]!, /requestId=ops-request-01/);
    assert.match(logs[0]!, /method=GET/);
    assert.match(logs[0]!, /path=\/api\/health\/readiness/);
    assert.match(logs[0]!, /status=204/);
    assert.doesNotMatch(logs[0]!, /raw-secret-token/);
    assert.doesNotMatch(logs[0]!, /\?/);
  });

  it('generates a safe request id when the incoming header is unsafe', () => {
    const requestId = resolveRequestId('unsafe id with spaces and bearer-token-secret');
    assert.match(requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    assert.notEqual(requestId, 'unsafe id with spaces and bearer-token-secret');

    const colonRequestId = resolveRequestId('unsafe:semantic:request');
    assert.match(colonRequestId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    assert.notEqual(colonRequestId, 'unsafe:semantic:request');

    for (const sensitiveRequestId of ['token-secret', 'auth-token', 'cookie-session', 'password-reset']) {
      const generatedRequestId = resolveRequestId(sensitiveRequestId);
      assert.match(generatedRequestId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      assert.notEqual(generatedRequestId, sensitiveRequestId);
    }
  });

  it('does not echo sensitive-looking request ids in response headers or logs', () => {
    const logs: string[] = [];
    const middleware = createRequestCorrelationMiddleware({ log: (message) => logs.push(message) });
    const request = {
      headers: { 'x-request-id': 'auth-token' },
      method: 'GET',
      originalUrl: '/api/health/readiness',
    } as unknown as Request;
    const response = createResponse(200);

    middleware(request, response, () => undefined);
    response.finishHandlers.forEach((handler) => handler());

    assert.match(request.headers['x-request-id'] as string, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    assert.match(response.headers['x-request-id'], /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    assert.doesNotMatch(response.headers['x-request-id'], /auth-token/);
    assert.equal(logs.length, 1);
    assert.doesNotMatch(logs[0]!, /auth-token/);
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
