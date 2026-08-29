import { Injectable, Logger } from '@nestjs/common';
import { SubscriptionStatus } from '@prisma/client';
import { Cron, CronExpression } from '@nestjs/schedule';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { parsePanelId } from '../../anti-fraud/sharing-detection.util';
import { shouldRunSchedules } from '../../../common/runtime/process-role.util';
import { PanelDevicesClient } from '../../remnawave/services/panel-devices.client';
import { NodeAddressesService } from '../../remnawave/services/node-addresses.service';
import { PanelInfraClient } from '../../remnawave/services/panel-infra.client';
import { UserIpObservationService } from './user-ip-observation.service';

/**
 * Ceiling on one run. A panel with more concurrent connections than this has a
 * scale problem this collector is not the place to solve, and an unbounded
 * resolve would put a query with tens of thousands of ids in front of the
 * database once an hour.
 */
const MAX_USERS_PER_RUN = 2000;

/**
 * Records the addresses customers actually connect to the VPN from.
 *
 * ── Why this source and not the cabinet ───────────────────────────────────
 *
 * The cabinet sees a customer's address only when they are NOT using the
 * product: browsing while connected arrives from one of our own exit nodes,
 * which says nothing about them. The tunnel is the other way round — a client
 * establishes it FROM the customer's real address, because that is what
 * connecting means. So the panel's connection list is the one place their true
 * origin is visible, and it is visible for everybody who actually uses the
 * service rather than only for those who happened to open a browser tab off-VPN.
 *
 * ── Why hourly, and why a job of its own ──────────────────────────────────
 *
 * `SharingDetectors.detectConcurrentIpSharing` already polls the same endpoint
 * every five minutes, and reusing that poll was the obvious idea. It resolves
 * only OFFENDERS into rezeis accounts — a handful — while recording history
 * means resolving everybody online, which would turn a cheap detector run into
 * a thousands-row lookup every five minutes.
 *
 * A history does not need five-minute resolution. Hourly is a twelfth of the
 * load, keeps the detector untouched, and answers the question this table
 * exists for — "has this address been seen on a blocked account" — just as
 * well.
 *
 * ── What is NOT recorded ──────────────────────────────────────────────────
 *
 * `UserIpObservationService` still applies `classifyCascadeIp`, so private
 * ranges and carrier NAT are refused here too. The node exclusion is close to
 * a no-op on this path by construction — these addresses are where customers
 * come FROM — but it stays in force rather than being special-cased away: a
 * node connecting through another node is not a shape worth hand-waving about.
 */
@Injectable()
export class ConnectionIpCollectorService {
  private readonly logger = new Logger(ConnectionIpCollectorService.name);

  /** True while a run is in flight, so an overlapping tick stands down. */
  private running = false;

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly infraClient: PanelInfraClient,
    private readonly nodeAddresses: NodeAddressesService,
    private readonly devicesClient: PanelDevicesClient,
    private readonly observations: UserIpObservationService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR, { name: 'connection-ip-collector' })
  public async tick(): Promise<void> {
    if (!shouldRunSchedules()) return;
    if (this.running) {
      this.logger.debug('Connection address collection still running; this tick stands down');
      return;
    }
    this.running = true;
    try {
      await this.collect();
    } catch (err) {
      this.logger.warn(`Connection address collection failed: ${(err as Error).message}`);
    } finally {
      // `finally`, so one throw cannot silence the collector for the lifetime
      // of the process.
      this.running = false;
    }
  }

  public async collect(): Promise<{ readonly recorded: number; readonly seen: number }> {
    const nodeList = await this.infraClient.getNodes();
    if (nodeList.kind !== 'ok') {
      // "We could not look" is not "nobody is connected". Said once and
      // abandoned rather than treated as an empty panel.
      this.logger.warn('Connection address collection skipped: the node list is unreadable');
      return { recorded: 0, seen: 0 };
    }

    // panelId → the addresses it was seen connecting from.
    const byPanelId = new Map<number, Set<string>>();
    for (const node of nodeList.data.filter((n) => n.isConnected && !n.isDisabled)) {
      const rows = await this.devicesClient.fetchNodeConnections(node.uuid);
      // `null` is "this node could not be read", not "this node was quiet" —
      // the same distinction the sharing detector turns on. Skipped, never
      // counted as an empty node.
      if (rows === null) continue;
      for (const row of rows) {
        // `parsePanelId`, not `Number()`. The field's runtime spelling varies by
        // panel version — 2.x sends a string, 3.x a number — and the job reader
        // casts rather than validates, so the coercing branch is live. `Number`
        // turns `''`, `null`, `true`, `'42.0'` and `'0x2A'` into valid-looking
        // ids belonging to somebody else; the shared parser refuses all of them.
        const panelId = parsePanelId(row.userId);
        if (panelId === null) continue;
        let addresses = byPanelId.get(panelId);
        if (addresses === undefined) {
          addresses = new Set<string>();
          byPanelId.set(panelId, addresses);
        }
        // Guarded: `readJobRows` casts rather than validates, so a panel that
        // omits `ips` would throw out of the whole run — taking every node not
        // yet visited with it.
        if (!Array.isArray(row.ips)) continue;
        for (const sample of row.ips) {
          if (typeof sample.ip === 'string' && sample.ip.length > 0) addresses.add(sample.ip);
        }
        // Checked HERE, inside the row loop, not between nodes. Between nodes
        // the cap could only ever overshoot: one busy node with fifty thousand
        // connections put all fifty thousand into the `IN` list the constant
        // exists to bound.
        if (byPanelId.size >= MAX_USERS_PER_RUN) break;
      }
      if (byPanelId.size >= MAX_USERS_PER_RUN) break;
    }
    if (byPanelId.size === 0) return { recorded: 0, seen: 0 };

    // One query for the whole batch. `remnawavePanelId` is the 3.x address; a
    // subscription linked before the upgrade carries a uuid in `remnawaveId`
    // instead and is simply not resolvable by panel id — those are skipped
    // rather than guessed at, because attributing an address to the wrong
    // account is worse than not recording it.
    const rows = await this.prismaService.subscription.findMany({
      where: {
        remnawavePanelId: { in: [...byPanelId.keys()] },
        // DELETED rows keep their panel id, and a panel id is NOT unique in
        // this schema. Without this filter a live subscription for customer B
        // competed with a deleted one from customer A for the same id, the
        // unordered read decided which won, and B's home address could be
        // written onto A's account — where, if A is ever blocked, it comes back
        // as evidence against B.
        status: { not: SubscriptionStatus.DELETED },
      },
      select: { remnawavePanelId: true, userId: true, createdAt: true },
      // Deterministic tie-break for the ids that still collide, matching what
      // the sharing detector does with the same ambiguity.
      orderBy: { createdAt: 'desc' },
    });
    const userIdByPanelId = new Map<number, string>();
    const ambiguous: number[] = [];
    for (const row of rows) {
      if (row.remnawavePanelId === null) continue;
      const existing = userIdByPanelId.get(row.remnawavePanelId);
      if (existing !== undefined) {
        // Two LIVE subscriptions on one panel id is a state nobody can resolve
        // from here, and guessing attributes a person's address to a stranger.
        // Recorded for nobody, and said out loud.
        if (existing !== row.userId) ambiguous.push(row.remnawavePanelId);
        continue;
      }
      userIdByPanelId.set(row.remnawavePanelId, row.userId);
    }
    for (const panelId of ambiguous) userIdByPanelId.delete(panelId);
    if (ambiguous.length > 0) {
      this.logger.warn(
        `Skipped ${ambiguous.length} panel id(s) claimed by more than one live subscription — ` +
          'an address cannot be attributed without guessing whose it is',
      );
    }

    // Read ONCE for the whole run and handed down. Per-address it was one
    // uncached panel call each, thousands of them, sequentially.
    const nodes = await this.nodeAddresses.read();
    if (nodes === null || nodes.length === 0) {
      // Refusing everything anyway, so say why rather than logging a run that
      // recorded nothing and looked successful.
      this.logger.warn(
        'Connection address collection recorded nothing: the node list is unreadable, so no ' +
          'address can be told from one of our own exits',
      );
      return { recorded: 0, seen: byPanelId.size };
    }

    let recorded = 0;
    for (const [panelId, addresses] of byPanelId) {
      const userId = userIdByPanelId.get(panelId);
      if (userId === undefined) continue;
      for (const address of addresses) {
        if (await this.observations.record(userId, address, nodes)) recorded += 1;
      }
    }
    this.logger.log(
      `Recorded ${recorded} connection address observation(s) across ${userIdByPanelId.size} account(s)`,
    );
    return { recorded, seen: byPanelId.size };
  }
}
