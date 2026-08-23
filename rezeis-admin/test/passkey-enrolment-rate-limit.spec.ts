import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ModuleRef } from '@nestjs/core';

import { PasswordHashService } from '../src/modules/auth/services/password-hash.service';
import { PasskeyService } from '../src/modules/oauth/services/passkey.service';

/**
 * Passkey ENROLMENT re-authentication must spend the fail2ban budget.
 *
 * The sign-in half of this file was already wired to `LoginGuardService`:
 * `isRateLimited` opens `verifyAuthentication`, and six `recordFailedLogin`
 * calls sit on its rejection paths. `assertFreshFactor` — the enrolment gate on
 * `passkey/register/options` — wrote an audit row and nothing else, so a stolen
 * bearer token could guess the account's TOTP code or password there forever
 * and `admin_login_attempts` stayed empty. The route now carries a 10/60s
 * throttle, which bounds the rate; what was missing is the account-level
 * counter, and that is what these tests pin.
 *
 * Two of them are anti-vacuity controls, and both matter: a recorder that fires
 * on every call would satisfy "the failure was charged" while quietly billing
 * the operator for opening the dialog and for succeeding.
 */

const METADATA = {
  requestId: 'req-1',
  remoteAddress: '203.0.113.7',
  userAgent: 'Mozilla/5.0 (test)',
};

const RP_ID = 'panel.example.test';
const PASSWORD = 'correct horse battery staple';

interface RecordedAttempt {
  readonly loginNormalized: string;
  readonly ipAddress: string;
  readonly success: boolean;
  readonly reason: string | null;
  readonly userAgent: string | null;
}

interface Harness {
  readonly service: PasskeyService;
  readonly attempts: RecordedAttempt[];
  readonly rateLimitChecks: string[];
  readonly auditActions: string[];
}

async function createHarness(options?: {
  totpEnabled?: boolean;
  acceptedCodes?: readonly string[];
  /** Reproduces a container where the counter is not wired at all. */
  omitLoginGuard?: boolean;
}): Promise<Harness> {
  const attempts: RecordedAttempt[] = [];
  const rateLimitChecks: string[] = [];
  const auditActions: string[] = [];
  const passwordHashService = new PasswordHashService();
  const passwordHash = await passwordHashService.hashPassword({
    plainTextPassword: PASSWORD,
    audience: 'admin',
  });

  const prisma = {
    adminUser: {
      findUnique: async () => ({
        id: 'admin-1',
        login: 'Operator',
        loginNormalized: 'operator',
        name: 'The Operator',
        totpEnabled: options?.totpEnabled ?? false,
        passwordHash,
      }),
    },
    adminPasskey: { findMany: async () => [] },
    adminAuditLog: {
      create: async ({ data }: { data: { action: string } }) => {
        auditActions.push(data.action);
        return data;
      },
    },
  };

  const cache = {
    get: async () => null,
    set: async () => undefined,
    del: async () => undefined,
  };

  const loginGuard = {
    isRateLimited: async (ipAddress: string) => {
      rateLimitChecks.push(ipAddress);
      return false;
    },
    recordAttempt: async (input: RecordedAttempt) => {
      attempts.push(input);
      return { autoBlocked: false, failureCount: attempts.length };
    },
  };

  const providers: Record<string, unknown> = {
    TwoFactorService: {
      verifyForLogin: async (_adminId: string, code: string) =>
        (options?.acceptedCodes ?? ['123456']).includes(code),
    },
    PasswordHashService: passwordHashService,
  };
  if (!options?.omitLoginGuard) providers['LoginGuardService'] = loginGuard;

  const moduleRef = {
    get: (token: unknown): unknown => {
      const name = (token as { name?: string } | undefined)?.name ?? '<anonymous>';
      if (!(name in providers)) throw new Error(`provider ${name} is not registered`);
      return providers[name];
    },
  } as unknown as ModuleRef;

  const service = new PasskeyService(
    prisma as never,
    cache as never,
    { signAsync: async () => 'jwt' } as never,
    { jwtSecret: 'x', jwtExpiresIn: '24h' } as never,
    moduleRef,
  );

  return { service, attempts, rateLimitChecks, auditActions };
}

function enrol(
  harness: Harness,
  reauth: { code?: string; password?: string },
): Promise<Record<string, unknown> | Error> {
  return harness.service
    .generateRegistrationOptions('admin-1', RP_ID, reauth, METADATA)
    .then(
      (options) => options,
      (error: unknown) => error as Error,
    );
}

describe('a failed passkey-enrolment factor is charged to the login guard', () => {
  it('records a failed TOTP code as a failure against the account', async () => {
    const harness = await createHarness({ totpEnabled: true, acceptedCodes: ['123456'] });

    const outcome = await enrol(harness, { code: '000000' });

    assert.ok(outcome instanceof Error, 'a wrong code must not produce enrolment options');
    assert.equal(harness.attempts.length, 1, 'the enrolment factor spent nothing');
    assert.deepEqual(harness.attempts[0], {
      loginNormalized: 'operator',
      ipAddress: '203.0.113.7',
      success: false,
      reason: 'passkey_enrolment_invalid_totp',
      userAgent: 'Mozilla/5.0 (test)',
    });
    assert.ok(
      harness.auditActions.includes('admin.passkey.registration_rejected'),
      'the honest audit row must survive alongside the counter',
    );
    assert.ok(
      !harness.auditActions.includes('admin.login.failed'),
      'an enrolment is not a login; it must not claim one failed',
    );
  });

  it('records a failed password factor when the account has no 2FA', async () => {
    const harness = await createHarness({ totpEnabled: false });

    const outcome = await enrol(harness, { password: 'not the password' });

    assert.ok(outcome instanceof Error);
    assert.equal(harness.attempts.length, 1);
    assert.equal(harness.attempts[0]?.success, false);
    assert.equal(harness.attempts[0]?.reason, 'passkey_enrolment_invalid_password');
  });

  it('keys the counter on the real login, not the empty one sign-in must use', async () => {
    // The decision this pins. `verifyAuthentication` passes `''` because passkey
    // sign-in is usernameless and the account is unknown until the credential
    // resolves. Enrolment is authenticated — the account IS known — so copying
    // the empty login here would write a row no per-account query can find and
    // would skip the tighter per-(login, IP) budget entirely.
    const harness = await createHarness({ totpEnabled: true });

    await enrol(harness, { code: '000000' });

    assert.equal(harness.attempts.length, 1);
    assert.notEqual(harness.attempts[0]?.loginNormalized, '', 'the account was known and dropped');
    assert.equal(harness.attempts[0]?.loginNormalized, 'operator');
  });

  it('still refuses the enrolment when the counter is not wired at all', async () => {
    // Degrading the way every other lazily-resolved dependency in this file
    // degrades: an absent counter must not become a way to enrol.
    const harness = await createHarness({ totpEnabled: true, omitLoginGuard: true });

    const outcome = await enrol(harness, { code: '000000' });

    assert.ok(outcome instanceof Error, 'a missing counter let a wrong code through');
    assert.equal(harness.attempts.length, 0);
  });
});

describe('what the enrolment counter must NOT charge', () => {
  it('does not bill the prompt round-trip that carries no factor at all', async () => {
    // ANTI-VACUITY CONTROL. The SPA's first call deliberately arrives empty so
    // the server can say which factor to render. Recording it would spend the
    // operator's budget for opening the dialog — five clicks and their own
    // password sign-in starts answering 429.
    const harness = await createHarness({ totpEnabled: true });

    const outcome = await enrol(harness, {});

    assert.ok(outcome instanceof Error);
    assert.equal(
      (outcome as Error & { getResponse?: () => { code?: string } }).getResponse?.().code,
      'passkey_reauth_required',
      'this must be the prompt, not a rejection',
    );
    assert.deepEqual(harness.attempts, [], 'the prompt was billed as a failed attempt');
  });

  it('records a SUCCESSFUL enrolment as a success, never as a failure', async () => {
    // ANTI-VACUITY CONTROL. "Record on every path" would pass every assertion
    // in the suite above while marking a correct code as a failed attempt —
    // five successful enrolments would then lock the operator out.
    const harness = await createHarness({ totpEnabled: true, acceptedCodes: ['123456'] });

    const outcome = await enrol(harness, { code: '123456' });

    assert.ok(!(outcome instanceof Error), 'a correct code must produce enrolment options');
    assert.ok(
      typeof (outcome as Record<string, unknown>)['challenge'] === 'string',
      'the enrolment did not actually complete',
    );
    assert.equal(harness.attempts.length, 1);
    assert.equal(harness.attempts[0]?.success, true, 'a correct factor was recorded as a FAILURE');
    assert.equal(harness.attempts[0]?.reason, 'passkey_enrolment');
    assert.equal(
      harness.attempts.filter((a) => !a.success).length,
      0,
      'a successful enrolment must not leave a failure row behind it',
    );
  });
});
