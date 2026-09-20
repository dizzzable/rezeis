import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma, SubscriptionStatus } from '@prisma/client';

import { RawCacheService } from '../../../common/cache/raw-cache.service';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { shouldRunSchedules } from '../../../common/runtime/process-role.util';
import { EVENT_TYPES, SystemEventsService } from '../../../common/services/system-events.service';
import { planNamesMetadata } from '../../../common/utils/plan-snapshot.util';
import { panelUserAddress, storedIdentityOf } from '../../remnawave/services/panel-user-address';
import { RemnawaveApiService } from '../../remnawave/services/remnawave-api.service';
import type { RemnawaveUserAddressing } from '../../remnawave/services/panel-version.util';
import { panelIdentityWhere } from '../../remnawave/services/remnawave-webhook.service';
import {
  claimFirstTraffic,
  connectEvidenceOf,
  firstTrafficEventDue,
  recordCheck,
  recordConnectEvidence,
  recordProbeFailure,
  recordProfileMissing,
} from '../connect-evidence.util';
import { readConnectHelpSettings } from '../connect-help-settings';
import { probeBacklogSql, probeCandidatesSql, type ProbeCandidateRow } from '../connect-probe.sql';
import {
  CONNECT_PROBE_BATCH,
  CONNECT_PROBE_CONCURRENCY,
  CONNECT_PROBE_CRON,
  CONNECT_PROBE_READ_DEADLINE_MS,
  CONNECT_PROBE_STATUS_KEY,
} from '../connect-signal.constants';

/**
 * What one read of one profile came to.
 *
 *   connected / not_connected  the panel answered with a traffic block;
 *   missing                    the panel's own USER_NOT_FOUND — recorded, never
 *                              read as "not connected";
 *   unavailable                no usable answer: an outage, the deadline, a body
 *                              or a block we cannot decode — counted, nothing
 *                              stamped;
 *   unaddressable              the profile cannot be named on this panel at all
 *                              (a 2.x uuid on a 3.x panel with nothing else
 *                              recorded) — not asked, never verified;
 *   gone                       (re-check only) no live subscription with a
 *                              profile by that id.
 */
export type ProbeReadOutcome =
  | 'connected'
  | 'not_connected'
  | 'missing'
  | 'unavailable'
  | 'unaddressable'
  | 'gone';

/**
 * The probe's last cycle, mirrored into Redis for the API process to read
 * (`CONNECT_PROBE_STATUS_KEY`). Instants are ISO strings.
 */
export interface ConnectProbeStatus {
  readonly lastCycleAt: string;
  /** The last cycle in which the panel answered, or there was nothing to read. */
  readonly lastOkAt: string | null;
  readonly lastFailAt: string | null;
  readonly lastReason: string | null;
  /** Since when every cycle has failed; `null` while the probe is fine. */
  readonly failingSince: string | null;
  /** The first cycle that left no eligible subscription never tried. Kept once set. */
  readonly firstPassCompletedAt: string | null;
  readonly candidates: number;
  readonly connected: number;
  readonly notConnected: number;
  readonly missing: number;
  readonly failed: number;
  readonly unaddressable: number;
  /** Eligible subscriptions never tried yet, after this cycle. */
  readonly backlog: number;
  readonly durationMs: number;
}

/** The counts of one cycle. */
export interface ConnectProbeCycleResult {
  readonly candidates: number;
  readonly connected: number;
  readonly notConnected: number;
  readonly missing: number;
  readonly failed: number;
  readonly unaddressable: number;
  readonly backlog: number;
}

/** The value, or `null` when it did not arrive within `ms`. The work is left to finish on its own. */
async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** `work` over `items`, at most `limit` at a time. */
async function forEachLimited<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      await work(item);
    }
  });
  await Promise.all(lanes);
}

/**
 * THE PROBE — the connection signal for the subscriptions nobody else read.
 *
 * Webhooks are optional and lossy (three retries five seconds apart, then the
 * event is gone), and the cabinet read happens only when the customer opens
 * the cabinet. So every ten minutes the worker reads, one profile at a time, up
 * to a hundred live subscriptions of the last 30 days that are not known to
 * have connected: the ones the automatic help will decide within the hour
 * first, then those never read, then the longest unread. Each read is the
 * single-profile `GET` every Remnawave version serves with the traffic block,
 * three seconds at most, four in flight. No bulk-list walk.
 *
 * Worker only (`shouldRunSchedules`), one cycle at a time in the process. Its
 * last cycle is mirrored into Redis, where `ConnectSignalHealthService` — in
 * the API process — reads it.
 */
@Injectable()
export class ConnectSignalProbeService {
  private readonly logger = new Logger(ConnectSignalProbeService.name);

  /** True while a cycle runs, so an overlapping tick stands down. */
  private running = false;

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly remnawaveApiService: RemnawaveApiService,
    private readonly rawCacheService: RawCacheService,
    private readonly systemEvents: SystemEventsService,
  ) {}

  @Cron(CONNECT_PROBE_CRON, { name: 'connect-signal-probe' })
  public async tick(): Promise<void> {
    if (!shouldRunSchedules()) return;
    if (this.running) {
      this.logger.debug('Connection probe still running; this tick stands down');
      return;
    }
    this.running = true;
    try {
      await this.runCycle();
    } catch (error) {
      this.logger.error('Connection probe cycle failed', error instanceof Error ? error.stack : undefined);
    } finally {
      this.running = false;
    }
  }

  /**
   * One cycle: pick the batch, read it, write what the reads prove, and mirror
   * the result. A cycle that throws is mirrored as a failure before it throws.
   */
  public async runCycle(now: Date = new Date()): Promise<ConnectProbeCycleResult> {
    const startedAt = Date.now();
    let result: ConnectProbeCycleResult;
    try {
      result = await this.probeBatch(now);
    } catch (error) {
      await this.mirror(now, null, `error: ${(error as Error).message}`, Date.now() - startedAt);
      throw error;
    }
    await this.mirror(now, result, null, Date.now() - startedAt);
    return result;
  }

  /**
   * Re-reads ONE subscription now, the same way a cycle does, and writes what
   * the read proves. For the automatic sender's last look before it decides
   * (a fresh read unless its verification is minutes old).
   */
  public async recheck(subscriptionId: string, now: Date = new Date()): Promise<ProbeReadOutcome> {
    const row = await this.prismaService.subscription.findFirst({
      where: {
        id: subscriptionId,
        status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.LIMITED] },
        remnawaveId: { not: null },
      },
      select: {
        id: true,
        userId: true,
        remnawaveId: true,
        remnawavePanelId: true,
        remnawavePanelUsername: true,
        configUrl: true,
        planSnapshot: true,
      },
    });
    if (row === null || row.remnawaveId === null) return 'gone';
    const addressing = await this.readAddressing();
    return this.probeOne({ ...row, remnawaveId: row.remnawaveId, checkedAt: null, dueSoon: false }, addressing, now);
  }

  private async probeBatch(now: Date): Promise<ConnectProbeCycleResult> {
    const settings = await this.readSettings();
    const candidates = await this.prismaService.$queryRaw<ProbeCandidateRow[]>(
      probeCandidatesSql({ now, settings, limit: CONNECT_PROBE_BATCH }),
    );
    const addressing = candidates.length > 0 ? await this.readAddressing() : null;
    const tally = { connected: 0, notConnected: 0, missing: 0, failed: 0, unaddressable: 0 };
    await forEachLimited(candidates, CONNECT_PROBE_CONCURRENCY, async (candidate) => {
      const outcome = await this.probeOne(candidate, addressing, now);
      if (outcome === 'connected') tally.connected += 1;
      else if (outcome === 'not_connected') tally.notConnected += 1;
      else if (outcome === 'missing') tally.missing += 1;
      else if (outcome === 'unaddressable') tally.unaddressable += 1;
      else tally.failed += 1;
    });
    const backlogRows = await this.prismaService.$queryRaw<Array<{ readonly backlog: number }>>(
      probeBacklogSql(now),
    );
    return { candidates: candidates.length, ...tally, backlog: Number(backlogRows[0]?.backlog ?? 0) };
  }

  /** Reads one profile and writes what it proves. Never throws. */
  private async probeOne(
    candidate: ProbeCandidateRow,
    addressing: RemnawaveUserAddressing | null,
    now: Date,
  ): Promise<ProbeReadOutcome> {
    try {
      const identity = storedIdentityOf(candidate);
      if (identity === null) return 'unaddressable';
      // Asked BEFORE the read, because the adapter answers an unaddressable
      // profile with the same `unavailable` as an outage — and an install whose
      // only candidates are unreachable-by-design must not read as a dead panel.
      if (addressing !== null && panelUserAddress(identity, addressing).kind === 'impossible') {
        await recordProbeFailure(this.prismaService, candidate.id, now);
        return 'unaddressable';
      }
      const outcome = await withDeadline(
        this.remnawaveApiService.getPanelUserOutcome(identity),
        CONNECT_PROBE_READ_DEADLINE_MS,
      );
      if (outcome === null || outcome.kind === 'unavailable') {
        await recordProbeFailure(this.prismaService, candidate.id, now);
        return 'unavailable';
      }
      if (outcome.kind === 'missing') {
        await recordProfileMissing(this.prismaService, candidate.id, now);
        return 'missing';
      }
      const readAt = new Date();
      const evidence = connectEvidenceOf(outcome.user.userTraffic, readAt);
      if (evidence.kind === 'unknown') {
        // A row without a block we can read is a shape we cannot decode:
        // unavailable, never "not connected".
        await recordProbeFailure(this.prismaService, candidate.id, now);
        return 'unavailable';
      }
      const subscriptions = panelIdentityWhere(candidate.remnawaveId);
      if (evidence.kind === 'not_connected') {
        await recordCheck(this.prismaService, { subscriptions, checkedAt: readAt });
        return 'not_connected';
      }
      await recordConnectEvidence(this.prismaService, {
        subscriptions,
        at: evidence.at,
        source: 'probe',
        checkedAt: readAt,
      });
      await this.claimFirstTraffic(candidate, evidence.at, readAt);
      return 'connected';
    } catch (error) {
      this.logger.warn(`Connection probe failed for subscription ${candidate.id}: ${(error as Error).message}`);
      return 'unavailable';
    }
  }

  /** The person's `firstTrafficAt`, through the shared claim; the winner announces a fresh one. */
  private async claimFirstTraffic(candidate: ProbeCandidateRow, connectedAt: Date, now: Date): Promise<void> {
    const won = await claimFirstTraffic(this.prismaService, candidate.userId, connectedAt);
    if (!won || !firstTrafficEventDue(connectedAt, now)) return;
    const user = await this.prismaService.user.findUnique({
      where: { id: candidate.userId },
      select: { telegramId: true, name: true, username: true },
    });
    this.systemEvents.info(EVENT_TYPES.USER_FIRST_TRAFFIC, 'USER', 'User started using traffic', {
      userId: candidate.userId,
      ...(user?.telegramId !== null && user?.telegramId !== undefined
        ? { telegramId: user.telegramId.toString() }
        : {}),
      ...(user?.name ? { userName: user.name } : {}),
      ...(user?.username ? { username: user.username } : {}),
      subscriptionId: candidate.id,
      ...planNamesMetadata([candidate.planSnapshot]),
      remnawaveId: candidate.remnawaveId,
      connectedAt: connectedAt.toISOString(),
      source: 'PROBE',
    });
  }

  /** The panel's addressing, or `null` when it cannot be read — then nothing is pre-judged unaddressable. */
  private async readAddressing(): Promise<RemnawaveUserAddressing | null> {
    try {
      return (await this.remnawaveApiService.getPanelShape()).addressing;
    } catch {
      return null;
    }
  }

  /** The operator's «Помощь с подключением» switches, for the ordering only. */
  private async readSettings() {
    const rows = await this.prismaService.$queryRaw<Array<{ readonly settings: unknown }>>(
      Prisma.sql`SELECT "connect_help_settings" AS "settings" FROM "settings" ORDER BY "id" LIMIT 1`,
    );
    return readConnectHelpSettings(rows[0]?.settings ?? null);
  }

  /**
   * Mirrors the cycle into Redis, carrying forward what a single cycle cannot
   * know on its own (the last success, since when it has been failing, the
   * first pass). A cycle counts as OK when the panel answered at least once or
   * there was nothing it needed to be asked; as failed when every read it made
   * failed, or the cycle itself threw.
   */
  private async mirror(
    now: Date,
    result: ConnectProbeCycleResult | null,
    thrown: string | null,
    durationMs: number,
  ): Promise<void> {
    let previous: ConnectProbeStatus | null = null;
    try {
      previous = await this.rawCacheService.get<ConnectProbeStatus>(CONNECT_PROBE_STATUS_KEY);
    } catch (error) {
      this.logger.warn(`Could not read the probe status: ${(error as Error).message}`);
    }
    const at = now.toISOString();
    const answered = result !== null && result.connected + result.notConnected + result.missing > 0;
    const asked = result !== null && result.connected + result.notConnected + result.missing + result.failed > 0;
    const ok = result !== null && (answered || !asked);
    const status: ConnectProbeStatus = {
      lastCycleAt: at,
      lastOkAt: ok ? at : previous?.lastOkAt ?? null,
      lastFailAt: ok ? previous?.lastFailAt ?? null : at,
      lastReason: ok ? previous?.lastReason ?? null : thrown ?? 'unavailable',
      failingSince: ok ? null : previous?.failingSince ?? at,
      firstPassCompletedAt:
        previous?.firstPassCompletedAt ?? (ok && result !== null && result.backlog === 0 ? at : null),
      candidates: result?.candidates ?? 0,
      connected: result?.connected ?? 0,
      notConnected: result?.notConnected ?? 0,
      missing: result?.missing ?? 0,
      failed: result?.failed ?? 0,
      unaddressable: result?.unaddressable ?? 0,
      backlog: result?.backlog ?? previous?.backlog ?? 0,
      durationMs,
    };
    try {
      await this.rawCacheService.set(CONNECT_PROBE_STATUS_KEY, status);
    } catch (error) {
      this.logger.warn(`Could not mirror the probe status: ${(error as Error).message}`);
    }
    if (result !== null) {
      this.logger.log(
        `connect-signal probe: candidates=${result.candidates} connected=${result.connected} ` +
          `notConnected=${result.notConnected} missing=${result.missing} failed=${result.failed} ` +
          `unaddressable=${result.unaddressable} backlog=${result.backlog}`,
      );
    }
  }
}
