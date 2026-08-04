import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TransactionStatus, TrialClaimStatus } from '@prisma/client';

import { findResumablePaidTrialClaim } from '../src/modules/subscriptions/services/trial-claim-ledger.util';

/**
 * A paid-trial draft holds a RESERVED claim, and the quota counter treats
 * RESERVED as spent. So an abandoned checkout — closed page, blocked redirect,
 * backed out of the card form — told the buyer their trial was already used,
 * while the attempt that "used" it was unpaid and still theirs to finish.
 *
 * `findResumablePaidTrialClaim` names that reservation so quoting can leave it
 * out. It must find ONLY a reservation the buyer can still act on: a RESERVED
 * claim whose transaction is still PENDING. A consumed trial, a released one,
 * or one whose payment already went terminal are all genuinely spent or gone,
 * and reporting them would re-open the trial to someone who used it.
 */

interface ClaimRow {
  readonly userId: string;
  readonly status: TrialClaimStatus;
  readonly transactionId: string | null;
}

interface TxRow {
  readonly id: string;
  readonly status: TransactionStatus;
}

function createClient(claims: readonly ClaimRow[], transactions: readonly TxRow[]): never {
  return {
    trialClaim: {
      findMany: async (args: { where: Record<string, unknown> }) =>
        claims
          .filter(
            (claim) =>
              claim.userId === args.where['userId'] &&
              claim.status === args.where['status'] &&
              claim.transactionId !== null,
          )
          .map((claim) => ({ transactionId: claim.transactionId })),
    },
    transaction: {
      findFirst: async (args: { where: { id: { in: readonly string[] }; status: string } }) =>
        transactions.find(
          (tx) => args.where.id.in.includes(tx.id) && tx.status === args.where.status,
        ) ?? null,
    },
  } as never;
}

const USER = 'user-1';

describe('findResumablePaidTrialClaim', () => {
  it('finds the reservation behind an unpaid, still-open attempt', async () => {
    const client = createClient(
      [{ userId: USER, status: TrialClaimStatus.RESERVED, transactionId: 'tx-1' }],
      [{ id: 'tx-1', status: TransactionStatus.PENDING }],
    );

    assert.deepEqual(await findResumablePaidTrialClaim(client, USER), { transactionId: 'tx-1' });
  });

  it('reports nothing for a trial that was actually consumed', async () => {
    // The genuine "already used" case — this one must keep blocking.
    const client = createClient(
      [{ userId: USER, status: TrialClaimStatus.CONSUMED, transactionId: 'tx-1' }],
      [{ id: 'tx-1', status: TransactionStatus.COMPLETED }],
    );

    assert.equal(await findResumablePaidTrialClaim(client, USER), null);
  });

  it('reports nothing once the reservation was released', async () => {
    // Already freed — the quota counter ignores it, so there is nothing to skip.
    const client = createClient(
      [{ userId: USER, status: TrialClaimStatus.RELEASED, transactionId: 'tx-1' }],
      [{ id: 'tx-1', status: TransactionStatus.CANCELED }],
    );

    assert.equal(await findResumablePaidTrialClaim(client, USER), null);
  });

  it('reports nothing when the reservation outlived a terminal payment', async () => {
    // A RESERVED claim on a CANCELED transaction is a leak, not something the
    // buyer can resume. It must be released, not quietly discounted here.
    const client = createClient(
      [{ userId: USER, status: TrialClaimStatus.RESERVED, transactionId: 'tx-1' }],
      [{ id: 'tx-1', status: TransactionStatus.CANCELED }],
    );

    assert.equal(await findResumablePaidTrialClaim(client, USER), null);
  });

  it('never reaches across users', async () => {
    const client = createClient(
      [{ userId: 'someone-else', status: TrialClaimStatus.RESERVED, transactionId: 'tx-1' }],
      [{ id: 'tx-1', status: TransactionStatus.PENDING }],
    );

    assert.equal(await findResumablePaidTrialClaim(client, USER), null);
  });

  it('reports nothing when the user holds no claims at all', async () => {
    assert.equal(await findResumablePaidTrialClaim(createClient([], []), USER), null);
  });

  it('picks the pending attempt when an older trial was already consumed', async () => {
    // Quota above one: a spent unit and a live attempt coexist, and only the
    // live one may be discounted.
    const client = createClient(
      [
        { userId: USER, status: TrialClaimStatus.CONSUMED, transactionId: 'tx-old' },
        { userId: USER, status: TrialClaimStatus.RESERVED, transactionId: 'tx-new' },
      ],
      [
        { id: 'tx-old', status: TransactionStatus.COMPLETED },
        { id: 'tx-new', status: TransactionStatus.PENDING },
      ],
    );

    assert.deepEqual(await findResumablePaidTrialClaim(client, USER), { transactionId: 'tx-new' });
  });
});
