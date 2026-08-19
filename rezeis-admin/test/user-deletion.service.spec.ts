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

/** A stored row, as opposed to the projection the snapshot selects out of it. */
interface SubscriptionTableRow extends ProfileSnapshotRow {
  readonly userId: string;
  readonly configUrl: string | null;
}

type WhereNode = Record<string, unknown>;

/**
 * Evaluates the snapshot's `where` against a row.
 *
 * Deliberately a real filter and not a canned answer. Every other fake in this
 * file returns a fixed list, which means the SELECTION is unobservable: a test
 * can hand back a row the production query would never return, and the
 * assertion about what happens to that row proves nothing about production.
 * The one thing under test here is which rows survive the `where`, so the
 * `where` has to run.
 *
 * Supports only what the query under test uses — equality, `not`, and `OR`.
 * Anything else throws rather than silently matching, so a future widening of
 * the query cannot quietly turn this fake back into a canned answer.
 */
function matchesWhere(row: Record<string, unknown>, where: WhereNode): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === 'OR') {
      return (condition as WhereNode[]).some((branch) => matchesWhere(row, branch));
    }
    if (key === 'AND') {
      return (condition as WhereNode[]).every((branch) => matchesWhere(row, branch));
    }
    const value = row[key];
    if (condition !== null && typeof condition === 'object') {
      if ('not' in (condition as Record<string, unknown>)) {
        return value !== (condition as { not: unknown }).not;
      }
      throw new Error(`unsupported filter on ${key}: ${JSON.stringify(condition)}`);
    }
    return value === condition;
  });
}

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
  /**
   * When set, `findMany` FILTERS this table with the real `where` instead of
   * returning `profileSnapshot` unread. Opt-in so the existing tests, which are
   * about what happens AFTER the selection, keep their canned rows.
   */
  subscriptionTable: readonly SubscriptionTableRow[] | null;
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
    subscriptionTable: null,
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
      findMany: async (args: { where: WhereNode }) => {
        state.order.push('snapshot:profiles');
        if (state.subscriptionTable === null) return state.profileSnapshot;
        return state.subscriptionTable
          .filter((row) => matchesWhere(row as unknown as Record<string, unknown>, args.where))
          .map(({ userId: _userId, ...selected }) => selected);
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

  it('snapshots a damaged panel link so the orphaned profile is reported, not lost', async () => {
    // THE SELECTION IS THE SUBJECT, which is why this test filters for real
    // while the rest of the file hands back canned rows.
    //
    // The create/update decoder used to cast an undecoded panel body into the
    // typed shape. On 3.x that left `uuid` and `id` undefined — Prisma skips
    // undefined columns — while the panel username and the subscription URL,
    // which came from arguments, landed. `sub-damaged` is that exact row: a
    // LIVE panel profile whose only surviving evidence is two columns.
    //
    // With the snapshot keyed on `remnawaveId IS NOT NULL` such a row never
    // entered the snapshot at all, so deleting the user destroyed the local
    // rows and left the profile running with nothing pointing at it — not
    // billed, not swept, and no longer repairable, because the repair selects
    // on the row that has just been deleted.
    const { service, state } = buildService({
      subscriptionTable: [
        {
          userId: 'user-1',
          id: 'sub-healthy',
          remnawaveId: 'rw-1',
          remnawavePanelId: 4471,
          remnawavePanelUsername: 'rz_bob_1',
          configUrl: 'https://sub.example.test/api/sub/aaa',
        },
        {
          userId: 'user-1',
          id: 'sub-damaged',
          remnawaveId: null,
          remnawavePanelId: null,
          remnawavePanelUsername: 'rz_bob_2',
          configUrl: 'https://sub.example.test/api/sub/bbb',
        },
        // Never provisioned: the ordinary unlinked row. It must stay OUT, or
        // every user deletion emits a warning nobody can act on and operators
        // learn to ignore the one that matters.
        {
          userId: 'user-1',
          id: 'sub-never-provisioned',
          remnawaveId: null,
          remnawavePanelId: null,
          remnawavePanelUsername: null,
          configUrl: null,
        },
        // Another user's live profile: the `userId` predicate still holds.
        {
          userId: 'user-2',
          id: 'sub-someone-else',
          remnawaveId: 'rw-2',
          remnawavePanelId: 5150,
          remnawavePanelUsername: 'rz_carol_1',
          configUrl: 'https://sub.example.test/api/sub/ccc',
        },
      ],
    });

    await service.deleteUser('user-1');

    // The addressable profile is still deleted, and only that one.
    assert.deepStrictEqual(
      state.panelRefs.map((ref) => (ref as StoredPanelIdentity).remnawaveId),
      ['rw-1'],
    );
    // The damaged one is reported — by id, and by the panel username, which is
    // the only handle an operator has left for finding it in the panel.
    assert.equal(state.loggedWarnings.length, 1);
    assert.match(state.loggedWarnings[0] ?? '', /sub-damaged/);
    assert.match(state.loggedWarnings[0] ?? '', /rz_bob_2/);
    assert.doesNotMatch(state.loggedWarnings[0] ?? '', /sub-never-provisioned/);
  });

  it('warns instead of silently skipping a snapshot with no panel identity', async () => {
    // The local account is already committed away, so a profile skipped here is
    // orphaned upstream: no row points at it and no sweep will look for it. The
    // skip is correct — there is nothing to address — but it must be visible.
    //
    // The row here is CANNED: this test is about what the loop does with a
    // null-identity snapshot, not about whether such a row can reach it. That
    // second question — which the snapshot's `where` answers, and answered
    // "never" until it was widened — is pinned by the test above.
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
