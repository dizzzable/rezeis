import 'reflect-metadata';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { BlockedIpService } from '../src/modules/blocked-ips/services/blocked-ip.service';
import { LoginGuardService } from '../src/modules/two-factor/services/login-guard.service';

/**
 * What the login guard's failure window actually is — held against what its
 * own header says it is.
 *
 * The header used to promise a reset: "Successful authentications reset the
 * per-IP failure counter (handled implicitly: the lookup is 'failures since
 * the last success', not all failures ever)". No such lookup was ever
 * written. `isRateLimited()` counts rows `WHERE success = false AND createdAt
 * >= now - 15min` and has never referenced a success row. Prose describing
 * behaviour the code does not have is worse than no prose: the next person to
 * tune the thresholds reasons from a reset that will not happen.
 *
 * This file is the joint. It pins the CODE fact and the PROSE fact together,
 * so the pair cannot drift apart again in either direction:
 *
 *   - implement the reset and forget the comment → the prose assertion fires;
 *   - restore the old claim without implementing it → the same assertion
 *     fires from the other side.
 *
 * It also pins the consequence operators actually hit, because that is the
 * part a reader is most likely to get wrong from the header alone.
 *
 * There are TWO budgets, and only one of them used to be exercised. Every
 * fixture here was decided by the per-(login, ip) budget of 5, which meant the
 * per-IP budget of 10 could be deleted outright — `>= MAX_FAILURES_PER_WINDOW`
 * raised a thousandfold, its window collapsed to nothing, its `createdAt`
 * filter dropped, its `ipAddress` scope dropped — and every test here stayed
 * green. That layer is the one that covers login enumeration: an attacker
 * spreading guesses across many usernames never spends the per-login budget at
 * all. The fixtures below reach it deliberately, and each queries a login with
 * NO failures of its own so the tighter budget cannot be what answered.
 *
 * The AUTO-BLOCK path is where that layer is enforced rather than merely
 * consulted, and it is the part with no per-login budget at all:
 * `evaluateAndBlock()` counts failures for the ADDRESS and writes a
 * `blocked_ips` row that `BlockedIpGuard` then refuses requests from. Three of
 * its decisions were invisible to this file — the `ipAddress` scope, the
 * `success: false` filter, and the expiry on the row it writes — so each could
 * be removed with every test here still green. The last one is the sharpest:
 * `BlockedIpService` only loads rows with `expiresAt > now()`, so an expiry in
 * the past is the whole layer switched off behind a log line and an audit
 * entry that both say it was switched on.
 */

const SOURCE_PATH = resolve(
  __dirname,
  '../src/modules/two-factor/services/login-guard.service.ts',
);

interface AttemptRow {
  readonly loginNormalized: string;
  readonly ipAddress: string;
  readonly success: boolean;
  readonly reason: string | null;
  readonly createdAt: Date;
}

interface CountArgs {
  where: {
    ipAddress?: string;
    loginNormalized?: string;
    success?: boolean;
    createdAt?: { gte?: Date };
  };
}

interface DeleteArgs {
  where: {
    createdAt?: { lt?: Date };
  };
}

interface BlockCall {
  readonly address: string;
  readonly reason: string | null;
  readonly source: string;
  readonly createdById: string | null;
  /**
   * The field that decides whether the block does anything at all.
   * `BlockedIpService.refreshCache()` loads
   * `WHERE expiresAt IS NULL OR expiresAt > now()`, so a row written with an
   * expiry already in the past is created, invalidates the cache, logs
   * "auto-blocked" and is audited as `autoBlocked: true` — and is never
   * enforced. Captured here so it can be asserted on.
   */
  readonly expiresAt: Date | null;
}

/**
 * Evaluates a Prisma `count` where-clause against an in-memory table. Real
 * filtering, not a canned number: a spec that returned a fixed count would
 * pass for a service that asked an entirely different question.
 *
 * `create` appends to the same table rather than discarding the row, because
 * `recordAttempt()` writes the attempt and then counts — including the one it
 * just wrote. A harness that swallowed the insert would be off by one against
 * the thresholds it is supposed to be checking.
 */
function buildHarness(rows: readonly AttemptRow[]): {
  service: LoginGuardService;
  queries: CountArgs['where'][];
  blocks: BlockCall[];
  /** The live table, so a test can see what the retention pass left behind. */
  table: AttemptRow[];
  /** Every `deleteMany` predicate, so the cutoff itself can be asserted. */
  deletes: DeleteArgs['where'][];
} {
  const queries: CountArgs['where'][] = [];
  const blocks: BlockCall[] = [];
  const deletes: DeleteArgs['where'][] = [];
  const table: AttemptRow[] = [...rows];
  const prismaService = {
    adminLoginAttempt: {
      count: async (args: CountArgs): Promise<number> => {
        queries.push(args.where);
        return table.filter((row) => {
          const where = args.where;
          if (where.ipAddress !== undefined && row.ipAddress !== where.ipAddress) return false;
          if (
            where.loginNormalized !== undefined &&
            row.loginNormalized !== where.loginNormalized
          ) {
            return false;
          }
          if (where.success !== undefined && row.success !== where.success) return false;
          const gte = where.createdAt?.gte;
          if (gte !== undefined && row.createdAt < gte) return false;
          return true;
        }).length;
      },
      create: async (args: { data: Omit<AttemptRow, 'createdAt'> }) => {
        table.push({ ...args.data, createdAt: new Date() });
        return args.data;
      },
      deleteMany: async (args: DeleteArgs): Promise<{ count: number }> => {
        deletes.push(args.where);
        const lt = args.where.createdAt?.lt;
        const before = table.length;
        // Prisma semantics, faithfully: an ABSENT predicate matches every row.
        // A fake that read `where: {}` as "match nothing" would make the single
        // most destructive mutation of this cron look harmless.
        const survivors = table.filter((row) => !(lt === undefined || row.createdAt < lt));
        table.length = 0;
        table.push(...survivors);
        return { count: before - table.length };
      },
    },
  } as unknown as PrismaService;

  const service = new LoginGuardService(prismaService, {
    create: async (input: BlockCall): Promise<void> => {
      blocks.push(input);
    },
  } as unknown as BlockedIpService);

  return { service, queries, blocks, table, deletes };
}

function thresholdsOf(service: LoginGuardService): {
  windowMinutes: number;
  maxPerWindow: number;
  maxPerLogin: number;
  blockDurationMinutes: number;
  retentionDays: number;
} {
  const internals = service as unknown as {
    WINDOW_MINUTES: number;
    MAX_FAILURES_PER_WINDOW: number;
    MAX_FAILURES_PER_LOGIN: number;
    BLOCK_DURATION_MINUTES: number;
    RETENTION_DAYS: number;
  };
  return {
    windowMinutes: internals.WINDOW_MINUTES,
    maxPerWindow: internals.MAX_FAILURES_PER_WINDOW,
    maxPerLogin: internals.MAX_FAILURES_PER_LOGIN,
    blockDurationMinutes: internals.BLOCK_DURATION_MINUTES,
    retentionDays: internals.RETENTION_DAYS,
  };
}

function minutesAgo(minutes: number): Date {
  return new Date(Date.now() - minutes * 60 * 1000);
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

function failure(overrides: Partial<AttemptRow> = {}): AttemptRow {
  return {
    loginNormalized: 'operator',
    ipAddress: '203.0.113.9',
    success: false,
    reason: 'invalid_password',
    createdAt: minutesAgo(10),
    ...overrides,
  };
}

describe('LoginGuardService — the window counts all failures, successes included or not', () => {
  it('does not consult a success row for either budget', async () => {
    const { service, queries } = buildHarness([]);
    await service.isRateLimited('203.0.113.9', 'operator');

    assert.ok(queries.length >= 2, 'neither budget was evaluated — this spec proved nothing');
    assert.deepStrictEqual(
      queries.filter((where) => where.success === true),
      [],
      'the guard now looks up successful authentications. That may well be an ' +
        'improvement, but the class header states the opposite in so many ' +
        'words — update it in the same commit.',
    );
    for (const where of queries) {
      assert.equal(
        where.success,
        false,
        'a budget query stopped filtering on failures and is now counting ' +
          'every attempt, successful ones included',
      );
    }
  });

  it('still counts failures that happened before a successful login', async () => {
    // The documented reset, tested where it would show. Five failures, then a
    // correct sign-in, then nothing: the operator is rate-limited anyway.
    const { service } = buildHarness([
      failure({ createdAt: minutesAgo(12) }),
      failure({ createdAt: minutesAgo(11) }),
      failure({ createdAt: minutesAgo(10) }),
      failure({ createdAt: minutesAgo(9) }),
      failure({ createdAt: minutesAgo(8) }),
      failure({ success: true, reason: null, createdAt: minutesAgo(5) }),
    ]);
    const { maxPerLogin } = thresholdsOf(service);
    assert.equal(maxPerLogin, 5, 'the per-login budget moved; the row count below assumes 5');

    assert.equal(
      await service.isRateLimited('203.0.113.9', 'operator'),
      true,
      'a success cleared the counter. That is the behaviour the header used to ' +
        'claim; if it has now been implemented, say so there instead of ' +
        'leaving the two out of step.',
    );
  });

  it('forgets failures once they age out of the window', async () => {
    const { service } = buildHarness([
      failure({ createdAt: minutesAgo(60) }),
      failure({ createdAt: minutesAgo(45) }),
      failure({ createdAt: minutesAgo(30) }),
      failure({ createdAt: minutesAgo(20) }),
      failure({ createdAt: minutesAgo(16) }),
    ]);
    const { windowMinutes } = thresholdsOf(service);
    assert.equal(windowMinutes, 15, 'the window moved; the timestamps above assume 15 minutes');

    assert.equal(
      await service.isRateLimited('203.0.113.9', 'operator'),
      false,
      'the window is no longer a window — old failures are being counted forever',
    );
  });

  it('scopes the tighter budget to (login, ip), not to the IP alone', async () => {
    // Five failures against a DIFFERENT login from the same IP must not trip
    // the per-login budget; the per-IP budget of 10 is what covers that case.
    const { service } = buildHarness([
      failure({ loginNormalized: 'someone-else' }),
      failure({ loginNormalized: 'someone-else' }),
      failure({ loginNormalized: 'someone-else' }),
      failure({ loginNormalized: 'someone-else' }),
      failure({ loginNormalized: 'someone-else' }),
    ]);
    const { maxPerWindow } = thresholdsOf(service);
    assert.equal(maxPerWindow, 10, 'the per-IP budget moved; the row count below assumes 10');

    assert.equal(await service.isRateLimited('203.0.113.9', 'operator'), false);
  });

  it('spends the per-IP budget across DIFFERENT logins from one address', async () => {
    // The layer that covers login ENUMERATION, and the one no fixture used to
    // reach. Ten failures from one address, spread thin enough that no single
    // login is anywhere near its own budget of 5 — and the login asked about
    // has no failures at all, so the per-(login, ip) count is zero and only the
    // per-IP budget can answer.
    const { service } = buildHarness([
      failure({ loginNormalized: 'alpha', createdAt: minutesAgo(12) }),
      failure({ loginNormalized: 'alpha', createdAt: minutesAgo(11) }),
      failure({ loginNormalized: 'alpha', createdAt: minutesAgo(10) }),
      failure({ loginNormalized: 'alpha', createdAt: minutesAgo(9) }),
      failure({ loginNormalized: 'beta', createdAt: minutesAgo(8) }),
      failure({ loginNormalized: 'beta', createdAt: minutesAgo(7) }),
      failure({ loginNormalized: 'beta', createdAt: minutesAgo(6) }),
      failure({ loginNormalized: 'gamma', createdAt: minutesAgo(5) }),
      failure({ loginNormalized: 'gamma', createdAt: minutesAgo(4) }),
      failure({ loginNormalized: 'gamma', createdAt: minutesAgo(3) }),
    ]);
    const { maxPerWindow, maxPerLogin } = thresholdsOf(service);
    assert.equal(maxPerWindow, 10, 'the per-IP budget moved; the row count above assumes 10');
    assert.equal(maxPerLogin, 5, 'the per-login budget moved; the 4/3/3 split above assumes 5');

    assert.equal(
      await service.isRateLimited('203.0.113.9', 'delta'),
      true,
      'ten failures from one address did not rate-limit it. The per-IP budget ' +
        'is the only layer that sees an attacker spreading guesses across many ' +
        'usernames — no single login ever reaches its own budget of 5.',
    );
  });

  it('counts only the failures inside the window for the per-IP budget', async () => {
    // Straddling the 15-minute boundary. Ten failures exist; five are old
    // enough to have been forgotten. Dropping the `createdAt` filter from the
    // per-IP query turns this into a lockout that never expires.
    const { service } = buildHarness([
      failure({ loginNormalized: 'alpha', createdAt: minutesAgo(16) }),
      failure({ loginNormalized: 'alpha', createdAt: minutesAgo(17) }),
      failure({ loginNormalized: 'beta', createdAt: minutesAgo(18) }),
      failure({ loginNormalized: 'beta', createdAt: minutesAgo(40) }),
      failure({ loginNormalized: 'gamma', createdAt: minutesAgo(90) }),
      failure({ loginNormalized: 'alpha', createdAt: minutesAgo(14) }),
      failure({ loginNormalized: 'alpha', createdAt: minutesAgo(13) }),
      failure({ loginNormalized: 'beta', createdAt: minutesAgo(12) }),
      failure({ loginNormalized: 'beta', createdAt: minutesAgo(11) }),
      failure({ loginNormalized: 'gamma', createdAt: minutesAgo(10) }),
    ]);
    assert.equal(thresholdsOf(service).windowMinutes, 15, 'the window moved');

    assert.equal(
      await service.isRateLimited('203.0.113.9', 'delta'),
      false,
      'failures that aged out of the window are still being counted against ' +
        'the per-IP budget — the block never expires',
    );
  });

  it('counts only failures from the SAME address for the per-IP budget', async () => {
    // Nine of ours plus four from a neighbour. Dropping the `ipAddress` scope
    // makes one noisy address lock out every operator behind it — a shared
    // office NAT is enough.
    const { service } = buildHarness([
      ...Array.from({ length: 9 }, (_unused, index) =>
        failure({
          loginNormalized: ['alpha', 'beta', 'gamma'][index % 3],
          createdAt: minutesAgo(12 - index),
        }),
      ),
      ...Array.from({ length: 4 }, (_unused, index) =>
        failure({
          ipAddress: '198.51.100.7',
          loginNormalized: 'alpha',
          createdAt: minutesAgo(5 - index),
        }),
      ),
    ]);

    assert.equal(
      await service.isRateLimited('203.0.113.9', 'delta'),
      false,
      "another address's failures were counted against this one — the per-IP " +
        'query has lost its `ipAddress` scope',
    );
  });

  it('spends one budget across the password step and the TOTP step', async () => {
    // The consequence worth knowing before anyone tunes these numbers, and the
    // reason implementing the documented reset would not help. Three mistyped
    // passwords, then two attempts where the password was RIGHT and the code
    // was not: five failures, locked out. `AdminAuthService.loginAdmin()`
    // records `success: true` only after BOTH factors pass, so there is no
    // success row in between for a reset to key on.
    const { service } = buildHarness([
      failure({ reason: 'invalid_password', createdAt: minutesAgo(6) }),
      failure({ reason: 'invalid_password', createdAt: minutesAgo(5) }),
      failure({ reason: 'invalid_password', createdAt: minutesAgo(4) }),
      failure({ reason: 'totp_required', createdAt: minutesAgo(3) }),
      failure({ reason: 'totp_invalid', createdAt: minutesAgo(2) }),
    ]);

    assert.equal(
      await service.isRateLimited('203.0.113.9', 'operator'),
      true,
      'the shared-budget behaviour described in the class header no longer holds',
    );
  });
});

describe('LoginGuardService — the auto-block runs off the same per-IP window', () => {
  it('blocks the address on the tenth failure, whatever logins they targeted', async () => {
    // `recordAttempt()` writes the row and then counts, so nine seeded plus
    // this one is the tenth. Again spread across three logins, none of them
    // near the per-login budget: this path has no per-login layer at all, and
    // it is what actually stops enumeration.
    const { service, blocks } = buildHarness(
      Array.from({ length: 9 }, (_unused, index) =>
        failure({
          loginNormalized: ['alpha', 'beta', 'gamma'][index % 3],
          createdAt: minutesAgo(12 - index),
        }),
      ),
    );

    const outcome = await service.recordAttempt({
      loginNormalized: 'delta',
      ipAddress: '203.0.113.9',
      success: false,
      reason: 'invalid_password',
    });

    assert.equal(outcome.failureCount, 10, 'the attempt just recorded was not counted');
    assert.equal(
      outcome.autoBlocked,
      true,
      'ten failures from one address in the window did not auto-block it',
    );
    assert.equal(blocks.length, 1, 'no block was written');
    assert.equal(blocks[0]?.address, '203.0.113.9');
    assert.equal(blocks[0]?.source, 'login_guard');
  });

  it('does not block on failures that have already aged out', async () => {
    // Twelve failures, all older than the window. The only row inside it is
    // the one being recorded now. Dropping the `createdAt` filter here blocks
    // an address for something it did an hour ago, on its next single typo.
    const { service, blocks } = buildHarness(
      Array.from({ length: 12 }, (_unused, index) =>
        failure({ loginNormalized: 'alpha', createdAt: minutesAgo(20 + index) }),
      ),
    );

    const outcome = await service.recordAttempt({
      loginNormalized: 'alpha',
      ipAddress: '203.0.113.9',
      success: false,
      reason: 'invalid_password',
    });

    assert.equal(outcome.failureCount, 1, 'aged-out failures were counted');
    assert.equal(
      outcome.autoBlocked,
      false,
      'the address was blocked for failures that had already left the window',
    );
    assert.deepStrictEqual(blocks, [], 'a block was written anyway');
  });

  it('does not evaluate anything on a successful attempt', async () => {
    // The early return. Without it a correct sign-in from an address with nine
    // recent failures would be the tenth row and block the operator who just
    // proved who they are.
    const { service, blocks, queries } = buildHarness(
      Array.from({ length: 9 }, (_unused, index) =>
        failure({ loginNormalized: 'alpha', createdAt: minutesAgo(12 - index) }),
      ),
    );

    const outcome = await service.recordAttempt({
      loginNormalized: 'alpha',
      ipAddress: '203.0.113.9',
      success: true,
    });

    assert.deepStrictEqual(outcome, { autoBlocked: false, failureCount: 0 });
    assert.deepStrictEqual(queries, [], 'a successful attempt was evaluated for blocking');
    assert.deepStrictEqual(blocks, []);
  });

  it('counts only THIS address, so a neighbour behind the same NAT cannot block it', async () => {
    // `isRateLimited()` only answers one attempt; THIS path is what puts the
    // address in `blocked_ips`, where `BlockedIpGuard` refuses everything from
    // it for the next 30 minutes. It has no per-login layer to hide behind, so
    // its `ipAddress` scope is load-bearing on its own — and no fixture used to
    // put a second address in the table at all, which meant the scope could be
    // deleted with the whole file still green.
    //
    // Six of our own failures and five from a neighbour. Eleven rows in the
    // window; seven of them ours once this attempt is recorded.
    const { service, blocks } = buildHarness([
      ...Array.from({ length: 6 }, (_unused, index) =>
        failure({
          loginNormalized: ['alpha', 'beta', 'gamma'][index % 3],
          createdAt: minutesAgo(12 - index),
        }),
      ),
      ...Array.from({ length: 5 }, (_unused, index) =>
        failure({
          ipAddress: '198.51.100.7',
          loginNormalized: 'alpha',
          createdAt: minutesAgo(6 - index),
        }),
      ),
    ]);

    const outcome = await service.recordAttempt({
      loginNormalized: 'delta',
      ipAddress: '203.0.113.9',
      success: false,
      reason: 'invalid_password',
    });

    assert.equal(
      outcome.failureCount,
      7,
      "another address's failures were counted against this one — the auto-block " +
        'query has lost its `ipAddress` scope, and one noisy tenant of a shared ' +
        'office NAT now blocklists every operator behind it',
    );
    assert.equal(outcome.autoBlocked, false);
    assert.deepStrictEqual(blocks, [], 'an address was blocked for what its neighbour did');
  });

  it('does not spend the budget on sign-ins that SUCCEEDED', async () => {
    // `AdminAuthService.loginAdmin()` records `success: true` on every completed
    // sign-in, from the same address as the failures, through this same
    // `recordAttempt()`. Seven good sign-ins and two typos share an office IP;
    // the tenth row in the window is the typo being recorded now, and only three
    // of the ten are failures.
    //
    // Every other auto-block fixture here is failures-only, so dropping
    // `success: false` from this query changed nothing they could see — while
    // in production it turns a busy morning into a 30-minute lockout of the
    // operators who kept getting it right.
    const { service, blocks } = buildHarness([
      ...Array.from({ length: 7 }, (_unused, index) =>
        failure({
          loginNormalized: ['alpha', 'beta', 'gamma'][index % 3],
          success: true,
          reason: null,
          createdAt: minutesAgo(13 - index),
        }),
      ),
      failure({ loginNormalized: 'alpha', createdAt: minutesAgo(5) }),
      failure({ loginNormalized: 'beta', createdAt: minutesAgo(4) }),
    ]);

    const outcome = await service.recordAttempt({
      loginNormalized: 'gamma',
      ipAddress: '203.0.113.9',
      success: false,
      reason: 'invalid_password',
    });

    assert.equal(
      outcome.failureCount,
      3,
      'successful sign-ins were counted as failures — the auto-block query has ' +
        'lost its `success: false` filter',
    );
    assert.equal(outcome.autoBlocked, false);
    assert.deepStrictEqual(blocks, [], 'an address was blocked for signing in correctly');
  });

  it('writes a block that is actually in force, for the configured duration', async () => {
    // The last step, and the one that decides whether any of the above matters.
    // `BlockedIpService.refreshCache()` loads
    // `WHERE expiresAt IS NULL OR expiresAt > now()`. A row written with an
    // expiry already in the past is created, invalidates the cache, logs
    // "Login guard auto-blocked ..." and returns `autoBlocked: true` into the
    // audit trail — and `BlockedIpGuard` never sees it. Nothing in this file
    // looked at that field, so the entire per-IP layer could be switched off
    // while every assertion about it kept passing. That is this repo's recurring
    // defect exactly: the decision is correct and nothing reaches its effect.
    const { service, blocks } = buildHarness(
      Array.from({ length: 9 }, (_unused, index) =>
        failure({
          loginNormalized: ['alpha', 'beta', 'gamma'][index % 3],
          createdAt: minutesAgo(12 - index),
        }),
      ),
    );
    const { blockDurationMinutes } = thresholdsOf(service);

    const before = Date.now();
    const outcome = await service.recordAttempt({
      loginNormalized: 'delta',
      ipAddress: '203.0.113.9',
      success: false,
      reason: 'invalid_password',
    });
    const after = Date.now();

    assert.equal(outcome.autoBlocked, true, 'the tenth failure did not block the address');
    assert.equal(blocks.length, 1, 'no block was written');

    const expiresAt = blocks[0]?.expiresAt ?? null;
    if (!(expiresAt instanceof Date)) {
      assert.fail(
        'the auto-block carries no expiry. `null` means PERMANENT here — one ' +
          'typo storm would blocklist an office until an operator deletes the ' +
          'row by hand.',
      );
    }

    assert.ok(
      expiresAt.getTime() > after,
      'the auto-block was written ALREADY EXPIRED. `BlockedIpService` only loads ' +
        'rows with `expiresAt > now()`, so this block is created, logged and ' +
        'audited as `autoBlocked: true` and then never enforced — the per-IP ' +
        'layer switched off in the one place nothing else looks.',
    );

    const durationMs = blockDurationMinutes * 60 * 1000;
    assert.ok(
      expiresAt.getTime() >= before + durationMs - 1000 &&
        expiresAt.getTime() <= after + durationMs + 1000,
      `the block expires ${Math.round((expiresAt.getTime() - after) / 1000)}s from now, ` +
        `not the configured ${blockDurationMinutes} minutes`,
    );
  });
});

describe('LoginGuardService — an attempt with NO login (the passkey path)', () => {
  /**
   * `PasskeyService.verifyAuthentication()` opens with
   * `isRateLimited(ipAddress, '')` — the first statement in the method, before
   * the credential id is even looked up. The empty string is DELIBERATE and
   * correct: passkey sign-in is usernameless, so at that point the request has
   * offered an assertion and nothing else, and there is no account to scope a
   * budget to until that assertion verifies. `loginNormalized.length > 0`
   * therefore skips the per-(login, ip) branch, which leaves the per-IP budget
   * as the ONLY budget passkey authentication has.
   *
   * `test/passkey-hardening.spec.ts` pins the caller half — that the call comes
   * first, that its arguments are `(remoteAddress, '')`, and that a `true`
   * becomes a 401. It cannot pin THIS half, because it drives a
   * `LoginGuardService` double that returns a canned boolean. Adding
   * `if (loginNormalized.length === 0) return false;` to the top of
   * `isRateLimited()` leaves all 25 of its tests green while passkey
   * authentication runs with no rate limit whatsoever.
   */
  it('is still governed by the per-IP budget when the login is empty', async () => {
    const { service, queries } = buildHarness(
      Array.from({ length: 10 }, (_unused, index) =>
        failure({
          loginNormalized: ['alpha', 'beta', 'gamma'][index % 3],
          createdAt: minutesAgo(12 - index),
        }),
      ),
    );
    assert.equal(thresholdsOf(service).maxPerWindow, 10, 'the per-IP budget moved');

    assert.equal(
      await service.isRateLimited('203.0.113.9', ''),
      true,
      'an attempt with no login was waved through with ten failures already ' +
        'against its address. That is every passkey sign-in: the per-IP budget ' +
        'is the only one that applies to them, and it just stopped applying.',
    );

    assert.equal(
      queries.length,
      1,
      'the per-(login, ip) query ran for an EMPTY login. It would count the rows ' +
        '`PasskeyService.recordFailedLogin()` writes with an empty ' +
        '`loginNormalized` and silently put passkey attempts on the tighter ' +
        'budget of 5 instead of the per-IP 10 — a different policy than the one ' +
        'the call site documents.',
    );
  });

  it('auto-blocks on the tenth failure even though none of them named a login', async () => {
    // `PasskeyService.recordFailedLogin()` passes an empty `loginNormalized`
    // for every rejected assertion — credential_not_found, challenge_expired,
    // assertion_rejected, assertion_unverified. `evaluateAndBlock()` counts by
    // ADDRESS and has no per-login layer, so the empty login costs nothing
    // there — but nothing said so, and a plausible "no account to attribute
    // this to, skip it" early return in `recordAttempt()` would leave a passkey
    // flood recorded, counted, and never blocked.
    const { service, blocks } = buildHarness(
      Array.from({ length: 9 }, (_unused, index) =>
        failure({
          loginNormalized: '',
          reason: 'credential_not_found',
          createdAt: minutesAgo(12 - index),
        }),
      ),
    );

    const outcome = await service.recordAttempt({
      loginNormalized: '',
      ipAddress: '203.0.113.9',
      success: false,
      reason: 'assertion_unverified',
    });

    assert.equal(outcome.failureCount, 10, 'the attempt just recorded was not counted');
    assert.equal(
      outcome.autoBlocked,
      true,
      'ten rejected passkey assertions from one address did not block it — the ' +
        'auto-block is skipping attempts that carry no login, which is all of them',
    );
    assert.equal(blocks[0]?.address, '203.0.113.9', 'no block was written for the address');
  });
});

describe('LoginGuardService — the retention cron must not hand back a fresh budget', () => {
  it('trims only what is past the retention horizon, leaving the live window intact', async () => {
    // `cleanupOldAttempts()` is the only thing in this service that DELETES,
    // and everything both budgets know lives in the rows it deletes. A pass
    // that trims to `now` instead of to `now - 30d` empties the failure window
    // every night at 04:00, and the guard starts each morning with the
    // attacker's counter back at zero. Nothing reports it either way: both
    // budgets fail by going QUIET. Until now no test in this file called the
    // method at all.
    const { service, table } = buildHarness([
      ...Array.from({ length: 10 }, (_unused, index) =>
        failure({
          loginNormalized: ['alpha', 'beta', 'gamma'][index % 3],
          createdAt: minutesAgo(12 - index),
        }),
      ),
      ...[31, 45, 90, 200, 400].map((days) =>
        failure({ loginNormalized: 'alpha', createdAt: daysAgo(days) }),
      ),
    ]);
    const { retentionDays } = thresholdsOf(service);
    assert.equal(retentionDays, 30, 'the retention window moved; the ages above assume 30 days');
    assert.equal(
      await service.isRateLimited('203.0.113.9', 'delta'),
      true,
      'the fixture is not rate-limited before the pass runs — this test would ' +
        'prove nothing about what the pass took away',
    );

    await service.cleanupOldAttempts();

    assert.equal(
      table.length,
      10,
      'the retention pass did not leave exactly the ten rows inside the window ' +
        'standing — it either deleted live rows or did not run at all',
    );
    assert.deepStrictEqual(
      table.filter((row) => row.createdAt < daysAgo(retentionDays)),
      [],
      'rows past the retention horizon survived the pass — the table it exists ' +
        'to bound grows forever',
    );
    assert.equal(
      await service.isRateLimited('203.0.113.9', 'delta'),
      true,
      'the nightly retention pass wiped the LIVE failure window. An address ' +
        'that was rate-limited at 03:59 walks in at 04:01 with a fresh budget, ' +
        'and nothing anywhere says so — the whole brute-force defence deleted ' +
        'by a plausible tidy-up, invisibly.',
    );
  });

  it('recomputes the cutoff on every run, at the configured horizon', async () => {
    // Two failure modes, one pair of assertions. A cutoff captured ONCE — at
    // construction or at module load — is harmless at boot and then, on a
    // long-lived process, quietly stops deleting anything while still reporting
    // success. A cutoff at the wrong horizon is the loud version of the same
    // mistake. Neither is visible from outside, because `deleteMany` reports a
    // row count and nothing about what it asked for.
    const { service, deletes } = buildHarness([]);
    const { retentionDays } = thresholdsOf(service);
    const retentionMs = retentionDays * 24 * 60 * 60 * 1000;

    const before = Date.now();
    await service.cleanupOldAttempts();
    const after = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await service.cleanupOldAttempts();

    assert.equal(
      deletes.length,
      2,
      'the retention pass did not run. `shouldRunSchedules()` is false in this ' +
        'process, or the guard in front of it has been inverted — either way ' +
        'the attempts table is now unbounded.',
    );

    const first = deletes[0]?.createdAt?.lt ?? null;
    const second = deletes[1]?.createdAt?.lt ?? null;
    if (!(first instanceof Date)) {
      assert.fail(
        'the retention pass issued a `deleteMany` with no `createdAt` bound. ' +
          'Prisma reads an empty `where` as EVERY ROW: this empties the attempts ' +
          'table nightly and both budgets restart from zero.',
      );
    }
    if (!(second instanceof Date)) {
      assert.fail('the second retention pass issued a `deleteMany` with no `createdAt` bound');
    }

    assert.ok(
      first.getTime() >= before - retentionMs - 1000 &&
        first.getTime() <= after - retentionMs + 1000,
      `the pass trims at ${((Date.now() - first.getTime()) / 86_400_000).toFixed(1)} days, ` +
        `not the configured ${retentionDays}`,
    );
    assert.ok(
      second.getTime() > first.getTime(),
      'the cutoff did not move between two runs — it is computed once and then ' +
        'frozen, so on a long-lived process the retention pass deletes less and ' +
        'less until it deletes nothing, reporting success the whole way',
    );
  });
});

describe('LoginGuardService — the header and the code say the same thing', () => {
  it('never describes a success-based reset the queries do not perform', () => {
    const source = readFileSync(SOURCE_PATH, 'utf8');

    const marker = source.indexOf('public async isRateLimited(');
    assert.notEqual(marker, -1, 'isRateLimited() was renamed — this guard is now blind');
    const privateSection = source.indexOf('── Private', marker);
    const body = source.slice(marker, privateSection === -1 ? undefined : privateSection);

    const codeResetsOnSuccess = /success:\s*true/u.test(body);
    // The disclaimer the header must carry while the code behaves this way.
    const proseDeniesReset = /does not reset/u.test(source);

    if (codeResetsOnSuccess) {
      assert.equal(
        proseDeniesReset,
        false,
        'isRateLimited() now looks up a successful authentication, but the ' +
          'class header still states that a success does not reset the ' +
          'counter. The reset was implemented and the prose was not updated — ' +
          'this is the same mismatch, pointing the other way.',
      );
    } else {
      assert.ok(
        proseDeniesReset,
        'the class header no longer states that a successful authentication ' +
          'does NOT reset the failure counter, while isRateLimited() still ' +
          'counts every failure in the window. The old claim — "failures since ' +
          'the last success, not all failures ever" — described a lookup that ' +
          'was never written. Either implement it or keep saying so.',
      );
    }
  });
});
