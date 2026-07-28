import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ConflictException } from '@nestjs/common';

import { BulkUserOperationsService } from '../src/modules/users/services/bulk-user-operations.service';
import {
  USER_DELETE_PROTECTED_HISTORY_CODE,
  USER_DELETE_PROTECTED_HISTORY_MESSAGE,
} from '../src/modules/users/services/user-deletion.service';

function buildService(deleteUser: (userId: string) => Promise<void>) {
  const emitted: Array<{ readonly level: string; readonly type: string }> = [];
  const prisma = {
    user: {
      findFirst: async () => ({ id: 'user-1', telegramId: 42n, isBlocked: false }),
    },
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
    ),
  };
}

describe('BulkUserOperationsService user deletion', () => {
  it('uses the shared deletion boundary and emits user.deleted only after success', async () => {
    const deleted: string[] = [];
    const { service, emitted } = buildService(async (userId) => {
      deleted.push(userId);
    });

    const result = await service.execute({
      userIds: ['user-1'],
      action: 'delete',
      adminId: 'admin-1',
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
      adminId: 'admin-1',
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
