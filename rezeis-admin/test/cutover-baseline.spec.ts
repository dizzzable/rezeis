import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  GIB_BYTES,
  deriveCutoverBaseline,
} from '../src/modules/add-on-entitlements/domain/cutover-baseline';
import { LAPSED_TERM_WINDOW_MS } from '../src/modules/add-on-entitlements/domain/term-window';

const createdAt = new Date('2026-01-01T00:00:00.000Z');
const expiresAt = new Date('2026-02-01T00:00:00.000Z');

describe('deriveCutoverBaseline', () => {
  it('maps a finite traffic limit (GB) to bytes and keeps a finite device limit', () => {
    const result = deriveCutoverBaseline({
      trafficLimit: 100,
      deviceLimit: 3,
      trafficLimitStrategy: 'MONTH',
      createdAt,
      expiresAt,
    });
    assert.equal(result.baseTrafficLimitBytes, 100n * GIB_BYTES);
    assert.equal(result.baseDeviceLimit, 3);
    assert.equal(result.trafficResetStrategy, 'MONTH');
    assert.equal(result.startsAt.getTime(), createdAt.getTime());
    assert.equal(result.endsAt?.getTime(), expiresAt.getTime());
    assert.equal(result.classification, 'MATCHED');
    assert.deepEqual(result.ambiguousReasons, []);
  });

  it('treats null traffic as canonical unlimited', () => {
    const result = deriveCutoverBaseline({
      trafficLimit: null,
      deviceLimit: 5,
      trafficLimitStrategy: 'NO_RESET',
      createdAt,
      expiresAt: null,
    });
    assert.equal(result.baseTrafficLimitBytes, null);
    assert.equal(result.baseDeviceLimit, 5);
    assert.equal(result.endsAt, null);
    assert.equal(result.classification, 'MATCHED');
  });

  it('treats a finite 0 GB traffic limit as a real finite zero, not unlimited', () => {
    const result = deriveCutoverBaseline({
      trafficLimit: 0,
      deviceLimit: 2,
      trafficLimitStrategy: 'DAY',
      createdAt,
      expiresAt,
    });
    assert.equal(result.baseTrafficLimitBytes, 0n);
    assert.equal(result.classification, 'MATCHED');
  });

  it('maps deviceLimit <= 0 to canonical unlimited (null)', () => {
    for (const deviceLimit of [0, -1]) {
      const result = deriveCutoverBaseline({
        trafficLimit: 50,
        deviceLimit,
        trafficLimitStrategy: 'NO_RESET',
        createdAt,
        expiresAt,
      });
      assert.equal(result.baseDeviceLimit, null, `deviceLimit=${deviceLimit} → unlimited`);
      assert.equal(result.classification, 'MATCHED');
    }
  });

  it('flags an unknown reset strategy but defaults to NO_RESET', () => {
    const result = deriveCutoverBaseline({
      trafficLimit: 10,
      deviceLimit: 1,
      trafficLimitStrategy: 'WEIRD',
      createdAt,
      expiresAt,
    });
    assert.equal(result.trafficResetStrategy, 'NO_RESET');
    assert.equal(result.classification, 'AMBIGUOUS');
    assert.ok(result.ambiguousReasons.includes('UNKNOWN_RESET_STRATEGY'));
  });

  it('flags a null reset strategy as ambiguous', () => {
    const result = deriveCutoverBaseline({
      trafficLimit: 10,
      deviceLimit: 1,
      trafficLimitStrategy: null,
      createdAt,
      expiresAt,
    });
    assert.equal(result.trafficResetStrategy, 'NO_RESET');
    assert.ok(result.ambiguousReasons.includes('UNKNOWN_RESET_STRATEGY'));
  });

  it('closes a lapsed window one second before expiry instead of leaving it open, and flags it', () => {
    // The import shape: the row was created AFTER it had already expired. An
    // open end here meant "never expires", and the renewal producer cannot
    // append after one — a paid renewal was left unfulfilled.
    const lapsedAt = new Date('2025-11-15T08:30:00.000Z');
    const result = deriveCutoverBaseline({
      trafficLimit: 10,
      deviceLimit: 1,
      trafficLimitStrategy: 'MONTH',
      createdAt,
      expiresAt: lapsedAt,
    });
    assert.equal(result.endsAt?.getTime(), lapsedAt.getTime());
    assert.equal(result.startsAt.getTime(), lapsedAt.getTime() - 1_000);
    assert.equal(result.classification, 'AMBIGUOUS');
    assert.deepEqual(result.ambiguousReasons, ['NON_POSITIVE_TERM_WINDOW']);
  });

  it('closes an equal-instant window the same way (ends_at > starts_at still holds)', () => {
    const result = deriveCutoverBaseline({
      trafficLimit: 10,
      deviceLimit: 1,
      trafficLimitStrategy: 'MONTH',
      createdAt,
      expiresAt: createdAt, // expiresAt == createdAt → not strictly after
    });
    assert.equal(result.endsAt?.getTime(), createdAt.getTime());
    assert.equal(result.startsAt.getTime(), createdAt.getTime() - 1_000);
    assert.ok(result.ambiguousReasons.includes('NON_POSITIVE_TERM_WINDOW'));
  });

  it('pulls the start back for a window shorter than a second, without flagging it', () => {
    const almost = new Date(createdAt.getTime() + 400);
    const result = deriveCutoverBaseline({
      trafficLimit: 10,
      deviceLimit: 1,
      trafficLimitStrategy: 'MONTH',
      createdAt,
      expiresAt: almost,
    });
    assert.equal(result.endsAt?.getTime(), almost.getTime());
    assert.equal(result.startsAt.getTime(), almost.getTime() - 1_000);
    assert.equal(result.classification, 'MATCHED');
  });

  it('leaves the window open ONLY for a lifetime subscription', () => {
    const result = deriveCutoverBaseline({
      trafficLimit: 10,
      deviceLimit: 1,
      trafficLimitStrategy: 'MONTH',
      createdAt,
      expiresAt: null,
    });
    assert.equal(result.endsAt, null);
    assert.equal(result.startsAt.getTime(), createdAt.getTime());
    assert.equal(result.classification, 'MATCHED');
  });

  it('uses a one-second lapsed window', () => {
    // A literal, not the constant: a fixture read from the value it pins would
    // move with it.
    assert.equal(LAPSED_TERM_WINDOW_MS, 1_000);
  });

  it('flags a negative traffic anomaly and falls back to a finite zero baseline', () => {
    const result = deriveCutoverBaseline({
      trafficLimit: -5,
      deviceLimit: 1,
      trafficLimitStrategy: 'MONTH',
      createdAt,
      expiresAt,
    });
    assert.equal(result.baseTrafficLimitBytes, 0n);
    assert.equal(result.classification, 'AMBIGUOUS');
    assert.ok(result.ambiguousReasons.includes('NON_INTEGER_OR_NEGATIVE_TRAFFIC'));
  });
});
