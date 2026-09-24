import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { reimportPlanSnapshot } from '../src/modules/imports/utils/reimport-plan-snapshot.util';

/**
 * The snapshot a backup importer writes: the stored one with the backup's own
 * keys merged in, and the donor's `tag` / reset strategy only while no plan is
 * named. Through the real importers and a database:
 * `backup-reimport-plan-snapshot-postgres.spec.ts`.
 */

/** What «Назначить план» writes, plus a renewal paid here. */
const ASSIGNED = {
  id: 'plan-pro',
  name: 'Pro',
  tag: 'PRO',
  type: 'BOTH',
  icon: 'star',
  trafficLimit: 100,
  deviceLimit: 3,
  trafficLimitStrategy: 'MONTH',
  internalSquads: ['squad-pro'],
  externalSquad: null,
  selectedDurationDays: 90,
  currency: 'RUB',
};

const DONOR = {
  own: {
    importedFrom: 'remnashop',
    importRecordId: 'import-2',
    sourceSubscriptionId: 41,
    originalPlanSnapshot: { id: 9, name: 'Donor Pro' },
  },
  planFacts: { tag: 'DONOR', trafficLimitStrategy: 'DAY', currency: 'USD' },
};

describe('reimportPlanSnapshot', () => {
  it('is the backup’s facts alone for a new row', () => {
    assert.deepEqual(reimportPlanSnapshot(undefined, DONOR), { ...DONOR.planFacts, ...DONOR.own });
  });

  it('keeps every key of a plan an operator assigned, and refreshes only the import’s own', () => {
    const stored = { ...ASSIGNED, importedFrom: 'remnashop', importRecordId: 'import-1', sourceSubscriptionId: 41 };
    assert.deepEqual(reimportPlanSnapshot(stored, DONOR), { ...ASSIGNED, ...DONOR.own });
  });

  it('reads `planId` alone as a plan too: a row an older re-import stripped keeps its tag and strategy', () => {
    const stripped = { planId: 'plan-pro', importedFrom: 'remnashop', tag: 'PRO', trafficLimitStrategy: 'MONTH' };
    assert.deepEqual(reimportPlanSnapshot(stripped, DONOR), {
      planId: 'plan-pro',
      tag: 'PRO',
      trafficLimitStrategy: 'MONTH',
      ...DONOR.own,
    });
  });

  it('writes the donor’s tag, strategy and currency over a never-assigned import, and keeps what it does not state', () => {
    const imported = {
      importedFrom: 'remnashop',
      importRecordId: 'import-1',
      tag: 'OLD',
      trafficLimitStrategy: 'WEEK',
      currency: 'EUR',
      selectedDurationDays: 90,
    };
    assert.deepEqual(reimportPlanSnapshot(imported, DONOR), {
      selectedDurationDays: 90,
      ...DONOR.planFacts,
      ...DONOR.own,
    });
  });

  it('keeps a stored import key the backup does not restate', () => {
    const { importRecordId: _omitted, ...withoutRecord } = DONOR.own;
    const stored = { importedFrom: 'remnashop', importRecordId: 'import-1' };
    assert.equal(reimportPlanSnapshot(stored, { own: withoutRecord })['importRecordId'], 'import-1');
  });

  it('does not take an empty `id` for a plan', () => {
    assert.equal(reimportPlanSnapshot({ id: '', tag: 'OLD' }, DONOR)['tag'], 'DONOR');
  });

  it('reads a stored value that is not an object as no snapshot', () => {
    for (const stored of [null, [], 'text', 7]) {
      assert.deepEqual(reimportPlanSnapshot(stored, DONOR), { ...DONOR.planFacts, ...DONOR.own }, JSON.stringify(stored));
    }
  });
});
