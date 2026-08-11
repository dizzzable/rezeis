import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { EVENT_TYPES } from '../src/common/services/system-events.service';
import { USER_EVENT_WHITELIST } from '../src/modules/realtime/interfaces/user-realtime-event.interface';
import {
  panelUserAddress,
  type StoredPanelIdentity,
} from '../src/modules/remnawave/services/panel-user-address';
import {
  USER_DELETE_PROTECTED_HISTORY_CODE,
  UserDeletionService,
} from '../src/modules/users/services/user-deletion.service';

/**
 * A subscription row as the deletion snapshot selects it. Both supplementary
 * identity columns are present because a real row carries them on every
 * supported panel version — omitting them here would let a snapshot that drops
 * them look complete while leaving the panel profile unnameable on 3.x.
 */
interface ProfileSnapshotRow {
  readonly id: string;
  readonly remnawaveId: string | null;
  readonly remnawavePanelId: number | null;
  readonly remnawavePanelUsername: string | null;
}

const DEFAULT_PROFILE_SNAPSHOT: readonly ProfileSnapshotRow[] = [
  { id: 'sub-1', remnawaveId: 'rw-1', remnawavePanelId: 4471, remnawavePanelUsername: 'rz_bob_1' },
];

interface FakeState {
  readonly order: string[];
  transactionCount: number;
  promocodeActivationCount: number;
  referralPointsExchangeCount: number;
  referralRewardCount: number;
  partnerTransactionCount: number;
  partnerWithdrawalCount: number;
  trialClaimCount: number;
  deleteError: unknown;
  panelError: unknown;
  transactionError: unknown;
  profileSnapshot: readonly ProfileSnapshotRow[];
  readonly panelRefs: unknown[];
  readonly loggedWarnings: string[];
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
    trialClaimCount: 0,
    deleteError: null,
    panelError: null,
    transactionError: null,
    profileSnapshot: DEFAULT_PROFILE_SNAPSHOT,
    panelRefs: [],
    loggedWarnings: [],
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
    trialClaim: {
      count: async () => {
        state.order.push('count:trial-claim');
        return state.trialClaimCount;
      },
    },
    subscription: {
      findMany: async () => {
        state.order.push('snapshot:profiles');
        return state.profileSnapshot;
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
    deletePanelUser: async (ref: StoredPanelIdentity) => {
      state.panelRefs.push(ref);
      state.order.push(`delete:panel:${ref.remnawaveId}`);
      if (state.panelError) throw state.panelError;
    },
  };

  const service = new UserDeletionService(prisma as never, remnawave as never);
  const logger = (service as unknown as { logger: { warn: (message: string) => void } }).logger;
  logger.warn = (message: string) => {
    state.loggedWarnings.push(message);
  };
  return { state, service };
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
      'count:trial-claim',
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

  it('preserves durable trial-claim history', async () => {
    const { service, state } = buildService({ trialClaimCount: 1 });

    await assertProtectedHistoryConflict(() => service.deleteUser('user-1'));

    assert.equal(state.order.includes('delete:user'), false);
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
      'count:trial-claim',
      'snapshot:profiles',
      'delete:user',
      'delete:panel:rw-1',
    ]);
  });

  it('addresses the panel by the recorded numeric id when remnawaveId is a stale 2.x uuid', async () => {
    // Created on 2.x, panel since upgraded to 3.x, nothing re-synced. The
    // stored string names nothing there; the recorded id is the only route to
    // the profile, and this is the last chance to use it — the local rows are
    // already gone.
    const staleUuid = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
    const { service, state } = buildService({
      profileSnapshot: [
        {
          id: 'sub-upgraded',
          remnawaveId: staleUuid,
          remnawavePanelId: 4471,
          remnawavePanelUsername: 'rz_bob_1',
        },
      ],
    });

    await service.deleteUser('user-1');

    assert.equal(state.panelRefs.length, 1);
    // Through the real addressing function: what matters is that a 3.x path can
    // be BUILT from what the service handed over.
    assert.deepStrictEqual(panelUserAddress(state.panelRefs[0] as StoredPanelIdentity, 'id'), {
      kind: 'ready',
      segment: '4471',
    });
    // Counter-check: the stored string alone — what this call site used to pass
    // — names nothing on that panel, so the assertion above is not free.
    assert.equal(
      panelUserAddress({ remnawaveId: staleUuid, panelId: null, panelUsername: null }, 'id').kind,
      'impossible',
    );
  });

  it('warns instead of silently skipping a snapshot with no panel identity', async () => {
    // The local account is already committed away, so a profile skipped here is
    // orphaned upstream: no row points at it and no sweep will look for it. The
    // skip is correct — there is nothing to address — but it must be visible.
    const { service, state } = buildService({
      profileSnapshot: [
        { id: 'sub-unlinked', remnawaveId: null, remnawavePanelId: null, remnawavePanelUsername: null },
      ],
    });

    await service.deleteUser('user-1');

    assert.equal(state.order.includes('delete:user'), true);
    assert.equal(
      state.order.some((entry) => entry.startsWith('delete:panel:')),
      false,
    );
    assert.equal(state.loggedWarnings.length, 1);
    // The subscription id is the whole point of the line — without it an
    // operator cannot tell which profile to go and look for.
    assert.match(state.loggedWarnings[0] ?? '', /sub-unlinked/);
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
