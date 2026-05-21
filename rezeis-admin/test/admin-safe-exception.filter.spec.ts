import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ArgumentsHost, BadRequestException, NotFoundException } from '@nestjs/common';

import { AdminSafeExceptionFilter } from '../src/common/filters/admin-safe-exception.filter';

interface CapturedResponse {
  statusCode?: number;
  body?: unknown;
}

describe('AdminSafeExceptionFilter', () => {
  it('sanitizes unexpected exceptions without leaking raw messages, query strings, or unsafe request ids', () => {
    const captured = runFilter(
      new Error(
        'database failed postgres://admin:secret-password@db.internal/rezeis?token=provider-secret-token',
      ),
      {
        originalUrl:
          '/api/users/12345/accounts/user@example.com/subscriptions/123e4567-e89b-12d3-a456-426614174000?token=provider-secret-token',
        headers: { 'x-request-id': 'unsafe:request-id' },
      },
    );

    assert.equal(captured.statusCode, 500);
    const body = assertResponseBody(captured.body);
    assert.equal(body.statusCode, 500);
    assert.equal(body.message, 'Internal server error');
    assert.equal(body.errorCode, 'INTERNAL_SERVER_ERROR');
    assert.equal(body.error, 'Internal Server Error');
    assert.equal(body.requestId, null);
    assert.equal(body.path, '/api/users/:redacted/accounts/:redacted/subscriptions/:redacted');
    assert.equal(typeof body.timestamp, 'string');
    assert.match(body.timestamp as string, /^\d{4}-\d{2}-\d{2}T/);

    const serializedBody = JSON.stringify(body);
    assert.equal(serializedBody.includes('postgres://'), false);
    assert.equal(serializedBody.includes('secret-password'), false);
    assert.equal(serializedBody.includes('provider-secret-token'), false);
    assert.equal(serializedBody.includes('12345'), false);
    assert.equal(serializedBody.includes('user@example.com'), false);
    assert.equal(serializedBody.includes('123e4567-e89b-12d3-a456-426614174000'), false);
    assert.equal(serializedBody.includes('unsafe:request-id'), false);
  });

  it('keeps deliberate HttpException responses compatible while adding stable metadata', () => {
    const captured = runFilter(new BadRequestException(['email must be valid']), {
      originalUrl: '/api/auth/login?password=raw-secret',
      headers: { 'x-request-id': 'request.safe-123' },
    });

    assert.equal(captured.statusCode, 400);
    const body = assertResponseBody(captured.body);
    assert.equal(body.statusCode, 400);
    assert.deepEqual(body.message, ['email must be valid']);
    assert.equal(body.errorCode, 'BAD_REQUEST');
    assert.equal(body.error, 'Bad Request');
    assert.equal(body.requestId, 'request.safe-123');
    assert.equal(body.path, '/api/auth/login');

    const serializedBody = JSON.stringify(body);
    assert.equal(serializedBody.includes('password=raw-secret'), false);
  });

  it('sanitizes sensitive deliberate HttpException messages and error labels', () => {
    const captured = runFilter(
      new BadRequestException({
        message: [
          'Validation failed for subscription sub_secret12345 with token provider-secret-token',
          'auth failed for admin operator',
          'Plain client-facing validation issue',
        ],
        error: 'Bad Request auth failed',
      }),
      {
        originalUrl: '/api/payments/sub_secret12345?token=provider-secret-token',
        headers: { 'x-request-id': 'cookie-session' },
      },
    );

    assert.equal(captured.statusCode, 400);
    const body = assertResponseBody(captured.body);
    assert.equal(body.statusCode, 400);
    assert.deepEqual(body.message, ['Request failed', 'Request failed', 'Plain client-facing validation issue']);
    assert.equal(body.error, 'Bad Request');
    assert.equal(body.errorCode, 'BAD_REQUEST');
    assert.equal(body.requestId, null);
    assert.equal(body.path, '/api/payments/:redacted');

    const serializedBody = JSON.stringify(body);
    assert.equal(serializedBody.includes('sub_secret12345'), false);
    assert.equal(serializedBody.includes('provider-secret-token'), false);
    assert.equal(serializedBody.includes('token='), false);
    assert.equal(serializedBody.includes('auth failed'), false);
    assert.equal(serializedBody.includes('cookie-session'), false);
  });

  it('maps common HTTP statuses to stable safe error codes', () => {
    const captured = runFilter(new NotFoundException('Route not found'), {
      originalUrl: '/api/missing/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      headers: {},
    });

    assert.equal(captured.statusCode, 404);
    const body = assertResponseBody(captured.body);
    assert.equal(body.statusCode, 404);
    assert.equal(body.message, 'Route not found');
    assert.equal(body.errorCode, 'NOT_FOUND');
    assert.equal(body.path, '/api/missing/:redacted');
  });
});

function assertResponseBody(body: unknown): Record<string, unknown> {
  assert.equal(typeof body, 'object');
  assert.notEqual(body, null);
  assert.equal(Array.isArray(body), false);
  return body as Record<string, unknown>;
}

function runFilter(
  exception: unknown,
  request: { originalUrl: string; headers: Record<string, string> },
): CapturedResponse {
  const captured: CapturedResponse = {};
  const response = {
    status(statusCode: number) {
      captured.statusCode = statusCode;
      return response;
    },
    json(body: unknown) {
      captured.body = body;
      return response;
    },
  };
  const host = {
    switchToHttp() {
      return {
        getRequest: () => request,
        getResponse: () => response,
      };
    },
  } as unknown as ArgumentsHost;

  new AdminSafeExceptionFilter().catch(exception, host);
  return captured;
}
