import { Injectable, Logger } from '@nestjs/common';
import { FraudSignalSeverity } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { RemnawaveApiService } from '../../remnawave/services/remnawave-api.service';
import { FraudSignalCandidate } from '../interfaces/fraud-signal.interface';
import {
  resolveSharingDetectionConfig,
  SharingDetectionConfig,
} from '../sharing-detection.config';

/**
 * Subscription-sharing detectors backed by the Remnawave panel.
 *
 * Two complementary signals:
 *   - HWID over-limit: a user has more *registered devices* than their plan's
 *     `hwidDeviceLimit` (cheap, uses the top-users endpoint).
 *   - Concurrent-IP: a user is connected from more *distinct source IPs* than
 *     their device limit within a short window (uses the `ip-control` API that
 *     powers the panel's "Active sessions" view).
 *
 * Both resolve the Remnawave user to a rezeis user id (via
 * `Subscription.remnawaveId`) for deep-linking, and fail soft so a panel
 * outage never aborts the cron detector batch.
 */
@Injectable()
export class SharingDetectors {
  private readonly logger = new Logger(SharingDetectors.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly remnawaveApiService: RemnawaveApiService,
  ) {}

  // ── Detector: HWID device over-limit ───────────────────────────────────

  public async detectHwidOverage(now: Date): Promise<readonly FraudSignalCandidate[]> {
    const config = resolveSharingDetectionConfig();
    if (!config.enableHwidOverage) return [];
    try {
      const [topUsers, limitByUuid] = await Promise.all([
        this.remnawaveApiService.getHwidTopUsers(),
        this.buildDeviceLimitByUuid(),
      ]);
      if (topUsers.length === 0) return [];

      const offenders = topUsers
        .map((u) => ({
          uuid: u.userUuid,
          username: u.username,
          devices: u.devicesCount,
          limit: limitByUuid.get(u.userUuid) ?? 0,
        }))
        .filter((u) => u.limit > 0 && u.devices > u.limit);
      if (offenders.length === 0) return [];

      const userIdByUuid = await this.resolveRezeisUserIds(offenders.map((o) => o.uuid));
      const day = utcDay(now);
      return offenders.map((o) => {
        const rezeisUserId = userIdByUuid.get(o.uuid) ?? null;
        return {
          code: 'SUBSCRIPTION_SHARING_HWID',
          fingerprint: `${day}|${o.uuid}`,
          severity:
            o.devices >= o.limit * 2 ? FraudSignalSeverity.HIGH : FraudSignalSeverity.MEDIUM,
          title: 'Subscription sharing — device limit exceeded',
          description: `User ${o.username} has ${o.devices} registered devices but the plan allows ${o.limit}.`,
          score: clampScore(50 + (o.devices - o.limit) * 10),
          confidence: 80,
          affectedUserIds: rezeisUserId ? [rezeisUserId] : [],
          metadata: {
            kind: 'hwid_overage',
            deviceCount: o.devices,
            deviceLimit: o.limit,
            remnawaveUuid: o.uuid,
            remnawaveUsername: o.username,
          },
        } satisfies FraudSignalCandidate;
      });
    } catch (error) {
      this.logger.warn(`HWID overage detection failed: ${(error as Error).message}`);
      return [];
    }
  }

  // ── Detector: concurrent-IP sharing ─────────────────────────────────────

  public async detectConcurrentIpSharing(now: Date): Promise<readonly FraudSignalCandidate[]> {
    const config = resolveSharingDetectionConfig();
    if (!config.enableIpSharing) return [];
    try {
      const panelUsers = await this.remnawaveApiService.getAllPanelUsers();
      if (panelUsers.length === 0) return [];

      // panelId → { uuid, limit } (ip-control keys online users by panel id)
      const byPanelId = new Map<number, { uuid: string; limit: number }>();
      for (const u of panelUsers) {
        if (u.panelId !== null) {
          byPanelId.set(u.panelId, { uuid: u.uuid, limit: u.hwidDeviceLimit ?? 0 });
        }
      }

      const nodes = await this.remnawaveApiService.getAllNodes();
      const connected = nodes
        .filter((n) => n.isConnected && !n.isDisabled)
        .slice(0, config.maxNodesPerRun);
      if (connected.length === 0) return [];

      const windowStart = now.getTime() - config.ipWindowMinutes * 60_000;
      // panelId → ip → sample
      const byUser = new Map<string, Map<string, IpAggregate>>();

      for (const node of connected) {
        const rows = await this.remnawaveApiService.fetchUsersIpsForNode(node.uuid);
        for (const row of rows) {
          for (const sample of row.ips) {
            const seen = Date.parse(sample.lastSeen);
            if (Number.isFinite(seen) && seen < windowStart) continue;
            let ipMap = byUser.get(row.userId);
            if (!ipMap) {
              ipMap = new Map<string, IpAggregate>();
              byUser.set(row.userId, ipMap);
            }
            if (!ipMap.has(sample.ip)) {
              ipMap.set(sample.ip, {
                ip: sample.ip,
                lastSeen: sample.lastSeen,
                nodeName: node.name,
                countryCode: node.countryCode ?? null,
              });
            }
          }
        }
      }

      const offenders: Array<{
        uuid: string;
        limit: number;
        ips: IpAggregate[];
      }> = [];
      for (const [panelIdStr, ipMap] of byUser) {
        const meta = byPanelId.get(Number.parseInt(panelIdStr, 10));
        if (!meta || meta.limit <= 0) continue;
        if (ipMap.size <= meta.limit) continue;
        offenders.push({ uuid: meta.uuid, limit: meta.limit, ips: [...ipMap.values()] });
      }
      if (offenders.length === 0) return [];

      const userIdByUuid = await this.resolveRezeisUserIds(offenders.map((o) => o.uuid));
      const day = utcDay(now);
      return offenders.map((o) => {
        const rezeisUserId = userIdByUuid.get(o.uuid) ?? null;
        return {
          code: 'SUBSCRIPTION_SHARING_IP',
          fingerprint: `${day}|${o.uuid}`,
          severity:
            o.ips.length >= o.limit * 2 ? FraudSignalSeverity.HIGH : FraudSignalSeverity.MEDIUM,
          title: 'Subscription sharing — concurrent IPs exceed device limit',
          description: `User connected from ${o.ips.length} distinct IPs in the last ${config.ipWindowMinutes}m but the plan allows ${o.limit} devices.`,
          score: clampScore(55 + (o.ips.length - o.limit) * 8),
          confidence: 75,
          affectedUserIds: rezeisUserId ? [rezeisUserId] : [],
          metadata: {
            kind: 'ip_sharing',
            distinctIpCount: o.ips.length,
            deviceLimit: o.limit,
            windowMinutes: config.ipWindowMinutes,
            remnawaveUuid: o.uuid,
            ips: o.ips.slice(0, config.maxIpsInMetadata),
          },
        } satisfies FraudSignalCandidate;
      });
    } catch (error) {
      this.logger.warn(`Concurrent-IP detection failed: ${(error as Error).message}`);
      return [];
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  /**
   * Map Remnawave subscription UUIDs → device limits via panel users.
   * Keyed by uuid for the HWID detector (top-users endpoint gives uuid).
   */
  private async buildDeviceLimitByUuid(): Promise<Map<string, number>> {
    const panelUsers = await this.remnawaveApiService.getAllPanelUsers();
    const map = new Map<string, number>();
    for (const u of panelUsers) {
      map.set(u.uuid, u.hwidDeviceLimit ?? 0);
    }
    return map;
  }

  /**
   * Resolve Remnawave subscription UUIDs to rezeis user ids via
   * `Subscription.remnawaveId`. Returns only the ones we can map.
   */
  private async resolveRezeisUserIds(uuids: readonly string[]): Promise<Map<string, string>> {
    const unique = [...new Set(uuids)].filter((u) => u.length > 0);
    if (unique.length === 0) return new Map();
    const rows = await this.prismaService.subscription.findMany({
      where: { remnawaveId: { in: unique } },
      select: { remnawaveId: true, userId: true },
    });
    const map = new Map<string, string>();
    for (const row of rows) {
      if (row.remnawaveId) map.set(row.remnawaveId, row.userId);
    }
    return map;
  }
}

interface IpAggregate {
  readonly ip: string;
  readonly lastSeen: string;
  readonly nodeName: string;
  readonly countryCode: string | null;
}

function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function clampScore(value: number): number {
  if (value < 0) return 0;
  if (value > 100) return 100;
  return Math.round(value);
}

// Re-exported for tests that want to assert on the resolved config shape.
export type { SharingDetectionConfig };
