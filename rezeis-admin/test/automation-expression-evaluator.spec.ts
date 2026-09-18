import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { evaluateCondition } from '../src/modules/automations/utils/expression-evaluator';

/**
 * A rule's conditions, and the one shape of "no conditions" that did not count
 * ════════════════════════════════════════════════════════════════════════════
 *
 * `null` meant "always match". `{}` — which the SPA reads as no conditions in
 * the trigger map and the run dialog — fell into the malformed-expression
 * branch (an object that is not exactly one operator) and answered false, so a
 * rule saved with it was SKIPPED on every run. The executor's side of the same
 * defect is pinned in `automation-manual-run.spec.ts`.
 */

const PAYLOAD = { userId: 'user-9', score: 80, metadata: { severity: 'HIGH' } };

describe('conditions that filter nothing', () => {
  it('lets `{}` at the top match every payload', () => {
    assert.equal(evaluateCondition({}, PAYLOAD), true);
    assert.equal(evaluateCondition({}, {}), true);
  });

  it('still lets null and undefined match every payload', () => {
    assert.equal(evaluateCondition(null, PAYLOAD), true);
    assert.equal(evaluateCondition(undefined, PAYLOAD), true);
  });
});

describe('conditions that do filter', () => {
  it('still evaluates a real expression, both ways', () => {
    // The control for the cases above: an object with an operator is not waved
    // through with the empty one.
    assert.equal(evaluateCondition({ '==': ['$userId', 'user-9'] }, PAYLOAD), true);
    assert.equal(evaluateCondition({ '==': ['$userId', 'someone-else'] }, PAYLOAD), false);
    assert.equal(evaluateCondition({ '>': ['$score', 90] }, PAYLOAD), false);
  });

  it('keeps an object with more than one operator malformed, and false', () => {
    assert.equal(
      evaluateCondition({ '==': ['$userId', 'user-9'], '>': ['$score', 1] }, PAYLOAD),
      false,
    );
  });

  it('keeps `{}` NESTED inside an operator as the malformed operand it always was', () => {
    // Only the top level changed. Inside `and` an empty object is still false,
    // so it cannot widen a hand-written expression into "always".
    assert.equal(evaluateCondition({ and: [{}] }, PAYLOAD), false);
    assert.equal(evaluateCondition({ and: [{ '==': ['$userId', 'user-9'] }, {}] }, PAYLOAD), false);
    assert.equal(evaluateCondition({ or: [{}, { '==': ['$userId', 'someone-else'] }] }, PAYLOAD), false);
    assert.equal(evaluateCondition({ not: [{}] }, PAYLOAD), true);
  });
});
