import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Test } from '@nestjs/testing';
import { UserRole, type Prisma } from '@prisma/client';
import type { Request } from 'express';

import { RawCacheService } from '../src/common/cache/raw-cache.service';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AdminJwtAuthGuard } from '../src/modules/auth/guards/admin-jwt-auth.guard';
import type { CurrentAdminInterface } from '../src/modules/auth/interfaces/current-admin.interface';
import { PasswordHashService } from '../src/modules/auth/services/password-hash.service';
import { RbacGuard } from '../src/modules/rbac/guards/rbac.guard';
import { AdminUserWebController } from '../src/modules/users/controllers/admin-user-web.controller';
import {
  WebSessionRevocationService,
  type WebSessionRevocationDatabase,
} from '../src/modules/web-auth/services/web-session-revocation.service';
import { applySessionsRevokedAtRaise } from './helpers/sessions-revoked-at-sql';

/**
 * An operator's temporary password signs the customer's other sessions out
 * ════════════════════════════════════════════════════════════════════════
 * The typical support case: a customer's account was taken over, and an
 * operator issues a temporary password from the user card («Сбросить пароль»).
 * Until now whoever was signed in with the old password stayed signed in for
 * the rest of their 30-day window. The temporary password now writes
 * `web_accounts.sessions_revoked_at` in the same transaction — as a reset link,
 * a password change and a first password do — through the statement that never
 * moves the moment back (`sessions-revoked-at.util.ts`), and the cabinet signs
 * every older session out at its next check (`web-session-revocation.spec.ts`
 * and the cabinet's `test/session-revocation.test.ts`).
 */

const ADMIN: CurrentAdminInterface = {
  id: 'admin-1',
  login: 'operator',
  email: null,
  name: 'Operator',
  role: UserRole.ADMIN,
  isActive: true,
  tokenVersion: 1,
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  lastLoginAt: null,
  lastLoginIp: null,
  rbacRoleId: null,
  mustChangePassword: false,
};

interface AccountRow {
  id: string;
  userId: string;
  login: string;
  passwordHash: string | null;
  requiresPasswordChange: boolean;
  temporaryPasswordExpiresAt: Date | null;
  sessionsRevokedAt: Date | null;
}

/**
 * The customer's user and web account, the writes made to it, and the port the
 * cabinet's question reads — over the same row, so what the operator writes is
 * what the cabinet is told.
 */
function world() {
  const account: AccountRow = {
    id: 'wa-taken-over',
    userId: 'u-taken-over',
    login: 'taken_over',
    passwordHash: 'scrypt$the-password-somebody-else-knows',
    requiresPasswordChange: false,
    temporaryPasswordExpiresAt: null,
    sessionsRevokedAt: null,
  };
  /**
   * Every write, through the typed client (which ASSIGNS what it is given) or
   * through the raw statement that raises the sign-out moment, and whether it
   * ran inside a transaction. Both ways are offered, so a controller that
   * assigned the moment would be caught by the value it leaves behind.
   */
  const updates: Array<{
    via: 'update' | 'raise';
    inTransaction: boolean;
    where?: Record<string, unknown>;
    data?: Record<string, unknown>;
  }> = [];
  let transactions = 0;
  const update = (target: AccountRow, inTransaction: boolean) =>
    async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      updates.push({ via: 'update', inTransaction, where: args.where, data: args.data });
      assert.equal(args.where.id, target.id);
      Object.assign(target, args.data);
      return { ...target };
    };
  const raise = (target: AccountRow, inTransaction: boolean) => async (query: Prisma.Sql) => {
    updates.push({ via: 'raise', inTransaction });
    return applySessionsRevokedAtRaise(query, [target]);
  };
  const prisma = {
    user: {
      findFirst: async (args: { where: { telegramId?: bigint } }) =>
        args.where.telegramId === 700_001n ? { id: account.userId, telegramId: 700_001n } : null,
    },
    webAccount: {
      findFirst: async (args: { where: { userId?: string } }) =>
        args.where.userId === account.userId ? { ...account } : null,
      update: update(account, false),
    },
    // Lands whole or not at all: the callback works on a copy.
    $transaction: async <R>(
      fn: (tx: { webAccount: { update: ReturnType<typeof update> }; $executeRaw: ReturnType<typeof raise> }) => Promise<R>,
    ): Promise<R> => {
      transactions += 1;
      const staged = { ...account };
      const result = await fn({ webAccount: { update: update(staged, true) }, $executeRaw: raise(staged, true) });
      Object.assign(account, staged);
      return result;
    },
    adminAuditLog: { create: async () => ({}) },
  };
  const revocationPort: WebSessionRevocationDatabase = {
    webAccount: {
      findUnique: async (args) => {
        const where = args.where as { userId?: string };
        return where.userId === account.userId ? { sessionsRevokedAt: account.sessionsRevokedAt } : null;
      },
    },
    $executeRaw: async () => {
      throw new Error('the operator path does not revoke through the service in this case');
    },
  };
  return {
    account,
    updates,
    prisma,
    revocationPort,
    get transactions() {
      return transactions;
    },
  };
}

async function operatorController(prisma: ReturnType<typeof world>['prisma']): Promise<AdminUserWebController> {
  const moduleRef = await Test.createTestingModule({
    controllers: [AdminUserWebController],
    providers: [
      { provide: PrismaService, useValue: prisma },
      { provide: PasswordHashService, useValue: new PasswordHashService() },
      { provide: RawCacheService, useValue: { set: async () => undefined } },
    ],
  })
    // The route's permission (`users:edit`) is pinned by
    // `admin-route-permission-gates.spec.ts`; here the handler is called as
    // the router would once the guards let the operator through.
    .overrideGuard(AdminJwtAuthGuard)
    .useValue({ canActivate: (): boolean => true })
    .overrideGuard(RbacGuard)
    .useValue({ canActivate: (): boolean => true })
    .compile();
  return moduleRef.get(AdminUserWebController);
}

/** What `extractRequestMetadata` reads of a request. */
const REQUEST = { headers: {}, ip: '203.0.113.9', socket: { remoteAddress: '203.0.113.9' } } as unknown as Request;

describe('an operator’s temporary password signs the customer’s other sessions out', () => {
  it('writes the temporary password and the moment in one transaction', async () => {
    const state = world();
    const { account, updates, prisma } = state;
    const controller = await operatorController(prisma);
    const before = Date.now();

    const issued = await controller.resetWebPassword('700001', ADMIN, REQUEST);

    assert.equal(state.transactions, 1, 'the password and the sign-out were not written in one transaction');
    assert.deepEqual(
      updates.map((write) => [write.via, write.inTransaction]),
      [
        ['update', true],
        ['raise', true],
      ],
      'the temporary password, then the moment through the statement that never moves it back — both inside the transaction',
    );
    const [write] = updates;
    assert.ok(typeof write.data?.['passwordHash'] === 'string', 'no temporary password was written');
    assert.equal(
      write.data?.['sessionsRevokedAt'],
      undefined,
      'the moment was assigned with the password, so a later one could be overwritten',
    );
    const revokedAt = account.sessionsRevokedAt;
    assert.ok(revokedAt instanceof Date, 'whoever held the old password stays signed in');
    assert.ok(revokedAt.getTime() >= before && revokedAt.getTime() <= Date.now());
    // The temporary password itself is unchanged in what it does.
    assert.equal(write.data?.['requiresPasswordChange'], true);
    assert.equal(issued.requiresPasswordChange, true);
    assert.equal(issued.login, 'taken_over');
  });

  it('never moves the moment back: a later one another writer already stored stands', async () => {
    const { account, prisma } = world();
    const later = new Date(Date.now() + 60 * 60 * 1000);
    account.sessionsRevokedAt = new Date(later);
    const controller = await operatorController(prisma);

    await controller.resetWebPassword('700001', ADMIN, REQUEST);

    assert.deepEqual(account.sessionsRevokedAt, later, 'the stored moment moved back');
    assert.notEqual(account.passwordHash, 'scrypt$the-password-somebody-else-knows', 'no temporary password was written');
  });

  it('is what the cabinet is told when it next asks about the customer’s sessions', async () => {
    const { prisma, revocationPort } = world();
    const controller = await operatorController(prisma);
    const revocation = new WebSessionRevocationService(revocationPort);
    assert.equal((await revocation.state('u-taken-over')).sessionsRevokedAt, null);

    await controller.resetWebPassword('700001', ADMIN, REQUEST);

    const { sessionsRevokedAt } = await revocation.state('u-taken-over');
    assert.ok(sessionsRevokedAt !== null, 'the cabinet would keep every older session');
    assert.ok(Date.now() - Date.parse(sessionsRevokedAt) < 60_000);
  });
});
