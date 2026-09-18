import 'reflect-metadata';

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { INestApplication, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Prisma } from '@prisma/client';
import request from 'supertest';

import { RawCacheService } from '../src/common/cache/raw-cache.service';
import { AdminSafeExceptionFilter } from '../src/common/filters/admin-safe-exception.filter';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { SystemEventsService } from '../src/common/services/system-events.service';
import { InternalAdminAuthGuard } from '../src/modules/auth/guards/internal-admin-auth.guard';
import { PasswordHashService } from '../src/modules/auth/services/password-hash.service';
import { EmailDeliveryService } from '../src/modules/email/services/email-delivery.service';
import { LegalDocumentsService } from '../src/modules/legal-documents/services/legal-documents.service';
import { ReferralManualAttachService } from '../src/modules/referrals/services/referral-manual-attach.service';
import { AccessModeGuard } from '../src/modules/settings/services/access-mode-guard.service';
import { SettingsService } from '../src/modules/settings/services/settings.service';
import { InternalWebAuthCredentialsController } from '../src/modules/web-auth/controllers/internal-web-auth-credentials.controller';
import { RegistrationSnapshotService } from '../src/modules/web-auth/services/registration-snapshot.service';
import { WebAuthService } from '../src/modules/web-auth/services/web-auth.service';
import { WebAuthModule } from '../src/modules/web-auth/web-auth.module';
import {
  WEB_FIRST_PASSWORD_DATABASE,
  WebFirstPasswordService,
} from '../src/modules/web-auth/services/web-first-password.service';
import {
  WEB_SESSION_REVOCATION_DATABASE,
  WebSessionRevocationService,
  type WebSessionRevocationDatabase,
} from '../src/modules/web-auth/services/web-session-revocation.service';
import { applySessionsRevokedAtRaise } from './helpers/sessions-revoked-at-sql';

/**
 * Signing a customer's other cabinet sessions out — the panel's half
 * ══════════════════════════════════════════════════════════════════
 * The cabinet cannot enumerate a customer's sessions (opaque Redis keys, no
 * index by customer), so the panel keeps one moment per web account,
 * `sessions_revoked_at`: every session that started before it is signed out
 * the next time the cabinet asks (`sessions/state`, at most once a minute per
 * session). This file pins who writes the moment and what the cabinet can ask:
 *
 *   - a password change writes it in the same transaction as the new password,
 *     and a refused one writes nothing;
 *   - «Выйти на всех устройствах» (`sessions/revoke`) writes it for that
 *     customer only;
 *   - neither ever moves it back: a later moment another writer already put
 *     there stands (`GREATEST`, `sessions-revoked-at.util.ts`);
 *   - `sessions/state` reports it, with the panel's own clock beside it so the
 *     cabinet can compare its sessions' starts on ONE clock, and reports
 *     nothing revoked for a customer who has no web account (a Telegram-only
 *     one);
 *   - the routes sit where the cabinet calls them, and refuse a body without a
 *     customer, through the real validation pipe and error filter.
 *
 * A password reset writes it on every channel — pinned in
 * `web-auth-reset.spec.ts` ("signs every older session out…"). A first
 * password writes it too — `web-first-password.spec.ts`; an operator's
 * temporary password — `operator-password-reset-sessions.spec.ts`. That the
 * statement keeps the later moment on a real database, under a real lock wait,
 * is `web-first-password-postgres.spec.ts`.
 */

interface AccountRow {
  id: string;
  userId: string;
  passwordHash: string | null;
  requiresPasswordChange: boolean;
  temporaryPasswordExpiresAt: Date | null;
  sessionsRevokedAt: Date | null;
}

const CURRENT = 'c0ffee'.repeat(10) + 'c0ff';
const NEXT = 'bead'.repeat(16);

/**
 * One write a service made: through the typed client (`update` /
 * `updateMany`, which ASSIGN what they are given) or through the one raw
 * statement that raises the sign-out moment, and whether it ran inside a
 * transaction.
 */
interface Write {
  readonly via: 'update' | 'updateMany' | 'raise';
  readonly inTransaction: boolean;
  readonly where?: Record<string, unknown>;
  readonly data?: Record<string, unknown>;
}

/**
 * The web accounts both services read and write, and every write they made.
 * Both ways Prisma offers to write the moment are here — a plain assignment
 * through the typed client, and the raw statement — so a service that wrote it
 * the plain way would be caught by the value it leaves, not by a missing
 * method.
 */
function accounts(rows: AccountRow[]) {
  const writes: Write[] = [];
  let transactions = 0;
  const matches = (row: AccountRow, where: Record<string, unknown>): boolean => {
    const unmodelled = Object.keys(where).filter((key) => key !== 'id' && key !== 'userId');
    assert.deepEqual(unmodelled, [], 'the fake models id and userId filters only');
    return Object.entries(where).every(([key, value]) => (row as unknown as Record<string, unknown>)[key] === value);
  };
  const apply = (row: AccountRow, data: Record<string, unknown>) => {
    for (const [field, value] of Object.entries(data)) {
      assert.ok(value === null || typeof value !== 'object' || value instanceof Date, `plain values only (${field})`);
      (row as unknown as Record<string, unknown>)[field] = value;
    }
  };
  const update = (target: AccountRow[], inTransaction: boolean) =>
    async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      writes.push({ via: 'update', inTransaction, where: args.where, data: args.data });
      const row = target.find((candidate) => candidate.id === args.where.id);
      assert.ok(row, `no account ${args.where.id}`);
      apply(row, args.data);
      return row;
    };
  const raise = (target: AccountRow[], inTransaction: boolean) => async (query: Prisma.Sql) => {
    writes.push({ via: 'raise', inTransaction });
    return applySessionsRevokedAtRaise(query, target);
  };
  const revocationPort = {
    webAccount: {
      findUnique: async (args: { where: Prisma.WebAccountWhereUniqueInput; select: { sessionsRevokedAt: true } }) => {
        assert.deepEqual(args.select, { sessionsRevokedAt: true });
        const where = args.where as Record<string, unknown>;
        const row = rows.find((candidate) => matches(candidate, where));
        return row === undefined ? null : { sessionsRevokedAt: row.sessionsRevokedAt };
      },
      updateMany: async (args: { where: Prisma.WebAccountWhereInput; data: Prisma.WebAccountUpdateManyMutationInput }) => {
        const where = args.where as Record<string, unknown>;
        const data = args.data as Record<string, unknown>;
        writes.push({ via: 'updateMany', inTransaction: false, where, data });
        const hit = rows.filter((row) => matches(row, where));
        for (const row of hit) apply(row, data);
        return { count: hit.length } satisfies Prisma.BatchPayload;
      },
    },
    $executeRaw: raise(rows, false),
  };
  const port: WebSessionRevocationDatabase = revocationPort;
  /**
   * What `WebAuthService.changePassword` touches of Prisma: one read by user,
   * and writes — outside a transaction, or inside one that lands whole or not
   * at all.
   */
  const prisma = {
    webAccount: {
      findUnique: async (args: { where: { userId?: string } }) => {
        assert.deepEqual(Object.keys(args.where), ['userId']);
        return rows.find((row) => row.userId === args.where.userId) ?? null;
      },
      update: update(rows, false),
    },
    $transaction: async <R>(fn: (tx: { webAccount: { update: ReturnType<typeof update> }; $executeRaw: ReturnType<typeof raise> }) => Promise<R>): Promise<R> => {
      transactions += 1;
      const staged = rows.map((row) => ({ ...row }));
      const result = await fn({ webAccount: { update: update(staged, true) }, $executeRaw: raise(staged, true) });
      staged.forEach((row, index) => Object.assign(rows[index], row));
      return result;
    },
  };
  return {
    rows,
    writes,
    revocationPort: port,
    prisma,
    get transactions() {
      return transactions;
    },
  };
}

function row(id: string, overrides: Partial<AccountRow> = {}): AccountRow {
  return {
    id: `wa-${id}`,
    userId: `u-${id}`,
    passwordHash: null,
    requiresPasswordChange: false,
    temporaryPasswordExpiresAt: null,
    sessionsRevokedAt: null,
    ...overrides,
  };
}

async function webAuthService(db: ReturnType<typeof accounts>) {
  const hasher = new PasswordHashService();
  const moduleRef = await Test.createTestingModule({
    providers: [
      WebAuthService,
      { provide: PrismaService, useValue: db.prisma },
      { provide: PasswordHashService, useValue: hasher },
      { provide: RawCacheService, useValue: { del: async () => undefined } },
      { provide: ReferralManualAttachService, useValue: {} },
      { provide: SettingsService, useValue: {} },
      { provide: AccessModeGuard, useValue: {} },
      { provide: SystemEventsService, useValue: {} },
      { provide: EmailDeliveryService, useValue: {} },
      { provide: RegistrationSnapshotService, useValue: {} },
      { provide: LegalDocumentsService, useValue: {} },
    ],
  }).compile();
  return { service: moduleRef.get(WebAuthService), hasher };
}

describe('a password change signs every older session out', () => {
  it('writes the new password and the moment in one transaction, and hands the moment to the cabinet', async () => {
    const db = accounts([row('alice'), row('bob')]);
    const { service, hasher } = await webAuthService(db);
    db.rows[0].passwordHash = await hasher.hashPassword({ plainTextPassword: CURRENT, audience: 'subscriber' });
    const before = Date.now();

    const result = await service.changePassword({ userId: 'u-alice', currentPassword: CURRENT, newPassword: NEXT });

    assert.equal(db.transactions, 1, 'the password and the moment were not written in one transaction');
    assert.deepEqual(
      db.writes.map((write) => [write.via, write.inTransaction]),
      [
        ['update', true],
        ['raise', true],
      ],
      'the new password, then the moment through the statement that never moves it back — both inside the transaction',
    );
    const [password] = db.writes;
    assert.ok(typeof password.data?.['passwordHash'] === 'string');
    assert.equal(password.data?.['sessionsRevokedAt'], undefined, 'the moment was assigned with the password, so a later one could be overwritten');
    const alice = db.rows[0];
    assert.ok(alice.sessionsRevokedAt !== null && alice.sessionsRevokedAt.getTime() >= before);
    assert.deepEqual(result, { success: true, sessionsRevokedAt: alice.sessionsRevokedAt.toISOString() });
    assert.equal(db.rows[1].sessionsRevokedAt, null, 'somebody else’s sessions were signed out');
  });

  it('never moves the moment back: a later one another writer already stored stands', async () => {
    // Another writer — «Выйти на всех устройствах», a reset — took a later
    // moment and committed first. This change must not pull it back, or every
    // session opened between the two moments would survive it.
    const later = new Date(Date.now() + 60 * 60 * 1000);
    const db = accounts([row('alice', { sessionsRevokedAt: new Date(later) })]);
    const { service, hasher } = await webAuthService(db);
    db.rows[0].passwordHash = await hasher.hashPassword({ plainTextPassword: CURRENT, audience: 'subscriber' });

    const result = await service.changePassword({ userId: 'u-alice', currentPassword: CURRENT, newPassword: NEXT });

    assert.deepEqual(db.rows[0].sessionsRevokedAt, later, 'the stored moment moved back');
    // The browser that changed the password still counts from ITS moment.
    assert.ok(Date.parse(result.sessionsRevokedAt) < later.getTime());
  });

  it('writes nothing when the current password is wrong', async () => {
    const db = accounts([row('alice')]);
    const { service, hasher } = await webAuthService(db);
    db.rows[0].passwordHash = await hasher.hashPassword({ plainTextPassword: CURRENT, audience: 'subscriber' });

    await assert.rejects(
      () => service.changePassword({ userId: 'u-alice', currentPassword: 'f'.repeat(64), newPassword: NEXT }),
      UnauthorizedException,
    );

    assert.deepEqual(db.writes, []);
    assert.equal(db.rows[0].sessionsRevokedAt, null);
  });
});

describe('«Выйти на всех устройствах» and the question the cabinet asks', () => {
  it('reports nothing revoked until something is, then the moment, as an exact instant', async () => {
    const db = accounts([row('alice'), row('bob')]);
    const revocation = new WebSessionRevocationService(db.revocationPort);

    assert.equal((await revocation.state('u-alice')).sessionsRevokedAt, null);

    const now = new Date('2026-09-18T10:00:00.123Z');
    assert.deepEqual(await revocation.revokeAll('u-alice', now), { sessionsRevokedAt: '2026-09-18T10:00:00.123Z' });

    assert.equal((await revocation.state('u-alice')).sessionsRevokedAt, '2026-09-18T10:00:00.123Z');
    assert.equal((await revocation.state('u-bob')).sessionsRevokedAt, null, 'revoked for the wrong customer');
    assert.deepEqual(
      db.writes.map((write) => write.via),
      ['raise'],
      'the moment was not written through the statement that never moves it back',
    );
    assert.deepEqual(db.rows[1].sessionsRevokedAt, null);
  });

  it('never moves the moment back: a later one another writer already stored stands', async () => {
    const later = new Date('2026-09-18T11:00:00.000Z');
    const db = accounts([row('alice', { sessionsRevokedAt: new Date(later) })]);
    const revocation = new WebSessionRevocationService(db.revocationPort);

    const result = await revocation.revokeAll('u-alice', new Date('2026-09-18T10:00:00.000Z'));

    assert.equal((await revocation.state('u-alice')).sessionsRevokedAt, later.toISOString(), 'the stored moment moved back');
    // The browser that pressed it counts from ITS moment; the later one still
    // signs out whatever started before it.
    assert.deepEqual(result, { sessionsRevokedAt: '2026-09-18T10:00:00.000Z' });
  });

  it('tells the cabinet the panel’s own clock with every answer, so it can compare on one clock', async () => {
    // The cabinet stamps a session's start with ITS clock and this moment is
    // the panel's. Two servers' clocks disagree by seconds, sometimes more; the
    // cabinet estimates the difference from this `now` and the round trip.
    const db = accounts([row('alice', { sessionsRevokedAt: new Date('2026-09-18T10:00:00.000Z') })]);
    const revocation = new WebSessionRevocationService(db.revocationPort);
    const before = Date.now();

    const state = await revocation.state('u-alice');

    const after = Date.now();
    assert.equal(typeof state.now, 'string', 'no clock beside the moment');
    const now = Date.parse(state.now);
    assert.equal(new Date(now).toISOString(), state.now, 'not an exact instant');
    assert.ok(now >= before && now <= after, `${state.now} is not the time of the answer`);
    const nobody = await revocation.state('u-telegram-only');
    assert.equal(typeof nobody.now, 'string', 'the clock is missing when nothing was ever revoked');
  });

  it('reports nothing revoked for a customer with no web account, and refuses to revoke for one', async () => {
    const db = accounts([row('alice')]);
    const revocation = new WebSessionRevocationService(db.revocationPort);

    assert.equal((await revocation.state('u-telegram-only')).sessionsRevokedAt, null);
    await assert.rejects(() => revocation.revokeAll('u-telegram-only'), { status: 404 });
    assert.equal(db.rows[0].sessionsRevokedAt, null);
  });
});

describe('the wiring the panel boots with', () => {
  it('serves the credentials routes and provides their services by the tokens they inject', () => {
    const controllers = Reflect.getMetadata('controllers', WebAuthModule) as unknown[];
    const providers = Reflect.getMetadata('providers', WebAuthModule) as Array<unknown>;
    const provided = providers.map((provider) =>
      typeof provider === 'function' ? provider : (provider as { provide: unknown }).provide,
    );

    assert.ok(controllers.includes(InternalWebAuthCredentialsController), 'the routes are not served');
    for (const token of [
      WebSessionRevocationService,
      WEB_SESSION_REVOCATION_DATABASE,
      WebFirstPasswordService,
      WEB_FIRST_PASSWORD_DATABASE,
    ]) {
      assert.ok(provided.includes(token), `${String(token)} is not provided`);
    }
  });
});

describe('the routes the cabinet calls', () => {
  let app: INestApplication | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function boot(db: ReturnType<typeof accounts>): Promise<INestApplication> {
    const moduleRef = await Test.createTestingModule({
      controllers: [InternalWebAuthCredentialsController],
      providers: [
        WebSessionRevocationService,
        { provide: WEB_SESSION_REVOCATION_DATABASE, useValue: db.revocationPort },
        // Present because the controller serves the first-password routes too;
        // none is called here, and a call would throw on the empty port.
        WebFirstPasswordService,
        { provide: WEB_FIRST_PASSWORD_DATABASE, useValue: { webAccount: {} } },
        { provide: PasswordHashService, useValue: new PasswordHashService() },
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

  it('revokes at POST /api/internal/web-auth/sessions/revoke and reports at …/sessions/state', async () => {
    const db = accounts([row('alice')]);
    const server = (await boot(db)).getHttpServer();

    const revoked = await request(server).post('/api/internal/web-auth/sessions/revoke').send({ userId: 'u-alice' });
    assert.equal(revoked.status, 200, revoked.text);
    const at = (revoked.body as { sessionsRevokedAt: string }).sessionsRevokedAt;
    assert.equal(new Date(at).toISOString(), at);

    const state = await request(server).post('/api/internal/web-auth/sessions/state').send({ userId: 'u-alice' });
    assert.equal(state.status, 200, state.text);
    const body = state.body as { sessionsRevokedAt: string; now: string };
    assert.deepEqual(Object.keys(body).sort(), ['now', 'sessionsRevokedAt']);
    assert.equal(body.sessionsRevokedAt, at);
    assert.equal(new Date(body.now).toISOString(), body.now);
  });

  it('refuses a body that names no customer, or carries anything else', async () => {
    const db = accounts([row('alice')]);
    const server = (await boot(db)).getHttpServer();

    for (const body of [{}, { userId: '' }, { userId: 'u-alice', sessionsRevokedAt: '2020-01-01T00:00:00.000Z' }]) {
      const response = await request(server).post('/api/internal/web-auth/sessions/revoke').send(body);
      assert.equal(response.status, 400, JSON.stringify(body));
    }
    assert.deepEqual(db.writes, []);
  });

  it('answers 404 to «Выйти на всех устройствах» for a customer with no web account', async () => {
    const db = accounts([]);
    const server = (await boot(db)).getHttpServer();

    const response = await request(server).post('/api/internal/web-auth/sessions/revoke').send({ userId: 'u-nobody' });

    assert.equal(response.status, 404);
  });
});
