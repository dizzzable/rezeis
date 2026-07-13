import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  LimitArithmeticError,
  addDeviceLimit,
  addTrafficLimit,
} from '../src/modules/add-on-entitlements/domain/subscription-limit';

describe('subscription limit arithmetic', () => {
  it('keeps unlimited absorbing and never performs arithmetic on it', () => {
    assert.equal(addTrafficLimit(null, [10n, (1n << 63n) - 1n, 1n]), null);
    assert.equal(addDeviceLimit(null, [1, 2_147_483_647, 1]), null);
  });

  it('adds finite traffic contributions exactly as bigint values', () => {
    assert.equal(addTrafficLimit(1_000_000_000_000n, [2_000_000_000n, 3n]), 1_002_000_000_003n);
  });

  it('rejects negative contributions instead of silently reducing a purchased limit', () => {
    assert.throws(
      () => addTrafficLimit(10n, [-1n]),
      (error: unknown) => error instanceof LimitArithmeticError && error.code === 'NEGATIVE_CONTRIBUTION',
    );
    assert.throws(
      () => addDeviceLimit(2, [-1]),
      (error: unknown) => error instanceof LimitArithmeticError && error.code === 'NEGATIVE_CONTRIBUTION',
    );
  });

  it('rejects signed bigint overflow', () => {
    assert.throws(
      () => addTrafficLimit((1n << 63n) - 1n, [1n]),
      (error: unknown) => error instanceof LimitArithmeticError && error.code === 'OVERFLOW',
    );
  });

  it('rejects device-limit overflow and non-integer values', () => {
    assert.throws(
      () => addDeviceLimit(2_147_483_647, [1]),
      (error: unknown) => error instanceof LimitArithmeticError && error.code === 'OVERFLOW',
    );
    assert.throws(
      () => addDeviceLimit(2, [0.5]),
      (error: unknown) => error instanceof LimitArithmeticError && error.code === 'INVALID_VALUE',
    );
  });
});
