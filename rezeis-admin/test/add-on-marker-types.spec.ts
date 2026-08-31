import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AddOnType, TransactionStatus } from '@prisma/client';

import { isAddOnTransaction } from '../src/modules/payments/services/payment-subscription-mutation.service';

/**
 * Which paid transactions are recognised as add-on purchases.
 *
 * This is the cheapest test in the repository and it guards the most expensive
 * defect the reset add-on shipped with: `RESET_TRAFFIC` was missing from the
 * allow-list, so a captured payment was not seen as an add-on at all. It fell
 * through to the renewal path, threw "Purchased plan not found", and the
 * webhook job retried it for ever while the stranded-fulfilment sweeper skipped
 * it for the same reason. Money taken, traffic never reset, no self-healing.
 *
 * Enumerating `AddOnType` rather than listing types by hand is the point: a
 * fourth member added tomorrow fails HERE, in one line, instead of in a
 * customer's payment.
 */

function addOnTransaction(addOnType: string) {
  return {
    id: 't-1',
    status: TransactionStatus.COMPLETED,
    type: 'ADDITIONAL',
    planSnapshot: {
      snapshotSource: 'ADDON_PURCHASE',
      addOnId: 'a-1',
      addOnType,
      addOnValue: 1,
      targetSubscriptionId: 'sub-1',
    },
  } as never;
}

describe('recognising an add-on purchase', () => {
  it('recognises EVERY configured add-on type', () => {
    for (const type of Object.values(AddOnType)) {
      assert.equal(
        isAddOnTransaction(addOnTransaction(type)),
        true,
        `${type} is not recognised as an add-on purchase — its fulfilment is unreachable ` +
          'and a captured payment for it never completes',
      );
    }
  });

  it('does not mistake a renewal for one', () => {
    assert.equal(
      isAddOnTransaction({
        id: 't-2',
        status: TransactionStatus.COMPLETED,
        type: 'RENEWAL',
        planSnapshot: { id: 'plan-1', name: 'Base' },
      } as never),
      false,
    );
  });

  it('does not accept a marker whose type is not an add-on type at all', () => {
    assert.equal(isAddOnTransaction(addOnTransaction('SOMETHING_ELSE')), false);
  });
});
