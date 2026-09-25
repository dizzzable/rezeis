import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveAddOnRolloutFlags } from '../src/modules/add-on-entitlements/add-on-rollout.config';
import { SubscriptionTermHooksService } from '../src/modules/add-on-entitlements/services/subscription-term-hooks.service';

/**
 * A subscription created inside a caller's transaction enters the term model
 * while stage 1 is on — and the switches it asks are the snapshot the caller
 * read BEFORE opening that transaction (review R2b-07): read inside it, a cold
 * settings cache needs a second pool connection while this one is held.
 */
function build(stored: { durableAccounting?: boolean }) {
  const calls = { reads: 0, entered: [] as string[] };
  const switches = {
    flags: async () => {
      calls.reads += 1;
      return resolveAddOnRolloutFlags(stored, {});
    },
  };
  const cutover = {
    ensureTermInTransaction: async (_tx: unknown, subscriptionId: string) => {
      calls.entered.push(subscriptionId);
      return { outcome: 'CREATED', termId: 'term-1' };
    },
  };
  const hooks = new SubscriptionTermHooksService({} as never, {} as never, cutover as never, switches as never);
  return { hooks, calls };
}

describe('SubscriptionTermHooksService.enterNewSubscriptionInTransaction', () => {
  it('takes the caller\'s snapshot and reads nothing inside the transaction', async () => {
    const { hooks, calls } = build({ durableAccounting: false });
    const snapshot = resolveAddOnRolloutFlags({ durableAccounting: true }, {});

    const entered = await hooks.enterNewSubscriptionInTransaction({} as never, 'sub-1', snapshot);

    assert.equal(calls.reads, 0, 'no read of the switches inside the transaction');
    assert.deepEqual(calls.entered, ['sub-1'], 'the snapshot, not the switches now, decides');
    assert.equal(entered?.outcome, 'CREATED');
  });

  it('stays out of the model when the snapshot has stage 1 off', async () => {
    const { hooks, calls } = build({ durableAccounting: true });

    const entered = await hooks.enterNewSubscriptionInTransaction(
      {} as never,
      'sub-1',
      resolveAddOnRolloutFlags({ durableAccounting: false }, {}),
    );

    assert.equal(entered, null);
    assert.deepEqual(calls.entered, []);
    assert.equal(calls.reads, 0);
  });

  it('reads the switches itself only for a caller that passes no snapshot', async () => {
    const { hooks, calls } = build({ durableAccounting: true });

    await hooks.enterNewSubscriptionInTransaction({} as never, 'sub-1');

    assert.equal(calls.reads, 1);
    assert.deepEqual(calls.entered, ['sub-1']);
  });

  it('readFlags reads through the switches, for a caller to do before its transaction', async () => {
    const { hooks, calls } = build({ durableAccounting: false });

    const flags = await hooks.readFlags();

    assert.equal(calls.reads, 1);
    assert.equal(flags.entitlementShadow, false);
  });
});
