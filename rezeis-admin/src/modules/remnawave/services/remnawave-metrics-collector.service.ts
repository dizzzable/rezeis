import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { shouldRunSchedules } from '../../../common/runtime/process-role.util';
import { RemnawaveApiService } from './remnawave-api.service';

interface NodeSnapshotEntry {
  readonly uuid: string;
  readonly name: string;
  readonly usersOnline: number;
  readonly trafficUsedBytes: number;
  readonly isConnected: boolean;
  readonly countryCode: string;
}

/**
 * Collects Remnawave panel metrics every 5 minutes and stores them as
 * time-series samples in `RemnawaveMetricSample`.
 *
 * Powers:
 *   - Online users trend chart on the dashboard
 *   - Per-node traffic history
 *   - System resource monitoring (CPU/RAM of the panel)
 *
 * Retention: samples older than 7 days are pruned daily.
 */
@Injectable()
export class RemnawaveMetricsCollectorService {
  private readonly logger = new Logger(RemnawaveMetricsCollectorService.name);

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

      const nodes = await this.remnawaveApiService.getAllNodes();
      const nodesSnapshot: NodeSnapshotEntry[] = (nodes ?? []).map((node) => ({
        uuid: node.uuid,
        name: node.name,
        usersOnline: node.usersOnline,
        trafficUsedBytes: node.trafficUsedBytes ?? 0,
        isConnected: node.isConnected,
        countryCode: node.countryCode,
      }));

      await this.prismaService.remnawaveMetricSample.create({
        data: {
          onlineNow: stats.users.onlineStats.onlineNow,
          totalUsers: stats.users.totalUsers,
          nodesOnline: stats.nodes.totalOnline,
          totalBytesLifetime: BigInt(stats.nodes.totalBytesLifetime),
          nodesSnapshot: JSON.parse(JSON.stringify(nodesSnapshot)),
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
   * Returns the last N hours of metric samples for the dashboard chart.
   */
  public async getOnlineTrend(hours = 24): Promise<OnlineTrendPoint[]> {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);
    const samples = await this.prismaService.remnawaveMetricSample.findMany({
      where: { createdAt: { gte: since } },
      select: {
        onlineNow: true,
        totalUsers: true,
        nodesOnline: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    return samples.map((s) => ({
      time: s.createdAt.toISOString(),
      onlineNow: s.onlineNow,
      totalUsers: s.totalUsers,
      nodesOnline: s.nodesOnline,
    }));
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
}

export interface OnlineTrendPoint {
  readonly time: string;
  readonly onlineNow: number;
  readonly totalUsers: number;
  readonly nodesOnline: number;
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
