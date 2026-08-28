import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ConflictException } from '@nestjs/common';

import { BulkUserOperationsService } from '../src/modules/users/services/bulk-user-operations.service';
import {
  USER_DELETE_PROTECTED_HISTORY_CODE,
  USER_DELETE_PROTECTED_HISTORY_MESSAGE,
} from '../src/modules/users/services/user-deletion.service';

const ADMIN = { id: 'admin-1' } as never;
const REQUEST_METADATA = { requestId: null, remoteAddress: null, userAgent: null };

/**
 * A no-op block service.
 *
 * Every test in this file is about token RESOLUTION and deletion — the two
 * `action: 'block'` runs below never resolve a user, so the block never fires.
 * `bulk-user-audit-trail.spec.ts` is where the block itself is asserted, and it
 * builds the real service over its fake client for exactly that reason.
 */
const NO_BLOCKS = {
  block: async () => undefined,
  unblock: async () => undefined,
} as never;

function buildService(deleteUser: (userId: string) => Promise<void>) {
  const emitted: Array<{ readonly level: string; readonly type: string }> = [];
  const prisma = {
    user: {
      findFirst: async () => ({ id: 'user-1', telegramId: 42n, isBlocked: false }),
    },
    adminAuditLog: { create: async () => undefined },
  };
  const events = {
    warn: (type: string) => emitted.push({ level: 'warn', type }),
    info: (type: string) => emitted.push({ level: 'info', type }),
  };

  return {
    emitted,
    service: new BulkUserOperationsService(
      prisma as never,
      events as never,
      { deleteUser } as never,
      NO_BLOCKS,
    ),
  };
}

/** Captures the where-clause `resolveUser` builds for a pasted token. */
async function captureResolveWhere(token: string): Promise<Record<string, unknown>> {
  const calls: Array<{ readonly where: Record<string, unknown> }> = [];
  const service = new BulkUserOperationsService(
    {
      user: {
        findFirst: async (args: { readonly where: Record<string, unknown> }) => {
          calls.push(args);
          return null;
        },
      },
    } as never,
    { warn: () => undefined, info: () => undefined } as never,
    { deleteUser: async () => undefined } as never,
    NO_BLOCKS,
  );

  await service.execute({
    userIds: [token],
    action: 'block',
    currentAdmin: ADMIN,
    requestMetadata: REQUEST_METADATA,
  });
  assert.equal(calls.length, 1, 'expected exactly one resolve lookup');
  return calls[0].where;
}

function telegramIdBranches(where: Record<string, unknown>): ReadonlyArray<Record<string, unknown>> {
  const clauses = (where as { readonly OR: ReadonlyArray<Record<string, unknown>> }).OR;
  return clauses.filter((clause) => 'telegramId' in clause);
}

describe('BulkUserOperationsService token resolution', () => {
  it('keeps the telegramId branch for the largest id Postgres int8 can hold', async () => {
    assert.deepStrictEqual(
      telegramIdBranches(await captureResolveWhere('9223372036854775807')),
      [{ telegramId: 9223372036854775807n }],
    );
  });

  it('drops the telegramId branch one past the bound, though it is still 19 digits', async () => {
    // The old `^\d{1,19}$` gate admitted this: nineteen digits, out of range.
    assert.equal('9999999999999999999'.length, 19);
    assert.deepStrictEqual(telegramIdBranches(await captureResolveWhere('9999999999999999999')), []);
    assert.deepStrictEqual(telegramIdBranches(await captureResolveWhere('9223372036854775808')), []);
  });

  it('still looks the overflowing token up by id / email / login', async () => {
    const overflowing = '9999999999999999999';
    assert.deepStrictEqual((await captureResolveWhere(overflowing)).OR, [
      { id: overflowing },
      { email: { equals: overflowing, mode: 'insensitive' } },
      { webAccount: { login: { equals: overflowing, mode: 'insensitive' } } },
    ]);
  });

  it('reports an unresolvable overflowing token as skipped, not as a failed run', async () => {
    const service = new BulkUserOperationsService(
      { user: { findFirst: async () => null } } as never,
      { warn: () => undefined, info: () => undefined } as never,
      { deleteUser: async () => undefined } as never,
      NO_BLOCKS,
    );

    const result = await service.execute({
      userIds: ['99999999999999999999999999'],
      action: 'block',
      currentAdmin: ADMIN,
      requestMetadata: REQUEST_METADATA,
    });

    assert.equal(result.failed, 0);
    assert.equal(result.skipped, 1);
  });
});

describe('BulkUserOperationsService user deletion', () => {
  it('uses the shared deletion boundary and emits user.deleted only after success', async () => {
    const deleted: string[] = [];
    const { service, emitted } = buildService(async (userId) => {
      deleted.push(userId);
    });

    const result = await service.execute({
      userIds: ['user-1'],
      action: 'delete',
      currentAdmin: ADMIN,
      requestMetadata: REQUEST_METADATA,
    });

    assert.deepStrictEqual(deleted, ['user-1']);
    assert.equal(result.succeeded, 1);
    assert.equal(result.failed, 0);
    assert.deepStrictEqual(emitted, [
      { level: 'warn', type: 'user.deleted' },
      { level: 'info', type: 'system.bulk_users_executed' },
    ]);
  });

  it('reports a protected-history conflict per row without emitting a deletion event', async () => {
    const { service, emitted } = buildService(async () => {
      throw new ConflictException({
        code: USER_DELETE_PROTECTED_HISTORY_CODE,
        message: USER_DELETE_PROTECTED_HISTORY_MESSAGE,
      });
    });

    const result = await service.execute({
      userIds: ['user-1'],
      action: 'delete',
      currentAdmin: ADMIN,
      requestMetadata: REQUEST_METADATA,
    });

    assert.equal(result.succeeded, 0);
    assert.equal(result.failed, 1);
    assert.deepStrictEqual(result.items, [
      {
        userId: 'user-1',
        status: 'error',
        message: USER_DELETE_PROTECTED_HISTORY_MESSAGE,
      },
    ]);
    assert.deepStrictEqual(emitted, [
      { level: 'info', type: 'system.bulk_users_executed' },
    ]);
  });
});
