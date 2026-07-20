import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { balanceToPoints } from '../src/modules/imports/services/stealthnet-importer.service';

describe('balanceToPoints (STEALTHNET wallet → loyalty points)', () => {
  it('converts whole major units 1:1', () => {
    assert.equal(balanceToPoints(100, 1), 100);
    assert.equal(balanceToPoints(20, 1), 20);
  });

  it('rounds kopecks half-up to 2 decimals before rate', () => {
    // 10.004 → 10.00 major → 10 pts
    assert.equal(balanceToPoints(10.004, 1), 10);
    // 10.005 → 10.01 major → 10 pts (half-up on *100: 1000.5 → 1001 → 10.01)
    assert.equal(balanceToPoints(10.005, 1), 10);
    // classic: 10.50 → 11 when rate 1? No: 10.50 major * 1 = 10.5 → Math.round → 11
    assert.equal(balanceToPoints(10.5, 1), 11);
    assert.equal(balanceToPoints(10.49, 1), 10);
    assert.equal(balanceToPoints(10.5, 2), 21); // 10.50 * 2 = 21
  });

  it('rejects non-positive / invalid inputs', () => {
    assert.equal(balanceToPoints(0, 1), 0);
    assert.equal(balanceToPoints(-5, 1), 0);
    assert.equal(balanceToPoints(100, 0), 0);
    assert.equal(balanceToPoints(Number.NaN, 1), 0);
  });
});
