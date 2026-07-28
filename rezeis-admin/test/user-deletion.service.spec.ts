import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { EVENT_TYPES } from '../src/common/services/system-events.service';
import { USER_EVENT_WHITELIST } from '../src/modules/realtime/interfaces/user-realtime-event.interface';
import {
  USER_DELETE_PROTECTED_HISTORY_CODE,
  UserDeletionService,
} from '../src/modules/users/services/user-deletion.service';

interface FakeState {
  readonly order: string[];
  transactionCount: number;
  promocodeActivationCount: number;
  referralPointsExchangeCount: number;
  referralRewardCount: number;
  partnerTransactionCount: number;
  partnerWithdrawalCount: number;
  deleteError: unknown;
  panelError: unknown;
  transactionError: unknown;
}

function buildService(overrides: Partial<FakeState> = {}) {
  const state: FakeState = {
    order: [],
    transactionCount: 0,
    promocodeActivationCount: 0,
    referralPointsExchangeCount: 0,
    referralRewardCount: 0,
    partnerTransactionCount: 0,
    partnerWithdrawalCount: 0,
    deleteError: null,
    panelError: null,
    transactionError: null,
    ...overrides,
  };

  const transactionClient = {
    transaction: {
      count: async () => {
        state.order.push('count:transaction');
        return state.transactionCount;
      },
    },
    promocodeActivation: {
      count: async () => {
        state.order.push('count:promocode');
        return state.promocodeActivationCount;
      },
    },
    referralPointsExchange: {
      count: async () => {
        state.order.push('count:referral-points-exchange');
        return state.referralPointsExchangeCount;
      },
    },
    referralReward: {
      count: async () => {
        state.order.push('count:referral-reward');
        return state.referralRewardCount;
      },
    },
    partnerTransaction: {
      count: async () => {
        state.order.push('count:partner-transaction');
        return state.partnerTransactionCount;
      },
    },
    partnerWithdrawal: {
      count: async () => {
        state.order.push('count:partner-withdrawal');
        return state.partnerWithdrawalCount;
      },
    },
    subscription: {
      findMany: async () => {
        state.order.push('snapshot:profiles');
        return [{ id: 'sub-1', remnawaveId: 'rw-1' }];
      },
    },
    user: {
      delete: async () => {
        state.order.push('delete:user');
        if (state.deleteError) throw state.deleteError;
        return { id: 'user-1' };
      },
    },
  };

  const prisma = {
    $transaction: async (
      operation: (tx: typeof transactionClient) => Promise<unknown>,
      options: { isolationLevel: Prisma.TransactionIsolationLevel },
    ) => {
      state.order.push(`transaction:${options.isolationLevel}`);
      if (state.transactionError) {
        const error = state.transactionError;
        state.transactionError = null;
        throw error;
      }
      return operation(transactionClient);
    },
  };

  const remnawave = {
    deletePanelUser: async (id: string) => {
      state.order.push(`delete:panel:${id}`);
      if (state.panelError) throw state.panelError;
    },
  };

  return {
    state,
    service: new UserDeletionService(prisma as never, remnawave as never),
  };
}

function prismaError(code: string): { readonly name: string; readonly code: string } {
  return { name: 'PrismaClientKnownRequestError', code };
}

async function assertProtectedHistoryConflict(operation: () => Promise<unknown>): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert.equal(error instanceof ConflictException, true);
    assert.deepStrictEqual((error as ConflictException).getResponse(), {
      code: USER_DELETE_PROTECTED_HISTORY_CODE,
      message:
        'This user has protected payment, partner-ledger, or reward history and cannot be permanently deleted. Block the account instead; audit records must be preserved.',
    });
    return true;
  });
}

describe('UserDeletionService', () => {
  it('refuses to delete a paid user before touching the database account or Remnawave', async () => {
    const { service, state } = buildService({ transactionCount: 1 });

    await assertProtectedHistoryConflict(() => service.deleteUser('user-1'));

    assert.deepStrictEqual(state.order, [
      `transaction:${Prisma.TransactionIsolationLevel.Serializable}`,
      'count:transaction',
      'count:promocode',
      'count:referral-points-exchange',
      'count:referral-reward',
      'count:partner-transaction',
      'count:partner-withdrawal',
    ]);
  });

  it('preserves promocode and referral reward audit records too', async () => {
    const promocode = buildService({ promocodeActivationCount: 1 });
    await assertProtectedHistoryConflict(() => promocode.service.deleteUser('user-1'));
    assert.equal(promocode.state.order.includes('delete:user'), false);

    const reward = buildService({ referralRewardCount: 1 });
    await assertProtectedHistoryConflict(() => reward.service.deleteUser('user-1'));
    assert.equal(reward.state.order.includes('delete:user'), false);
  });

  it('preserves referral point exchanges and both sides of the partner money ledger', async () => {
    const exchange = buildService({ referralPointsExchangeCount: 1 });
    await assertProtectedHistoryConflict(() => exchange.service.deleteUser('user-1'));
    assert.equal(exchange.state.order.includes('delete:user'), false);

    const earning = buildService({ partnerTransactionCount: 1 });
    await assertProtectedHistoryConflict(() => earning.service.deleteUser('user-1'));
    assert.equal(earning.state.order.includes('delete:user'), false);

    const withdrawal = buildService({ partnerWithdrawalCount: 1 });
    await assertProtectedHistoryConflict(() => withdrawal.service.deleteUser('user-1'));
    assert.equal(withdrawal.state.order.includes('delete:user'), false);
  });

  it('deletes a clean local account before its snapshotted Remnawave profile', async () => {
    const { service, state } = buildService();

    await service.deleteUser('user-1');

    assert.deepStrictEqual(state.order, [
      `transaction:${Prisma.TransactionIsolationLevel.Serializable}`,
      'count:transaction',
      'count:promocode',
      'count:referral-points-exchange',
      'count:referral-reward',
      'count:partner-transaction',
      'count:partner-withdrawal',
      'snapshot:profiles',
      'delete:user',
      'delete:panel:rw-1',
    ]);
  });

  it('keeps a committed local deletion successful when Remnawave cleanup is temporarily unavailable', async () => {
    const { service, state } = buildService({ panelError: new Error('panel unavailable') });

    await assert.doesNotReject(() => service.deleteUser('user-1'));

    assert.equal(state.order.includes('delete:user'), true);
    assert.equal(state.order[state.order.length - 1], 'delete:panel:rw-1');
  });

  it('maps a nested foreign-key restriction to the same safe conflict and leaves Remnawave intact', async () => {
    const { service, state } = buildService({ deleteError: prismaError('P2003') });

    await assertProtectedHistoryConflict(() => service.deleteUser('user-1'));

    assert.equal(state.order.includes('delete:panel:rw-1'), false);
  });

  it('maps a concurrent already-deleted row to a stable not-found response', async () => {
    const { service, state } = buildService({ deleteError: prismaError('P2025') });

    await assert.rejects(
      () => service.deleteUser('user-1'),
      (error: unknown) =>
        error instanceof NotFoundException && error.message === 'User not found',
    );

    assert.equal(state.order.includes('delete:panel:rw-1'), false);
  });

  it('retries a serializable write conflict without duplicating external cleanup', async () => {
    const { service, state } = buildService({ transactionError: prismaError('P2034') });

    await service.deleteUser('user-1');

    assert.equal(
      state.order.filter((entry) => entry === `transaction:${Prisma.TransactionIsolationLevel.Serializable}`).length,
      2,
    );
    assert.equal(state.order.filter((entry) => entry === 'delete:panel:rw-1').length, 1);
  });

  it('projects user.deleted only to that user and strips admin/deleted-user metadata', () => {
    const projection = USER_EVENT_WHITELIST[EVENT_TYPES.USER_DELETED];
    assert.notEqual(projection, undefined);
    assert.equal(projection?.category, 'NOTIFICATION');
    assert.equal(projection?.severity, 'WARNING');
    assert.equal(projection?.message, 'Account deleted');

    const metadata = {
      userId: 'user-1',
      telegramId: '42',
      adminId: 'must-not-leak',
      email: 'must-not-leak@example.test',
    };
    assert.deepStrictEqual(
      projection?.project(metadata, { userId: 'user-1', telegramId: null }),
      {},
    );
    assert.equal(
      projection?.project(metadata, { userId: 'other-user', telegramId: null }),
      null,
    );
  });
});
