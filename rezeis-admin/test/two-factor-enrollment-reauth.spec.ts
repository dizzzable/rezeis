/**
 * Minting a second factor demanded nothing the session did not already carry.
 *
 * `POST /admin/2fa/enroll` and `POST /admin/2fa/confirm` sat behind
 * `AdminJwtAuthGuard` and nothing else, and `enroll` hands the caller a fresh
 * TOTP secret plus a fresh set of recovery codes. So a stolen bearer token was
 * a complete account takeover in two requests: enrol, confirm, and from that
 * moment the account's second factor belongs to the attacker while the
 * legitimate operator's password alone stops being sufficient. An adversarial
 * review proved it end to end against the real services.
 *
 * It also falsified a premise something else relies on.
 * `PasskeyService.assertFreshFactor` picks the password when an account has no
 * 2FA, on the stated grounds that it is then "the only factor left that a
 * hijacked session does not hold". This route sold the session a factor of its
 * own, so two requests converted the password branch into the TOTP branch and
 * satisfied it with a secret the attacker had just been handed.
 *
 * The existing coverage could not have caught any of this:
 * `test/admin-two-factor.controller.spec.ts` asserts route paths, verbs and
 * guard lists and never calls a handler, and `beginEnrollment` had no
 * behavioural spec anywhere. These cases drive the REAL service and assert
 * what it did — whether a secret was minted, and whether the database was
 * touched — rather than that a check was called.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { PasswordHashService } from '../src/modules/auth/services/password-hash.service';
import { TwoFactorService } from '../src/modules/two-factor/services/two-factor.service';

const CRYPT_KEY = 'a'.repeat(64);
const REAL_PASSWORD = 'the-real-password-nobody-stole';

interface Harness {
  readonly service: TwoFactorService;
  /** Every write that reached `adminUser.update` — i.e. the minted secret. */
  readonly userUpdates: Array<Record<string, unknown>>;
  /** Every audit row written, so a seizure is not invisible. */
  readonly auditRows: Array<Record<string, unknown>>;
}

async function buildHarness(
  options: { readonly totpEnabled?: boolean; readonly withVerifier?: boolean } = {},
): Promise<Harness> {
  const userUpdates: Array<Record<string, unknown>> = [];
  const auditRows: Array<Record<string, unknown>> = [];
  // A real hash from the real hasher — the point is that a wrong password is
  // rejected by the same code production uses, not by a fake that says no.
  const hasher = new PasswordHashService();
  const passwordHash = await hasher.hashPassword({
    plainTextPassword: REAL_PASSWORD,
    audience: 'admin',
  });

  const prismaService = {
    adminUser: {
      findUniqueOrThrow: async () => ({
        id: 'admin-1',
        login: 'operator',
        totpEnabled: options.totpEnabled ?? false,
        passwordHash,
      }),
      update: async (args: { data: Record<string, unknown> }) => {
        userUpdates.push(args.data);
        return args.data;
      },
    },
    adminAuditLog: {
      create: async (args: { data: Record<string, unknown> }) => {
        auditRows.push(args.data);
        return args.data;
      },
    },
  } as unknown as PrismaService;

  const service = new TwoFactorService(
    prismaService,
    { cryptKey: CRYPT_KEY, serviceName: 'Rezeis Admin' } as never,
    undefined,
    options.withVerifier === false ? undefined : hasher,
  );
  return { service, userUpdates, auditRows };
}

function payloadOf(error: unknown): Record<string, unknown> {
  const response = (error as { getResponse?: () => unknown }).getResponse?.();
  return (response && typeof response === 'object' ? response : {}) as Record<string, unknown>;
}

async function attempt(
  service: TwoFactorService,
  password?: string,
): Promise<{ readonly result: unknown; readonly error: unknown }> {
  try {
    return { result: await service.beginEnrollment('admin-1', password), error: null };
  } catch (err) {
    return { result: null, error: err };
  }
}

describe('minting a second factor demands the current password', () => {
  it('refuses a bearer token on its own, and mints nothing', async () => {
    // The attack verbatim: the session, and nothing else.
    const harness = await buildHarness();

    const { result, error } = await attempt(harness.service);

    assert.equal(result, null, 'a session alone must not buy a second factor');
    assert.equal(payloadOf(error)['statusCode'], 401);
    // The secret is the prize. Nothing may reach the database.
    assert.deepEqual(harness.userUpdates, [], 'a refused enrolment wrote a secret anyway');
  });

  it('names the credential it wants, so the panel can ask for it', async () => {
    // Without `code` AND `factor` on the wire the SPA gets an untyped 401,
    // cannot raise a prompt, and 2FA simply cannot be switched on. That exact
    // failure already shipped once on the passkey path.
    const harness = await buildHarness();

    const { error } = await attempt(harness.service);

    assert.equal(payloadOf(error)['code'], 'totp_enroll_reauth_required');
    assert.equal(payloadOf(error)['factor'], 'password');
  });

  it('refuses a wrong password, and still mints nothing', async () => {
    const harness = await buildHarness();

    const { result, error } = await attempt(harness.service, 'guessed-it-wrong');

    assert.equal(result, null);
    assert.match(String((error as Error).message), /Re-authentication failed/);
    assert.deepEqual(harness.userUpdates, []);
  });

  it('records the refusal, so a seizure attempt is not invisible', async () => {
    // The module wrote no audit row at all before this — only a logger line.
    const harness = await buildHarness();

    await attempt(harness.service, 'guessed-it-wrong');

    assert.equal(harness.auditRows.length, 1);
    assert.equal(harness.auditRows[0]?.['action'], 'admin.2fa.enrollment_rejected');
    assert.equal(harness.auditRows[0]?.['adminUserId'], 'admin-1');
  });

  it('lets the real operator through, with a usable secret', async () => {
    // The other half of the rule. A gate that also blocked the legitimate
    // operator would just mean nobody can enable 2FA, which is its own outage
    // and is how a control ends up switched off.
    const harness = await buildHarness();

    const { result, error } = await attempt(harness.service, REAL_PASSWORD);

    assert.equal(error, null);
    const enrollment = result as { secret: string; otpauthUri: string; recoveryCodes: string[] };
    assert.ok(enrollment.secret.length > 0, 'the operator must actually get a secret');
    assert.match(enrollment.otpauthUri, /^otpauth:\/\/totp\//);
    assert.ok(enrollment.recoveryCodes.length > 0);
    assert.equal(harness.userUpdates.length, 1, 'the secret must be persisted for confirm');
  });

  it('refuses when no password verifier is available, rather than minting unverified', async () => {
    // The verifier is `@Optional()` so the many positionally-constructed specs
    // keep compiling. Optional must not mean skippable: an unresolvable
    // verifier is exactly the state in which minting is least safe.
    const harness = await buildHarness({ withVerifier: false });

    const { result, error } = await attempt(harness.service, REAL_PASSWORD);

    assert.equal(result, null, 'a missing verifier must refuse, not wave the request through');
    assert.equal(payloadOf(error)['statusCode'], 401);
    assert.deepEqual(harness.userUpdates, []);
  });

  it('still refuses an account that already has 2FA before asking for anything', async () => {
    // Pre-existing behaviour, pinned so the new gate cannot be read as having
    // replaced it: re-enrolling over a live factor stays a conflict, and that
    // refusal must not be downgraded into a password prompt.
    const harness = await buildHarness({ totpEnabled: true });

    const { error } = await attempt(harness.service, REAL_PASSWORD);

    assert.match(String((error as Error).message), /already enabled/i);
    assert.deepEqual(harness.userUpdates, []);
  });
});
