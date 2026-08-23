import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ArgumentsHost,
  BadRequestException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';

import {
  AdminSafeExceptionFilter,
  SAFE_PRODUCT_MESSAGES,
} from '../src/common/filters/admin-safe-exception.filter';

/**
 * What the sign-in form is allowed to say, asserted on the wire.
 *
 * The defect this file was written for: `AdminSafeExceptionFilter` scrubs any
 * exception message matching its sensitive-text patterns, one of which is a
 * vocabulary list containing the word "password". The backend's own refusal is
 * the sentence 'Invalid login or password', so every mistyped password reached
 * the operator as "Request failed" — and `sign-in-page.tsx` renders
 * `response.data.message`, so that string is literally what the panel printed.
 * 'Admin token is no longer valid' lost the same way, on "token", which meant a
 * session ended by a password change or a revoked passkey also said nothing.
 *
 * Every assertion here is made on the body the filter hands to
 * `response.json(...)`, never on the exception object. That distinction is the
 * whole subject: the exception has always carried the right sentence, and the
 * operator has never seen it.
 *
 * The half of this file that matters most is the second block. A message
 * allowlist is only safe while it is an EXACT, whole-string match — the moment
 * it becomes a prefix, a substring, or a normalised comparison it is a channel
 * for the connection strings and bearer tokens the patterns exist to stop. So
 * the sensitive cases below outnumber the product ones on purpose.
 */

interface WireResponse {
  readonly statusCode: number;
  readonly body: Record<string, unknown>;
}

/**
 * Drives the real filter through a minimal `ArgumentsHost`, capturing the
 * status and body it writes. Same shape as `test/passkey-hardening.spec.ts`,
 * for the same reason: nothing in production ever reads the exception.
 */
function throughSafeFilter(
  exception: unknown,
  originalUrl = '/api/admin/auth/login',
): WireResponse {
  let statusCode = 0;
  let body: Record<string, unknown> = {};
  const response = {
    status(code: number) {
      statusCode = code;
      return response;
    },
    json(payload: unknown) {
      body = (payload ?? {}) as Record<string, unknown>;
      return response;
    },
  };
  const host = {
    switchToHttp: () => ({
      getRequest: () => ({ originalUrl, headers: {} }),
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;

  new AdminSafeExceptionFilter().catch(exception, host);
  return { statusCode, body };
}

function messageOn(exception: unknown): unknown {
  return throughSafeFilter(exception).body.message;
}

/** The one field that legitimately differs between two identical refusals. */
function withoutTimestamp(body: Record<string, unknown>): Record<string, unknown> {
  const { timestamp, ...rest } = body;
  assert.equal(typeof timestamp, 'string');
  return rest;
}

// ── 1. The two sentences the panel is allowed to say ────────────────────────

describe('the panel can state the reason a sign-in was refused', () => {
  it('answers a wrong password with the reason, not "Request failed"', () => {
    // The defect, as the operator experiences it. `admin-auth.service.ts`
    // throws this for a wrong password AND for a login that does not exist —
    // one sentence for both, deliberately.
    const wire = throughSafeFilter(new UnauthorizedException('Invalid login or password'));

    assert.equal(wire.statusCode, 401);
    assert.equal(
      wire.body.message,
      'Invalid login or password',
      'the sign-in form prints this string; "Request failed" is the bug',
    );
  });

  it('tells an operator whose session was revoked that the session is over', () => {
    // Thrown by `admin-jwt.strategy.ts` when the token is well formed and
    // correctly signed but its version no longer matches the account — a
    // password change, or a revoked passkey. "Request failed" gives the
    // operator nothing to do.
    const wire = throughSafeFilter(
      new UnauthorizedException('Admin token is no longer valid'),
      '/api/admin/auth/me',
    );

    assert.equal(wire.statusCode, 401);
    assert.equal(wire.body.message, 'Admin token is no longer valid');
  });

  it('changes the message and NOTHING else about the response', () => {
    // The allowlist deliberately adds no field. A `code` would have been the
    // other design, and would have moved `errorCode` off 'UNAUTHORIZED' for
    // every client of four different modules that throw this sentence.
    const wire = throughSafeFilter(new UnauthorizedException('Invalid login or password'));

    assert.deepStrictEqual(Object.keys(wire.body).sort(), [
      'error',
      'errorCode',
      'message',
      'path',
      'requestId',
      'statusCode',
      'timestamp',
    ]);
    assert.equal(wire.body.errorCode, 'UNAUTHORIZED');
    assert.equal(wire.body.error, 'Unauthorized');
    assert.equal(wire.body.statusCode, 401);
    assert.equal(wire.body.path, '/api/admin/auth/login');
    assert.equal(wire.body.requestId, null);
    assert.equal('code' in wire.body, false, 'no new wire field was introduced');
  });

  it('keeps every entry live rather than decorative', () => {
    // An entry that no longer survives the filter is an entry whose sentence
    // has been reworded at the throw site, and the panel is silently back to
    // "Request failed" on that path.
    for (const sentence of SAFE_PRODUCT_MESSAGES) {
      assert.equal(
        messageOn(new UnauthorizedException(sentence)),
        sentence,
        `allowlisted sentence did not survive: ${sentence}`,
      );
    }
  });
});

// ── 2. The scrub is not weakened ────────────────────────────────────────────

describe('unexpected exception text is still scrubbed', () => {
  it('reduces an unhandled exception to a generic 500', () => {
    const wire = throughSafeFilter(
      new Error('connect failed postgres://admin:s3cr3t@db.internal/rezeis?token=live-token'),
    );

    assert.equal(wire.statusCode, 500);
    assert.equal(wire.body.message, 'Internal server error');
    assert.equal(JSON.stringify(wire.body).includes('s3cr3t'), false);
    assert.equal(JSON.stringify(wire.body).includes('postgres://'), false);
  });

  for (const [label, leak] of [
    ['a connection string', 'Upstream refused postgres://admin:s3cr3t@db.internal/rezeis'],
    ['a bearer token', 'Provider rejected Bearer eyJhbGciOiJIUzI1NiJ9.aaaaaaaa.bbbbbbbb'],
    ['a session cookie', 'Retry with cookie sid=6f1c2d3e4f5a6b7c8d9e0f1a'],
    ['an operator address', 'No mailbox for operator@rezeis.example'],
    ['a provider object id', 'Refund failed for re_1QxYzAbCdEfGhIjK'],
    ['a raw identifier', 'Row 123e4567-e89b-12d3-a456-426614174000 is locked'],
  ] as const) {
    it(`still refuses to print ${label}`, () => {
      const wire = throughSafeFilter(new BadRequestException(leak));

      assert.equal(wire.statusCode, 400);
      assert.equal(wire.body.message, 'Request failed', `${label} reached the wire`);
      assert.equal(JSON.stringify(wire.body).includes(leak), false);
    });
  }

  /**
   * The failure mode a message allowlist invites: matching loosely enough that
   * an interpolated `${err}` rides in behind an approved sentence. Each of
   * these DIFFERS from an entry, so each must meet the pattern scrub unchanged.
   */
  for (const [label, crafted] of [
    [
      'a secret appended to an approved sentence',
      'Invalid login or password: postgres://admin:s3cr3t@db.internal/rezeis',
    ],
    [
      'an approved sentence appended to a secret',
      'Bearer eyJhbGciOiJIUzI1NiJ9.aaaaaaaa.bbbbbbbb — Invalid login or password',
    ],
    [
      'an approved sentence wrapped in exception framing',
      'UnauthorizedException: Invalid login or password (at /srv/rezeis/admin/src/modules/auth/services/admin-auth.service.ts:280)',
    ],
    ['a case-folded near miss', 'invalid login or password'],
    ['a whitespace-padded near miss', '  Invalid login or password  '],
    ['a punctuation near miss', 'Invalid login or password.'],
    ['the other entry, adorned', 'Admin token is no longer valid: 6f1c2d3e4f5a6b7c8d9e0f1a2b3c'],
  ] as const) {
    it(`scrubs ${label}`, () => {
      assert.equal(
        messageOn(new UnauthorizedException(crafted)),
        'Request failed',
        `a near miss got through: ${crafted}`,
      );
    });
  }

  it('scrubs the poisoned element of an array without silencing its neighbour', () => {
    // Arrays are the validation shape, and are sanitised element by element.
    // The allowlist has to hold at that granularity too.
    const wire = throughSafeFilter(
      new BadRequestException({
        message: [
          'Invalid login or password',
          'Invalid login or password from postgres://admin:s3cr3t@db.internal/rezeis',
          'Plain client-facing validation issue',
        ],
      }),
    );

    assert.deepStrictEqual(wire.body.message, [
      'Invalid login or password',
      'Request failed',
      'Plain client-facing validation issue',
    ]);
    assert.equal(JSON.stringify(wire.body).includes('s3cr3t'), false);
  });

  it('does not extend the allowlist to the error LABEL', () => {
    // `error` carries Nest's status word, never product copy. Letting an
    // approved sentence through there would widen the exemption to a second
    // field for no benefit at all.
    const wire = throughSafeFilter(
      new BadRequestException({
        message: 'Plain client-facing validation issue',
        error: 'Invalid login or password',
      }),
    );

    assert.equal(wire.body.message, 'Plain client-facing validation issue');
    assert.equal(wire.body.error, 'Bad Request');
  });

  it('does not let a deliberate product CODE carry a scrubbable message', () => {
    // The other way this could have been written — "a body that names an
    // allowlisted code was authored on purpose, so trust its message" — is a
    // far wider exemption than the one taken. Prove it was not taken: the code
    // survives, the message does not.
    const wire = throughSafeFilter(
      new UnauthorizedException({
        code: 'totp_required',
        message: 'Two-factor required; session token 6f1c2d3e4f5a6b7c8d9e0f1a2b3c',
      }),
    );

    assert.equal(wire.body.code, 'totp_required', 'the code passthrough still works');
    assert.equal(wire.body.message, 'Request failed');
  });

  it('holds every allowlist entry to being hand-written product copy', () => {
    // The mechanical half of the review that adding an entry demands. The
    // vocabulary pattern is exactly what these entries are exempt from, so it
    // is not re-checked here; what is checked is that no entry carries a
    // SECRET-SHAPED value, and that none has a hole an interpolation could
    // fill. `'Failed to reach postgres://…'` or `'Token 6f1c… rejected'` would
    // fail this even though a reviewer waved them through.
    const secretShaped: readonly [string, RegExp][] = [
      ['a URL with credentials', /:\/\//u],
      ['an email address', /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/u],
      ['a long hex run', /\b[0-9a-f]{12,}\b/iu],
      ['a provider object id', /\b[a-z]{2,5}_[A-Za-z0-9][A-Za-z0-9_-]{3,}\b/u],
      ['an interpolation hole', /\$\{|\{\{|%[sd]\b/u],
      ['a filesystem path', /(?:^|\s)[A-Za-z]:[\\/]|\/(?:srv|home|usr|var|etc)\//u],
    ];

    assert.ok(SAFE_PRODUCT_MESSAGES.size > 0, 'an empty allowlist proves nothing');
    for (const sentence of SAFE_PRODUCT_MESSAGES) {
      assert.equal(sentence.trim(), sentence, `entry has stray whitespace: "${sentence}"`);
      assert.ok(sentence.length > 0);
      for (const [label, pattern] of secretShaped) {
        assert.equal(
          pattern.test(sentence),
          false,
          `allowlist entry looks like it carries ${label}: "${sentence}"`,
        );
      }
    }
  });
});

// ── 3. What this change does to the login-enumeration surface ───────────────

describe('the three login outcomes, as they leave the filter', () => {
  /**
   * Not a fix — `admin-auth.service.ts` is not this change's to touch — but a
   * pin on what the change did and did not move.
   *
   * The inactive branch answers with a different STATUS and a different
   * sentence, before the password is checked, so a deactivated login is
   * confirmable without knowing its password. Releasing 'Invalid login or
   * password' does not widen that: the sentence is shared by the two branches
   * that were already indistinguishable, and 'Admin user is inactive' has
   * never matched a sensitive pattern, so it was already reaching the wire
   * verbatim. The oracle is the status split, and it is untouched here.
   *
   * If a later edit gives the two 401 branches different words, the first
   * assertion below is what fails.
   */
  it('adds no field that tells the deactivated login apart from the other two', () => {
    // Both 401 branches — wrong password, and no such admin — throw the one
    // allowlisted sentence, so they remain a single indistinguishable class.
    // What is worth pinning is the SHAPE against the third outcome: if the
    // allowlist had introduced a `code`, or any other field, on the 401 and
    // not on the 403, the probe would have gained a second signal on top of
    // the status split it already has.
    const refused = throughSafeFilter(new UnauthorizedException('Invalid login or password'));
    const inactive = throughSafeFilter(new ForbiddenException('Admin user is inactive'));

    assert.deepStrictEqual(
      Object.keys(refused.body).sort(),
      Object.keys(inactive.body).sort(),
      'the two outcomes no longer carry the same field set',
    );
    assert.equal(refused.statusCode, 401);
    assert.equal(refused.body.message, 'Invalid login or password');
    assert.equal('code' in refused.body, false);
    assert.equal('code' in inactive.body, false);
  });

  it('leaves the deactivated-login branch exactly as it was', () => {
    // Byte for byte what it emitted before the allowlist existed: this
    // sentence trips none of the patterns, so it never passed through the code
    // path that changed.
    const wire = throughSafeFilter(new ForbiddenException('Admin user is inactive'));

    assert.equal(wire.statusCode, 403);
    assert.deepStrictEqual(withoutTimestamp(wire.body), {
      path: '/api/admin/auth/login',
      requestId: null,
      statusCode: 403,
      message: 'Admin user is inactive',
      errorCode: 'FORBIDDEN',
      error: 'Forbidden',
    });
    // Stated plainly, because it is the question the allowlist raises: this
    // sentence is NOT on the allowlist, and does not need to be. It trips no
    // sensitive pattern, so it was already reaching the wire verbatim. The
    // allowlist did not widen the enumeration surface by one character.
    assert.equal(SAFE_PRODUCT_MESSAGES.has('Admin user is inactive'), false);
  });

  it('carries the same deactivation sentence at TWO different statuses', () => {
    // Neither file is this change's to touch, so this is a measurement rather
    // than a fix - but it is the one whoever makes them consistent will need.
    //
    // `admin-auth.service.ts:362` refuses a deactivated admin at 403 on
    // POST /admin/auth/login. `admin-jwt.strategy.ts:62` refuses the same
    // account with the same sentence at 401, on every authenticated route.
    // One condition, one wording, two statuses - and the SPA's axios
    // interceptor spends 401 on "your session is over" while 403 renders as a
    // locked-workspace card. Whichever way they are reconciled, both call
    // sites have to move together.
    const atLogin = throughSafeFilter(new ForbiddenException('Admin user is inactive'));
    const onEveryRequest = throughSafeFilter(
      new UnauthorizedException('Admin user is inactive'),
      '/api/admin/auth/me',
    );

    assert.equal(atLogin.body.message, onEveryRequest.body.message);
    assert.equal(atLogin.statusCode, 403);
    assert.equal(atLogin.body.errorCode, 'FORBIDDEN');
    assert.equal(atLogin.body.error, 'Forbidden');
    assert.equal(onEveryRequest.statusCode, 401);
    assert.equal(onEveryRequest.body.errorCode, 'UNAUTHORIZED');
    assert.equal(onEveryRequest.body.error, 'Unauthorized');
  });
});
