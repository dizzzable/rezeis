import 'reflect-metadata';

import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Prisma } from '@prisma/client';

import type { PrismaService } from '../src/common/prisma/prisma.service';
import { AdminRemnawaveController } from '../src/modules/remnawave/controllers/admin-remnawave.controller';
import type { RemnawaveSystemStatsInterface } from '../src/modules/remnawave/interfaces/remnawave-system-stats.interface';
import type { RemnawaveNodeInterface } from '../src/modules/remnawave/interfaces/remnawave-node.interface';
import type { RemnawaveApiService } from '../src/modules/remnawave/services/remnawave-api.service';
import {
  LIVE_ONLINE_STATS_FAILURE_TTL_MS,
  LIVE_ONLINE_STATS_TTL_MS,
  LIVE_ONLINE_STATS_WAIT_MS,
  ONLINE_DISTRIBUTION_CACHE_MS,
  RemnawaveMetricsCollectorService,
  type OnlineRange,
} from '../src/modules/remnawave/services/remnawave-metrics-collector.service';
import { effectiveRoutePermissions, routeHandlerNames } from './helpers/controller-routes';

/**
 * The dashboard's «Онлайн пользователей» card, server side: the chart for 24
 * hours or 7 days, the peak, Remnawave's own online-now and unique counts behind
 * a short cache, and the node/country breakdown behind the card's globe button.
 *
 * The store is an in-memory table that answers the way the real query does —
 * bounded by `createdAt >= start`, ordered, projected to the selected columns —
 * and refuses a query of any other shape, so a service that stopped bounding
 * the window or started dragging the snapshots into the chart query fails here
 * instead of passing on data it never asked for.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** «Now» for every test: 18.09.2026, 12:34:56 UTC. */
const NOW = Date.parse('2026-09-18T12:34:56.000Z');

interface StoredSample {
  readonly id?: string;
  readonly onlineNow: number;
  readonly createdAt: Date;
  readonly nodesSnapshot: unknown;
}

interface RecordedQuery {
  readonly gte: string;
  readonly select: readonly string[];
}

/**
 * `rows` is the table itself: a test may push a sample into it between two
 * requests, as the collector would. A row without an id gets one, as cuid would.
 */
function sampleTable(rows: StoredSample[]) {
  const queries: RecordedQuery[] = [];
  const created: Array<Record<string, unknown>> = [];
  const idOf = (row: StoredSample): string => row.id ?? `sample-${row.createdAt.toISOString()}`;
  const remnawaveMetricSample = {
    findFirst: async (args: { readonly orderBy?: unknown; readonly select?: Record<string, unknown> }) => {
      assert.deepStrictEqual(args.orderBy, { createdAt: 'desc' }, 'the newest sample, by time');
      assert.deepStrictEqual(args.select, { id: true, createdAt: true }, 'only the columns that identify it');
      const newest = [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
      return newest === undefined ? null : { id: idOf(newest), createdAt: newest.createdAt };
    },
    findMany: async (args: {
      readonly where?: { readonly createdAt?: { readonly gte?: unknown } };
      readonly select?: Record<string, unknown>;
      readonly orderBy?: unknown;
    }) => {
      const gte = args.where?.createdAt?.gte;
      assert.ok(gte instanceof Date, 'the query is bounded by the start of the window');
      assert.deepStrictEqual(args.orderBy, { createdAt: 'asc' }, 'samples are read oldest first');
      assert.ok(args.select !== undefined, 'the query names its columns');
      const keys = Object.keys(args.select).sort();
      queries.push({ gte: gte.toISOString(), select: keys });
      return rows
        .filter((row) => row.createdAt.getTime() >= gte.getTime())
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map((row) => Object.fromEntries(keys.map((key) => [key, row[key as keyof StoredSample]])));
    },
    create: async (args: { readonly data: Record<string, unknown> }) => {
      created.push(args.data);
      return args.data;
    },
  };
  return { prisma: { remnawaveMetricSample } as unknown as PrismaService, queries, created };
}

function stats(onlineNow: number, lastDay: number, lastWeek: number): RemnawaveSystemStatsInterface {
  return {
    users: {
      totalUsers: 900,
      statusCounts: {},
      onlineStats: { onlineNow, lastDay, lastWeek, neverOnline: 12 },
    },
    nodes: { totalOnline: 3, totalBytesLifetime: 0 },
    cpu: { cores: 4 },
    memory: { total: 8, free: 4, used: 4 },
    uptime: 100,
    timestamp: NOW,
  };
}

/** A Remnawave whose stats answer is decided per call, counting the calls. */
function remnawave(answer: () => Promise<RemnawaveSystemStatsInterface | null>) {
  const calls = { count: 0 };
  const api = {
    getSystemStats: () => {
      calls.count += 1;
      return answer();
    },
  } as unknown as RemnawaveApiService;
  return { api, calls };
}

function at(iso: string): Date {
  return new Date(iso);
}

function sample(iso: string, onlineNow: number, nodesSnapshot: unknown = []): StoredSample {
  return { onlineNow, createdAt: at(iso), nodesSnapshot };
}

/** Lets settled promises run their callbacks; `setImmediate` is never mocked here. */
async function drain(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

afterEach(() => {
  mock.timers.reset();
});

describe('the chart points', () => {
  it('draws seven days as the HIGHEST sample of each hour, and an hour nobody measured as a gap', async () => {
    mock.timers.enable({ apis: ['Date'], now: NOW });
    const table = sampleTable([
      // Before the window: the query must not reach it.
      sample('2026-09-11T11:59:59.000Z', 999),
      // The window's first hour starts ON the hour, seven days back.
      sample('2026-09-11T12:00:00.000Z', 1),
      sample('2026-09-18T09:05:02.000Z', 4),
      sample('2026-09-18T09:50:01.000Z', 6),
      sample('2026-09-18T10:00:03.000Z', 5),
      sample('2026-09-18T10:05:02.000Z', 9),
      sample('2026-09-18T10:55:01.000Z', 7),
      // 11:00–11:59: the collector did not run.
      sample('2026-09-18T12:00:02.000Z', 3),
      sample('2026-09-18T12:30:01.000Z', 2),
    ]);
    const service = new RemnawaveMetricsCollectorService(table.prisma, remnawave(async () => null).api);

    const overview = await service.getOnlineOverview('7d');

    assert.equal(overview.bucketMinutes, 60);
    // 168 whole hours back from 12:00 today, and today's hour so far.
    assert.equal(overview.points.length, 169);
    assert.deepStrictEqual(overview.points[0], { time: '2026-09-11T12:00:00.000Z', onlineNow: 1 });
    assert.deepStrictEqual(overview.points.slice(-4), [
      { time: '2026-09-18T09:00:00.000Z', onlineNow: 6 },
      { time: '2026-09-18T10:00:00.000Z', onlineNow: 9 },
      { time: '2026-09-18T11:00:00.000Z', onlineNow: null },
      { time: '2026-09-18T12:00:00.000Z', onlineNow: 3 },
    ]);
    // Every point in between is a whole hour, and nothing was invented for them.
    for (let index = 1; index < overview.points.length; index += 1) {
      const step = Date.parse(overview.points[index].time) - Date.parse(overview.points[index - 1].time);
      assert.equal(step, HOUR, `point ${index} is an hour after the one before it`);
    }
    assert.equal(overview.points.filter((point) => point.onlineNow !== null).length, 4);
    assert.equal(overview.sampleCount, 8);
    assert.deepStrictEqual(table.queries, [
      // The chart query reads two columns — never the per-node snapshots.
      { gte: '2026-09-11T12:00:00.000Z', select: ['createdAt', 'onlineNow'] },
    ]);
  });

  it('draws 24 hours sample by sample, one five-minute point each, with the same gaps', async () => {
    mock.timers.enable({ apis: ['Date'], now: NOW });
    const table = sampleTable([
      sample('2026-09-17T12:30:04.000Z', 11),
      sample('2026-09-18T12:15:01.000Z', 8),
      sample('2026-09-18T12:20:01.000Z', 6),
      // 12:25 was missed.
    ]);
    const service = new RemnawaveMetricsCollectorService(table.prisma, remnawave(async () => null).api);

    const overview = await service.getOnlineOverview('24h');

    assert.equal(overview.bucketMinutes, 5);
    assert.equal(overview.points.length, 289);
    assert.deepStrictEqual(overview.points[0], { time: '2026-09-17T12:30:00.000Z', onlineNow: 11 });
    assert.deepStrictEqual(overview.points.slice(-4), [
      { time: '2026-09-18T12:15:00.000Z', onlineNow: 8 },
      { time: '2026-09-18T12:20:00.000Z', onlineNow: 6 },
      { time: '2026-09-18T12:25:00.000Z', onlineNow: null },
      { time: '2026-09-18T12:30:00.000Z', onlineNow: null },
    ]);
    assert.deepStrictEqual(table.queries, [{ gte: '2026-09-17T12:30:00.000Z', select: ['createdAt', 'onlineNow'] }]);
  });

  it('puts a sample stamped a moment ahead of this clock into the last point, not past the axis', async () => {
    mock.timers.enable({ apis: ['Date'], now: NOW });
    const table = sampleTable([sample('2026-09-18T12:35:30.000Z', 42)]);
    const service = new RemnawaveMetricsCollectorService(table.prisma, remnawave(async () => null).api);

    const overview = await service.getOnlineOverview('24h');

    assert.deepStrictEqual(overview.points[overview.points.length - 1], {
      time: '2026-09-18T12:30:00.000Z',
      onlineNow: 42,
    });
  });

  it('names the peak from the raw samples, at the LATEST time it was reached', async () => {
    mock.timers.enable({ apis: ['Date'], now: NOW });
    const table = sampleTable([
      sample('2026-09-18T01:00:00.000Z', 30),
      sample('2026-09-18T02:00:00.000Z', 55),
      sample('2026-09-18T03:00:00.000Z', 55),
      sample('2026-09-18T12:30:00.000Z', 12),
    ]);
    const service = new RemnawaveMetricsCollectorService(table.prisma, remnawave(async () => null).api);

    const overview = await service.getOnlineOverview('24h');

    assert.deepStrictEqual(overview.peak, { value: 55, at: '2026-09-18T03:00:00.000Z' });
    assert.deepStrictEqual(overview.latestSample, { onlineNow: 12, at: '2026-09-18T12:30:00.000Z' });
    // The card says «today», «yesterday» by this server's clock, not the browser's.
    assert.equal(overview.generatedAt, '2026-09-18T12:34:56.000Z');
  });

  it('raises the peak to Remnawave’s live figure when online has climbed past every stored sample', async () => {
    mock.timers.enable({ apis: ['Date'], now: NOW });
    const table = sampleTable([
      sample('2026-09-18T11:00:00.000Z', 1250),
      sample('2026-09-18T12:30:00.000Z', 1298),
    ]);
    let online = 1305;
    const upstream = remnawave(async () => stats(online, 4000, 9000));
    const service = new RemnawaveMetricsCollectorService(table.prisma, upstream.api);

    // «Сейчас 1 305 · Пик 1 298» would contradict itself: the peak is now.
    const climbing = await service.getOnlineOverview('24h');
    assert.equal(climbing.live?.onlineNow, 1305);
    assert.deepStrictEqual(climbing.peak, { value: 1305, at: '2026-09-18T12:34:56.000Z' });

    // Below the stored peak, the stored peak stands.
    online = 1200;
    mock.timers.tick(LIVE_ONLINE_STATS_TTL_MS);
    const falling = await service.getOnlineOverview('24h');
    assert.equal(falling.live?.onlineNow, 1200);
    assert.deepStrictEqual(falling.peak, { value: 1298, at: '2026-09-18T12:30:00.000Z' });
  });

  it('does not call «now» the peak of a window nothing was stored in', async () => {
    mock.timers.enable({ apis: ['Date'], now: NOW });
    const service = new RemnawaveMetricsCollectorService(sampleTable([]).prisma, remnawave(async () => stats(80, 90, 99)).api);

    const overview = await service.getOnlineOverview('24h');

    assert.equal(overview.live?.onlineNow, 80);
    assert.equal(overview.peak, null);
  });

  it('says nothing was measured rather than drawing zeros when the window holds no sample', async () => {
    mock.timers.enable({ apis: ['Date'], now: NOW });
    const table = sampleTable([sample('2026-09-10T00:00:00.000Z', 70)]);
    const service = new RemnawaveMetricsCollectorService(table.prisma, remnawave(async () => null).api);

    const overview = await service.getOnlineOverview('7d');

    assert.equal(overview.sampleCount, 0);
    assert.equal(overview.peak, null);
    assert.equal(overview.latestSample, null);
    assert.equal(overview.points.length, 169);
    assert.ok(overview.points.every((point) => point.onlineNow === null), 'no point claims a count');
  });
});

describe('Remnawave figures on the card', () => {
  it('gives the day’s unique users for 24 hours and the week’s for 7 days, from one call', async () => {
    mock.timers.enable({ apis: ['Date'], now: NOW });
    const upstream = remnawave(async () => stats(120, 480, 1900));
    const service = new RemnawaveMetricsCollectorService(sampleTable([]).prisma, upstream.api);

    const day = await service.getOnlineOverview('24h');
    const week = await service.getOnlineOverview('7d');

    assert.deepStrictEqual(day.live, { onlineNow: 120, uniqueUsers: 480, checkedAt: '2026-09-18T12:34:56.000Z' });
    assert.deepStrictEqual(week.live, { onlineNow: 120, uniqueUsers: 1900, checkedAt: '2026-09-18T12:34:56.000Z' });
    assert.equal(upstream.calls.count, 1, 'both windows are served by one cached answer');
  });

  it('answers without them — `live: null`, never a zero — when Remnawave does not answer or throws', async () => {
    mock.timers.enable({ apis: ['Date'], now: NOW });
    const silent = new RemnawaveMetricsCollectorService(sampleTable([]).prisma, remnawave(async () => null).api);
    const throwing = new RemnawaveMetricsCollectorService(
      sampleTable([]).prisma,
      remnawave(async () => {
        throw new Error('socket hang up');
      }).api,
    );

    assert.equal((await silent.getOnlineOverview('24h')).live, null);
    assert.equal((await throwing.getOnlineOverview('24h')).live, null);
  });

  it('reuses an answer for two minutes, then asks again', async () => {
    mock.timers.enable({ apis: ['Date'], now: NOW });
    let online = 100;
    const upstream = remnawave(async () => stats(online, 400, 1500));
    const service = new RemnawaveMetricsCollectorService(sampleTable([]).prisma, upstream.api);

    assert.equal((await service.getOnlineOverview('24h')).live?.onlineNow, 100);
    online = 101;
    // A dashboard's next refetch, a minute on: served from the cache.
    mock.timers.tick(60_000);
    assert.equal((await service.getOnlineOverview('24h')).live?.onlineNow, 100);
    mock.timers.tick(LIVE_ONLINE_STATS_TTL_MS - 60_000 - 1);
    assert.equal((await service.getOnlineOverview('24h')).live?.onlineNow, 100);
    assert.equal(upstream.calls.count, 1);

    mock.timers.tick(1);
    assert.equal((await service.getOnlineOverview('24h')).live?.onlineNow, 101);
    assert.equal(upstream.calls.count, 2);
  });

  it('asks a silent Remnawave again after thirty seconds, not two minutes', async () => {
    mock.timers.enable({ apis: ['Date'], now: NOW });
    let answer: RemnawaveSystemStatsInterface | null = null;
    const upstream = remnawave(async () => answer);
    const service = new RemnawaveMetricsCollectorService(sampleTable([]).prisma, upstream.api);

    assert.equal((await service.getOnlineOverview('24h')).live, null);
    answer = stats(7, 8, 9);
    mock.timers.tick(LIVE_ONLINE_STATS_FAILURE_TTL_MS - 1);
    assert.equal((await service.getOnlineOverview('24h')).live, null, 'the failure is remembered briefly');
    assert.equal(upstream.calls.count, 1);

    mock.timers.tick(1);
    assert.equal((await service.getOnlineOverview('24h')).live?.onlineNow, 7);
    assert.equal(upstream.calls.count, 2);
  });

  // A regression here hangs rather than fails — the bound is what reports it.
  it('shares one call among requests that arrive while it runs', { timeout: 10_000 }, async () => {
    mock.timers.enable({ apis: ['Date'], now: NOW });
    let release: (value: RemnawaveSystemStatsInterface) => void = () => undefined;
    const upstream = remnawave(
      () =>
        new Promise<RemnawaveSystemStatsInterface>((resolve) => {
          release = resolve;
        }),
    );
    const service = new RemnawaveMetricsCollectorService(sampleTable([]).prisma, upstream.api);

    const first = service.getOnlineOverview('24h');
    const second = service.getOnlineOverview('7d');
    await drain();
    release(stats(50, 60, 70));

    assert.deepStrictEqual(
      [(await first).live?.uniqueUsers, (await second).live?.uniqueUsers],
      [60, 70],
    );
    assert.equal(upstream.calls.count, 1);
  });

  it('answers a request within five seconds of a hung Remnawave, and keeps what the call brings later', { timeout: 10_000 }, async () => {
    mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
    let release: (value: RemnawaveSystemStatsInterface) => void = () => undefined;
    const upstream = remnawave(
      () =>
        new Promise<RemnawaveSystemStatsInterface>((resolve) => {
          release = resolve;
        }),
    );
    const table = sampleTable([sample('2026-09-18T12:30:00.000Z', 33)]);
    const service = new RemnawaveMetricsCollectorService(table.prisma, upstream.api);

    let answered: Awaited<ReturnType<RemnawaveMetricsCollectorService['getOnlineOverview']>> | null = null;
    const pending = service.getOnlineOverview('24h').then((overview) => {
      answered = overview;
      return overview;
    });
    await drain();
    mock.timers.tick(LIVE_ONLINE_STATS_WAIT_MS - 1);
    await drain();
    assert.equal(answered, null, 'still waiting inside the bound');

    mock.timers.tick(1);
    await drain();
    const overview = await pending;
    assert.equal(overview.live, null, 'the card is told Remnawave did not answer');
    assert.equal(overview.latestSample?.onlineNow, 33, 'and still gets the stored chart');

    // A second request while the call still hangs joins it instead of starting another.
    const joined = service.getOnlineOverview('24h');
    await drain();
    assert.equal(upstream.calls.count, 1);
    release(stats(34, 35, 36));
    assert.equal((await joined).live?.onlineNow, 34);

    // And the late answer is the cached one from now on.
    assert.equal((await service.getOnlineOverview('7d')).live?.uniqueUsers, 36);
    assert.equal(upstream.calls.count, 1);
  });
});

describe('online by node and by country', () => {
  const DE_1 = '11111111-1111-4111-8111-111111111111';
  const DE_2 = '22222222-2222-4222-8222-222222222222';
  const NL_1 = '33333333-3333-4333-8333-333333333333';
  const FI_1 = '44444444-4444-4444-8444-444444444444';
  const OFF = '55555555-5555-4555-8555-555555555555';
  const NOWHERE = '66666666-6666-4666-8666-666666666666';

  function node(uuid: string, name: string, countryCode: string, usersOnline: number, extra: Record<string, unknown> = {}) {
    return { uuid, name, countryCode, usersOnline, trafficUsedBytes: 0, isConnected: true, ...extra };
  }

  it('ranks the nodes by who is online in the newest sample, with each node’s peak over the window', async () => {
    mock.timers.enable({ apis: ['Date'], now: NOW });
    const table = sampleTable([
      // Outside a 24-hour window, inside a week: a peak only the week sees.
      sample('2026-09-15T20:00:00.000Z', 0, [node(DE_1, 'Frankfurt', 'DE', 400), node(NL_1, 'Amsterdam', 'NL', 10)]),
      sample('2026-09-18T08:00:00.000Z', 0, [
        node(DE_1, 'Frankfurt', 'DE', 90),
        node(DE_2, 'Berlin', 'de', 70),
        node(NL_1, 'Amsterdam', 'NL', 50),
        // Disconnected: what it last reported is not people online.
        node(FI_1, 'Helsinki', 'FI', 500, { isConnected: false }),
      ]),
      sample('2026-09-18T12:30:00.000Z', 0, [
        node(DE_1, 'Frankfurt', 'DE', 60),
        node(DE_2, 'Berlin', 'de', 25),
        node(NL_1, 'Amsterdam', 'NL', 80),
        node(FI_1, 'Helsinki', 'FI', 30, { isConnected: false }),
        node(OFF, 'Old box', 'DE', 0, { isConnected: false, isDisabled: true }),
        node(NOWHERE, 'Mystery', 'XX', 5),
        { name: 'no uuid', usersOnline: 999, isConnected: true, countryCode: 'US' },
        'not a node',
      ]),
    ]);
    const service = new RemnawaveMetricsCollectorService(table.prisma, remnawave(async () => null).api);

    const day = await service.getOnlineDistribution('24h');

    assert.equal(day.sampledAt, '2026-09-18T12:30:00.000Z');
    // Stamped with this server's clock, which the card judges «out of date» by.
    assert.equal(day.generatedAt, '2026-09-18T12:34:56.000Z');
    assert.deepStrictEqual(day.nodes, [
      { uuid: NL_1, name: 'Amsterdam', countryCode: 'NL', usersOnline: 80, peak: 80, isConnected: true },
      { uuid: DE_1, name: 'Frankfurt', countryCode: 'DE', usersOnline: 60, peak: 90, isConnected: true },
      { uuid: DE_2, name: 'Berlin', countryCode: 'DE', usersOnline: 25, peak: 70, isConnected: true },
      { uuid: NOWHERE, name: 'Mystery', countryCode: '', usersOnline: 5, peak: 5, isConnected: true },
      // Down: last, counting nobody, and its stale 500 was never a peak either.
      { uuid: FI_1, name: 'Helsinki', countryCode: 'FI', usersOnline: 0, peak: 0, isConnected: false },
    ]);
    assert.equal(day.totalUsersOnline, 170);
    // Frankfurt and Berlin together outweigh Amsterdam; 'XX' is no country, and
    // a country whose only node is down counts nobody.
    assert.deepStrictEqual(day.countries, [
      { countryCode: 'DE', usersOnline: 85, nodes: 2, nodesConnected: 2 },
      { countryCode: 'NL', usersOnline: 80, nodes: 1, nodesConnected: 1 },
      { countryCode: '', usersOnline: 5, nodes: 1, nodesConnected: 1 },
      { countryCode: 'FI', usersOnline: 0, nodes: 1, nodesConnected: 0 },
    ]);
    assert.deepStrictEqual(table.queries, [{ gte: '2026-09-17T12:30:00.000Z', select: ['createdAt', 'nodesSnapshot'] }]);

    const week = await service.getOnlineDistribution('7d');
    assert.equal(week.nodes.find((entry) => entry.uuid === DE_1)?.peak, 400, 'a week remembers Monday night');
    assert.equal(week.nodes.find((entry) => entry.uuid === NL_1)?.peak, 80);
  });

  it('has nothing to say about now when the window holds no sample', async () => {
    mock.timers.enable({ apis: ['Date'], now: NOW });
    const table = sampleTable([sample('2026-09-01T00:00:00.000Z', 0, [node(DE_1, 'Frankfurt', 'DE', 60)])]);
    const service = new RemnawaveMetricsCollectorService(table.prisma, remnawave(async () => null).api);

    assert.deepStrictEqual(await service.getOnlineDistribution('7d'), {
      range: '7d',
      generatedAt: '2026-09-18T12:34:56.000Z',
      sampledAt: null,
      nodeReadFailedAt: null,
      totalUsersOnline: 0,
      nodes: [],
      countries: [],
    });
  });

  it('passes over a newest sample whose node read failed, and says when, instead of claiming no nodes', async () => {
    mock.timers.enable({ apis: ['Date'], now: NOW });
    const table = sampleTable([
      sample('2026-09-18T12:20:00.000Z', 140, [node(DE_1, 'Frankfurt', 'DE', 60), node(NL_1, 'Amsterdam', 'NL', 80)]),
      // `/api/nodes` failed while `/api/system/stats` answered: no list at all —
      // JSON null, as the real column hands it back, never `[]`.
      sample('2026-09-18T12:25:00.000Z', 150, null),
      sample('2026-09-18T12:30:00.000Z', 155, null),
    ]);
    const service = new RemnawaveMetricsCollectorService(table.prisma, remnawave(async () => null).api);

    const distribution = await service.getOnlineDistribution('24h');

    // The lists are the last ones read, stamped with when they were read…
    assert.equal(distribution.sampledAt, '2026-09-18T12:20:00.000Z');
    assert.deepStrictEqual(
      distribution.nodes.map((entry) => [entry.name, entry.usersOnline]),
      [['Amsterdam', 80], ['Frankfurt', 60]],
    );
    assert.equal(distribution.totalUsersOnline, 140);
    // …and the answer says that the newest reading of the list failed.
    assert.equal(distribution.nodeReadFailedAt, '2026-09-18T12:30:00.000Z');
  });

  it('says the node list could not be read at all, rather than that there are no nodes', async () => {
    mock.timers.enable({ apis: ['Date'], now: NOW });
    const table = sampleTable([
      sample('2026-09-18T12:25:00.000Z', 150, null),
      // Not a list either: a failed read, whatever else it is.
      sample('2026-09-18T12:30:00.000Z', 155, { nodes: 'garbled' }),
    ]);
    const service = new RemnawaveMetricsCollectorService(table.prisma, remnawave(async () => null).api);

    const distribution = await service.getOnlineDistribution('24h');

    assert.equal(distribution.sampledAt, null);
    assert.equal(distribution.nodeReadFailedAt, '2026-09-18T12:30:00.000Z');
    assert.deepStrictEqual(distribution.nodes, []);
  });

  it('still says there are no enabled nodes when the panel really answered with none', async () => {
    mock.timers.enable({ apis: ['Date'], now: NOW });
    const table = sampleTable([sample('2026-09-18T12:30:00.000Z', 0, [])]);
    const service = new RemnawaveMetricsCollectorService(table.prisma, remnawave(async () => null).api);

    const distribution = await service.getOnlineDistribution('24h');

    assert.equal(distribution.sampledAt, '2026-09-18T12:30:00.000Z');
    assert.equal(distribution.nodeReadFailedAt, null);
    assert.deepStrictEqual(distribution.nodes, []);
  });

  it('reads the week of snapshots once per new sample, not once per viewer per minute', { timeout: 10_000 }, async () => {
    mock.timers.enable({ apis: ['Date'], now: NOW });
    const rows = [sample('2026-09-18T12:30:00.000Z', 0, [node(DE_1, 'Frankfurt', 'DE', 60)])];
    const table = sampleTable(rows);
    const service = new RemnawaveMetricsCollectorService(table.prisma, remnawave(async () => null).api);
    const heavyReads = (): number => table.queries.filter((query) => query.select.includes('nodesSnapshot')).length;

    // Three viewers at once: one reading of the week between them.
    const answers = await Promise.all([
      service.getOnlineDistribution('7d'),
      service.getOnlineDistribution('7d'),
      service.getOnlineDistribution('7d'),
    ]);
    assert.equal(heavyReads(), 1);
    assert.deepStrictEqual(answers.map((answer) => answer.nodes[0]?.usersOnline), [60, 60, 60]);

    // A minute on, nothing new stored: the same breakdown, answered now.
    mock.timers.tick(MINUTE);
    const later = await service.getOnlineDistribution('7d');
    assert.equal(heavyReads(), 1);
    assert.equal(later.generatedAt, '2026-09-18T12:35:56.000Z', 'stamped with the moment of this answer');

    // The other window is a reading of its own.
    await service.getOnlineDistribution('24h');
    assert.equal(heavyReads(), 2);

    // A new sample is in the very next answer.
    rows.push(sample('2026-09-18T12:35:00.000Z', 0, [node(DE_1, 'Frankfurt', 'DE', 75)]));
    const fresh = await service.getOnlineDistribution('7d');
    assert.equal(heavyReads(), 3);
    assert.equal(fresh.nodes[0]?.usersOnline, 75);
    assert.equal(fresh.sampledAt, '2026-09-18T12:35:00.000Z');

    // With nothing new, the window's edge still moves on after one interval.
    mock.timers.tick(ONLINE_DISTRIBUTION_CACHE_MS - 1);
    await service.getOnlineDistribution('7d');
    assert.equal(heavyReads(), 3);
    mock.timers.tick(1);
    await service.getOnlineDistribution('7d');
    assert.equal(heavyReads(), 4);
  });
});

describe('the five-minute sample', () => {
  it('records which nodes the operator switched off, so the breakdown can leave them out', async () => {
    const table = sampleTable([]);
    const api = {
      getSystemStats: async () => stats(5, 6, 7),
      readAllNodes: async () =>
        [
          { uuid: 'a', name: 'On', usersOnline: 5, trafficUsedBytes: 10, isConnected: true, isDisabled: false, countryCode: 'DE' },
          { uuid: 'b', name: 'Off', usersOnline: 0, trafficUsedBytes: null, isConnected: false, isDisabled: true, countryCode: 'NL' },
        ] as unknown as RemnawaveNodeInterface[],
    } as unknown as RemnawaveApiService;
    const service = new RemnawaveMetricsCollectorService(table.prisma, api);

    await service.collectMetrics();

    assert.equal(table.created.length, 1, 'one sample was written');
    assert.deepStrictEqual(table.created[0]?.['nodesSnapshot'], [
      { uuid: 'a', name: 'On', usersOnline: 5, trafficUsedBytes: 10, isConnected: true, isDisabled: false, countryCode: 'DE' },
      { uuid: 'b', name: 'Off', usersOnline: 0, trafficUsedBytes: 0, isConnected: false, isDisabled: true, countryCode: 'NL' },
    ]);
  });

  it('stores a node list it could not read as JSON null, never as an empty list, and keeps the online count', async () => {
    const table = sampleTable([]);
    const api = {
      getSystemStats: async () => stats(42, 50, 60),
      readAllNodes: async () => null,
      getAllNodes: async () => {
        throw new Error('getAllNodes answers [] for a failure; the collector must not read through it');
      },
    } as unknown as RemnawaveApiService;
    const service = new RemnawaveMetricsCollectorService(table.prisma, api);

    await service.collectMetrics();

    assert.equal(table.created.length, 1, 'the sample is still written: its online count is good');
    assert.equal(table.created[0]?.['onlineNow'], 42);
    assert.equal(table.created[0]?.['nodesSnapshot'], Prisma.JsonNull);
  });

  it('writes no sample at all when Remnawave’s stats are not an answer', async () => {
    const table = sampleTable([]);
    const api = {
      getSystemStats: async () => null,
      readAllNodes: async () => [],
    } as unknown as RemnawaveApiService;
    const service = new RemnawaveMetricsCollectorService(table.prisma, api);

    await service.collectMetrics();

    assert.deepStrictEqual(table.created, []);
  });
});

describe('the card routes', () => {
  function controllerWith(collector: Partial<RemnawaveMetricsCollectorService>): AdminRemnawaveController {
    return new AdminRemnawaveController(
      {} as never,
      collector as unknown as RemnawaveMetricsCollectorService,
      {} as never,
      {} as never,
    );
  }

  it('serves the overview and the breakdown to whoever may view Remnawave, and the raw trend no more', () => {
    const proto = AdminRemnawaveController.prototype;
    const routes: ReadonlyArray<readonly [string, (...args: never[]) => unknown, string]> = [
      ['overview', proto.getOnlineOverview, 'metrics/online-overview'],
      ['breakdown', proto.getOnlineDistribution, 'metrics/online-distribution'],
    ];
    for (const [label, handler, path] of routes) {
      assert.equal(Reflect.getMetadata(PATH_METADATA, handler), path, `${label} path`);
      assert.equal(Reflect.getMetadata(METHOD_METADATA, handler), RequestMethod.GET, `${label} verb`);
      assert.deepStrictEqual(
        effectiveRoutePermissions(AdminRemnawaveController, handler),
        [{ resource: 'remnawave', action: 'view' }],
        `${label} is gated on remnawave:view`,
      );
    }
    assert.ok(!routeHandlerNames(AdminRemnawaveController).includes('getOnlineTrend'), 'the raw-sample route is gone');
  });

  it('hands the service the window the query names, 24 hours when it names none', async () => {
    const asked: OnlineRange[] = [];
    const controller = controllerWith({
      getOnlineOverview: async (range: OnlineRange) => {
        asked.push(range);
        return { range } as never;
      },
      getOnlineDistribution: async (range: OnlineRange) => {
        asked.push(range);
        return { range } as never;
      },
    });

    await controller.getOnlineOverview({ range: '7d' });
    await controller.getOnlineOverview({});
    await controller.getOnlineDistribution({ range: '7d' });
    await controller.getOnlineDistribution({});

    // What reaches the handler is already validated — refusals are the pipe's,
    // held through the real router in `remnawave-metrics-online.http.spec.ts`.
    assert.deepStrictEqual(asked, ['7d', '24h', '7d', '24h']);
  });
});
