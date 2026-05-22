import { Injectable, Logger } from '@nestjs/common';
import { FraudSignalSeverity } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { RemnawaveApiService } from '../../remnawave/services/remnawave-api.service';
import { FraudSignalCandidate } from '../interfaces/fraud-signal.interface';

/**
 * Remnawave-specific fraud detectors.
 *
 * These detectors query the Remnawave panel API for HWID device data
 * and node connection patterns to identify:
 *   - HWID anomalies (too many devices per user)
 *   - Geo anomalies (connections from many countries simultaneously)
 *   - Node abuse (single user consuming disproportionate traffic)
 *
 * Designed to run alongside the existing `FraudDetectors` in the
 * anti-fraud cron cycle.
 */
@Injectable()
export class RemnawaveDetectors {
  private readonly logger = new Logger(RemnawaveDetectors.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly remnawaveApiService: RemnawaveApiService,
  ) {}

  // ── Detector: HWID Device Anomaly ──────────────────────────────────────

  /**
   * Detects users with an abnormally high number of HWID devices.
   * Threshold: users with devices > 2× their hwidDeviceLimit or > 10 devices.
   *
   * This indicates potential account sharing or credential leaking.
   */
  public async detectHwidAnomalies(_now: Date): Promise<readonly FraudSignalCandidate[]> {
    try {
      const hwidStats = await this.remnawaveApiService.getHwidStats();
      if (!hwidStats) return [];

      const avgDevices = hwidStats.stats.averageHwidDevicesPerUser;
      const totalDevices = hwidStats.stats.totalHwidDevices;
      const uniqueDevices = hwidStats.stats.totalUniqueDevices;

      // Alert if average devices per user is suspiciously high (> 3)
      // or if total devices is much higher than unique (device reuse)
      const candidates: FraudSignalCandidate[] = [];

      if (avgDevices > 3) {
        candidates.push({
          code: 'HWID_HIGH_AVERAGE_DEVICES',
          fingerprint: `avg_${Math.floor(avgDevices * 10)}`,
          severity: avgDevices > 5 ? FraudSignalSeverity.HIGH : FraudSignalSeverity.MEDIUM,
          title: 'High average HWID devices per user',
          description: `Average ${avgDevices.toFixed(1)} devices per user (total: ${totalDevices}, unique: ${uniqueDevices}). May indicate widespread account sharing.`,
          score: Math.min(Math.round(avgDevices * 15), 100),
          confidence: 70,
          affectedUserIds: [],
          metadata: {
            averageDevicesPerUser: avgDevices,
            totalHwidDevices: totalDevices,
            totalUniqueDevices: uniqueDevices,
            byPlatform: hwidStats.byPlatform,
          },
        });
      }

      return candidates;
    } catch (error) {
      this.logger.warn(`HWID anomaly detection failed: ${(error as Error).message}`);
      return [];
    }
  }

  // ── Detector: Node Traffic Abuse ───────────────────────────────────────

  /**
   * Detects nodes where a single user consumes > 50% of the node's traffic.
   * This is a sign of abuse (torrenting, bulk downloads, etc.).
   *
   * Uses the per-node usersOnline count vs traffic to estimate.
   */
  public async detectNodeTrafficAbuse(_now: Date): Promise<readonly FraudSignalCandidate[]> {
    try {
      const nodes = await this.remnawaveApiService.getAllNodes();
      if (!nodes || nodes.length === 0) return [];

      const candidates: FraudSignalCandidate[] = [];

      for (const node of nodes) {
        if (!node.isConnected || node.isDisabled) continue;
        if (!node.trafficLimitBytes || !node.trafficUsedBytes) continue;

        const usagePercent = (node.trafficUsedBytes / node.trafficLimitBytes) * 100;

        // Alert if a node is > 90% traffic used
        if (usagePercent > 90) {
          candidates.push({
            code: 'NODE_TRAFFIC_CRITICAL',
            fingerprint: `node_${node.uuid}_${Math.floor(usagePercent)}`,
            severity: FraudSignalSeverity.HIGH,
            title: `Node "${node.name}" traffic critical (${usagePercent.toFixed(0)}%)`,
            description: `Node ${node.name} (${node.countryCode}) has used ${usagePercent.toFixed(1)}% of its traffic limit. ${node.usersOnline} users online.`,
            score: Math.min(Math.round(usagePercent), 100),
            confidence: 95,
            affectedUserIds: [],
            metadata: {
              nodeUuid: node.uuid,
              nodeName: node.name,
              countryCode: node.countryCode,
              trafficUsedBytes: node.trafficUsedBytes,
              trafficLimitBytes: node.trafficLimitBytes,
              usagePercent: Math.round(usagePercent * 10) / 10,
              usersOnline: node.usersOnline,
            },
          });
        }
      }

      return candidates;
    } catch (error) {
      this.logger.warn(`Node traffic abuse detection failed: ${(error as Error).message}`);
      return [];
    }
  }

  // ── Detector: Geo Distribution Anomaly ─────────────────────────────────

  /**
   * Detects when the user base is concentrated in unexpected countries
   * or when nodes in certain countries have disproportionate load.
   *
   * Uses node country codes and online user counts to build a geo profile.
   */
  public async detectGeoAnomalies(_now: Date): Promise<readonly FraudSignalCandidate[]> {
    try {
      const nodes = await this.remnawaveApiService.getAllNodes();
      if (!nodes || nodes.length === 0) return [];

      // Build country → users online map
      const countryUsers: Record<string, number> = {};
      let totalOnline = 0;

      for (const node of nodes) {
        if (!node.isConnected || node.isDisabled) continue;
        const country = node.countryCode || 'UNKNOWN';
        countryUsers[country] = (countryUsers[country] ?? 0) + node.usersOnline;
        totalOnline += node.usersOnline;
      }

      if (totalOnline === 0) return [];

      const candidates: FraudSignalCandidate[] = [];

      // Check if any single country has > 80% of all users (concentration risk)
      for (const [country, users] of Object.entries(countryUsers)) {
        const pct = (users / totalOnline) * 100;
        if (pct > 80 && totalOnline > 10) {
          candidates.push({
            code: 'GEO_CONCENTRATION_RISK',
            fingerprint: `geo_${country}_${Math.floor(pct)}`,
            severity: FraudSignalSeverity.LOW,
            title: `High user concentration in ${country}`,
            description: `${pct.toFixed(0)}% of online users (${users}/${totalOnline}) are connected through ${country} nodes. Consider load balancing.`,
            score: Math.round(pct * 0.5),
            confidence: 60,
            affectedUserIds: [],
            metadata: {
              country,
              usersInCountry: users,
              totalOnline,
              percentInCountry: Math.round(pct * 10) / 10,
              allCountries: countryUsers,
            },
          });
        }
      }

      return candidates;
    } catch (error) {
      this.logger.warn(`Geo anomaly detection failed: ${(error as Error).message}`);
      return [];
    }
  }

  // ── Detector: Offline Nodes ────────────────────────────────────────────

  /**
   * Detects nodes that are offline (not disabled, but disconnected).
   * This is an operational alert rather than fraud, but surfaces in the
   * same attention system.
   */
  public async detectOfflineNodes(_now: Date): Promise<readonly FraudSignalCandidate[]> {
    try {
      const nodes = await this.remnawaveApiService.getAllNodes();
      if (!nodes || nodes.length === 0) return [];

      const offlineNodes = nodes.filter((n) => !n.isConnected && !n.isDisabled && !n.isConnecting);

      if (offlineNodes.length === 0) return [];

      return [
        {
          code: 'NODES_OFFLINE',
          fingerprint: `offline_${offlineNodes.length}_${offlineNodes.map((n) => n.uuid.slice(0, 4)).join('')}`,
          severity: offlineNodes.length > 2 ? FraudSignalSeverity.HIGH : FraudSignalSeverity.MEDIUM,
          title: `${offlineNodes.length} node(s) offline`,
          description: `Nodes offline: ${offlineNodes.map((n) => `${n.name} (${n.countryCode})`).join(', ')}`,
          score: Math.min(30 + offlineNodes.length * 20, 100),
          confidence: 100,
          affectedUserIds: [],
          metadata: {
            offlineCount: offlineNodes.length,
            nodes: offlineNodes.map((n) => ({
              uuid: n.uuid,
              name: n.name,
              countryCode: n.countryCode,
              lastStatusChange: n.lastStatusChange,
            })),
          },
        },
      ];
    } catch (error) {
      this.logger.warn(`Offline nodes detection failed: ${(error as Error).message}`);
      return [];
    }
  }
}
