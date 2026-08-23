import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ConfigType } from '@nestjs/config';
import type { ModuleRef } from '@nestjs/core';
import type { JwtService } from '@nestjs/jwt';

import type { RawCacheService } from '../src/common/cache/raw-cache.service';
import type { authConfig } from '../src/common/config/auth.config';
import type { PrismaService } from '../src/common/prisma/prisma.service';
import type { BlockedIpService } from '../src/modules/blocked-ips/services/blocked-ip.service';
import { PasskeyService } from '../src/modules/oauth/services/passkey.service';
import { LoginGuardService } from '../src/modules/two-factor/services/login-guard.service';

/**
 * The seam between passkey authentication and the brute-force guard, with a
 * REAL `LoginGuardService` on one end and a REAL `PasskeyService` on the other.
 *
 * Why this file exists rather than another test inside
 * `test/passkey-hardening.spec.ts`. That file already pins the caller half of
 * this contract, and pins it well: the guard is consulted before any work, the
 * arguments are `(remoteAddress, '')`, and a `true` becomes
 * `401 Too many login attempts`. But it drives a `LoginGuardService` DOUBLE
 * whose `isRateLimited` returns a canned boolean, so it can only ever assert
 * what happens once the guard has said stop. Whether the real guard ever SAYS
 * stop for a passkey attempt is a different question, and it was unasked:
 * adding `if (loginNormalized.length === 0) return false;` to the top of
 * `isRateLimited()` — a plausible "no login, nothing to scope, nothing to do"
 * tidy-up — leaves all 25 tests in that file green and all 19 in
 * `test/login-guard-window-semantics.spec.ts` green too, while passkey sign-in
 * runs with no rate limit at all.
 *
 * That is this repo's recurring defect stated exactly: the decision is correct
 * and nothing reaches it. So both ends are real here. Prisma, Redis and the JWT
 * signer are the edges and are faked; the attempts table is a real in-memory
 * table that BOTH ends share, so the failures the passkey path records are
 * literally the rows the guard counts.
 *
 * The empty login is correct, not a bug. `verifyAuthentication()` consults the
 * guard as its first statement, before `adminPasskey.findUnique()` — at that
 * moment the request has offered an assertion and nothing else, and passkey
 * sign-in is usernameless, so there is no account to scope a per-login budget
 * to. Rate-limiting first is also the point: the alternative is a credential
 * lookup per flood packet, and a per-credential answer leaks which credential
 * ids exist. The consequence is that the per-IP budget is the ONLY budget this
 * route has, which is what the tests below hold in place.
 */

const IP = '203.0.113.9';
const METADATA = {
  requestId: 'req-seam-1',
  remoteAddress: IP,
  userAgent: 'Mozilla/5.0 (test)',
};

interface AttemptRow {
  readonly loginNormalized: string;
  readonly ipAddress: string;
  readonly success: boolean;
  readonly reason: string | null;
  readonly createdAt: Date;
}

interface CountWhere {
  ipAddress?: string;
  loginNormalized?: string;
  success?: boolean;
  createdAt?: { gte?: Date };
}

interface Seam {
  readonly passkeyService: PasskeyService;
  /** The shared attempts table — written by the passkey path, read by the guard. */
  readonly attempts: AttemptRow[];
  /** Every `adminPasskey.findUnique` the service reached. Empty means it was stopped first. */
  readonly credentialLookups: string[];
  readonly auditRows: Array<Record<string, unknown>>;
  readonly blocks: Array<{ address: string; source: string }>;
}

function minutesAgo(minutes: number): Date {
  return new Date(Date.now() - minutes * 60 * 1000);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Builds the two real services over one fake Prisma.
 *
 * `adminLoginAttempt.count` filters the in-memory rows for real rather than
 * returning a canned number: a harness that answered with a fixed count would
 * pass for a guard that asked an entirely different question.
 */
function buildSeam(seed: readonly AttemptRow[]): Seam {
  const attempts: AttemptRow[] = [...seed];
  const credentialLookups: string[] = [];
  const auditRows: Array<Record<string, unknown>> = [];
  const blocks: Array<{ address: string; source: string }> = [];

  const prismaService = {
    adminLoginAttempt: {
      count: async (args: { where: CountWhere }): Promise<number> =>
        attempts.filter((row) => {
          const where = args.where;
          if (where.ipAddress !== undefined && row.ipAddress !== where.ipAddress) return false;
          if (where.loginNormalized !== undefined && row.loginNormalized !== where.loginNormalized) {
            return false;
          }
          if (where.success !== undefined && row.success !== where.success) return false;
          const gte = where.createdAt?.gte;
          if (gte !== undefined && row.createdAt < gte) return false;
          return true;
        }).length,
      create: async (args: { data: Omit<AttemptRow, 'createdAt'> }) => {
        attempts.push({ ...args.data, createdAt: new Date() });
        return args.data;
      },
    },
    adminPasskey: {
      findUnique: async (args: { where: { credentialId: string } }) => {
        credentialLookups.push(args.where.credentialId);
        return null;
      },
    },
    adminAuditLog: {
      create: async (args: { data: Record<string, unknown> }) => {
        auditRows.push(args.data);
        return args.data;
      },
    },
  } as unknown as PrismaService;

  const blockedIpService = {
    create: async (input: { address: string; source: string }): Promise<void> => {
      blocks.push({ address: input.address, source: input.source });
    },
  } as unknown as BlockedIpService;

  const loginGuardService = new LoginGuardService(prismaService, blockedIpService);

  const cacheService = {
    get: async () => null,
    set: async () => undefined,
    del: async () => undefined,
  } as unknown as RawCacheService;

  const jwtService = {
    signAsync: async () => 'unused.jwt.token',
  } as unknown as JwtService;

  // `resolveSecurityServices()` resolves all three lazily and treats ANY
  // failure as "no security services at all" — which would silently skip the
  // rate-limit check and make every assertion below vacuous. So all three
  // tokens answer; only the login guard is the real thing.
  const providers: Record<string, unknown> = {
    LoginGuardService: loginGuardService,
    TwoFactorService: { isEnabled: async () => false, verifyForLogin: async () => false },
    PasswordHashService: { verifyPassword: async () => false },
  };
  const moduleRef = {
    get: (token: unknown): unknown => {
      const name = (token as { name?: string } | undefined)?.name ?? '<anonymous>';
      if (!(name in providers)) throw new Error(`provider ${name} is not registered`);
      return providers[name];
    },
  } as unknown as ModuleRef;

  const passkeyService = new PasskeyService(
    prismaService,
    cacheService,
    jwtService,
    {} as unknown as ConfigType<typeof authConfig>,
    moduleRef,
  );

  return { passkeyService, attempts, credentialLookups, auditRows, blocks };
}

/**
 * A syntactically-shaped assertion for a credential that does not exist. It
 * never has to verify: every test here is decided before or at the credential
 * lookup, which is the point — the guard sits in front of all the WebAuthn
 * ceremony, and `test/passkey-hardening.spec.ts` is where the ceremony itself
 * is exercised for real.
 */
const ASSERTION = {
  id: 'credential-that-does-not-exist',
  rawId: 'credential-that-does-not-exist',
  type: 'public-key',
  clientExtensionResults: {},
  response: {
    clientDataJSON: '',
    authenticatorData: '',
    signature: '',
  },
} as unknown as Parameters<PasskeyService['verifyAuthentication']>[2];

function signIn(seam: Seam): Promise<unknown> {
  return seam.passkeyService.verifyAuthentication(
    'rezeis.example',
    'https://rezeis.example',
    ASSERTION,
    METADATA,
  );
}

/** Ten failures from one address, spread so no single login is near its own budget of 5. */
function tenFailuresFromOneAddress(): AttemptRow[] {
  return Array.from({ length: 10 }, (_unused, index) => ({
    loginNormalized: ['alpha', 'beta', ''][index % 3],
    ipAddress: IP,
    success: false,
    reason: 'invalid_password',
    createdAt: minutesAgo(12 - index),
  }));
}

describe('Passkey sign-in reaches the real login guard', () => {
  it('is refused before the credential is looked up once the per-IP budget is spent', async () => {
    const seam = buildSeam(tenFailuresFromOneAddress());

    const error = await signIn(seam).then(
      () => null,
      (err: unknown) => err,
    );

    assert.ok(error, 'the assertion was accepted from a rate-limited address');
    assert.equal(
      messageOf(error),
      'Too many login attempts. Try again later.',
      'the request was refused for some OTHER reason than the rate limit — this ' +
        'test would prove nothing about the guard',
    );
    assert.deepStrictEqual(
      seam.credentialLookups,
      [],
      'the credential was looked up anyway. The guard is meant to answer before ' +
        'any work happens; a flood that still costs a database round trip per ' +
        'packet is not rate-limited in the sense that matters.',
    );

    const rateLimitedAudit = seam.auditRows.find(
      (row) => JSON.stringify(row.metadata ?? {}).includes('rate_limited'),
    );
    assert.ok(
      rateLimitedAudit,
      'the refusal left no audit row saying it was a rate limit. The operator ' +
        'reading "passkey sign-in is failing" has nothing to tell a flood from a ' +
        'broken authenticator.',
    );
  });

  it('lets the assertion through while the budget still has room', async () => {
    // The vacuity guard for the test above. Nine failures is under the per-IP
    // budget of 10, so this request must reach the credential lookup and be
    // refused by it — a different refusal, with a different message. Without
    // this, a `verifyAuthentication()` that threw for any reason at all would
    // satisfy the assertions above.
    const seam = buildSeam(tenFailuresFromOneAddress().slice(0, 9));

    const error = await signIn(seam).then(
      () => null,
      (err: unknown) => err,
    );

    assert.equal(
      messageOf(error),
      'Passkey not found',
      'a request under the budget was refused by the rate limiter — the guard is ' +
        'now stopping traffic it should pass',
    );
    assert.deepStrictEqual(
      seam.credentialLookups,
      ['credential-that-does-not-exist'],
      'the credential lookup did not happen, so the request never got past the guard',
    );
  });

  it('spends the budget with the failures it records itself', async () => {
    // The loop closed, both ends real. Nine seeded failures, then one rejected
    // assertion that `recordFailedLogin()` writes as the tenth — with an empty
    // login, because there is no account to name — and the SAME address is
    // refused on its next attempt by the guard reading that row back.
    const seam = buildSeam(tenFailuresFromOneAddress().slice(0, 9));

    const first = await signIn(seam).then(
      () => null,
      (err: unknown) => err,
    );
    assert.equal(messageOf(first), 'Passkey not found', 'the fixture did not reach the lookup');
    assert.equal(
      seam.attempts.length,
      10,
      'the rejected assertion was not recorded as a failed attempt, so it costs ' +
        'an attacker nothing to keep trying',
    );
    assert.equal(
      seam.attempts[9]?.loginNormalized,
      '',
      'the recorded attempt named a login it cannot know yet',
    );

    const second = await signIn(seam).then(
      () => null,
      (err: unknown) => err,
    );
    assert.equal(
      messageOf(second),
      'Too many login attempts. Try again later.',
      'the tenth failure the passkey route recorded did not spend the budget the ' +
        'passkey route checks. The two halves are wired to different counters, or ' +
        'the per-IP budget no longer applies to attempts without a login — which ' +
        'is all of them here.',
    );
    assert.equal(
      seam.credentialLookups.length,
      1,
      'the second attempt reached the credential lookup as well — it was not ' +
        'stopped by the guard',
    );
  });

  it('auto-blocks the address once the passkey route has spent the whole window', async () => {
    // `evaluateAndBlock()` has no per-login layer at all, so an empty login must
    // not stop it. This is the step that moves the address from "refused this
    // request" to "refused every request", and it is the only one that outlives
    // the 15-minute window.
    const seam = buildSeam(tenFailuresFromOneAddress().slice(0, 9));

    await signIn(seam).then(
      () => null,
      () => null,
    );

    assert.deepStrictEqual(
      seam.blocks,
      [{ address: IP, source: 'login_guard' }],
      'ten failed passkey assertions from one address did not put it on the ' +
        'blocklist — the auto-block does not fire for attempts that carry no login',
    );
  });
});
