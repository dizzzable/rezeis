import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeBandwidthStats } from '../src/modules/remnawave/services/remnawave-bandwidth-stats.normalizer';

test('normalizes Remnawave string bandwidth counters', () => {
  const result = normalizeBandwidthStats({
    bandwidthLastTwoDays: { current: '1024', previous: '512', difference: '512' },
    bandwidthLastSevenDays: { current: '2048', previous: '1024', difference: '1024' },
  });

  assert.deepEqual(result.bandwidthLastTwoDays, { current: 1024, previous: 512, difference: 512 });
  assert.deepEqual(result.bandwidthLastSevenDays, { current: 2048, previous: 1024, difference: 1024 });
  assert.deepEqual(result.bandwidthLast30Days, { current: 0, previous: 0, difference: 0 });
});

test('replaces malformed bandwidth values with finite zeros', () => {
  const result = normalizeBandwidthStats({
    bandwidthCurrentYear: { current: 'not-a-number', previous: Infinity, difference: null },
  });

  assert.deepEqual(result.bandwidthCurrentYear, { current: 0, previous: 0, difference: 0 });
});
