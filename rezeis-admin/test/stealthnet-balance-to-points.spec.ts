import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { balanceToPoints } from '../src/modules/imports/services/stealthnet-importer.service';

describe('balanceToPoints (STEALTHNET wallet → loyalty points)', () => {
  it('converts whole major units 1:1', () => {
    assert.equal(balanceToPoints(100, 1), 100);
    assert.equal(balanceToPoints(20, 1), 20);
  });

  it('rounds kopecks half-up then applies rate', () => {
    assert.equal(balanceToPoints(10.004, 1), 10);
    // 10.50 → 1050 kopecks → 11 points at rate 1
    assert.equal(balanceToPoints(10.5, 1), 11);
    assert.equal(balanceToPoints(10.49, 1), 10);
    assert.equal(balanceToPoints(10.5, 2), 21);
    // half-kopeck edge with rate 100: 1.005 → 101 kopecks → 101 points
    assert.equal(balanceToPoints(1.005, 100), 101);
    assert.equal(balanceToPoints(1.004, 100), 100);
  });

  it('rejects non-positive / invalid inputs', () => {
    assert.equal(balanceToPoints(0, 1), 0);
    assert.equal(balanceToPoints(-5, 1), 0);
    assert.equal(balanceToPoints(100, 0), 0);
    assert.equal(balanceToPoints(Number.NaN, 1), 0);
  });
});
