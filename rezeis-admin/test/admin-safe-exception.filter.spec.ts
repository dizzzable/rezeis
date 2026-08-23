import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ArgumentsHost,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';

import {
  AdminSafeExceptionFilter,
  CODES_CARRYING_REAUTH_FACTOR,
  SAFE_PRODUCT_CODES,
} from '../src/common/filters/admin-safe-exception.filter';
import {
  SUBSCRIPTION_DELETE_STALE_PANEL_LINK_CODE,
  SUBSCRIPTION_DELETE_STALE_PANEL_LINK_MESSAGE,
  SUBSCRIPTION_DEVICE_DELETE_STALE_PANEL_LINK_CODE,
  SUBSCRIPTION_DEVICE_DELETE_STALE_PANEL_LINK_MESSAGE,
  SUBSCRIPTION_DEVICE_DELETE_STALE_PANEL_LINK_SUBSCRIBER_MESSAGE,
} from '../src/modules/remnawave/services/stale-panel-link';

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

  /**
   * The registration refusals, checked at the seam rather than in isolation.
   *
   * This one was written after the failure it describes. `LEGAL_CONSENT_REQUIRED`
   * was thrown by the register path and read by the reiwa BFF, but nobody added
   * it here — so the filter silently dropped the code, the BFF found none, and
   * "accept the terms" reached the visitor as "registration is disabled" while
   * registration was in fact enabled. Every layer was individually correct and
   * separately tested; the seam between them was not.
   *
   * So this asserts the whole contract each code carries: 403, the code
   * surviving the filter, and the sibling `errorCode` the BFF also reads.
   */
  for (const code of [
    'REGISTRATION_DISABLED',
    'INVITE_REQUIRED',
    'LEGAL_CONSENT_REQUIRED',
  ]) {
    it(`preserves the ${code} refusal so the BFF can tell registration failures apart`, () => {
      const captured = runFilter(
        new ForbiddenException({ code, message: 'Registration refused' }),
        {
          originalUrl: '/api/internal/web-auth/register',
          headers: { 'x-request-id': `request.safe-${code}` },
        },
      );

      assert.equal(captured.statusCode, 403);
      const body = assertResponseBody(captured.body);
      assert.equal(body.code, code, `${code} must survive the filter`);
      assert.equal(body.errorCode, code);
    });
  }

  /**
   * THE 2FA ENROLMENT PROMPT, ASSERTED ON THE WIRE BODY RATHER THAN ON THE
   * THROWN EXCEPTION — which is the whole reason the defect this pins shipped
   * green.
   *
   * `two-factor.service.ts` threw `totp_enroll_reauth_required` with
   * `factor: 'password'`, and `two-factor-enrollment-reauth.spec.ts` asserted
   * that on the exception's own payload. The code was listed in
   * `CODES_CARRYING_REAUTH_FACTOR` but NOT in `SAFE_PRODUCT_CODES`, and
   * `extractSafeReauthFactor` reads the payload `findSafeProductPayload`
   * returns — which is `undefined` on a product-allowlist miss. So the filter
   * stripped BOTH fields, `two-factor-page.tsx`'s `readDemandedFactor` found
   * nothing, the password prompt never rendered, and 2FA could not be switched
   * on by anybody. Every layer was individually right; the seam was not tested.
   */
  it('forwards both the code and the factor for totp_enroll_reauth_required, so 2FA can be switched on', () => {
    const captured = runFilter(
      new UnauthorizedException({
        statusCode: 401,
        code: 'totp_enroll_reauth_required',
        factor: 'password',
        message: 'Confirm it is you before adding a second factor',
      }),
      {
        originalUrl: '/api/admin/2fa/enroll',
        headers: { 'x-request-id': 'request.safe-2fa-enroll' },
      },
    );

    assert.equal(captured.statusCode, 401);
    const body = assertResponseBody(captured.body);
    assert.equal(
      body.code,
      'totp_enroll_reauth_required',
      'the SPA branches on `code`; stripped, this 401 is indistinguishable from an expired session',
    );
    assert.equal(body.errorCode, 'totp_enroll_reauth_required');
    assert.equal(
      body.factor,
      'password',
      'the SPA must be told WHICH credential to ask for — it is not the client\'s to guess',
    );
    assert.equal(body.message, 'Confirm it is you before adding a second factor');
  });

  /**
   * The two sets do DIFFERENT jobs, proved by a code that is in one and not the
   * other. `totp_required` is an allowlisted product code that declares no
   * factor, so a `factor` riding along on its body must be dropped while the
   * code survives.
   *
   * Without this, `CODES_CARRYING_REAUTH_FACTOR` could be deleted outright and
   * every assertion above would still pass — the factor would simply be
   * forwarded for everything, which is exactly the second allowlist's reason to
   * exist.
   */
  it('forwards the code but NOT the factor for a product code that declares none', () => {
    const captured = runFilter(
      new UnauthorizedException({
        statusCode: 401,
        code: 'totp_required',
        factor: 'password',
        message: 'Two-factor code required',
      }),
      { originalUrl: '/api/admin/auth/login', headers: {} },
    );

    assert.equal(captured.statusCode, 401);
    const body = assertResponseBody(captured.body);
    assert.equal(body.code, 'totp_required');
    assert.equal(
      body.factor,
      undefined,
      'a factor on a code that does not declare one must not leave the filter',
    );
  });

  /**
   * The two-set rule, enforced instead of remembered.
   *
   * `CODES_CARRYING_REAUTH_FACTOR` is a strict SUBSET of `SAFE_PRODUCT_CODES`,
   * because the factor is extracted from the payload the product allowlist
   * admits. A code listed only in the reauth set forwards NEITHER field — it is
   * not a partially-working refusal, it is a silent one. This is the check that
   * turns "somebody must remember to edit both lists" into a named failure.
   */
  it('lists every reauth-factor code in the product allowlist too, or neither field ever ships', () => {
    const missing = [...CODES_CARRYING_REAUTH_FACTOR].filter(
      (code) => !SAFE_PRODUCT_CODES.has(code),
    );
    assert.deepEqual(
      missing,
      [],
      'these codes declare a reauth factor but are not allowlisted product codes, so the ' +
        'filter drops both `code` and `factor` and the client sees an untyped 401',
    );
    // A non-empty positive side: an empty reauth set would satisfy the filter
    // above for the wrong reason.
    assert.ok(
      CODES_CARRYING_REAUTH_FACTOR.size >= 2,
      'both re-authentication refusals must be present for the check above to mean anything',
    );
    assert.ok(CODES_CARRYING_REAUTH_FACTOR.has('passkey_reauth_required'));
    assert.ok(CODES_CARRYING_REAUTH_FACTOR.has('totp_enroll_reauth_required'));
  });

  /**
   * The stale-panel-link deletion refusal, asserted with its REAL message.
   *
   * The message is not spot-checked prose here: it is imported from the module
   * that throws it, so this case fails if a future copy-edit introduces a word
   * the filter scrubs (`profile`, `token`, a bare uuid, a URL, …). A refusal
   * whose sentence is replaced with "Request failed" is still a correct
   * refusal and still tells the operator nothing about the repair to run.
   */
  it(`preserves the ${SUBSCRIPTION_DELETE_STALE_PANEL_LINK_CODE} refusal, code and sentence intact`, () => {
    const captured = runFilter(
      new ConflictException({
        code: SUBSCRIPTION_DELETE_STALE_PANEL_LINK_CODE,
        message: SUBSCRIPTION_DELETE_STALE_PANEL_LINK_MESSAGE,
      }),
      {
        originalUrl: '/api/admin/users/subscriptions/sub-1',
        headers: { 'x-request-id': 'request.safe-stale-link' },
      },
    );

    assert.equal(captured.statusCode, 409);
    const body = assertResponseBody(captured.body);
    assert.equal(body.code, SUBSCRIPTION_DELETE_STALE_PANEL_LINK_CODE);
    assert.equal(body.errorCode, SUBSCRIPTION_DELETE_STALE_PANEL_LINK_CODE);
    assert.equal(
      body.message,
      SUBSCRIPTION_DELETE_STALE_PANEL_LINK_MESSAGE,
      'the refusal names the remedy; scrubbed, the operator is told only that the request failed',
    );
    assert.equal(
      body.factor,
      undefined,
      'this refusal asks for no credential and must not grow a factor field',
    );
  });

  /**
   * The DEVICE refusal, both sentences, for the same reason as its sibling
   * above — and there are two of them because there are two audiences under one
   * code. Imported from the module that throws them, so a copy-edit that
   * introduces `profile`, `token`, a bare uuid or a URL fails here instead of
   * reaching a customer as "Request failed".
   */
  for (const [audience, message] of [
    ['operator', SUBSCRIPTION_DEVICE_DELETE_STALE_PANEL_LINK_MESSAGE],
    ['subscriber', SUBSCRIPTION_DEVICE_DELETE_STALE_PANEL_LINK_SUBSCRIBER_MESSAGE],
  ] as ReadonlyArray<readonly [string, string]>) {
    it(`preserves the ${SUBSCRIPTION_DEVICE_DELETE_STALE_PANEL_LINK_CODE} refusal (${audience} wording) intact`, () => {
      const captured = runFilter(
        new ConflictException({
          code: SUBSCRIPTION_DEVICE_DELETE_STALE_PANEL_LINK_CODE,
          message,
        }),
        {
          originalUrl: '/api/admin/users/subscriptions/sub-1/devices/hwid-x',
          headers: { 'x-request-id': 'request.safe-device-stale-link' },
        },
      );

      assert.equal(captured.statusCode, 409);
      const body = assertResponseBody(captured.body);
      assert.equal(body.code, SUBSCRIPTION_DEVICE_DELETE_STALE_PANEL_LINK_CODE);
      assert.equal(body.errorCode, SUBSCRIPTION_DEVICE_DELETE_STALE_PANEL_LINK_CODE);
      assert.equal(
        body.message,
        message,
        'scrubbed, both audiences are told only that the request failed',
      );
      assert.equal(body.factor, undefined);
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
