import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  carryImportDomainKeys,
  IMPORT_DOMAIN_SNAPSHOT_KEYS,
} from '../src/modules/imports/utils/import-domain-snapshot.util';

/**
 * A plan writer's snapshot keeps the import's own keys of the one it replaces
 * — the key a re-import on another installation finds the row by among them —
 * and `planId` follows the new plan. Through «Назначить план», «Назначить план
 * импортированным», the importers and a real database:
 * `plan-writers-keep-import-keys-postgres.spec.ts`.
 */

/** A Remnashop import linked by the plan cloner, then renewed here. */
const STORED = {
  importedFrom: 'remnashop',
  importRecordId: 'import-1',
  sourceSubscriptionId: 41,
  originalPlanSnapshot: { id: 9, name: 'Donor Pro' },
  planId: 'plan-old',
  id: 'plan-old',
  name: 'Old',
  tag: 'OLD',
  trafficLimitStrategy: 'DAY',
  trafficLimit: 50,
  selectedDurationDays: 90,
  currency: 'RUB',
};

/** What «Назначить план» builds from the new plan. */
const NEXT = {
  id: 'plan-new',
  name: 'New',
  tag: 'NEW',
  type: 'BOTH',
  icon: null,
  trafficLimit: 100,
  deviceLimit: 3,
  trafficLimitStrategy: 'MONTH',
  internalSquads: [],
  externalSquad: null,
};

describe('carryImportDomainKeys', () => {
  it('carries the import’s keys, and nothing else of the snapshot it replaces', () => {
    assert.deepEqual(carryImportDomainKeys(STORED, NEXT), {
      ...NEXT,
      importedFrom: 'remnashop',
      importRecordId: 'import-1',
      sourceSubscriptionId: 41,
      originalPlanSnapshot: { id: 9, name: 'Donor Pro' },
      planId: 'plan-new',
    });
  });

  it('keeps `planId` in step with the new plan, never at the old one', () => {
    assert.equal((carryImportDomainKeys(STORED, NEXT) as Record<string, unknown>)['planId'], 'plan-new');
  });

  it('adds no `planId` to a row that had none', () => {
    const { planId: _none, ...unlinked } = STORED;
    assert.equal('planId' in (carryImportDomainKeys(unlinked, NEXT) as object), false);
  });

  it('lets the plan writer’s own statement of a key win', () => {
    const next = { ...NEXT, planId: 'plan-new', importRecordId: 'import-2' };
    const carried = carryImportDomainKeys(STORED, next) as Record<string, unknown>;
    assert.deepEqual([carried['planId'], carried['importRecordId']], ['plan-new', 'import-2']);
  });

  it('carries every listed key the stored snapshot has — and the list holds each importer’s', () => {
    const stored = Object.fromEntries(IMPORT_DOMAIN_SNAPSHOT_KEYS.map((key) => [key, `stored-${key}`]));
    const carried = carryImportDomainKeys(stored, NEXT) as Record<string, unknown>;
    for (const key of IMPORT_DOMAIN_SNAPSHOT_KEYS) assert.equal(carried[key], `stored-${key}`, key);
    // The one a re-import on another installation finds the row by, and the
    // one the 3x-ui importer does.
    for (const key of ['sourceSubscriptionId', 'importedFrom']) {
      assert.equal((IMPORT_DOMAIN_SNAPSHOT_KEYS as readonly string[]).includes(key), true, key);
    }
  });

  it('never carries a plan’s or a payment’s key under a name the importers share', () => {
    for (const key of ['tag', 'trafficLimitStrategy', 'currency', 'planId', 'id', 'name']) {
      assert.equal((IMPORT_DOMAIN_SNAPSHOT_KEYS as readonly string[]).includes(key), false, key);
    }
  });

  it('with no stored object, or a `next` that is not one, returns `next` as it is', () => {
    for (const stored of [null, undefined, [], 'text', 7]) {
      assert.deepEqual(carryImportDomainKeys(stored as never, NEXT), NEXT, JSON.stringify(stored));
    }
    assert.equal(carryImportDomainKeys(STORED, 'not-an-object'), 'not-an-object');
  });
});
