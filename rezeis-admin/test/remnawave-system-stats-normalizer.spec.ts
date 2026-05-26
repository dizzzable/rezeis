import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalizeSystemStats } from '../src/modules/remnawave/services/remnawave-system-stats.normalizer';

describe('normalizeSystemStats', () => {
  it('accepts the modern Remnawave shape with onlineStats next to users', () => {
    const upstream = {
      cpu: { cores: 2 },
      memory: { total: 4106113024, free: 2613055488, used: 1493057536 },
      uptime: 12090111.9,
      timestamp: 1779737848317,
      users: {
        statusCounts: { ACTIVE: 74, DISABLED: 0, LIMITED: 0, EXPIRED: 2 },
        totalUsers: 76,
      },
      onlineStats: { onlineNow: 21, lastDay: 61, lastWeek: 69, neverOnline: 0 },
      nodes: { totalOnline: 19, totalBytesLifetime: '14916994270769' },
    };

    const result = normalizeSystemStats(upstream);

    assert.equal(result.users.totalUsers, 76);
    assert.deepStrictEqual(result.users.statusCounts, {
      ACTIVE: 74,
      DISABLED: 0,
      LIMITED: 0,
      EXPIRED: 2,
    });
    assert.deepStrictEqual(result.users.onlineStats, {
      onlineNow: 21,
      lastDay: 61,
      lastWeek: 69,
      neverOnline: 0,
    });
    assert.equal(result.nodes.totalOnline, 19);
    assert.equal(result.nodes.totalBytesLifetime, 14916994270769);
    assert.equal(result.cpu.cores, 2);
    assert.equal(result.memory.total, 4106113024);
    assert.equal(result.uptime, 12090111.9);
    assert.equal(result.timestamp, 1779737848317);
  });

  it('accepts the legacy shape with onlineStats nested under users', () => {
    const upstream = {
      users: {
        totalUsers: 10,
        statusCounts: { ACTIVE: 10 },
        onlineStats: { onlineNow: 3, lastDay: 5, lastWeek: 7, neverOnline: 1 },
      },
      nodes: { totalOnline: 1, totalBytesLifetime: 0 },
      cpu: { cores: 1 },
      memory: { total: 1, free: 1, used: 0 },
      uptime: 0,
      timestamp: 0,
    };

    const result = normalizeSystemStats(upstream);

    assert.deepStrictEqual(result.users.onlineStats, {
      onlineNow: 3,
      lastDay: 5,
      lastWeek: 7,
      neverOnline: 1,
    });
  });

  it('returns sensible zeros when fields are missing', () => {
    const result = normalizeSystemStats({});

    assert.deepStrictEqual(result, {
      users: {
        totalUsers: 0,
        statusCounts: {},
        onlineStats: { onlineNow: 0, lastDay: 0, lastWeek: 0, neverOnline: 0 },
      },
      nodes: { totalOnline: 0, totalBytesLifetime: 0 },
      cpu: { cores: 0 },
      memory: { total: 0, free: 0, used: 0 },
      uptime: 0,
      timestamp: 0,
    });
  });

  it('coerces invalid types to zeros without throwing', () => {
    const result = normalizeSystemStats({
      users: {
        totalUsers: 'not-a-number',
        statusCounts: 'should-be-object',
        onlineStats: { onlineNow: null, lastDay: undefined, lastWeek: NaN, neverOnline: 'x' },
      },
      nodes: { totalOnline: true, totalBytesLifetime: '   ' },
      cpu: { cores: [] },
      memory: { total: {}, free: 'free?', used: 0 },
      uptime: '',
      timestamp: false,
    } as unknown);

    assert.equal(result.users.totalUsers, 0);
    assert.deepStrictEqual(result.users.statusCounts, {});
    assert.deepStrictEqual(result.users.onlineStats, {
      onlineNow: 0,
      lastDay: 0,
      lastWeek: 0,
      neverOnline: 0,
    });
    assert.equal(result.nodes.totalOnline, 0);
    assert.equal(result.nodes.totalBytesLifetime, 0);
    assert.equal(result.cpu.cores, 0);
    assert.equal(result.memory.total, 0);
    assert.equal(result.memory.free, 0);
    assert.equal(result.memory.used, 0);
    assert.equal(result.uptime, 0);
    assert.equal(result.timestamp, 0);
  });
});
