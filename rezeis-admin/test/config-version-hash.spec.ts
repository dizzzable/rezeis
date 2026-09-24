import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { canonicalJson, configVersionOf } from '../src/modules/bot-config/config-versions/config-version-hash';

/**
 * The version of a settings group — the panel's half
 * ═══════════════════════════════════════════════════
 * The cabinet computes the same version from the copy it holds
 * (`reiwa/src/infrastructure/config-versions/config-version.ts`) and compares.
 * The two repositories share no package, so the strongest link available is
 * the same vector pinned on both sides: `reiwa/test/infrastructure/config-versions/config-version.test.ts`
 * asserts this very string. Change either implementation and its own vector
 * goes red — before the two can disagree in production, where a disagreement
 * reads as "every group changed" on every poll.
 */
const VECTOR = { b: [1, 'two', { d: null, c: true }], a: 'x', n: 1.5, u: 'я' };
const VECTOR_VERSION = '3cae81b052f3c76ccc55eed3869b39d9';

describe('configVersionOf — the panel side of the version the cabinet compares', () => {
  it('matches the vector the cabinet pins', () => {
    assert.equal(configVersionOf(VECTOR), VECTOR_VERSION);
  });

  it('writes objects with sorted keys and arrays in their order', () => {
    assert.equal(canonicalJson(VECTOR), '{"a":"x","b":[1,"two",{"c":true,"d":null}],"n":1.5,"u":"я"}');
  });

  it('hashes what the wire carries, not the objects a service built', () => {
    // The route answers through `res.json`: Dates as ISO strings, `undefined`
    // gone. The cabinet hashes what it parsed; so must this.
    const at = new Date('2026-09-24T12:00:00.000Z');
    assert.equal(
      configVersionOf({ updatedAt: at, note: undefined, value: 1 }),
      configVersionOf({ value: 1, updatedAt: '2026-09-24T12:00:00.000Z' }),
    );
  });

  it('does not see key order, and does see array order', () => {
    assert.equal(configVersionOf({ a: 1, b: 2 }), configVersionOf({ b: 2, a: 1 }));
    assert.notEqual(configVersionOf({ buttons: ['a', 'b'] }), configVersionOf({ buttons: ['b', 'a'] }));
  });

  it('gives 32 hex digits, the shape the poll accepts back', () => {
    assert.match(configVersionOf(VECTOR), /^[0-9a-f]{32}$/);
    assert.equal(configVersionOf(undefined), configVersionOf(null));
  });
});
