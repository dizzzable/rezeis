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

    assert.ok(result !== null, 'a real answer is read');
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

    assert.deepStrictEqual(result?.users.onlineStats, {
      onlineNow: 3,
      lastDay: 5,
      lastWeek: 7,
      neverOnline: 1,
    });
  });

  it('treats a body without the online counts as no answer at all', () => {
    // A proxy's `{}`, an HTML page, another service's JSON. Folded into zeros,
    // this drew a green «Сейчас 0» on the dashboard and stored a sample of
    // nobody online; `getSystemStats` hands the `null` on as a failure.
    for (const body of [{}, null, 'Bad gateway', [], { users: {} }, { status: 'ok' }]) {
      assert.equal(normalizeSystemStats(body), null, JSON.stringify(body));
    }
    // The counts must be counts: all three that are read, each a number.
    for (const onlineStats of [
      { onlineNow: null, lastDay: 1, lastWeek: 2 },
      { onlineNow: 1, lastDay: 'x', lastWeek: 2 },
      { onlineNow: 1, lastDay: 2 },
      { onlineNow: -1, lastDay: 2, lastWeek: 3 },
      { onlineNow: NaN, lastDay: 2, lastWeek: 3 },
      { onlineNow: '', lastDay: 2, lastWeek: 3 },
    ]) {
      assert.equal(normalizeSystemStats({ onlineStats }), null, JSON.stringify(onlineStats));
    }
  });

  it('returns sensible zeros for every other field that is missing', () => {
    const result = normalizeSystemStats({ onlineStats: { onlineNow: 0, lastDay: 0, lastWeek: 0 } });

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

  it('coerces invalid types in the other fields to zeros without throwing', () => {
    const result = normalizeSystemStats({
      users: {
        totalUsers: 'not-a-number',
        statusCounts: 'should-be-object',
        // Decimal text is still a count; `neverOnline` is not one the card reads.
        onlineStats: { onlineNow: '3', lastDay: 4, lastWeek: 5, neverOnline: 'x' },
      },
      nodes: { totalOnline: true, totalBytesLifetime: '   ' },
      cpu: { cores: [] },
      memory: { total: {}, free: 'free?', used: 0 },
      uptime: '',
      timestamp: false,
    } as unknown);

    assert.ok(result !== null, 'a partially degraded answer is still an answer');
    assert.equal(result.users.totalUsers, 0);
    assert.deepStrictEqual(result.users.statusCounts, {});
    assert.deepStrictEqual(result.users.onlineStats, {
      onlineNow: 3,
      lastDay: 4,
      lastWeek: 5,
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
