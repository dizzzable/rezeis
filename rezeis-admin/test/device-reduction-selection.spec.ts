import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DeviceReductionSourceError,
  selectDeviceReductionTargets,
} from '../src/modules/add-on-entitlements/domain/device-reduction-selection';

const D = (hwid: string, createdAt: string) => ({ hwid, createdAt });

describe('selectDeviceReductionTargets (T-011)', () => {
  it('returns zero overage and no targets when devices are within the limit', () => {
    const result = selectDeviceReductionTargets([D('a', '2026-01-01T00:00:00Z')], 3);
    assert.equal(result.overage, 0);
    assert.deepEqual(result.targets, []);
    assert.equal(result.retained.length, 1);
  });

  it('deletes the newest devices, keeping the oldest desiredLimit', () => {
    const devices = [
      D('old', '2026-01-01T00:00:00Z'),
      D('mid', '2026-03-01T00:00:00Z'),
      D('new', '2026-06-01T00:00:00Z'),
    ];
    const result = selectDeviceReductionTargets(devices, 1);
    assert.equal(result.overage, 2);
    // Newest first: new, then mid.
    assert.deepEqual(result.targets.map((d) => d.hwid), ['new', 'mid']);
    assert.deepEqual(result.retained.map((d) => d.hwid), ['old']);
  });

  it('breaks createdAt ties by canonical hwid DESC (deterministic)', () => {
    const devices = [
      D('aaa', '2026-01-01T00:00:00Z'),
      D('ccc', '2026-01-01T00:00:00Z'),
      D('bbb', '2026-01-01T00:00:00Z'),
    ];
    // All same timestamp → sort hwid DESC → ccc, bbb, aaa. Delete top 2.
    const result = selectDeviceReductionTargets(devices, 1);
    assert.deepEqual(result.targets.map((d) => d.hwid), ['ccc', 'bbb']);
    assert.deepEqual(result.retained.map((d) => d.hwid), ['aaa']);
  });

  it('reducing to zero deletes every device', () => {
    const result = selectDeviceReductionTargets([D('a', '2026-01-01T00:00:00Z'), D('b', '2026-02-01T00:00:00Z')], 0);
    assert.equal(result.overage, 2);
    assert.equal(result.targets.length, 2);
    assert.equal(result.retained.length, 0);
  });

  it('is stable across input ordering (same targets regardless of array order)', () => {
    const a = selectDeviceReductionTargets([D('x', '2026-05-01T00:00:00Z'), D('y', '2026-01-01T00:00:00Z')], 1);
    const b = selectDeviceReductionTargets([D('y', '2026-01-01T00:00:00Z'), D('x', '2026-05-01T00:00:00Z')], 1);
    assert.deepEqual(a.targets.map((d) => d.hwid), b.targets.map((d) => d.hwid));
    assert.deepEqual(a.targets.map((d) => d.hwid), ['x']);
  });

  it('throws on an invalid createdAt (fail-closed before any mutation)', () => {
    assert.throws(
      () => selectDeviceReductionTargets([D('a', 'not-a-date')], 0),
      (e: unknown) => e instanceof DeviceReductionSourceError,
    );
  });

  it('throws on a duplicate hwid', () => {
    assert.throws(
      () => selectDeviceReductionTargets([D('dup', '2026-01-01T00:00:00Z'), D('dup', '2026-02-01T00:00:00Z')], 1),
      (e: unknown) => e instanceof DeviceReductionSourceError,
    );
  });

  it('throws on an empty hwid', () => {
    assert.throws(
      () => selectDeviceReductionTargets([D('', '2026-01-01T00:00:00Z')], 0),
      (e: unknown) => e instanceof DeviceReductionSourceError,
    );
  });

  it('throws on a negative or non-integer desiredLimit', () => {
    assert.throws(() => selectDeviceReductionTargets([], -1), (e: unknown) => e instanceof DeviceReductionSourceError);
    assert.throws(() => selectDeviceReductionTargets([], 1.5), (e: unknown) => e instanceof DeviceReductionSourceError);
  });
});
