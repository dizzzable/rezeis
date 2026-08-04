import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ArgumentsHost, BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';

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

  it('preserves allowlisted product codes for BFF branching (subscription limit)', () => {
    const captured = runFilter(
      new BadRequestException({
        code: 'SUBSCRIPTION_LIMIT_REACHED',
        message: 'The user has reached the maximum number of active subscriptions.',
      }),
      {
        originalUrl: '/api/internal/payments/transactions/draft',
        headers: { 'x-request-id': 'request.safe-limit-1' },
      },
    );

    assert.equal(captured.statusCode, 400);
    const body = assertResponseBody(captured.body);
    assert.equal(body.statusCode, 400);
    assert.equal(body.code, 'SUBSCRIPTION_LIMIT_REACHED');
    assert.equal(body.errorCode, 'SUBSCRIPTION_LIMIT_REACHED');
    assert.equal(
      body.message,
      'The user has reached the maximum number of active subscriptions.',
    );
    assert.equal(body.requestId, 'request.safe-limit-1');
  });

  it('preserves the safe paid-user deletion conflict contract', () => {
    const captured = runFilter(
      new ConflictException({
        code: 'USER_DELETE_PROTECTED_HISTORY',
        message:
          'This user has protected payment, partner-ledger, or reward history and cannot be permanently deleted. Block the account instead; audit records must be preserved.',
      }),
      {
        originalUrl: '/api/admin/users/12345',
        headers: { 'x-request-id': 'request.safe-user-delete-1' },
      },
    );

    assert.equal(captured.statusCode, 409);
    const body = assertResponseBody(captured.body);
    assert.equal(body.code, 'USER_DELETE_PROTECTED_HISTORY');
    assert.equal(body.errorCode, 'USER_DELETE_PROTECTED_HISTORY');
    assert.equal(
      body.message,
      'This user has protected payment, partner-ledger, or reward history and cannot be permanently deleted. Block the account instead; audit records must be preserved.',
    );
  });

  /**
   * The two paid-trial refusals must arrive at the BFF as distinguishable
   * codes. Stripped, both collapse into an untyped 400 that the BFF reports as
   * a generic checkout failure — so the buyer whose own unfinished attempt is
   * blocking them is told, once again, that their trial is simply used up.
   *
   * The messages are asserted verbatim because the filter also redacts any
   * message matching its sensitive-text patterns; a reworded message that
   * happens to trip one would leave the code correct but the explanation gone.
   */
  for (const { code, message } of [
    {
      code: 'TRIAL_ALREADY_USED',
      message: 'User has reached the trial claim limit',
    },
    {
      code: 'TRIAL_PENDING_CHECKOUT_STALE',
      message:
        'A paid-trial checkout is still pending for this user; finish or abandon it before starting another.',
    },
    {
      code: 'PAYMENT_ALREADY_AT_PROVIDER',
      message:
        'This checkout already exists at the payment provider; finish it or let it expire.',
    },
    {
      code: 'PAYMENT_PROVIDER_CREATE_IN_FLIGHT',
      message: 'A provider request is still in flight for this payment; retry shortly.',
    },
  ]) {
    it(`preserves the ${code} contract for BFF branching`, () => {
      const captured = runFilter(new BadRequestException({ code, message }), {
        originalUrl: '/api/internal/payments/transactions/draft',
        headers: { 'x-request-id': `request.safe-${code}` },
      });

      assert.equal(captured.statusCode, 400);
      const body = assertResponseBody(captured.body);
      assert.equal(body.code, code);
      assert.equal(body.errorCode, code);
      assert.equal(body.message, message);
    });
  }

  it('does not forward non-allowlisted product codes from exception bodies', () => {
    const captured = runFilter(
      new BadRequestException({
        code: 'INTERNAL_DB_LEAK_CODE',
        message: 'Plain client-facing validation issue',
      }),
      { originalUrl: '/api/internal/x', headers: {} },
    );

    assert.equal(captured.statusCode, 400);
    const body = assertResponseBody(captured.body);
    assert.equal(body.code, undefined);
    assert.equal(body.errorCode, 'BAD_REQUEST');
    assert.equal(body.message, 'Plain client-facing validation issue');
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
