import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  COMBINED_RENEWAL_PLAN_NAMES_KEY,
  combinedRenewalPlanNames,
  planNameFromSnapshot,
  planNameMetadata,
  planNamesFromTransactionSnapshot,
  planNamesMetadata,
} from '../src/common/utils/plan-snapshot.util';

/**
 * WHAT THIS IS FOR. An operator's card for «Платёж получен» named the gateway,
 * the amount and «Тип покупки: Продление» — and not the plan. The first thing
 * anybody asks about a payment is what it was for, and the answer was in the
 * row all along.
 */
describe('название тарифа для карточек оператора', () => {
  it('reads the name the customer bought, from the snapshot', () => {
    assert.equal(planNameFromSnapshot({ id: 'p1', name: 'Базовый' }), 'Базовый');
  });

  it('answers null rather than a placeholder when there is no name', () => {
    // Each of these used to be a way to print «План: » with nothing after it,
    // or worse, «План: Plan».
    assert.equal(planNameFromSnapshot({}), null);
    assert.equal(planNameFromSnapshot({ name: '   ' }), null);
    assert.equal(planNameFromSnapshot({ name: 42 }), null);
    assert.equal(planNameFromSnapshot(null), null);
    assert.equal(planNameFromSnapshot('Базовый'), null);
  });

  it('adds NO key at all when nothing can be named', () => {
    // Not `{ planName: undefined }`: the metadata is persisted as JSON and the
    // card tests the key for truth, so an empty key is a line waiting to be
    // printed blank.
    assert.deepStrictEqual(planNamesMetadata([{}, null]), {});
    assert.deepStrictEqual(Object.keys(planNamesMetadata([null])), []);
  });

  it('names every plan a combined renewal paid for, once each, in order', () => {
    assert.deepStrictEqual(
      planNamesMetadata([{ name: 'Базовый' }, { name: 'Про' }, { name: 'Базовый' }]),
      { planName: 'Базовый, Про' },
    );
  });

  it('cuts a name that would run the card over', () => {
    const many = Array.from({ length: 40 }, (_, i) => `Тариф номер ${i}`);
    const { planName } = planNameMetadata(many);
    assert.ok(planName !== undefined);
    assert.ok(planName.length <= 120);
    assert.ok(planName.endsWith('…'));
  });

  describe('со стороны транзакции', () => {
    it('takes the plan of a single purchase straight off the invoice', () => {
      assert.deepStrictEqual(
        planNamesFromTransactionSnapshot({ id: 'p1', name: 'Базовый', snapshotVersion: 1 }),
        { planName: 'Базовый' },
      );
    });

    it('takes a combined renewal’s plans from the names its draft wrote down', () => {
      // The marker is not a plan and has no `name`; every card raised later —
      // failed, expired, refunded — holds the transaction and not its items.
      const marker = {
        combinedRenewal: true,
        snapshotVersion: 1,
        itemCount: 2,
        [COMBINED_RENEWAL_PLAN_NAMES_KEY]: combinedRenewalPlanNames([
          { name: 'Базовый' },
          { name: 'Про' },
          { name: 'Базовый' },
        ]),
      };
      assert.deepStrictEqual(marker[COMBINED_RENEWAL_PLAN_NAMES_KEY], ['Базовый', 'Про']);
      assert.deepStrictEqual(planNamesFromTransactionSnapshot(marker), {
        planName: 'Базовый, Про',
      });
    });

    it('stays silent for a combined draft created before the names were written', () => {
      // In-flight at the moment of the update: nothing invents a name from an id.
      assert.deepStrictEqual(
        planNamesFromTransactionSnapshot({ combinedRenewal: true, snapshotVersion: 1, itemCount: 1 }),
        {},
      );
    });
  });
});
