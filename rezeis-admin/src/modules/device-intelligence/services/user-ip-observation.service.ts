import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { shouldRunSchedules } from '../../../common/runtime/process-role.util';
import { NodeAddressesService } from '../../remnawave/services/node-addresses.service';
import { classifyCascadeIp } from '../../users/utils/cascade-ip.util';

/** One address an account has been seen from, as the card renders it. */
export interface UserIpSummary {
  readonly address: string;
  readonly hits: number;
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date;
  /** Blocked accounts also seen from it. Empty for almost every address. */
  readonly sharedWithBlocked: readonly string[];
}

/** One prior sighting of an address on somebody else's account. */
export interface IpMatch {
  readonly userId: string;
  readonly hits: number;
  readonly lastSeenAt: Date;
}

/**
 * How long an observation is kept.
 *
 * Ninety days. These are movement traces rather than a browser fingerprint, and
 * an address a person used once last spring answers nothing anybody is asking.
 * Bounded here rather than "when somebody remembers", because a table nobody
 * prunes is a table that quietly becomes a permanent location history.
 */
const RETENTION_DAYS = 90;

/**
 * Where an account has been seen from, and who else was there.
 *
 * ── Why this is not simply an access log ──────────────────────────────────
 *
 * This is a VPN product, which inverts the usual reasoning about addresses. A
 * customer browsing the cabinet WHILE CONNECTED arrives from one of our own
 * exit nodes, and so does every other customer behind it. Recording those and
 * grouping on them would produce a map of who was on which node, presented as a
 * map of people — the kind of confident-looking output somebody then makes
 * decisions from.
 *
 * Mobile carriers do the same through CGNAT, thousands of subscribers behind
 * one address, so a match there links strangers.
 *
 * ── One function decides, and it is the ban's own ─────────────────────────
 *
 * `classifyCascadeIp` already answers "may this address be attributed to a
 * person" for the block cascade: it refuses our nodes, CGNAT, private ranges,
 * and — crucially — refuses when the node list could not be read at all,
 * because `getAllNodes()` reports a failure as an empty list. Asking the same
 * question a second way here would eventually disagree with it, and the
 * disagreement would show up as either a missed evader or a node's worth of
 * customers recorded as one person.
 */
@Injectable()
export class UserIpObservationService {
  private readonly logger = new Logger(UserIpObservationService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly nodeAddresses: NodeAddressesService,
  ) {}

  /**
   * Notes that `userId` was seen from `address`, when the address is one that
   * may be attributed to a person at all.
   *
   * Silent about refusals by design: the overwhelmingly common one is "the
   * customer is on our VPN", which happens on most sessions of a working
   * product and is not worth a log line each time.
   */
  public async record(
    userId: string,
    address: string | null | undefined,
    /**
     * The node list, when the caller already holds one.
     *
     * A batch caller MUST pass it. `NodeAddressesService.read()` is an uncached
     * panel call, and recording a few thousand addresses one at a time without
     * this issued a few thousand sequential fetches of the identical answer —
     * minutes of an hourly job spent re-asking one question, and a flood
     * against the very panel whose failure makes the whole classification
     * refuse.
     */
    nodes?: readonly (readonly string[])[] | null,
  ): Promise<boolean> {
    if (typeof address !== 'string' || address.trim().length === 0) return false;
    const verdict = classifyCascadeIp({
      address,
      nodes: nodes !== undefined ? nodes : await this.nodeAddresses.read(),
    });
    if (!verdict.capture) return false;

    try {
      await this.prismaService.userIpObservation.upsert({
        where: { userId_address: { userId, address: verdict.value } },
        create: { userId, address: verdict.value },
        // A repeat sighting bumps the counter rather than adding a row, which
        // is what keeps this table proportional to PLACES rather than to page
        // views — and what makes `hits` mean something.
        update: { lastSeenAt: new Date(), hits: { increment: 1 } },
      });
      return true;
    } catch (err) {
      // Never fatal. This is a background observation attached to a request the
      // customer made for their own reasons.
      this.logger.warn(`Could not record an address observation: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * Blocked accounts previously seen from this address.
   *
   * Answers "same place", never "same person": households, offices and shared
   * connections are ordinary. Every caller MARKS on this and refuses nothing.
   */
  public async blockedMatches(address: string | null | undefined): Promise<readonly IpMatch[]> {
    if (typeof address !== 'string' || address.trim().length === 0) return [];
    // Normalised through the same classifier, so a lookup cannot miss a stored
    // row over spelling. The node/CGNAT refusals apply here too, and correctly:
    // an address we would not record is one we must not match on either.
    const verdict = classifyCascadeIp({
      address,
      nodes: await this.nodeAddresses.read(),
    });
    if (!verdict.capture) return [];

    const rows = await this.prismaService.userIpObservation.findMany({
      where: { address: verdict.value, user: { isBlocked: true } },
      select: { userId: true, hits: true, lastSeenAt: true },
      orderBy: { hits: 'desc' },
      take: 5,
    });
    return rows;
  }

  /**
   * The addresses one account has been seen from, and who else was there.
   *
   * ── What an operator is looking at ────────────────────────────────────
   *
   * `sharedWithBlocked` is the only part worth acting on, and it still says
   * "same place" rather than "same person" — households, offices and shared
   * connections are ordinary, and this product moves people's traffic for a
   * living. `hits` is what separates a home connection from somewhere passed
   * through once.
   *
   * Bounded to the busiest handful: a card is read, not audited, and twenty
   * addresses would be a wall nobody looks at twice.
   */
  public async listForUser(userId: string): Promise<readonly UserIpSummary[]> {
    const rows = await this.prismaService.userIpObservation.findMany({
      where: { userId },
      select: { address: true, hits: true, firstSeenAt: true, lastSeenAt: true },
      orderBy: [{ hits: 'desc' }, { lastSeenAt: 'desc' }],
      take: 8,
    });
    if (rows.length === 0) return [];

    // One query for the whole set rather than one per address: a card that
    // costs eight round trips is a card somebody stops opening.
    const shared = await this.prismaService.userIpObservation.findMany({
      where: {
        address: { in: rows.map((row) => row.address) },
        userId: { not: userId },
        user: { isBlocked: true },
      },
      select: { address: true, userId: true },
    });
    const blockedByAddress = new Map<string, string[]>();
    for (const row of shared) {
      const list = blockedByAddress.get(row.address) ?? [];
      list.push(row.userId);
      blockedByAddress.set(row.address, list);
    }

    return rows.map((row) => ({
      address: row.address,
      hits: row.hits,
      firstSeenAt: row.firstSeenAt,
      lastSeenAt: row.lastSeenAt,
      sharedWithBlocked: blockedByAddress.get(row.address) ?? [],
    }));
  }

  /**
   * Drops observations past {@link RETENTION_DAYS}.
   *
   * ── Why this runs on a clock and not on somebody remembering ──────────
   *
   * A table nobody prunes quietly becomes a permanent location history. That is
   * not what was built here and not what anybody agreed to, and the difference
   * between the two is entirely whether this job exists.
   *
   * Daily, in the small hours: the work is a single indexed DELETE over a
   * bounded slice, and running it more often would only make it smaller.
   */
  @Cron(CronExpression.EVERY_DAY_AT_4AM, { name: 'user-ip-observation-prune' })
  public async pruneScheduled(): Promise<void> {
    if (!shouldRunSchedules()) return;
    try {
      await this.prune();
    } catch (err) {
      this.logger.warn(`Address observation prune failed: ${(err as Error).message}`);
    }
  }

  public async prune(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const outcome = await this.prismaService.userIpObservation.deleteMany({
      where: { lastSeenAt: { lt: cutoff } },
    });
    if (outcome.count > 0) {
      this.logger.log(`Pruned ${outcome.count} address observation(s) older than ${RETENTION_DAYS}d`);
    }
    return outcome.count;
  }
}
