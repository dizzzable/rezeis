import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';

import { Logger } from '@nestjs/common';

import { RawCacheService } from '../src/common/cache/raw-cache.service';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { TwoFactorService } from '../src/modules/two-factor/services/two-factor.service';
import { base32Decode } from '../src/modules/two-factor/utils/base32';
import { encryptTotpSecret } from '../src/modules/two-factor/utils/secret-cipher';
import { computeTotpCode, generateTotpSecret } from '../src/modules/two-factor/utils/totp';

/**
 * RFC 6238 §5.2 — a TOTP code is accepted at most ONCE.
 *
 * The defect this file was written after. `verifyForLogin()` computed the
 * expected code, compared it, returned the answer, and wrote nothing. With
 * `period = 30` and `window = 1` that made one observed six-digit code valid
 * across a 90-second band, an unlimited number of times. Inside that band a
 * single shoulder-surfed or replayed code bought three things, not one: a 24h
 * admin session via `POST /admin/auth/login`, PERMANENT removal of the second
 * factor via `POST /admin/2fa/disable` — which asks for a code and NOT for the
 * password — and a fresh recovery-code set via
 * `POST /admin/2fa/recovery-codes/regenerate`.
 *
 * What is faked and what is not. Prisma and the cache are the edges and are
 * faked. Everything on the path under test is real: the real
 * `TwoFactorService`, the real AES-GCM secret cipher, the real Base32 decode,
 * the real `verifyTotpCode()`. The codes fed in are computed with the
 * production `computeTotpCode()` from the production secret, so a test can
 * only pass by making the real algorithm accept and then consume them.
 *
 * The direction of the failure, decided rather than inherited. When the claim
 * store cannot answer, the TOTP branch REFUSES. Failing open would mean that
 * for the length of a Redis incident every captured code is replayable again
 * across its 90-second band — the exact condition the claim exists to remove,
 * arriving precisely when nobody is watching the logs. The price is real and
 * is not hidden: TOTP login is refused panel-wide for the duration, and
 * `POST /admin/2fa/disable` asks for a code too, so an operator cannot even
 * turn the second factor off to get past it.
 *
 * That price is payable only because the RECOVERY branch is unaffected — it is
 * Postgres-only and never consults the cache, so ten single-use codes issued at
 * enrollment remain a working way in. The fail-closed tests below and the
 * recovery-under-outage tests at the bottom are two halves of one decision;
 * neither is safe to keep without the other.
 */

const CRYPT_KEY = 'k'.repeat(32);
const ADMIN_ID = 'admin-1';
const TOTP_PERIOD_SECONDS = 30;

/**
 * In-memory stand-in for `RawCacheService`, faithful to the two methods used.
 *
 * A cache can fail in two shapes and the service handles them in two different
 * places, so both are modelled here:
 *
 *   - `down` — the client is present and ANSWERS, negatively. That is the real
 *     `isReady()` guard returning `false`, and it lands on the `if` branch.
 *   - `rejectsWith` — the client REJECTS mid-flight: a reset connection, a
 *     command timeout, `MISCONF`, a cluster failover. That lands in the
 *     `catch`, which is a separate decision and needs its own fixture. Without
 *     one, the `catch` could `return true` and this whole file stayed green
 *     while TOTP replay was unlimited for the length of the incident.
 */
class FakeCache {
  public readonly claims = new Map<string, number>();
  public readonly claimCalls: Array<{ key: string; ttlSeconds: number }> = [];
  /** Flip to simulate a Redis outage: `claimOnce` fails closed, `exists` sees nothing. */
  public down = false;
  /** Set to simulate a client that throws instead of answering. */
  public claimRejectsWith: Error | null = null;
  public existsRejectsWith: Error | null = null;

  public async claimOnce(key: string, ttlSeconds: number): Promise<boolean> {
    this.claimCalls.push({ key, ttlSeconds });
    if (this.claimRejectsWith) throw this.claimRejectsWith;
    if (this.down) return false; // mirrors the real fail-closed `isReady()` guard
    if (this.claims.has(key)) return false;
    this.claims.set(key, ttlSeconds);
    return true;
  }

  public async exists(key: string): Promise<boolean> {
    if (this.existsRejectsWith) throw this.existsRejectsWith;
    if (this.down) return false;
    return this.claims.has(key);
  }
}

interface Harness {
  readonly service: TwoFactorService;
  readonly cache: FakeCache;
  readonly secret: string;
  readonly recoveryHashes: string[];
  readonly userUpdates: Array<Record<string, unknown>>;
}

function buildHarness(options: { withCache?: boolean; recoveryHashes?: string[] } = {}): Harness {
  const secret = generateTotpSecret();
  const recoveryHashes = options.recoveryHashes ?? [];
  const userUpdates: Array<Record<string, unknown>> = [];

  const prismaService = {
    adminUser: {
      findUnique: async () => ({
        totpEnabled: true,
        totpSecretEncrypted: encryptTotpSecret(secret, CRYPT_KEY),
        totpRecoveryCodes: recoveryHashes,
      }),
      update: async (args: { data: Record<string, unknown> }) => {
        userUpdates.push(args.data);
        return args.data;
      },
    },
  } as unknown as PrismaService;

  const cache = new FakeCache();
  const service = new TwoFactorService(
    prismaService,
    { cryptKey: CRYPT_KEY, serviceName: 'Rezeis Admin' } as never,
    options.withCache === false ? undefined : (cache as unknown as RawCacheService),
  );

  return { service, cache, secret, recoveryHashes, userUpdates };
}

/** The code a phone would show right now, and the step it belongs to. */
function currentCode(secret: string): { code: string; step: number } {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const step = Math.floor(nowSeconds / TOTP_PERIOD_SECONDS);
  return { code: computeTotpCode(base32Decode(secret), step * TOTP_PERIOD_SECONDS), step };
}

// ── Log capture ──────────────────────────────────────────────────────────────
// The brief asks for one thing beyond the decision: when the cache is down,
// TOTP login must fail closed AND the operator must be able to tell that apart
// from a wrong code in the logs. Both refusals return `false` to the caller, so
// the log line is the ONLY place that distinction can live — which makes it
// part of the contract, not decoration.

const logs: Array<{ level: string; message: string }> = [];
const recordingLogger = {
  log: (message: unknown) => logs.push({ level: 'log', message: String(message) }),
  warn: (message: unknown) => logs.push({ level: 'warn', message: String(message) }),
  error: (message: unknown) => logs.push({ level: 'error', message: String(message) }),
  debug: (message: unknown) => logs.push({ level: 'debug', message: String(message) }),
  verbose: (message: unknown) => logs.push({ level: 'verbose', message: String(message) }),
  fatal: (message: unknown) => logs.push({ level: 'fatal', message: String(message) }),
};
Logger.overrideLogger(recordingLogger);

beforeEach(() => {
  logs.length = 0;
});

after(() => {
  Logger.overrideLogger(false);
});

describe('TwoFactorService.verifyForLogin — a TOTP code is consumable exactly once', () => {
  it('accepts a valid code the first time and refuses the identical code afterwards', async () => {
    const harness = buildHarness();
    const { code } = currentCode(harness.secret);

    assert.equal(
      await harness.service.verifyForLogin(ADMIN_ID, code),
      true,
      'a freshly minted code was refused on first use — the fix broke the happy path',
    );

    assert.equal(
      await harness.service.verifyForLogin(ADMIN_ID, code),
      false,
      'the SAME six digits were accepted a second time. RFC 6238 §5.2 requires ' +
        'one-time use; without it one captured code is valid for the full 90s ' +
        'drift band and buys a 24h session, `POST /admin/2fa/disable` (code, no ' +
        'password) and a fresh recovery-code set.',
    );

    // Vacuity guard. Both assertions above would also hold for a service that
    // rejected the code outright for some unrelated reason, or for one that
    // never consulted the claim store at all.
    assert.equal(
      harness.cache.claimCalls.length,
      2,
      'the single-use claim was not attempted — this spec proved nothing',
    );
  });

  it('refuses replays for 90 seconds — the full width of the ±1-step drift band', async () => {
    // The TTL is what closes the window; a shorter one would re-open its tail.
    // A code minted for step S is accepted while the current step is S-1..S+1,
    // so counting from the earliest moment it can be presented the band is
    // `period * (2 * window + 1)`.
    const harness = buildHarness();
    const { code } = currentCode(harness.secret);
    await harness.service.verifyForLogin(ADMIN_ID, code);

    assert.equal(
      harness.cache.claimCalls[0]?.ttlSeconds,
      90,
      'the claim expires before the code does, so the tail of the drift band ' +
        'stays replayable',
    );
  });

  it('claims the time step, not the admin — a neighbouring step still authenticates', async () => {
    // Keying on the admin alone would lock an operator out of their own panel
    // for 90 seconds after every login. Keying on the step consumes exactly the
    // code that was seen.
    const harness = buildHarness();
    const { code, step } = currentCode(harness.secret);
    await harness.service.verifyForLogin(ADMIN_ID, code);

    const previousStepCode = computeTotpCode(
      base32Decode(harness.secret),
      (step - 1) * TOTP_PERIOD_SECONDS,
    );
    // Distinct digits are not guaranteed by construction (1-in-10^6), and a
    // collision would make the assertion below meaningless rather than wrong.
    if (previousStepCode !== code) {
      assert.equal(
        await harness.service.verifyForLogin(ADMIN_ID, previousStepCode),
        true,
        'consuming one step also consumed its neighbour — the claim key is not ' +
          'per-step',
      );
    }
  });

  it('names the claim key after the admin and the real time step', async () => {
    // This is the mirror pin. `TOTP_PERIOD_SECONDS` / `TOTP_DRIFT_STEPS` in
    // two-factor.service.ts restate `DEFAULT_PERIOD_SEC` / `DEFAULT_WINDOW`
    // from utils/totp.ts, which does not export them. If the util's defaults
    // change, `resolveMatchedTimeStep()` silently stops matching and every
    // TOTP login starts failing closed. This test says so first, and names the
    // constant to update.
    const harness = buildHarness();
    const { code, step } = currentCode(harness.secret);
    await harness.service.verifyForLogin(ADMIN_ID, code);

    assert.equal(
      harness.cache.claimCalls[0]?.key,
      `admin:2fa:totp-step:${ADMIN_ID}:${step}`,
      'the claim key no longer names the step the code belongs to — ' +
        'TOTP_PERIOD_SECONDS/TOTP_DRIFT_STEPS in two-factor.service.ts have ' +
        'drifted from the defaults in utils/totp.ts',
    );
  });

  it('scopes the claim per admin, so one operator cannot lock out another', async () => {
    const harness = buildHarness();
    const { code } = currentCode(harness.secret);
    await harness.service.verifyForLogin('admin-a', code);

    assert.equal(
      await harness.service.verifyForLogin('admin-b', code),
      true,
      'a second admin was refused because a different admin had used the same ' +
        'time step — the key is missing its admin scope',
    );
  });
});

describe('TwoFactorService.verifyForLogin — failure modes the fix introduces', () => {
  it('fails CLOSED when the claim store is unreachable, with a log that says so', async () => {
    const harness = buildHarness();
    harness.cache.down = true;
    const { code } = currentCode(harness.secret);

    assert.equal(
      await harness.service.verifyForLogin(ADMIN_ID, code),
      false,
      'a valid code was accepted while the single-use claim could not be ' +
        'recorded — during a cache outage every captured code becomes ' +
        'replayable again, which is exactly the condition the claim exists for',
    );

    const outageLog = logs.find((entry) => entry.message.includes('claim store is unavailable'));
    assert.ok(
      outageLog,
      'nothing in the log distinguishes "the cache is down" from "wrong code". ' +
        'Both return false to the caller, so this line is the only signal an ' +
        'operator has while every TOTP login in the panel is refused.',
    );
    assert.equal(outageLog.level, 'error', 'a panel-wide login outage is not a warning');
  });

  it('separates a replay from an outage in the log', async () => {
    const harness = buildHarness();
    const { code } = currentCode(harness.secret);
    await harness.service.verifyForLogin(ADMIN_ID, code);
    logs.length = 0;
    await harness.service.verifyForLogin(ADMIN_ID, code);

    const replayLog = logs.find((entry) => entry.message.includes('replay'));
    assert.ok(
      replayLog,
      'a replayed code logged nothing about being a replay — the operator sees ' +
        'the same silence as for a typo, and an attack looks like a fumble',
    );
    assert.equal(
      logs.some((entry) => entry.message.includes('claim store is unavailable')),
      false,
      'a healthy cache reported itself as an outage',
    );
  });

  it('fails CLOSED when the claim command REJECTS rather than answering', async () => {
    // The other outage shape, and the one the `catch` in `claimTotpTimeStep()`
    // exists for. `down` above is a cache that is reachable and says no; this
    // is a cache that throws — reset connection, command timeout, `MISCONF`,
    // failover mid-command. The service's own comment says it "refuses the same
    // way", and until this test that claim was unguarded: changing the `catch`
    // to `return true` left every other assertion in this file green while
    // re-opening unlimited replay inside the 90-second drift band for as long
    // as Redis stayed unhappy.
    const harness = buildHarness();
    harness.cache.claimRejectsWith = new Error('Connection is closed.');
    const { code } = currentCode(harness.secret);

    assert.equal(
      await harness.service.verifyForLogin(ADMIN_ID, code),
      false,
      'a valid code was accepted while the claim command was throwing. The ' +
        'single-use guarantee is unverifiable in that state, which is exactly ' +
        'the condition a replay needs.',
    );
    assert.equal(
      harness.cache.claimCalls.length,
      1,
      'the claim was never attempted — the code was refused for some other ' +
        'reason and this spec proved nothing about the catch',
    );

    const failureLog = logs.find((entry) => entry.message.includes('single-use claim failed'));
    assert.ok(
      failureLog,
      'the refusal is invisible in the log. An operator seeing every TOTP ' +
        'login rejected has only this line to tell an infrastructure fault ' +
        'from a panel full of wrong codes.',
    );
    assert.equal(failureLog.level, 'error', 'a panel-wide login outage is not a warning');
    assert.match(
      failureLog.message,
      /Connection is closed\./u,
      'the underlying cache error is not quoted, so the log names a fault ' +
        'without naming which one',
    );
  });

  it('fails CLOSED when the replay/outage disambiguation itself throws', async () => {
    // The failure path makes a SECOND call — `exists()`, to tell "already
    // claimed" from "cache down" in the log. That call is inside the same
    // `try`, so a cache that answers the claim and then dies still has to
    // refuse rather than fall through to an accept.
    const harness = buildHarness();
    const { code } = currentCode(harness.secret);
    assert.equal(await harness.service.verifyForLogin(ADMIN_ID, code), true);

    harness.cache.existsRejectsWith = new Error('READONLY You can not write against a replica.');
    logs.length = 0;

    assert.equal(
      await harness.service.verifyForLogin(ADMIN_ID, code),
      false,
      'a replayed code was accepted because the log-disambiguation call threw',
    );
    assert.ok(
      logs.some(
        (entry) => entry.level === 'error' && entry.message.includes('single-use claim failed'),
      ),
      'the refusal is invisible in the log',
    );
  });

  it('never throws out of verifyForLogin, whatever the cache does', async () => {
    // `verifyForLogin()` documents that it "never throws": callers treat it as
    // a boolean verdict, and `AdminAuthService`/`OAuthLoginService` turn a
    // `false` into a clean 401. An escaping cache error would surface as a 500
    // on the login route instead — and, worse, would skip the audit-log write
    // that the refusal path performs.
    const harness = buildHarness();
    harness.cache.claimRejectsWith = new Error('ECONNRESET');
    const { code } = currentCode(harness.secret);

    await assert.doesNotReject(
      () => harness.service.verifyForLogin(ADMIN_ID, code),
      'a cache error escaped as an exception; the login route answers 500',
    );
  });

  it('fails CLOSED when no claim store was injected at all', async () => {
    // `RawCacheModule` is `@Global()`, so Nest always supplies it in
    // production; the constructor parameter is `@Optional()` only so specs
    // that build the service by hand keep compiling. An optional dependency
    // that silently switched single-use OFF would be the exact shape of defect
    // this repo keeps paying for: a correct decision nothing reaches.
    const harness = buildHarness({ withCache: false });
    const { code } = currentCode(harness.secret);

    assert.equal(
      await harness.service.verifyForLogin(ADMIN_ID, code),
      false,
      'without a claim store the service went back to accepting a code ' +
        'unlimited times — the `@Optional()` parameter has become a way to ' +
        'turn the protection off',
    );
    assert.ok(
      logs.some((entry) => entry.message.includes('no cache service available')),
      'the refusal is invisible in the log',
    );
  });
});

describe('TwoFactorService.verifyForLogin — the recovery-code branch is undisturbed', () => {
  const RECOVERY_CODE = 'a1b2c3d4e5';
  const RECOVERY_HASH = 'db28a53c6b8a1d1c8e6a0c6f4dbdd6a86b0d1e3a3b4b12d6a5aaf0b6bf6e0f11';

  it('still consumes a recovery code from the database, without touching the cache', async () => {
    // The recovery branch was ALREADY correctly single-use — it deletes the
    // matching hash. The claim is for the TOTP branch only; a stray claim here
    // would add a second, redundant consumption path and a second way to fail.
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256').update(RECOVERY_CODE).digest('hex');
    const harness = buildHarness({ recoveryHashes: [hash] });

    assert.equal(await harness.service.verifyForLogin(ADMIN_ID, RECOVERY_CODE), true);
    assert.equal(
      harness.cache.claimCalls.length,
      0,
      'the TOTP claim ran for a recovery code — the two consumption paths have ' +
        'been crossed',
    );
    assert.deepStrictEqual(
      harness.userUpdates,
      [{ totpRecoveryCodes: [] }],
      'the recovery code was not removed from the stored set',
    );
  });

  it('refuses an unknown recovery code', async () => {
    const harness = buildHarness({ recoveryHashes: [RECOVERY_HASH] });
    assert.equal(await harness.service.verifyForLogin(ADMIN_ID, 'ffffffffff'), false);
    assert.deepStrictEqual(harness.userUpdates, []);
  });

  it('still accepts a recovery code while the claim store is unreachable', async () => {
    // The escape hatch that PAYS FOR the fail-closed decision above, and the
    // reason that decision is affordable at all. During a cache outage every
    // TOTP login in the panel is refused — deliberately, because an unverifiable
    // single-use claim is exactly the condition a replay needs. What keeps that
    // from being a total lockout is that recovery codes are consumed in
    // POSTGRES and never touch the cache, so an operator still has a way in
    // without anyone disabling 2FA under incident pressure.
    //
    // Nothing pinned that half. Hoisting the `!this.rawCacheService` guard out
    // of `claimTotpTimeStep()` to the top of `verifyForLogin()` — the obvious
    // tidy-up for someone reading the two refusal paths side by side — takes the
    // recovery branch down with the TOTP branch and turns a Redis outage into a
    // lockout of every 2FA admin, with the panel's own recovery mechanism dead.
    // That edit left all thirteen tests in this file green.
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256').update(RECOVERY_CODE).digest('hex');

    const downHarness = buildHarness({ recoveryHashes: [hash] });
    downHarness.cache.down = true;
    assert.equal(
      await downHarness.service.verifyForLogin(ADMIN_ID, RECOVERY_CODE),
      true,
      'a recovery code was refused because the CACHE was down. The recovery ' +
        'branch reads and writes Postgres only; if it has come to depend on the ' +
        'claim store, a Redis outage locks every 2FA admin out of the panel with ' +
        'no way back in.',
    );
    assert.deepStrictEqual(
      downHarness.userUpdates,
      [{ totpRecoveryCodes: [] }],
      'the recovery code was not consumed',
    );

    const throwingHarness = buildHarness({ recoveryHashes: [hash] });
    throwingHarness.cache.claimRejectsWith = new Error('Connection is closed.');
    throwingHarness.cache.existsRejectsWith = new Error('Connection is closed.');
    assert.equal(
      await throwingHarness.service.verifyForLogin(ADMIN_ID, RECOVERY_CODE),
      true,
      'a recovery code was refused because the cache client was THROWING — the ' +
        'other outage shape, same consequence',
    );
    assert.equal(
      throwingHarness.cache.claimCalls.length,
      0,
      'the recovery branch called into the claim store — the escape hatch now ' +
        'shares a failure mode with the thing it exists to escape',
    );
  });

  it('still accepts a recovery code when no claim store was injected at all', async () => {
    // The TOTP branch refuses without a claim store, correctly — that is the
    // test five above. The recovery branch does not need one and must not
    // inherit the refusal.
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256').update(RECOVERY_CODE).digest('hex');
    const harness = buildHarness({ withCache: false, recoveryHashes: [hash] });

    assert.equal(
      await harness.service.verifyForLogin(ADMIN_ID, RECOVERY_CODE),
      true,
      'the no-cache refusal has spread from the TOTP branch to the whole ' +
        'method, taking the recovery branch with it',
    );
    assert.deepStrictEqual(
      harness.userUpdates,
      [{ totpRecoveryCodes: [] }],
      'the recovery code was not consumed',
    );
  });
});
