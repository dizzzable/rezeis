import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { PasswordHashService } from '../src/modules/auth/services/password-hash.service';
import { WebFirstPasswordService } from '../src/modules/web-auth/services/web-first-password.service';
import { WebSessionRevocationService } from '../src/modules/web-auth/services/web-session-revocation.service';

/**
 * A first password and the sign-out moment, against a real PostgreSQL.
 *
 * `web-first-password.spec.ts` proves the SHAPE of the write that keeps a
 * first password from overwriting another: the empty password rides in the
 * `where` of the very statement that sets it. Only a real database can prove
 * that the shape holds under a real race — eight requests at once, each having
 * read "no password" before any wrote — because only Postgres re-evaluates
 * that `where` against the row it locks. Exactly one may win; every other one
 * must match nothing and say so.
 *
 * It also proves the migration's column is the one the services write and
 * read (`sessions_revoked_at`, millisecond precision), end to end through the
 * generated client — and that the statement every writer of it runs
 * (`sessions-revoked-at.util.ts`) never moves it back: not when a later moment
 * is already there, and not when the later moment is committed by another
 * transaction while this one waits for its lock.
 */

const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;
const prefix = `wfp-${process.pid}-${Date.now()}`;
let prisma: PrismaService;

/** A customer with a web account, for one case; removed after the file. */
async function customer(name: string, passwordHash: string | null = null): Promise<{ userId: string; accountId: string }> {
  const userId = `${prefix}-${name}-user`;
  const accountId = `${prefix}-${name}-wa`;
  const login = `${prefix}-${name}`;
  await prisma.user.create({ data: { id: userId, referralCode: `${prefix}-${name}-ref`, name } });
  await prisma.webAccount.create({
    data: {
      id: accountId,
      userId,
      login,
      loginNormalized: login,
      passwordHash,
      passwordBootstrapPending: passwordHash === null,
      requiresPasswordChange: passwordHash === null,
    },
  });
  return { userId, accountId };
}

run('a first password on PostgreSQL', () => {
  const hasher = new PasswordHashService();
  const created: string[] = [];

  before(async () => {
    process.env.DATABASE_URL = testUrl;
    process.env.DATABASE_POOL_SIZE = '10';
    prisma = new PrismaService();
    await prisma.$connect();
  });

  after(async () => {
    if (prisma === undefined) return;
    await prisma.webAccount.deleteMany({ where: { userId: { in: created } } });
    await prisma.user.deleteMany({ where: { id: { in: created } } });
    await prisma.$disconnect();
  });

  async function fresh(name: string, passwordHash: string | null = null) {
    const made = await customer(name, passwordHash);
    created.push(made.userId);
    return made;
  }

  it('lets exactly one of eight simultaneous first passwords win', async () => {
    const { userId, accountId } = await fresh('race');
    const service = new WebFirstPasswordService(prisma, hasher);
    const passwords = Array.from({ length: 8 }, (_, index) => `${index}`.repeat(64));

    const results = await Promise.all(passwords.map((password) => service.set(userId, password)));

    const winners = results.flatMap((result, index) => (result.status === 'set' ? [index] : []));
    assert.equal(winners.length, 1, JSON.stringify(results));
    assert.deepEqual(
      results.filter((result) => result.status !== 'set').map((result) => result.status),
      Array.from({ length: 7 }, () => 'has_password'),
    );
    const row = await prisma.webAccount.findUniqueOrThrow({ where: { id: accountId } });
    assert.ok(row.passwordHash !== null);
    for (const [index, password] of passwords.entries()) {
      const matches = await hasher.verifyPassword({ plainTextPassword: password, passwordHash: row.passwordHash });
      assert.equal(matches, index === winners[0], `password ${index}`);
    }
    assert.equal(row.passwordBootstrapPending, false);
    assert.equal(row.requiresPasswordChange, false);
    const won = results[winners[0]] as { sessionsRevokedAt: string };
    assert.equal(row.sessionsRevokedAt?.toISOString(), won.sessionsRevokedAt);
  });

  it('keeps the sign-out moment to the millisecond, and reports it back with the panel’s clock', async () => {
    const { userId } = await fresh('exact');
    const revocation = new WebSessionRevocationService(prisma);
    const now = new Date('2026-09-18T10:20:30.456Z');

    assert.deepEqual(await revocation.revokeAll(userId, now), { sessionsRevokedAt: '2026-09-18T10:20:30.456Z' });
    const state = await revocation.state(userId);
    assert.equal(state.sessionsRevokedAt, '2026-09-18T10:20:30.456Z');
    assert.ok(Math.abs(Date.parse(state.now) - Date.now()) < 5_000, `the panel's clock is off: ${state.now}`);
    assert.equal((await revocation.state(`${prefix}-nobody`)).sessionsRevokedAt, null);
  });

  it('never moves the sign-out moment back when a later one is already stored', async () => {
    const later = new Date('2026-09-18T12:00:05.000Z');
    const earlier = new Date('2026-09-18T12:00:00.000Z');
    const revocation = new WebSessionRevocationService(prisma);
    const firstPassword = new WebFirstPasswordService(prisma, hasher);

    const pressed = await fresh('pressed');
    await prisma.webAccount.update({ where: { id: pressed.accountId }, data: { sessionsRevokedAt: later } });
    await revocation.revokeAll(pressed.userId, earlier);

    const passwordless = await fresh('first');
    await prisma.webAccount.update({ where: { id: passwordless.accountId }, data: { sessionsRevokedAt: later } });
    assert.equal((await firstPassword.set(passwordless.userId, 'f'.repeat(64), earlier)).status, 'set');

    for (const { accountId } of [pressed, passwordless]) {
      const row = await prisma.webAccount.findUniqueOrThrow({ where: { id: accountId } });
      assert.equal(row.sessionsRevokedAt?.toISOString(), later.toISOString(), `${accountId}: the moment moved back`);
    }
    // An earlier moment still lands where nothing later stands.
    const blank = await fresh('blank');
    await revocation.revokeAll(blank.userId, earlier);
    assert.equal((await revocation.state(blank.userId)).sessionsRevokedAt, earlier.toISOString());
  });

  it('keeps the later moment a transaction commits while this write waits for its lock', async () => {
    // The race a plain assignment loses: this write took the EARLIER moment,
    // but another transaction holds the row, writes a LATER one and commits
    // only after this write has started waiting. Postgres re-reads the row
    // this write then locks, so GREATEST sees the later moment.
    const { userId, accountId } = await fresh('lock');
    const later = new Date('2026-09-18T12:10:05.000Z');
    const earlier = new Date('2026-09-18T12:10:00.000Z');
    const revocation = new WebSessionRevocationService(prisma);

    let holding!: () => void;
    const held = new Promise<void>((resolve) => {
      holding = resolve;
    });
    let letGo!: () => void;
    const released = new Promise<void>((resolve) => {
      letGo = resolve;
    });
    const other = prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`UPDATE "web_accounts" SET "sessions_revoked_at" = ${later}::timestamptz WHERE "id" = ${accountId}`;
        holding();
        await released;
      },
      { timeout: 30_000 },
    );
    await held;

    const waiting = revocation.revokeAll(userId, earlier);
    // Only once this write is really queued behind the row lock does the
    // other transaction commit.
    const deadline = Date.now() + 15_000;
    for (;;) {
      const [{ waiters }] = await prisma.$queryRaw<Array<{ waiters: bigint }>>`
        SELECT count(*) AS waiters FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock'`;
      if (waiters > 0n) break;
      assert.ok(Date.now() < deadline, 'the second write never waited for the row lock');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    letGo();
    await other;
    assert.deepEqual(await waiting, { sessionsRevokedAt: earlier.toISOString() });

    const row = await prisma.webAccount.findUniqueOrThrow({ where: { id: accountId } });
    assert.equal(row.sessionsRevokedAt?.toISOString(), later.toISOString(), 'the waiting write moved the moment back');
  });
});
