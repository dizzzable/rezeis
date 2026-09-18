import 'reflect-metadata';

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Prisma } from '@prisma/client';
import request from 'supertest';

import { AdminSafeExceptionFilter } from '../src/common/filters/admin-safe-exception.filter';
import { InternalAdminAuthGuard } from '../src/modules/auth/guards/internal-admin-auth.guard';
import { PasswordHashService } from '../src/modules/auth/services/password-hash.service';
import { InternalWebAuthCredentialsController } from '../src/modules/web-auth/controllers/internal-web-auth-credentials.controller';
import {
  FIRST_PASSWORD_ACCOUNT_SELECT,
  WEB_FIRST_PASSWORD_DATABASE,
  WebFirstPasswordService,
  type FirstPasswordHasher,
  type WebFirstPasswordDatabase,
} from '../src/modules/web-auth/services/web-first-password.service';
import {
  WEB_SESSION_REVOCATION_DATABASE,
  WebSessionRevocationService,
} from '../src/modules/web-auth/services/web-session-revocation.service';
import { applySessionsRevokedAtRaise } from './helpers/sessions-revoked-at-sql';

/**
 * A first password from inside the Mini App
 * ═════════════════════════════════════════
 * An account imported without a password can already be signed in to — the
 * Telegram Mini App needs none — and the cabinet then sent it to «Смена
 * пароля», which asks for the current password. There was none, so the only
 * way out was a reset link. `password/first` lets that signed-in customer set
 * the first one, and this file pins what keeps it from being anything more:
 *
 *   - it never overwrites a password — not one that was there, and not one a
 *     concurrent request set between this one's read and its write;
 *   - it refuses an account that is not a usable web account;
 *   - it lifts what sent the customer to the password page, and like any new
 *     password it signs older sessions out: with a moment taken once the
 *     password is hashed, written in the same transaction, never moved back;
 *   - over HTTP it takes exactly a customer and a new password — no current
 *     password field to confuse it with a change.
 *
 * The account is always the one of the cabinet's server session: the cabinet
 * sends `userId` from it, never from the browser (`reiwa`'s
 * `test/api/auth-first-password.test.ts`). The same race against a real
 * PostgreSQL is `web-first-password-postgres.spec.ts`.
 */

interface AccountRow {
  id: string;
  userId: string;
  login: string | null;
  passwordHash: string | null;
  passwordBootstrapPending: boolean;
  requiresPasswordChange: boolean;
  temporaryPasswordExpiresAt: Date | null;
  credentialsBootstrappedAt: Date | null;
  sessionsRevokedAt: Date | null;
  isBlocked: boolean;
}

const FIRST = 'a1b2'.repeat(16); // the SHA-256 hex the cabinet sends
const OTHER = 'c3d4'.repeat(16);

function imported(overrides: Partial<AccountRow> = {}): AccountRow {
  return {
    id: 'wa-imported',
    userId: 'u-imported',
    login: 'imported_user',
    passwordHash: null,
    passwordBootstrapPending: true,
    requiresPasswordChange: true,
    temporaryPasswordExpiresAt: null,
    credentialsBootstrappedAt: null,
    sessionsRevokedAt: null,
    isBlocked: false,
    ...overrides,
  };
}

/**
 * Web accounts as Postgres would serve this port: the `where` of a write is its
 * filter, and each statement runs whole before the next — which is what the row
 * lock a real write takes gives two concurrent requests. Both ways Prisma
 * offers to write the sign-out moment are here: a plain assignment through the
 * typed client, and the raw statement that never moves it back.
 */
function database(rows: AccountRow[]) {
  /** The password writes that matched a row, and whether each ran inside a transaction. */
  const writes: Array<{ data: Record<string, unknown>; inTransaction: boolean }> = [];
  /** The sign-out moment statements, and whether each ran inside a transaction. */
  const raises: Array<{ inTransaction: boolean }> = [];
  let transactions = 0;
  const updateMany = (inTransaction: boolean) =>
    async (args: { where: Prisma.WebAccountWhereInput; data: Prisma.WebAccountUpdateManyMutationInput }) => {
      const where = args.where as Record<string, unknown>;
      assert.deepEqual(Object.keys(where).sort(), ['id', 'passwordHash'], 'the write names the account and the empty password');
      const data = args.data as Record<string, unknown>;
      const hit = rows.filter((row) => row.id === where['id'] && row.passwordHash === where['passwordHash']);
      for (const row of hit) {
        for (const [field, value] of Object.entries(data)) {
          assert.ok(value === null || typeof value !== 'object' || value instanceof Date, `plain values only (${field})`);
          (row as unknown as Record<string, unknown>)[field] = value;
        }
        writes.push({ data, inTransaction });
      }
      return { count: hit.length };
    };
  const raise = (inTransaction: boolean) => async (query: Prisma.Sql) => {
    raises.push({ inTransaction });
    return applySessionsRevokedAtRaise(query, rows);
  };
  const fake = {
    webAccount: {
      findUnique: async (args: { where: Prisma.WebAccountWhereUniqueInput; select: typeof FIRST_PASSWORD_ACCOUNT_SELECT }) => {
        assert.equal(args.select, FIRST_PASSWORD_ACCOUNT_SELECT, 'an account read used another select');
        const where = args.where as Record<string, unknown>;
        assert.deepEqual(Object.keys(where), ['userId'], 'the account is looked up by its customer');
        const row = rows.find((candidate) => candidate.userId === where['userId']);
        if (row === undefined) return null;
        return {
          id: row.id,
          login: row.login,
          passwordHash: row.passwordHash,
          credentialsBootstrappedAt: row.credentialsBootstrappedAt,
          user: { isBlocked: row.isBlocked },
        };
      },
      updateMany: updateMany(false),
    },
    $transaction: async <R>(
      fn: (tx: { webAccount: { updateMany: ReturnType<typeof updateMany> }; $executeRaw: ReturnType<typeof raise> }) => Promise<R>,
    ): Promise<R> => {
      transactions += 1;
      return fn({ webAccount: { updateMany: updateMany(true) }, $executeRaw: raise(true) });
    },
  };
  const port: WebFirstPasswordDatabase = fake;
  return {
    rows,
    writes,
    raises,
    port,
    get transactions() {
      return transactions;
    },
  };
}

const realHasher = new PasswordHashService();

describe('a first password, set from a session the customer already has', () => {
  it('sets it, lifts what sent the customer to the password page, and signs older sessions out', async () => {
    const db = database([imported()]);
    const service = new WebFirstPasswordService(db.port, realHasher);
    const now = new Date('2026-09-18T12:00:00.000Z');

    const result = await service.set('u-imported', FIRST, now);

    assert.deepEqual(result, { status: 'set', login: 'imported_user', sessionsRevokedAt: now.toISOString() });
    const [row] = db.rows;
    assert.ok(row.passwordHash !== null);
    assert.equal(await realHasher.verifyPassword({ plainTextPassword: FIRST, passwordHash: row.passwordHash }), true);
    assert.ok(row.passwordHash.startsWith('scrypt$16384$8$5$'), 'not the subscriber scrypt parameters');
    assert.equal(row.passwordBootstrapPending, false);
    assert.equal(row.requiresPasswordChange, false);
    assert.equal(row.temporaryPasswordExpiresAt, null);
    assert.deepEqual(row.credentialsBootstrappedAt, now);
    assert.deepEqual(row.sessionsRevokedAt, now);
    assert.deepEqual(
      [...db.writes.map((write) => ['password', write.inTransaction]), ...db.raises.map((write) => ['moment', write.inTransaction])],
      [
        ['password', true],
        ['moment', true],
      ],
      'the password and the moment were not written in one transaction',
    );
    assert.equal(db.writes[0].data['sessionsRevokedAt'], undefined, 'the moment was assigned with the password, so a later one could be overwritten');
  });

  it('takes its moment once the password is hashed, not before', async () => {
    // scrypt takes a while. A moment taken BEFORE it is older than the write
    // that carries it, by the whole hash — and every session opened in that
    // gap would survive the new password.
    const db = database([imported()]);
    let hashedAt = 0;
    const hasher: FirstPasswordHasher = {
      hashPassword: async (input) => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        const hash = await realHasher.hashPassword(input);
        hashedAt = Date.now();
        return hash;
      },
    };
    const service = new WebFirstPasswordService(db.port, hasher);

    const result = await service.set('u-imported', FIRST);

    assert.equal(result.status, 'set');
    const moment = Date.parse((result as { sessionsRevokedAt: string }).sessionsRevokedAt);
    assert.ok(moment >= hashedAt, `the moment ${new Date(moment).toISOString()} predates the hash (${new Date(hashedAt).toISOString()})`);
    assert.equal(db.rows[0].sessionsRevokedAt?.getTime(), moment);
  });

  it('never moves the moment back: a later one another writer already stored stands', async () => {
    const later = new Date('2026-09-18T13:00:00.000Z');
    const db = database([imported({ sessionsRevokedAt: new Date(later) })]);
    const service = new WebFirstPasswordService(db.port, realHasher);

    const result = await service.set('u-imported', FIRST, new Date('2026-09-18T12:00:00.000Z'));

    assert.deepEqual(db.rows[0].sessionsRevokedAt, later, 'the stored moment moved back');
    // The browser that set it counts from ITS moment.
    assert.deepEqual(result, { status: 'set', login: 'imported_user', sessionsRevokedAt: '2026-09-18T12:00:00.000Z' });
  });

  it('refuses when a password exists, and leaves it exactly as it was', async () => {
    const existing = await realHasher.hashPassword({ plainTextPassword: OTHER, audience: 'subscriber' });
    const db = database([imported({ passwordHash: existing, passwordBootstrapPending: false })]);
    // The real hasher, counted: a refusal must not spend a scrypt run on a
    // password it is never going to store.
    let hashed = 0;
    const hasher: FirstPasswordHasher = {
      hashPassword: async (input) => {
        hashed += 1;
        return realHasher.hashPassword(input);
      },
    };
    const service = new WebFirstPasswordService(db.port, hasher);

    assert.deepEqual(await service.set('u-imported', FIRST), { status: 'has_password' });

    assert.equal(db.rows[0].passwordHash, existing);
    assert.deepEqual(db.writes, []);
    assert.deepEqual(db.raises, []);
    assert.equal(db.rows[0].sessionsRevokedAt, null);
    assert.equal(hashed, 0, 'the refusal hashed the password first');
  });

  it('refuses an account that is not a usable one: none, without a login, or blocked', async () => {
    const db = database([
      imported({ id: 'wa-nologin', userId: 'u-nologin', login: null }),
      imported({ id: 'wa-blocked', userId: 'u-blocked', isBlocked: true }),
    ]);
    const service = new WebFirstPasswordService(db.port, realHasher);

    for (const userId of ['u-nobody', 'u-nologin', 'u-blocked']) {
      assert.deepEqual(await service.set(userId, FIRST), { status: 'no_account' }, userId);
    }
    assert.deepEqual(db.writes, []);
  });

  it('lets exactly one of two concurrent first passwords win, and the loser writes nothing', async () => {
    // Both requests read "no password" before either writes: the hasher holds
    // each until both have arrived. Only the `where` of the write can then
    // keep the second from overwriting the first.
    const db = database([imported()]);
    let arrived = 0;
    let release!: () => void;
    const bothRead = new Promise<void>((resolve) => {
      release = resolve;
    });
    const hasher: FirstPasswordHasher = {
      hashPassword: async (input) => {
        arrived += 1;
        if (arrived === 2) release();
        await bothRead;
        return realHasher.hashPassword(input);
      },
    };
    const service = new WebFirstPasswordService(db.port, hasher);

    const results = await Promise.all([service.set('u-imported', FIRST), service.set('u-imported', OTHER)]);

    assert.equal(arrived, 2, 'the two requests did not both get past the read');
    const statuses = results.map((result) => result.status).sort();
    assert.deepEqual(statuses, ['has_password', 'set']);
    assert.equal(db.writes.length, 1);
    assert.equal(db.raises.length, 1, 'exactly the winner signs older sessions out: the loser set no password');
    const winner = results[0].status === 'set' ? FIRST : OTHER;
    const loser = winner === FIRST ? OTHER : FIRST;
    const stored = db.rows[0].passwordHash!;
    assert.equal(await realHasher.verifyPassword({ plainTextPassword: winner, passwordHash: stored }), true);
    assert.equal(await realHasher.verifyPassword({ plainTextPassword: loser, passwordHash: stored }), false);
  });

  it('tells the password page whether there is a password yet', async () => {
    const db = database([imported(), imported({ id: 'wa-alice', userId: 'u-alice', login: 'alice', passwordHash: 'scrypt$x' })]);
    const service = new WebFirstPasswordService(db.port, realHasher);

    assert.deepEqual(await service.state('u-imported'), { hasPassword: false, login: 'imported_user' });
    assert.deepEqual(await service.state('u-alice'), { hasPassword: true, login: 'alice' });
    await assert.rejects(() => service.state('u-nobody'), { status: 404 });
  });
});

describe('the first-password routes the cabinet calls', () => {
  let app: INestApplication | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function boot(db: ReturnType<typeof database>): Promise<INestApplication> {
    const moduleRef = await Test.createTestingModule({
      controllers: [InternalWebAuthCredentialsController],
      providers: [
        WebFirstPasswordService,
        { provide: WEB_FIRST_PASSWORD_DATABASE, useValue: db.port },
        { provide: PasswordHashService, useValue: realHasher },
        // Present because the controller serves the session routes too; none
        // is called here, and a call would throw on the empty port.
        WebSessionRevocationService,
        { provide: WEB_SESSION_REVOCATION_DATABASE, useValue: { webAccount: {} } },
      ],
    })
      .overrideGuard(InternalAdminAuthGuard)
      .useValue({ canActivate: (): boolean => true })
      .compile();
    const created = moduleRef.createNestApplication();
    created.setGlobalPrefix('/api');
    created.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
    created.useGlobalFilters(new AdminSafeExceptionFilter());
    await created.init();
    app = created;
    return created;
  }

  it('sets at POST /api/internal/web-auth/password/first and reports at …/password/state', async () => {
    const db = database([imported()]);
    const server = (await boot(db)).getHttpServer();

    const before = await request(server).post('/api/internal/web-auth/password/state').send({ userId: 'u-imported' });
    assert.equal(before.status, 200, before.text);
    assert.deepEqual(before.body, { hasPassword: false, login: 'imported_user' });

    const set = await request(server)
      .post('/api/internal/web-auth/password/first')
      .send({ userId: 'u-imported', newPassword: FIRST });
    assert.equal(set.status, 200, set.text);
    assert.equal((set.body as { status: string }).status, 'set');

    const after = await request(server).post('/api/internal/web-auth/password/state').send({ userId: 'u-imported' });
    assert.deepEqual(after.body, { hasPassword: true, login: 'imported_user' });
  });

  it('refuses a body without the customer, with a short password, or with a current password beside it', async () => {
    const db = database([imported()]);
    const server = (await boot(db)).getHttpServer();

    for (const body of [
      { newPassword: FIRST },
      { userId: 'u-imported', newPassword: 'short' },
      { userId: 'u-imported', newPassword: FIRST, currentPassword: OTHER },
    ]) {
      const response = await request(server).post('/api/internal/web-auth/password/first').send(body);
      assert.equal(response.status, 400, JSON.stringify(body));
    }
    assert.deepEqual(db.writes, []);
  });
});
