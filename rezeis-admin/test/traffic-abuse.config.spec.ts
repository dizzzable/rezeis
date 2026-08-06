import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveTrafficAbuseConfig } from '../src/modules/anti-fraud/traffic-abuse.config';

/**
 * The per-user node-traffic detector is enabled by default and names individual
 * customers. Its thresholds are therefore load-bearing, and until this suite
 * existed nothing checked that an unconfigured deployment actually got them:
 * `Number(value ?? '')` coerced an absent variable to `0`, which is finite, so
 * the fallback branch was unreachable and the clamp returned each range's FLOOR.
 *
 * These tests assert the DOCUMENTED defaults against an empty environment —
 * the configuration a real deployment runs, since this project's `.env` sets no
 * `ANTIFRAUD_*` variable at all.
 */
describe('resolveTrafficAbuseConfig', () => {
  it('returns the documented defaults when nothing is configured', () => {
    // The whole point: an empty env must not collapse to the range floors
    // (1 / 1.5 / 5 / 1), which would flag almost any user above 1 GB while
    // scanning a single arbitrary node per run.
    assert.deepEqual(resolveTrafficAbuseConfig({}), {
      enabled: true,
      minGb: 200,
      medianMultiplier: 4,
      sharePercent: 35,
      maxNodesPerRun: 25,
    });
  });

  it('treats an empty or blank variable as unset, not as zero', () => {
    // A variable declared with no value in a .env file arrives as ''. That is
    // "not configured", not "configure me to the minimum".
    const blank = resolveTrafficAbuseConfig({
      ANTIFRAUD_NODE_TRAFFIC_MIN_GB: '',
      ANTIFRAUD_NODE_TRAFFIC_SHARE_PERCENT: '   ',
      ANTIFRAUD_NODE_TRAFFIC_MAX_NODES: '',
    });
    assert.equal(blank.minGb, 200);
    assert.equal(blank.sharePercent, 35);
    assert.equal(blank.maxNodesPerRun, 25);
  });

  it('still falls back on a non-numeric value', () => {
    const garbage = resolveTrafficAbuseConfig({
      ANTIFRAUD_NODE_TRAFFIC_MIN_GB: 'lots',
      ANTIFRAUD_NODE_TRAFFIC_MEDIAN_MULTIPLIER: 'NaN',
    });
    assert.equal(garbage.minGb, 200);
    assert.equal(garbage.medianMultiplier, 4);
  });

  it('honours a configured value and clamps it to the documented range', () => {
    const configured = resolveTrafficAbuseConfig({
      ANTIFRAUD_NODE_TRAFFIC_MIN_GB: '500',
      ANTIFRAUD_NODE_TRAFFIC_MEDIAN_MULTIPLIER: '2.5',
      ANTIFRAUD_NODE_TRAFFIC_SHARE_PERCENT: '1',
      ANTIFRAUD_NODE_TRAFFIC_MAX_NODES: '9000',
    });
    assert.equal(configured.minGb, 500);
    assert.equal(configured.medianMultiplier, 2.5);
    // An explicit out-of-range value IS clamped — that behaviour is intended
    // and is what made the absent-variable bug invisible.
    assert.equal(configured.sharePercent, 5);
    assert.equal(configured.maxNodesPerRun, 500);
  });

  it('accepts an explicit zero where the range allows it, without confusing it with unset', () => {
    // `0` clamps to the floor because the floor is 1 — but it must get there by
    // being a configured value, not by impersonating an absent one.
    assert.equal(resolveTrafficAbuseConfig({ ANTIFRAUD_NODE_TRAFFIC_MIN_GB: '0' }).minGb, 1);
    assert.equal(resolveTrafficAbuseConfig({}).minGb, 200);
  });

  it('keeps the master switch opt-out', () => {
    assert.equal(resolveTrafficAbuseConfig({}).enabled, true);
    assert.equal(
      resolveTrafficAbuseConfig({ ANTIFRAUD_NODE_TRAFFIC_USER_ENABLED: 'false' }).enabled,
      false,
    );
  });
});
