import { Injectable, Logger } from '@nestjs/common';
import { FraudSignalSeverity } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  EVENT_TYPES,
  SystemEventCategory,
  SystemEventSeverity,
} from '../../../common/services/system-events.service';
import { RemnawaveNodeInterface } from '../../remnawave/interfaces/remnawave-node.interface';
import {
  NODE_USERS_BANDWIDTH_TOP_LIMIT,
  RemnawaveApiService,
} from '../../remnawave/services/remnawave-api.service';
import { RemnawaveVersionService } from '../../remnawave/services/remnawave-version.service';
import { computeConfidence, ratioStrength } from '../confidence.util';
import { FraudSignalCandidate } from '../interfaces/fraud-signal.interface';
import { AntiFraudTunablesService } from '../services/anti-fraud-tunables.service';

/**
 * Remnawave-derived detectors.
 *
 * Two kinds of output live here and they are deliberately NOT the same kind:
 *
 *   1. **Fraud signals** (`FraudSignalCandidate`) — an accusation against a
 *      customer. Only {@link RemnawaveDetectors.detectPerUserNodeTrafficAbuse}
 *      produces these, because it is the only thing here that names somebody.
 *
 *   2. **Operational alerts** (`OperationalAlert`) — facts about the
 *      infrastructure: a node is down, a node is near its traffic quota, the
 *      online population is concentrated behind one country, the panel-wide
 *      device average is high. These name nobody and are nobody's fault.
 *      They go to `SystemEventsService`, not to `fraud_signals`.
 *
 * Why the split exists: all four operational facts used to be written into the
 * fraud table. `NODES_OFFLINE` opened a HIGH-severity fraud signal — which the
 * severity→action policy turns into an operator notification — *because nodes
 * went offline*. An operator reading the fraud queue during an outage was told
 * their customers were committing fraud. `GEO_CONCENTRATION_RISK` was worse
 * than cosmetic: it divides one country's online users by the sum over
 * **connected** nodes, so when the non-DE nodes drop, DE crosses 80% and a
 * "risk" opens that is nothing but the outage restated.
 *
 * The evidence behind those four never supported an accusation, so they stopped
 * being filed as one. The information itself is preserved, in full, on the
 * operator-alert channel.
 */
@Injectable()
export class RemnawaveDetectors {
  private readonly logger = new Logger(RemnawaveDetectors.name);

  /**
   * True once `POST /api/bandwidth-stats/nodes/users` has failed and until it
   * succeeds again — the latch behind the transition-only logging in
   * {@link detectPerUserNodeTrafficAbuse}. Process-local and deliberately not
   * persisted: a restart re-announcing a still-broken endpoint once is the
   * useful direction to be wrong in.
   */
  private perUserTrafficBlind = false;

  /**
   * Edge-trigger state for the operational alerts.
   *
   * A fraud signal is a row keyed by `(code, fingerprint)`, so re-detecting the
   * same condition every 5 minutes was free — the upsert collapsed it. A system
   * event has no such key: every emit is an audit row and a Telegram card. So
   * the alerts below are **edge-triggered** — emitted when the condition's
   * *band* changes, not while it holds. `null` / absent means "not currently
   * alerting", which is also what re-arms an alert after recovery.
   *
   * A node that stops being observable (offline, removed, panel error) keeps
   * its entry rather than losing it: dropping the entry would make the node's
   * return re-announce a quota it never left, which is the same class of bug as
   * the outage-driven fraud signal this file exists to remove.
   */
  private lastOfflineNodesKey: string | null = null;
  private readonly lastNodeTrafficBandByUuid = new Map<string, number>();
  private readonly lastGeoBandByCountry = new Map<string, number>();
  private lastHwidBand: number | null = null;

  /** True while user-naming detection is suppressed by node instability. */
  private nodeFlapSuppressionActive = false;

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly remnawaveApiService: RemnawaveApiService,
    private readonly versionService: RemnawaveVersionService,
    private readonly tunablesService: AntiFraudTunablesService,
  ) {}

  // ── Operational alert: panel-wide HWID device average ──────────────────

  /**
   * Panel-wide average of HWID devices per user.
   *
   * Not fraud: it is a single number averaged over every account on the panel,
   * it names nobody, and the per-user version of this question already exists
   * and already accuses the right person — `SharingDetectors.detectHwidOverage`
   * compares one user's device count to *that user's* limit. A panel average of
   * 3.2 is a capacity/product observation ("our device limits are generous"),
   * not evidence against any customer.
   *
   * Banded on the detector's own two thresholds (3 = notable, 5 = high) instead
   * of the measured average. The old fingerprint was
   * `avg_${floor(avg * 10)}` — a distinct row every time the average drifted by
   * 0.1, i.e. a new "fraud signal" for a number that moves on its own.
   */
  public async collectHwidAverageAlerts(_now: Date): Promise<readonly OperationalAlert[]> {
    try {
      const hwidStats = await this.remnawaveApiService.getHwidStats();
      if (!hwidStats) return [];

      const avgDevices = hwidStats.stats.averageHwidDevicesPerUser;
      const totalDevices = hwidStats.stats.totalHwidDevices;
      const uniqueDevices = hwidStats.stats.totalUniqueDevices;

      const band = hwidAverageBand(avgDevices);
      if (band === null) {
        this.lastHwidBand = null;
        return [];
      }
      if (this.lastHwidBand === band) return [];
      this.lastHwidBand = band;

      return [
        {
          type: OPERATIONAL_EVENT_TYPES.REMNAWAVE_HWID_AVERAGE_HIGH,
          category: 'REMNAWAVE',
          severity: band >= HWID_AVERAGE_HIGH_BAND ? 'WARNING' : 'INFO',
          message: `Panel-wide HWID average is ${avgDevices.toFixed(1)} devices per user`,
          dedupeKey: `hwid|${band}`,
          metadata: {
            kind: 'hwid_average',
            band,
            averageDevicesPerUser: avgDevices,
            totalHwidDevices: totalDevices,
            totalUniqueDevices: uniqueDevices,
            byPlatform: hwidStats.byPlatform,
          },
        },
      ];
    } catch (error) {
      this.logger.warn(`HWID average collection failed: ${(error as Error).message}`);
      return [];
    }
  }

  // ── Operational alert: node traffic quota ──────────────────────────────

  /**
   * A node that has consumed most of its traffic allowance.
   *
   * This is a billing/capacity fact about a machine we rent. It used to be
   * filed as a HIGH-severity fraud signal with confidence 95 — "Node de-1
   * traffic critical (91%)" in the queue an operator reads to decide whether to
   * ban somebody. Nobody is accused here; the panel itself has a `notifyPercent`
   * field for exactly this, and the forwarded webhook already emits
   * `node.traffic_notify`. So this reports on the same channel and the same
   * event type as the panel's own notice.
   *
   * Banded (90 / 95 / 100) rather than keyed on the percentage. The old
   * fingerprint was `node_${uuid}_${floor(pct)}` — a separate fraud row for 90,
   * then 91, then 92, as the node filled up.
   */
  public async collectNodeTrafficAlerts(_now: Date): Promise<readonly OperationalAlert[]> {
    try {
      const nodes = await this.remnawaveApiService.getAllNodes();
      if (!nodes || nodes.length === 0) return [];

      const alerts: OperationalAlert[] = [];

      for (const node of nodes) {
        if (!node.isConnected || node.isDisabled) continue;
        if (!node.trafficLimitBytes || !node.trafficUsedBytes) continue;

        const usagePercent = (node.trafficUsedBytes / node.trafficLimitBytes) * 100;
        const band = nodeTrafficBand(usagePercent);

        if (band === null) {
          // Observed and healthy — this is the only condition that re-arms the
          // alert. A node we could not observe keeps its band.
          this.lastNodeTrafficBandByUuid.delete(node.uuid);
          continue;
        }
        if (this.lastNodeTrafficBandByUuid.get(node.uuid) === band) continue;
        this.lastNodeTrafficBandByUuid.set(node.uuid, band);

        alerts.push({
          type: EVENT_TYPES.NODE_TRAFFIC_NOTIFY,
          category: 'NODE',
          severity: 'WARNING',
          message: `Node "${node.name}" has used ${usagePercent.toFixed(1)}% of its traffic limit`,
          dedupeKey: `node_traffic|${node.uuid}|${band}`,
          metadata: {
            kind: 'node_traffic_quota',
            band,
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

      return alerts;
    } catch (error) {
      this.logger.warn(`Node traffic collection failed: ${(error as Error).message}`);
      return [];
    }
  }

  // ── Detector: Per-User Node Traffic Abuse (Remnawave 2.8+) ─────────────

  /**
   * Flags users whose bandwidth across the connected nodes is a clear outlier
   * — heavy in absolute terms AND far above the cohort (median / share). On a
   * VPN that usually means torrenting, bulk transfer, or a shared account.
   *
   * This is the only detector in this file that names a person, so it is the
   * only one that files a fraud signal — and the only one that has to prove the
   * cohort it judged against was real. Two guards do that:
   *
   *   - {@link findRecentNodeFlap}: if any node's connectivity changed recently,
   *     the run is skipped outright. When a node drops, its users leave the
   *     panel's aggregate and the survivors' *share* of the remainder jumps
   *     without anybody's behaviour changing.
   *   - the cohort-size gates below: a share test over three samples is not a
   *     statistic.
   *
   * Uses the 2.8 `bandwidth-stats/nodes/users` endpoint, so it's gated behind
   * the detected capability and self-activates once the panel upgrades. The
   * panel returns usernames (not UUIDs), so the signal carries the username
   * for the operator to action; `affectedUserIds` stays empty (like the other
   * node-level detectors). Advisory only — LOW/MEDIUM, never HIGH.
   */
  public async detectPerUserNodeTrafficAbuse(now: Date): Promise<readonly FraudSignalCandidate[]> {
    // Effective tunables for this run: panel value, else `ANTIFRAUD_NODE_TRAFFIC_*`,
    // else built-in default. Resolved outside the try/catch on purpose — if the
    // settings row is unreadable this rejects and `runDetectors` treats the
    // detector as having observed nothing, rather than the detector quietly
    // re-enabling itself on env defaults the operator had overridden.
    const config = (await this.tunablesService.resolve()).trafficAbuse;
    if (!config.enabled) return [];
    const caps = await this.versionService.getCapabilities();
    if (!caps.bandwidthNodesUsers) {
      this.logger.debug('Per-user traffic detection skipped: needs Remnawave 2.8+');
      return [];
    }
    try {
      const nodes = await this.remnawaveApiService.getAllNodes();

      // Guard on the WHOLE panel, not just the nodes we aggregate: when a node
      // outside the slice drops, its users reconnect onto the nodes inside it
      // and arrive as traffic that looks like somebody's new habit.
      const flap = await this.findRecentNodeFlap(now, nodes ?? []);
      if (flap !== null) {
        this.logNodeFlapSuppression(flap);
        return [];
      }
      this.nodeFlapSuppressionActive = false;

      // Sort before slicing. `getAllNodes` returns the panel's order, which is
      // not stable — an unsorted `.slice()` means the cohort's composition
      // changes between runs on its own, and the median/share both come out of
      // the cohort. Sorting by uuid makes the same panel produce the same slice.
      const eligibleNodes = (nodes ?? [])
        .filter((n) => n.isConnected && !n.isDisabled)
        .sort((a, b) => a.uuid.localeCompare(b.uuid));
      const connected = eligibleNodes.slice(0, config.maxNodesPerRun);
      if (connected.length === 0) return [];

      const topUsers = await this.remnawaveApiService.getNodeUsersBandwidth(
        connected.map((n) => n.uuid),
      );
      if (topUsers === null) {
        // The capability said the endpoint exists and the panel still did not
        // answer, so this run produced no signal because it could not look —
        // not because the panel is clean. Logged on the TRANSITION only: this
        // runs every 5 minutes and the condition, once true, stays true until
        // somebody fixes it, so a line per run would be 288/day of the same
        // text and would be tuned out exactly like the failure it is meant to
        // surface. One WARN when the detector goes blind, one LOG when it
        // recovers; the runs in between stay at debug.
        if (!this.perUserTrafficBlind) {
          this.perUserTrafficBlind = true;
          this.logger.warn(
            'Per-user traffic detection is BLIND: the panel reports the 2.8 ' +
              'bandwidth-stats endpoint as available but rejected the request. ' +
              'This detector will report zero offenders until that is fixed.',
          );
        } else {
          this.logger.debug('Per-user traffic detection still blind');
        }
        return [];
      }
      if (this.perUserTrafficBlind) {
        this.perUserTrafficBlind = false;
        this.logger.log('Per-user traffic detection recovered: panel answered again');
      }
      const valid = topUsers.filter((u) => u.total > 0);
      // Below this there is no cohort to be an outlier of — see
      // MIN_COHORT_FOR_ANY_TEST.
      if (valid.length < MIN_COHORT_FOR_ANY_TEST) {
        this.logger.debug(
          `Per-user traffic detection skipped: cohort of ${valid.length} is below the ` +
            `${MIN_COHORT_FOR_ANY_TEST}-sample minimum`,
        );
        return [];
      }

      // The share test compares one user against the cohort's TOTAL, so its
      // threshold has to mean something relative to an even split. In a cohort
      // of N, an even split gives everyone 100/N%. At N=3 that is 33.3% and the
      // configured 35% threshold flags a user who is 1.05x the average — the
      // detector reports "holds 36% of all traffic" about somebody who is
      // ordinary. Requiring the threshold to sit at least 3x above the even
      // split (100/N * 3 <= sharePercent, i.e. N >= 300/sharePercent) makes
      // clearing it mean "three times the typical user" at every configured
      // value: 9 users at the 35% default, 4 at a 75% setting, 30 at 10%.
      // The median test has no such denominator and keeps the lower gate.
      const minCohortForShare = Math.ceil(300 / config.sharePercent);
      const shareTestUsable = valid.length >= minCohortForShare;
      if (!shareTestUsable) {
        this.logger.debug(
          `Per-user traffic share test disabled this run: cohort of ${valid.length} is below ` +
            `the ${minCohortForShare} needed for a ${config.sharePercent}% threshold to be an outlier`,
        );
      }

      const totals = valid.map((u) => u.total).sort((a, b) => a - b);
      const median = totals[Math.floor(totals.length / 2)] ?? 0;
      const sum = totals.reduce((a, b) => a + b, 0);
      const minBytes = config.minGb * 1024 ** 3;
      const day = utcDay(now);

      // ── Data quality for every candidate this run produces ───────────────
      // Both of this detector's tests are COHORT-RELATIVE — a median and a
      // share of a sum — so anything that makes the cohort a partial view of
      // the panel makes both of them a partial answer. Unlike the concurrent-IP
      // detector, where a missing node can only lower a user's network count
      // and therefore only suppress, a missing slice here cuts both ways: the
      // user's own total falls AND the denominator falls, so the resulting
      // share can land either side of the truth. Two independent shortfalls:
      //
      //   • ROW SATURATION — `getNodeUsersBandwidth` asks for
      //     NODE_USERS_BANDWIDTH_TOP_LIMIT rows and the panel returns the TOP N
      //     by traffic. A response AT that ceiling is the panel telling us the
      //     list was cut, and the adapter's own note on that constant spells
      //     out the consequence: the light tail is what makes the median a
      //     baseline, so a truncated list raises the median and shrinks the
      //     sum at once.
      //   • NODE COVERAGE — `maxNodesPerRun` slices the connected node list, so
      //     traffic on the nodes we did not ask about is in nobody's total.
      //
      // Multiplied rather than averaged: they are independent losses, and a run
      // that is short on both is worse off than one short on either.
      const rowsSaturated = topUsers.length >= NODE_USERS_BANDWIDTH_TOP_LIMIT;
      const nodeCoverage =
        eligibleNodes.length > 0 ? connected.length / eligibleNodes.length : 1;
      const dataQuality = (rowsSaturated ? SATURATED_COHORT_QUALITY : 1) * nodeCoverage;

      const candidates: FraudSignalCandidate[] = [];
      for (const u of valid) {
        if (u.total < minBytes) continue;
        const sharePct = sum > 0 ? (u.total / sum) * 100 : 0;
        const aboveMedian = median > 0 && u.total >= median * config.medianMultiplier;
        const aboveShare = shareTestUsable && sharePct >= config.sharePercent;
        if (!aboveMedian && !aboveShare) continue;
        const extreme = aboveMedian && aboveShare;
        // Say which test fired and how big the cohort was. The old text always
        // claimed the user was "well above the cohort median" even when the
        // median test had not fired, and never said how many users the
        // comparison was against — which is exactly the number that collapses
        // when a node drops.
        const reasons: string[] = [];
        if (aboveMedian) {
          reasons.push(`${(u.total / median).toFixed(1)}x the ${formatGb(median)} cohort median`);
        }
        if (aboveShare) reasons.push(`${sharePct.toFixed(0)}% of the cohort total`);
        // ── Confidence ────────────────────────────────────────────────────
        // Four independent readings. Nothing below touches `severity` (still
        // `extreme ? MEDIUM : LOW`) or `score`.
        //
        //  • COHORT — the population both relative tests are measured against.
        //    `MIN_COHORT_FOR_ANY_TEST` (5) is the bare minimum at which a
        //    median has two samples either side; 50 is a population where one
        //    user arriving or leaving cannot move it. This is the "cohort size"
        //    the brief names, and the number the class header already warns
        //    collapses when a node drops.
        //  • MEDIAN MARGIN and SHARE MARGIN — how far past each configured
        //    threshold the user landed, and 0 for a test that did not fire at
        //    all. Together they are what makes `extreme` (both tests firing)
        //    come out meaningfully more confident than either alone, which is
        //    the reference model's core claim: agreement between independent
        //    signals is the thing confidence should track.
        //  • ABSOLUTE — `total / minGb`, the one reading that owes the cohort
        //    nothing. A user 10× over the absolute floor is heavy whatever the
        //    rest of the panel is doing, so this keeps a real signal from being
        //    discounted to nothing by a small cohort alone.
        const medianRatio = median > 0 ? u.total / median : Number.NaN;
        const absoluteRatio = minBytes > 0 ? u.total / minBytes : Number.NaN;
        const { confidence, explanation } = computeConfidence({
          ceiling: NODE_TRAFFIC_CONFIDENCE,
          dataQuality,
          factors: [
            {
              name: 'cohortSize',
              observed: valid.length,
              strength: ratioStrength(valid.length, MIN_COHORT_FOR_ANY_TEST, 50),
            },
            {
              name: 'medianMargin',
              observed: aboveMedian ? medianRatio : 0,
              strength: aboveMedian
                ? ratioStrength(medianRatio / config.medianMultiplier, 1, 3)
                : 0,
            },
            {
              name: 'shareMargin',
              observed: aboveShare ? sharePct : 0,
              strength: aboveShare ? ratioStrength(sharePct / config.sharePercent, 1, 2) : 0,
            },
            {
              name: 'absoluteMargin',
              observed: absoluteRatio,
              strength: ratioStrength(absoluteRatio, 1, 10),
            },
          ],
        });
        candidates.push({
          code: 'NODE_TRAFFIC_USER_ABUSE',
          fingerprint: `${day}|${u.username}`,
          severity: extreme ? FraudSignalSeverity.MEDIUM : FraudSignalSeverity.LOW,
          title: 'Excessive per-user node traffic',
          description: `User ${u.username} consumed ${formatGb(u.total)} across ${connected.length} node(s) — ${reasons.join(' and ')}, measured against a cohort of ${valid.length}.`,
          score: clampScore(30 + Math.round(sharePct)),
          confidence,
          affectedUserIds: [],
          metadata: {
            kind: 'node_traffic_user',
            remnawaveUsername: u.username,
            totalBytes: u.total,
            sharePercent: Math.round(sharePct * 10) / 10,
            medianBytes: median,
            nodeCount: connected.length,
            cohortSize: valid.length,
            shareTestApplied: shareTestUsable,
            // The two shortfalls behind `confidenceDataQuality`, separately, so
            // an operator can tell a truncated row list from an unscanned node.
            cohortRowsSaturated: rowsSaturated,
            connectedNodeCount: eligibleNodes.length,
            ...explanation,
          },
        });
      }
      return candidates;
    } catch (error) {
      this.logger.warn(`Per-user node traffic detection failed: ${(error as Error).message}`);
      return [];
    }
  }

  // ── Operational alert: geo concentration ───────────────────────────────

  /**
   * One country holding most of the online population.
   *
   * This was never fraud and, as written, was usually not even geography: the
   * denominator sums `usersOnline` over **connected** nodes only, so the moment
   * the non-DE nodes drop, DE's share climbs past 80% and a
   * `GEO_CONCENTRATION_RISK` signal opens describing the outage. The number is
   * only meaningful over a stable panel, so it carries the same node-stability
   * guard as the user-naming detector — during a flap the concentration *is*
   * the flap — and it reports as an operational note, not a fraud signal.
   *
   * Banded in tens (80 / 90 / 100) instead of `geo_${country}_${floor(pct)}`,
   * which minted a row per integer percent.
   */
  public async collectGeoConcentrationAlerts(now: Date): Promise<readonly OperationalAlert[]> {
    try {
      const nodes = await this.remnawaveApiService.getAllNodes();
      if (!nodes || nodes.length === 0) return [];

      const flap = await this.findRecentNodeFlap(now, nodes);
      if (flap !== null) {
        this.logger.log(
          `Geo concentration not reported: ${describeFlap(flap)} — the concentration ` +
            'this run would describe is the node change, not the user base',
        );
        return [];
      }

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

      const alerts: OperationalAlert[] = [];

      for (const [country, users] of Object.entries(countryUsers)) {
        const pct = (users / totalOnline) * 100;
        const band = totalOnline > GEO_MIN_ONLINE ? geoConcentrationBand(pct) : null;
        if (band === null) {
          this.lastGeoBandByCountry.delete(country);
          continue;
        }
        if (this.lastGeoBandByCountry.get(country) === band) continue;
        this.lastGeoBandByCountry.set(country, band);

        alerts.push({
          type: OPERATIONAL_EVENT_TYPES.NODE_GEO_CONCENTRATION,
          category: 'NODE',
          severity: 'INFO',
          message: `${pct.toFixed(0)}% of online users (${users}/${totalOnline}) are connected through ${country} nodes`,
          dedupeKey: `geo|${country}|${band}`,
          metadata: {
            kind: 'geo_concentration',
            band,
            country,
            usersInCountry: users,
            totalOnline,
            percentInCountry: Math.round(pct * 10) / 10,
            allCountries: countryUsers,
          },
        });
      }

      return alerts;
    } catch (error) {
      this.logger.warn(`Geo concentration collection failed: ${(error as Error).message}`);
      return [];
    }
  }

  // ── Operational alert: offline nodes ───────────────────────────────────

  /**
   * Nodes that are enabled but not connected.
   *
   * The operator's complaint, verbatim, was that anti-fraud "should not fire
   * when a node goes down and then say the user is committing fraud". This was
   * that: `NODES_OFFLINE` opened a fraud signal, HIGH-severity once more than
   * two nodes were down, which the severity→action policy escalates to a
   * notification. Nothing about a node being unreachable is a customer's doing.
   *
   * It now emits the same event type (`node.connection_lost`) the panel's own
   * webhook forwards for this condition — so a polled outage and a pushed one
   * land in the same place, with the same label, and the panel's push is not
   * required for the outage to be seen.
   *
   * The dedupe key is the SORTED, full uuid list. It was
   * `offline_${count}_${uuids.slice(0, 4).join('')}` over an array `getAllNodes`
   * does not sort, so the identical outage in a different panel ordering minted
   * a second HIGH signal — and the 4-char uuid prefixes could collide besides.
   */
  public async collectOfflineNodeAlerts(_now: Date): Promise<readonly OperationalAlert[]> {
    try {
      const nodes = await this.remnawaveApiService.getAllNodes();
      if (!nodes || nodes.length === 0) return [];

      const offlineNodes = nodes
        .filter((n) => !n.isConnected && !n.isDisabled && !n.isConnecting)
        .sort((a, b) => a.uuid.localeCompare(b.uuid));

      if (offlineNodes.length === 0) {
        this.lastOfflineNodesKey = null;
        return [];
      }

      const dedupeKey = `nodes_offline|${offlineNodes.map((n) => n.uuid).join(',')}`;
      if (this.lastOfflineNodesKey === dedupeKey) return [];
      this.lastOfflineNodesKey = dedupeKey;

      return [
        {
          type: EVENT_TYPES.NODE_CONNECTION_LOST,
          category: 'NODE',
          severity: 'WARNING',
          message: `${offlineNodes.length} node(s) offline: ${offlineNodes
            .map((n) => `${n.name} (${n.countryCode})`)
            .join(', ')}`,
          dedupeKey,
          metadata: {
            kind: 'nodes_offline',
            offlineCount: offlineNodes.length,
            // The generic Telegram formatter renders a node block from
            // `nodeName` / `nodeUuid`; give it the first node so a single-node
            // outage (the common case) gets the same card as the panel's push.
            nodeName: offlineNodes[0].name,
            nodeUuid: offlineNodes[0].uuid,
            countryCode: offlineNodes[0].countryCode,
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
      this.logger.warn(`Offline node collection failed: ${(error as Error).message}`);
      return [];
    }
  }

  // ── Node stability guard ───────────────────────────────────────────────

  /**
   * Did any node's connectivity change in the last
   * {@link NODE_STABILITY_WINDOW_MINUTES} minutes?
   *
   * Two independent sources, either of which is enough:
   *
   *   1. `RemnawaveMetricSample.nodesSnapshot` — the metrics collector writes a
   *      per-node `isConnected` every 5 minutes and keeps 7 days. A uuid
   *      observed both connected and disconnected inside the window flapped.
   *      The live node list counts as the newest observation, so a node that
   *      dropped since the last sample is caught without waiting for one.
   *   2. `node.lastStatusChange` — the panel's own timestamp for the last
   *      connect/disconnect. Covers the case the snapshot cannot: a deployment
   *      with no sample history yet, where source 1 has nothing to compare.
   *
   * Returns `null` when neither source shows a change — including when neither
   * source has anything to say. Failing closed there would be worse than the
   * bug: a panel whose metrics collector is not running would have every
   * user-naming detector silently disabled forever, which is precisely the
   * "detector that can never fire" shape this codebase has been bitten by. The
   * absence of history is logged instead.
   */
  private async findRecentNodeFlap(
    now: Date,
    liveNodes: readonly RemnawaveNodeInterface[],
  ): Promise<NodeFlapEvidence | null> {
    const windowStart = now.getTime() - NODE_STABILITY_WINDOW_MINUTES * 60_000;

    // Source 2 first — it is free, it is already in hand, and it needs no query.
    const recentlyChanged = liveNodes
      .filter((n) => !n.isDisabled)
      .filter((n) => {
        const changedAt = n.lastStatusChange ? Date.parse(n.lastStatusChange) : NaN;
        return Number.isFinite(changedAt) && changedAt >= windowStart;
      })
      .map((n) => n.name || n.uuid);
    if (recentlyChanged.length > 0) {
      return {
        source: 'panel_status_change',
        nodes: [...recentlyChanged].sort(),
        windowMinutes: NODE_STABILITY_WINDOW_MINUTES,
      };
    }

    // Source 1 — snapshot history.
    let samples: readonly { nodesSnapshot: unknown }[] = [];
    try {
      samples = await this.prismaService.remnawaveMetricSample.findMany({
        where: { createdAt: { gte: new Date(windowStart) } },
        select: { nodesSnapshot: true },
        orderBy: { createdAt: 'asc' },
      });
    } catch (error) {
      // No history available (no table access, no metrics module in this
      // runtime). Source 2 already ran and found nothing.
      this.logger.debug(
        `Node stability history unavailable: ${(error as Error).message} — ` +
          'falling back to the panel status timestamps alone',
      );
      return null;
    }

    if (samples.length === 0) {
      this.logger.debug(
        `No node snapshots in the last ${NODE_STABILITY_WINDOW_MINUTES}m — ` +
          'stability judged from panel status timestamps alone',
      );
      return null;
    }

    // uuid → the set of connectivity states observed inside the window.
    const observed = new Map<string, { name: string; states: Set<boolean> }>();
    const record = (uuid: string, name: string, connected: boolean): void => {
      const entry = observed.get(uuid);
      if (entry) {
        entry.states.add(connected);
        return;
      }
      observed.set(uuid, { name: name || uuid, states: new Set([connected]) });
    };

    for (const sample of samples) {
      for (const entry of parseNodesSnapshot(sample.nodesSnapshot)) {
        record(entry.uuid, entry.name, entry.isConnected);
      }
    }
    for (const node of liveNodes) {
      if (node.isDisabled) continue;
      record(node.uuid, node.name, node.isConnected);
    }

    const flapped = [...observed.values()]
      .filter((entry) => entry.states.size > 1)
      .map((entry) => entry.name)
      .sort();
    if (flapped.length === 0) return null;

    return {
      source: 'metric_snapshots',
      nodes: flapped,
      windowMinutes: NODE_STABILITY_WINDOW_MINUTES,
    };
  }

  /**
   * A suppressed run has to be visible, so every one of them logs — a skipped
   * detector that leaves no trace is indistinguishable from a clean panel, and
   * that confusion is what this whole change is about. WARN on the transition
   * into suppression, LOG on each subsequent suppressed run: unlike the
   * `perUserTrafficBlind` latch above (a broken endpoint that stays broken for
   * weeks, hence transition-only), node instability is a bounded incident, so a
   * line per 5-minute run tracks a real event and stops when it does.
   */
  private logNodeFlapSuppression(flap: NodeFlapEvidence): void {
    const message =
      `Per-user traffic detection skipped: ${describeFlap(flap)}. ` +
      'A node change moves every user\'s share of the cohort, so this run has no ' +
      'cohort to accuse anybody against.';
    if (!this.nodeFlapSuppressionActive) {
      this.nodeFlapSuppressionActive = true;
      this.logger.warn(message);
      return;
    }
    this.logger.log(message);
  }
}

// ── Operational alert contract ───────────────────────────────────────────────

/**
 * An infrastructure fact for the operator channel (`SystemEventsService`).
 *
 * Deliberately NOT a `FraudSignalCandidate`: it has no `score`, no
 * `confidence`, and no `affectedUserIds`, because none of those mean anything
 * about a node. `dedupeKey` is the detector's own edge-trigger identity and is
 * carried on the alert so a test can assert it directly.
 */
export interface OperationalAlert {
  readonly type: string;
  readonly category: SystemEventCategory;
  readonly severity: SystemEventSeverity;
  readonly message: string;
  readonly dedupeKey: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

/**
 * Event types these alerts use that the shared registry does not have yet.
 *
 * `node.connection_lost` and `node.traffic_notify` already exist in
 * `EVENT_TYPES` (the panel forwards both), so those are used directly. These
 * two have no counterpart. They follow the same `category.verb` convention and
 * are declared here rather than in `EVENT_TYPES` because this change is scoped
 * to the anti-fraud module — they should be promoted into the shared registry,
 * `EVENT_PRESENTATION`, and the operator's selectable catalogue in
 * `web/src/features/notifications/notifications-page.tsx`. Until they are, both
 * still reach the audit log, the realtime dashboard feed, and Telegram in `all`
 * mode; only the `selected` mode filter cannot tick them.
 */
export const OPERATIONAL_EVENT_TYPES = {
  NODE_GEO_CONCENTRATION: 'node.geo_concentration',
  REMNAWAVE_HWID_AVERAGE_HIGH: 'remnawave.hwid_average_high',
} as const;

/** Why a user-naming run was suppressed, and by which evidence. */
export interface NodeFlapEvidence {
  readonly source: 'panel_status_change' | 'metric_snapshots';
  readonly nodes: readonly string[];
  readonly windowMinutes: number;
}

// ── Thresholds ───────────────────────────────────────────────────────────────

/**
 * How long a node connectivity change keeps the user-naming detectors quiet.
 *
 * 30 minutes = six collector samples and six detector runs. Chosen from the
 * 5-minute cadence both sides run at: a shorter window (10m = 2 samples) can
 * see only one edge of a flap, so a node that drops and returns between two
 * runs would leave the cohort disturbed but the guard unarmed. Longer (hours)
 * starts to weaken real detection — after a routine node restart a genuine
 * offender would go unreported for the rest of the window, and the brief for
 * this change is explicit that missing genuine abuse is not an acceptable
 * trade. 30m also covers the reconnect tail: users do not all come back the
 * instant the node does, so the cohort keeps moving for several minutes after
 * connectivity is nominally restored.
 */
const NODE_STABILITY_WINDOW_MINUTES = 30;

/**
 * Smallest cohort the per-user detector will judge anybody against.
 *
 * The old gate was 3. With three samples `totals[floor(3/2)]` is the middle
 * value, so "at least 4x the median" only says the top user is 4x the SECOND of
 * three — routine between a heavy user and a light one, and it flips the moment
 * one of the three leaves the aggregate. At 5 the median has two samples either
 * side, so clearing the multiplier means beating the entire lower half, and no
 * single user entering or leaving can move the median more than one rank.
 */
const MIN_COHORT_FOR_ANY_TEST = 5;

/**
 * CONFIDENCE CEILING for the per-user traffic detector — the most its evidence
 * can be worth with a large cohort, both tests firing well past their
 * thresholds, and a complete read.
 *
 * It is the literal this detector used to report about every offender it ever
 * named, kept as the ceiling so the top of the range is unchanged and the
 * evidence model can only move a signal DOWN from what was previously claimed
 * unconditionally. The lowest ceiling in the module, and rightly: heavy traffic
 * on a VPN is the most innocently explicable of everything anti-fraud looks at.
 * See `confidence.util.ts`.
 */
const NODE_TRAFFIC_CONFIDENCE = 55;

/**
 * Data-quality multiplier when the per-user bandwidth response came back at the
 * adapter's row ceiling, so the cohort is the panel's TOP N and not its
 * population.
 *
 * Half rather than something smaller: the rows we hold are real and the heavy
 * end of the distribution — the part an outlier test actually compares against
 * — is exactly the part that survives truncation. What is lost is the light
 * tail, which is what makes the median a baseline at all, so the damage is
 * severe but not total.
 */
const SATURATED_COHORT_QUALITY = 0.5;

/** Panel-wide device-average bands: the detector's own notable/high cutoffs. */
const HWID_AVERAGE_NOTABLE_BAND = 3;
const HWID_AVERAGE_HIGH_BAND = 5;

/** Below this many users online, a country percentage is noise. */
const GEO_MIN_ONLINE = 10;

// ── Helpers ──────────────────────────────────────────────────────────────────

/** `null` when the average is unremarkable; otherwise the band it crossed. */
function hwidAverageBand(avgDevices: number): number | null {
  if (avgDevices > HWID_AVERAGE_HIGH_BAND) return HWID_AVERAGE_HIGH_BAND;
  if (avgDevices > HWID_AVERAGE_NOTABLE_BAND) return HWID_AVERAGE_NOTABLE_BAND;
  return null;
}

/** `null` below 90%; otherwise 90, 95 or 100 — never the measured percent. */
function nodeTrafficBand(usagePercent: number): number | null {
  if (usagePercent >= 100) return 100;
  if (usagePercent >= 95) return 95;
  if (usagePercent > 90) return 90;
  return null;
}

/** `null` at or below 80%; otherwise 80, 90 or 100 — never the measured percent. */
function geoConcentrationBand(pct: number): number | null {
  if (pct >= 100) return 100;
  if (pct >= 90) return 90;
  if (pct > 80) return 80;
  return null;
}

function describeFlap(flap: NodeFlapEvidence): string {
  const source =
    flap.source === 'panel_status_change'
      ? 'the panel reports a status change'
      : 'the node snapshots disagree';
  return `${source} within the last ${flap.windowMinutes}m for ${flap.nodes.join(', ')}`;
}

interface NodeSnapshotEntry {
  readonly uuid: string;
  readonly name: string;
  readonly isConnected: boolean;
}

/** Tolerant read of `RemnawaveMetricSample.nodesSnapshot` (untyped JSON). */
function parseNodesSnapshot(raw: unknown): readonly NodeSnapshotEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: NodeSnapshotEntry[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const uuid = record['uuid'];
    const isConnected = record['isConnected'];
    if (typeof uuid !== 'string' || uuid.length === 0) continue;
    if (typeof isConnected !== 'boolean') continue;
    out.push({
      uuid,
      name: typeof record['name'] === 'string' ? record['name'] : uuid,
      isConnected,
    });
  }
  return out;
}

function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function clampScore(value: number): number {
  if (value < 0) return 0;
  if (value > 100) return 100;
  return Math.round(value);
}

function formatGb(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  if (gb >= 1024) return `${(gb / 1024).toFixed(1)} TB`;
  return `${gb.toFixed(1)} GB`;
}
