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
 * generated client.
 */

const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;
const prefix = `wfp-${process.pid}-${Date.now()}`;
let prisma: PrismaService;

run('a first password on PostgreSQL', () => {
  const userId = `${prefix}-user`;
  const accountId = `${prefix}-wa`;
  const login = `${prefix}-login`;
  const hasher = new PasswordHashService();

  before(async () => {
    process.env.DATABASE_URL = testUrl;
    process.env.DATABASE_POOL_SIZE = '10';
    prisma = new PrismaService();
    await prisma.$connect();
    await prisma.user.create({ data: { id: userId, referralCode: `${prefix}-ref`, name: 'First password' } });
    await prisma.webAccount.create({
      data: {
        id: accountId,
        userId,
        login,
        loginNormalized: login,
        passwordHash: null,
        passwordBootstrapPending: true,
        requiresPasswordChange: true,
      },
    });
  });

  after(async () => {
    if (prisma === undefined) return;
    await prisma.webAccount.deleteMany({ where: { id: accountId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it('lets exactly one of eight simultaneous first passwords win', async () => {
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

  it('keeps the sign-out moment to the millisecond, and reports it back', async () => {
    const revocation = new WebSessionRevocationService(prisma);
    const now = new Date('2026-09-18T10:20:30.456Z');

    assert.deepEqual(await revocation.revokeAll(userId, now), { sessionsRevokedAt: '2026-09-18T10:20:30.456Z' });
    assert.deepEqual(await revocation.state(userId), { sessionsRevokedAt: '2026-09-18T10:20:30.456Z' });
    assert.deepEqual(await revocation.state(`${prefix}-nobody`), { sessionsRevokedAt: null });
  });
});
