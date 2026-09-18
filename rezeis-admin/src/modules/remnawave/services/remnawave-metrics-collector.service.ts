import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { shouldRunSchedules } from '../../../common/runtime/process-role.util';
import { RemnawaveApiService } from './remnawave-api.service';

interface NodeSnapshotEntry {
  readonly uuid: string;
  readonly name: string;
  readonly usersOnline: number;
  readonly trafficUsedBytes: number;
  readonly isConnected: boolean;
  /**
   * Switched off by the operator in Remnawave. Written since 18.09.2026: a
   * sample taken before that has no such field, and the node it describes
   * reads as switched on.
   */
  readonly isDisabled?: boolean;
  readonly countryCode: string;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * The two windows the dashboard's «Онлайн пользователей» card offers.
 *
 * 24 hours are drawn sample by sample: the collector writes one every five
 * minutes, so a five-minute bucket holds exactly one, and the chart gets 289
 * points. Seven days are 2016 samples, and each hour is drawn as the HIGHEST of
 * its twelve — 169 points. The maximum and not the mean, so that the highest
 * point of the chart is the peak the card's header names: a mean flattens the
 * very spike an operator opens the week to find.
 *
 * A bucket nothing was measured in stays EMPTY (`onlineNow: null`) and the
 * chart breaks there. Joining the neighbours across it would draw a line
 * through hours in which nobody looked — a panel that was down all night
 * would show a calm night.
 */
export const ONLINE_RANGES = {
  '24h': { hours: 24, bucketMs: 5 * MINUTE_MS },
  '7d': { hours: 7 * 24, bucketMs: HOUR_MS },
} as const;

export type OnlineRange = keyof typeof ONLINE_RANGES;

/** The windows by name — what `OnlineRangeQueryDto` accepts for `range`. */
export const ONLINE_RANGE_KEYS = Object.keys(ONLINE_RANGES) as OnlineRange[];

/**
 * How long a computed node/country breakdown is served again — one sampling
 * interval — as long as no newer sample has been stored meanwhile.
 *
 * The seven-day breakdown reads every snapshot of the week: about 2 030 JSON
 * arrays, some 6 MB at twenty nodes. Every open dashboard turned over asks for
 * it once a minute, and the data under it changes once every five. Keyed by
 * the newest sample, a new sample is in the next answer at once; the age limit
 * only lets the window's far edge move along.
 */
export const ONLINE_DISTRIBUTION_CACHE_MS = 5 * MINUTE_MS;

/**
 * How long Remnawave's own figures are reused. Every open dashboard refetches
 * the card once a minute, for either window; two minutes means at most one
 * `/api/system/stats` call per two minutes per process, whoever is looking and
 * however many are. A single dashboard reaches Remnawave on every other
 * refetch, not on each. Online-now and the unique counts over a day and a week
 * do not move meaningfully in that time.
 */
export const LIVE_ONLINE_STATS_TTL_MS = 2 * MINUTE_MS;

/** A Remnawave that did not answer is asked again sooner, so its return shows within half a minute. */
export const LIVE_ONLINE_STATS_FAILURE_TTL_MS = 30_000;

/**
 * How long one request waits for Remnawave before answering without it.
 *
 * The upstream client gives up only after 45 s (`OUTBOUND_HTTP_TIMEOUT_MS`),
 * and the panel cuts every request at 30 s with a 408 — waiting for a hung
 * Remnawave would lose the stored chart together with the live figures. The
 * call itself is not abandoned: it stays the one in flight, later requests join
 * it instead of starting another, and whatever it ends with is cached.
 */
export const LIVE_ONLINE_STATS_WAIT_MS = 5_000;

interface LiveOnlineStats {
  readonly onlineNow: number;
  readonly lastDay: number;
  readonly lastWeek: number;
  readonly checkedAt: string;
}

/** The time span one card request covers, bucket-aligned. */
export interface OnlineWindow {
  /** First bucket's start: `now - range`, rounded DOWN to the bucket, so the first bucket is whole. */
  readonly start: number;
  readonly end: number;
  readonly bucketMs: number;
}

export function onlineWindow(range: OnlineRange, now: number): OnlineWindow {
  const { hours, bucketMs } = ONLINE_RANGES[range];
  return {
    start: Math.floor((now - hours * HOUR_MS) / bucketMs) * bucketMs,
    end: now,
    bucketMs,
  };
}

/**
 * The chart's points: one per bucket from the window's start to now, each the
 * highest `onlineNow` sampled inside it, or `null` when nothing was.
 *
 * A sample stamped after `end` — another process's clock a little ahead —
 * belongs to the last bucket rather than to one past the axis.
 */
export function bucketOnlineSamples(
  samples: ReadonlyArray<{ readonly onlineNow: number; readonly createdAt: Date }>,
  window: OnlineWindow,
): OnlineOverviewPoint[] {
  const highest = new Map<number, number>();
  for (const sample of samples) {
    const at = Math.min(sample.createdAt.getTime(), window.end);
    if (at < window.start) continue;
    const bucket = window.start + Math.floor((at - window.start) / window.bucketMs) * window.bucketMs;
    const seen = highest.get(bucket);
    if (seen === undefined || sample.onlineNow > seen) highest.set(bucket, sample.onlineNow);
  }
  const points: OnlineOverviewPoint[] = [];
  for (let bucket = window.start; bucket <= window.end; bucket += window.bucketMs) {
    points.push({ time: new Date(bucket).toISOString(), onlineNow: highest.get(bucket) ?? null });
  }
  return points;
}

/** The highest sample, and when — the LATEST time it was reached, if it was reached more than once. */
function peakOf(
  samples: ReadonlyArray<{ readonly onlineNow: number; readonly createdAt: Date }>,
): OnlineOverview['peak'] {
  let peak: { value: number; at: Date } | null = null;
  for (const sample of samples) {
    if (peak === null || sample.onlineNow >= peak.value) peak = { value: sample.onlineNow, at: sample.createdAt };
  }
  return peak === null ? null : { value: peak.value, at: peak.at.toISOString() };
}

/**
 * A stored snapshot, read defensively: the column is JSON, and every sample of
 * the last week was written by whatever version of this file was running then.
 * An entry without a uuid cannot be matched across samples and is skipped.
 */
function readNodeSnapshot(value: unknown): NodeSnapshotEntry[] {
  if (!Array.isArray(value)) return [];
  const nodes: NodeSnapshotEntry[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const row = entry as Record<string, unknown>;
    const uuid = row['uuid'];
    if (typeof uuid !== 'string' || uuid.length === 0) continue;
    const users = row['usersOnline'];
    const traffic = row['trafficUsedBytes'];
    nodes.push({
      uuid,
      name: typeof row['name'] === 'string' ? row['name'] : '',
      usersOnline: typeof users === 'number' && Number.isFinite(users) && users > 0 ? Math.round(users) : 0,
      trafficUsedBytes: typeof traffic === 'number' && Number.isFinite(traffic) ? traffic : 0,
      isConnected: row['isConnected'] === true,
      isDisabled: row['isDisabled'] === true,
      countryCode: typeof row['countryCode'] === 'string' ? row['countryCode'] : '',
    });
  }
  return nodes;
}

/**
 * A node's country as an ISO 3166 alpha-2 code, or `''` when it has none.
 * Remnawave's own placeholder for "no country" is `XX`, and `ZZ` is the
 * standard's "unknown region" — both are no country, not a country to draw.
 */
function normalizeCountryCode(raw: string): string {
  const code = raw.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) && code !== 'XX' && code !== 'ZZ' ? code : '';
}

/**
 * Who is online on which node and in which country, from the stored samples.
 *
 * NOW is the newest sample in the window whose node list was READ — at most
 * five minutes old while the collector runs, and stamped (`sampledAt`) so the
 * card can say how old it is when it is not. A sample whose node read failed
 * carries no list at all (`nodesSnapshot: null`, see `collectMetrics`) and is
 * passed over: an outage of `/api/nodes` while `/api/system/stats` still
 * answers — a fleet whose list outgrew the 1 MiB response cap does exactly
 * that, forever — used to store `[]`, and the card then said "no enabled
 * nodes" about it. When the newest sample is such a failure,
 * `nodeReadFailedAt` says when, and the lists are the last ones read.
 *
 * A PEAK is a node's highest count in any sample of the window.
 *
 * A node that has lost its connection counts nobody: what Remnawave last
 * reported for it is not a number of people online now. It stays in the list,
 * after the connected ones, so the operator sees that it is down. A node the
 * operator switched off is left out altogether.
 *
 * The counts are CONNECTIONS per node, so a person on two nodes is counted on
 * both; shares are of their sum, never of Remnawave's unique online-now.
 */
export function summariseOnlineDistribution(
  range: OnlineRange,
  samples: ReadonlyArray<{ readonly nodesSnapshot: unknown; readonly createdAt: Date }>,
  now: number,
): OnlineDistribution {
  const generatedAt = new Date(now).toISOString();
  // A list that was read, even an empty one, is an array; a failed read is not.
  const read = samples.filter((sample) => Array.isArray(sample.nodesSnapshot));
  const latestRead = read[read.length - 1];
  const latest = samples[samples.length - 1];
  const nodeReadFailedAt =
    latest !== undefined && latest !== latestRead ? latest.createdAt.toISOString() : null;
  if (latestRead === undefined) {
    return { range, generatedAt, sampledAt: null, nodeReadFailedAt, totalUsersOnline: 0, nodes: [], countries: [] };
  }

  const peaks = new Map<string, number>();
  for (const sample of read) {
    for (const node of readNodeSnapshot(sample.nodesSnapshot)) {
      const users = node.isConnected ? node.usersOnline : 0;
      peaks.set(node.uuid, Math.max(peaks.get(node.uuid) ?? 0, users));
    }
  }

  const nodes: OnlineDistributionNode[] = readNodeSnapshot(latestRead.nodesSnapshot)
    .filter((node) => node.isDisabled !== true)
    .map((node) => ({
      uuid: node.uuid,
      name: node.name,
      countryCode: normalizeCountryCode(node.countryCode),
      usersOnline: node.isConnected ? node.usersOnline : 0,
      peak: peaks.get(node.uuid) ?? 0,
      isConnected: node.isConnected,
    }))
    .sort(
      (a, b) =>
        Number(b.isConnected) - Number(a.isConnected) ||
        b.usersOnline - a.usersOnline ||
        b.peak - a.peak ||
        a.name.localeCompare(b.name),
    );

  const byCountry = new Map<string, { usersOnline: number; nodes: number; nodesConnected: number }>();
  for (const node of nodes) {
    const country = byCountry.get(node.countryCode) ?? { usersOnline: 0, nodes: 0, nodesConnected: 0 };
    country.usersOnline += node.usersOnline;
    country.nodes += 1;
    if (node.isConnected) country.nodesConnected += 1;
    byCountry.set(node.countryCode, country);
  }
  const countries: OnlineDistributionCountry[] = [...byCountry.entries()]
    .map(([countryCode, country]) => ({ countryCode, ...country }))
    .sort(
      (a, b) =>
        b.usersOnline - a.usersOnline ||
        b.nodesConnected - a.nodesConnected ||
        // The unnamed bucket goes last among equals: it is the least to act on.
        Number(a.countryCode === '') - Number(b.countryCode === '') ||
        a.countryCode.localeCompare(b.countryCode),
    );

  return {
    range,
    generatedAt,
    sampledAt: latestRead.createdAt.toISOString(),
    nodeReadFailedAt,
    totalUsersOnline: nodes.reduce((sum, node) => sum + node.usersOnline, 0),
    nodes,
    countries,
  };
}

/** Settles with `promise`, or with `fallback` once `ms` have passed — whichever comes first. */
function waitAtMost<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

/**
 * Collects Remnawave panel metrics every 5 minutes and stores them as
 * time-series samples in `RemnawaveMetricSample`.
 *
 * Powers:
 *   - the dashboard's «Онлайн пользователей» card: the chart over 24 hours or
 *     7 days, its peak, and the per-node and per-country breakdown behind the
 *     card's globe button
 *   - Per-node traffic history
 *   - System resource monitoring (CPU/RAM of the panel)
 *
 * Retention: samples older than 7 days are pruned daily.
 */
@Injectable()
export class RemnawaveMetricsCollectorService {
  private readonly logger = new Logger(RemnawaveMetricsCollectorService.name);

  /** Remnawave's last answer for the card, and until when it is served. */
  private liveStats: { readonly value: LiveOnlineStats | null; readonly expiresAt: number } | null = null;

  /** The one stats call in flight, shared by every request that arrives while it runs. */
  private liveStatsInFlight: Promise<LiveOnlineStats | null> | null = null;

  /** Each window's last computed breakdown, and the newest sample it was computed from. */
  private readonly distributionCache = new Map<
    OnlineRange,
    { readonly basis: string; readonly computedAt: number; readonly value: OnlineDistribution }
  >();

  /** Each window's breakdown being computed right now, shared by the requests that arrive meanwhile. */
  private readonly distributionInFlight = new Map<
    OnlineRange,
    { readonly basis: string; readonly promise: Promise<OnlineDistribution> }
  >();

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly remnawaveApiService: RemnawaveApiService,
  ) {}

  /**
   * Collects a snapshot every 5 minutes.
   */
  @Cron('0 */5 * * * *')
  public async collectMetrics(): Promise<void> {
    if (!shouldRunSchedules()) return;

    try {
      const stats = await this.remnawaveApiService.getSystemStats();
      if (!stats) return;

      // `readAllNodes`, not `getAllNodes`: the second answers `[]` for a failed
      // read too, and `[]` stored here is a panel with no enabled nodes.
      const nodes = await this.remnawaveApiService.readAllNodes();
      const nodesSnapshot: NodeSnapshotEntry[] | null =
        nodes === null
          ? null
          : nodes.map((node) => ({
              uuid: node.uuid,
              name: node.name,
              usersOnline: node.usersOnline,
              trafficUsedBytes: node.trafficUsedBytes ?? 0,
              isConnected: node.isConnected,
              isDisabled: node.isDisabled,
              countryCode: node.countryCode,
            }));

      await this.prismaService.remnawaveMetricSample.create({
        data: {
          onlineNow: stats.users.onlineStats.onlineNow,
          totalUsers: stats.users.totalUsers,
          nodesOnline: stats.nodes.totalOnline,
          totalBytesLifetime: BigInt(stats.nodes.totalBytesLifetime),
          // A list that could not be read is stored as JSON null — "no picture
          // in this sample" — so the online count still reaches the chart while
          // the node breakdown keeps showing the last list that WAS read. The
          // anti-fraud readers of this column already treat a non-array as
          // "no entries", exactly as they treated the `[]` stored before.
          nodesSnapshot:
            nodesSnapshot === null ? Prisma.JsonNull : (JSON.parse(JSON.stringify(nodesSnapshot)) as Prisma.InputJsonValue),
          cpuCores: stats.cpu.cores,
          memoryUsed: BigInt(stats.memory.used),
          memoryTotal: BigInt(stats.memory.total),
          uptime: stats.uptime,
        },
      });

      this.logger.debug(
        `Collected metrics: ${stats.users.onlineStats.onlineNow} online, ${stats.nodes.totalOnline} nodes`,
      );
    } catch (error) {
      this.logger.warn(`Failed to collect Remnawave metrics: ${(error as Error).message}`);
    }
  }

  /**
   * Prunes samples older than 7 days. Runs daily at 04:30.
   */
  @Cron('30 4 * * *')
  public async pruneOldSamples(): Promise<void> {
    if (!shouldRunSchedules()) return;

    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const result = await this.prismaService.remnawaveMetricSample.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });

    if (result.count > 0) {
      this.logger.log(`Pruned ${result.count} old metric samples`);
    }
  }

  /**
   * The card's chart for one window, its peak, the newest sample, and
   * Remnawave's own figures for right now.
   *
   * `live` is `null` when Remnawave did not answer within
   * `LIVE_ONLINE_STATS_WAIT_MS` — the card then says so instead of drawing a 0.
   * `uniqueUsers` is Remnawave's `lastDay` for 24 hours and `lastWeek` for
   * seven days: people seen online at any moment of the window, not a sum.
   */
  public async getOnlineOverview(range: OnlineRange): Promise<OnlineOverview> {
    const window = onlineWindow(range, Date.now());
    const [samples, live] = await Promise.all([
      this.prismaService.remnawaveMetricSample.findMany({
        where: { createdAt: { gte: new Date(window.start) } },
        select: { onlineNow: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      }),
      this.readLiveOnlineStats(),
    ]);
    const latest = samples[samples.length - 1];
    // «Сейчас» is Remnawave's live figure and the stored samples are up to five
    // minutes old, so while online climbs to the day's high the live figure is
    // above every sample: «Сейчас 1 305 · Пик 1 298» contradicts itself. Then
    // the peak IS now. With no sample at all the peak stays unknown — «now» is
    // not a peak of a window nothing was measured in.
    const storedPeak = peakOf(samples);
    const peak =
      storedPeak !== null && live !== null && live.onlineNow > storedPeak.value
        ? { value: live.onlineNow, at: live.checkedAt }
        : storedPeak;

    return {
      range,
      generatedAt: new Date(window.end).toISOString(),
      bucketMinutes: window.bucketMs / MINUTE_MS,
      points: bucketOnlineSamples(samples, window),
      sampleCount: samples.length,
      peak,
      latestSample:
        latest === undefined ? null : { onlineNow: latest.onlineNow, at: latest.createdAt.toISOString() },
      live:
        live === null
          ? null
          : {
              onlineNow: live.onlineNow,
              uniqueUsers: range === '24h' ? live.lastDay : live.lastWeek,
              checkedAt: live.checkedAt,
            },
    };
  }

  /**
   * The card turned over: online users by node and by country — see
   * `summariseOnlineDistribution` for what "now" and "peak" are.
   *
   * Computed once per window per new sample, and served from memory until the
   * next sample or `ONLINE_DISTRIBUTION_CACHE_MS`, whichever comes first. Each
   * request pays one indexed look at the newest sample to know whether one has
   * arrived; requests that arrive while the week is being read wait for that
   * one reading instead of starting their own. `generatedAt` is always the
   * moment of THIS answer, since the card judges the reading's age by it.
   */
  public async getOnlineDistribution(range: OnlineRange): Promise<OnlineDistribution> {
    const newest = await this.prismaService.remnawaveMetricSample.findFirst({
      orderBy: { createdAt: 'desc' },
      select: { id: true, createdAt: true },
    });
    const basis = newest === null ? 'none' : `${newest.id}@${newest.createdAt.toISOString()}`;
    const startedAt = Date.now();
    const answeredNow = (value: OnlineDistribution): OnlineDistribution => ({
      ...value,
      generatedAt: new Date(Date.now()).toISOString(),
    });

    const cached = this.distributionCache.get(range);
    if (cached !== undefined && cached.basis === basis && startedAt - cached.computedAt < ONLINE_DISTRIBUTION_CACHE_MS) {
      return answeredNow(cached.value);
    }
    const running = this.distributionInFlight.get(range);
    if (running !== undefined && running.basis === basis) {
      return answeredNow(await running.promise);
    }

    const promise = this.computeOnlineDistribution(range, startedAt);
    this.distributionInFlight.set(range, { basis, promise });
    try {
      const value = await promise;
      // A reading that started earlier and finished later must not replace a newer one.
      const stored = this.distributionCache.get(range);
      if (stored === undefined || stored.computedAt <= startedAt) {
        this.distributionCache.set(range, { basis, computedAt: startedAt, value });
      }
      return value;
    } finally {
      if (this.distributionInFlight.get(range)?.promise === promise) this.distributionInFlight.delete(range);
    }
  }

  private async computeOnlineDistribution(range: OnlineRange, now: number): Promise<OnlineDistribution> {
    const window = onlineWindow(range, now);
    const samples = await this.prismaService.remnawaveMetricSample.findMany({
      where: { createdAt: { gte: new Date(window.start) } },
      select: { nodesSnapshot: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
    return summariseOnlineDistribution(range, samples, window.end);
  }

  /**
   * Returns per-node traffic snapshots for the last N hours.
   */
  public async getNodeTrafficTrend(hours = 24): Promise<NodeTrafficTrendPoint[]> {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);
    const samples = await this.prismaService.remnawaveMetricSample.findMany({
      where: { createdAt: { gte: since } },
      select: {
        nodesSnapshot: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    return samples.map((s) => ({
      time: s.createdAt.toISOString(),
      nodes: s.nodesSnapshot as unknown as NodeSnapshotEntry[],
    }));
  }

  /**
   * Returns current geo distribution of online users by country.
   * Computed from the latest nodes snapshot or live API call.
   */
  public async getGeoDistribution(): Promise<GeoDistribution[]> {
    const nodes = await this.remnawaveApiService.getAllNodes();
    if (!nodes || nodes.length === 0) return [];

    const countryMap: Record<string, { usersOnline: number; nodesCount: number }> = {};
    let totalOnline = 0;

    for (const node of nodes) {
      if (node.isDisabled) continue;
      const country = node.countryCode || 'XX';
      if (!countryMap[country]) {
        countryMap[country] = { usersOnline: 0, nodesCount: 0 };
      }
      countryMap[country].usersOnline += node.usersOnline;
      countryMap[country].nodesCount += 1;
      totalOnline += node.usersOnline;
    }

    return Object.entries(countryMap)
      .map(([country, data]) => ({
        country,
        usersOnline: data.usersOnline,
        nodesCount: data.nodesCount,
        percentage: totalOnline > 0 ? Math.round((data.usersOnline / totalOnline) * 1000) / 10 : 0,
      }))
      .sort((a, b) => b.usersOnline - a.usersOnline);
  }

  /**
   * Remnawave's online-now and unique counts, from the short cache when it is
   * fresh, else from the call in flight (starting one if none is), waited on
   * for at most `LIVE_ONLINE_STATS_WAIT_MS`.
   */
  private async readLiveOnlineStats(): Promise<LiveOnlineStats | null> {
    const cached = this.liveStats;
    if (cached !== null && Date.now() < cached.expiresAt) return cached.value;

    let pending = this.liveStatsInFlight;
    if (pending === null) {
      const started = this.fetchLiveOnlineStats();
      pending = started;
      this.liveStatsInFlight = started;
      // Only this call's own settling clears the slot: a later call that took
      // it over must not be forgotten when an earlier one finishes.
      void started.finally(() => {
        if (this.liveStatsInFlight === started) this.liveStatsInFlight = null;
      });
    }
    return waitAtMost(pending, LIVE_ONLINE_STATS_WAIT_MS, null);
  }

  private async fetchLiveOnlineStats(): Promise<LiveOnlineStats | null> {
    let value: LiveOnlineStats | null = null;
    try {
      // `getSystemStats` answers `null` for every failure it can see — not
      // configured, unreachable, 4xx/5xx — and has already logged which.
      const stats = await this.remnawaveApiService.getSystemStats();
      if (stats !== null) {
        const online = stats.users.onlineStats;
        value = {
          onlineNow: online.onlineNow,
          lastDay: online.lastDay,
          lastWeek: online.lastWeek,
          checkedAt: new Date().toISOString(),
        };
      }
    } catch (error) {
      this.logger.warn(`Remnawave stats for the online card failed: ${(error as Error).message}`);
    }
    this.liveStats = {
      value,
      expiresAt: Date.now() + (value === null ? LIVE_ONLINE_STATS_FAILURE_TTL_MS : LIVE_ONLINE_STATS_TTL_MS),
    };
    return value;
  }
}

/** One point of the card's chart: the start of its bucket, and the highest count sampled in it. */
export interface OnlineOverviewPoint {
  readonly time: string;
  /** `null`: nothing was sampled in this bucket, and the chart breaks here. */
  readonly onlineNow: number | null;
}

/**
 * `generatedAt` on both answers is THIS server's clock when it answered. The
 * card judges «today», «yesterday» and «out of date» against it rather than
 * against the browser's clock: every other time in the answer was stamped by
 * this server too, and an operator's computer running twenty minutes fast would
 * otherwise see every reading as stale.
 */
export interface OnlineOverview {
  readonly range: OnlineRange;
  readonly generatedAt: string;
  /** Width of one point: 5 for 24 hours (a sample each), 60 for 7 days (an hour's highest). */
  readonly bucketMinutes: number;
  readonly points: readonly OnlineOverviewPoint[];
  /** Samples inside the window. `0` means the panel has measured nothing in it. */
  readonly sampleCount: number;
  /**
   * The highest stored sample of the window — or Remnawave's live figure, and
   * when it was read, when that is higher still. `null` when nothing was stored.
   */
  readonly peak: { readonly value: number; readonly at: string } | null;
  readonly latestSample: { readonly onlineNow: number; readonly at: string } | null;
  /** Remnawave's own figures; `null` when it did not answer. */
  readonly live: {
    readonly onlineNow: number;
    /** `lastDay` for 24 hours, `lastWeek` for 7 days. */
    readonly uniqueUsers: number;
    readonly checkedAt: string;
  } | null;
}

export interface OnlineDistributionNode {
  readonly uuid: string;
  readonly name: string;
  /** ISO alpha-2, or `''` when the node has no country. */
  readonly countryCode: string;
  /** In the newest sample; `0` for a node without a connection. */
  readonly usersOnline: number;
  /** Highest count in any sample of the window. */
  readonly peak: number;
  readonly isConnected: boolean;
}

export interface OnlineDistributionCountry {
  /** ISO alpha-2, or `''` for the nodes without a country. */
  readonly countryCode: string;
  readonly usersOnline: number;
  readonly nodes: number;
  readonly nodesConnected: number;
}

export interface OnlineDistribution {
  readonly range: OnlineRange;
  /** This server's clock when it answered — see `OnlineOverview`. */
  readonly generatedAt: string;
  /** When the lists were read: the newest sample whose node read succeeded; `null` when none did. */
  readonly sampledAt: string | null;
  /**
   * When the newest sample of the window failed to read the node list — the
   * lists are then from `sampledAt`, older. `null` when the newest read worked,
   * or when the window holds no sample at all.
   */
  readonly nodeReadFailedAt: string | null;
  /** Sum over the nodes — connections, so a person on two nodes counts twice. */
  readonly totalUsersOnline: number;
  readonly nodes: readonly OnlineDistributionNode[];
  readonly countries: readonly OnlineDistributionCountry[];
}

export interface NodeTrafficTrendPoint {
  readonly time: string;
  readonly nodes: readonly NodeSnapshotEntry[];
}

export interface GeoDistribution {
  readonly country: string;
  readonly usersOnline: number;
  readonly nodesCount: number;
  readonly percentage: number;
}
