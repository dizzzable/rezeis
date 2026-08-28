import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  FraudSignal,
  FraudSignalSeverity,
  FraudSignalStatus,
  Prisma,
} from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { shouldRunSchedules } from '../../../common/runtime/process-role.util';
import {
  EVENT_TYPES,
  SystemEventsService,
} from '../../../common/services/system-events.service';
import { RequestMetadataInterface } from '../../auth/interfaces/request-metadata.interface';
import {
  PanelDevicesClient,
  type PanelDevicesOutcome,
  type PanelDropConnectionsBody,
} from '../../remnawave/services/panel-devices.client';
import { FraudDetectors } from '../detectors/fraud-detectors';
import { OperationalAlert, RemnawaveDetectors } from '../detectors/remnawave-detectors';
import { SharingDetectors } from '../detectors/sharing-detectors';
import { SubscriptionUaDetectors } from '../detectors/subscription-ua-detectors';
import {
  FraudSignalAction,
  FraudSignalCandidate,
  FraudSignalInterface,
  FraudSharingOffender,
  FraudTrendPoint,
  ListFraudSignalsQuery,
  ListFraudSignalsResult,
} from '../interfaces/fraud-signal.interface';

/**
 * Default action policy applied when a candidate is upserted. The map is
 * intentionally conservative: HIGH-severity signals notify operators,
 * MEDIUM/LOW stay silent and only show up in the UI.
 *
 * The map is overridable from settings later; for now we keep it inlined
 * and return the chosen action with the upsert so the audit trail and
 * realtime broadcast are accurate.
 */
const DEFAULT_ACTIONS_BY_SEVERITY: Readonly<Record<FraudSignalSeverity, FraudSignalAction>> = {
  HIGH: 'notify',
  MEDIUM: 'none',
  LOW: 'none',
};

// ── Signal-lifecycle tuning ────────────────────────────────────────────────

/** Ordering used to decide whether a re-detection is *worse* than the row. */
const SEVERITY_RANK: Readonly<Record<FraudSignalSeverity, number>> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
};

/**
 * How long a DISMISSED verdict suppresses re-creation of the same condition.
 *
 * "Dismiss — false positive" is a statement about the *rule*, not about the
 * minute it was pressed, so the window has to outlive the fingerprint that
 * carried it: every detector buckets its fingerprint by UTC day (or ISO week),
 * so a window shorter than a day would let the identical finding come back
 * under tomorrow's key and the operator would be pressing Dismiss daily.
 * Seven days ≈ 2016 detector runs silenced — long enough to be worth pressing,
 * short enough that a condition wrongly dismissed cannot hide for a quarter.
 */
const DISMISSAL_SUPPRESSION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How long a RESOLVED verdict suppresses re-creation.
 *
 * Much shorter than a dismissal: "resolved" means the operator *acted*
 * (dropped connections, warned the customer), so re-detection is genuine news
 * — but not five minutes later, before the action could take effect.
 */
const RESOLUTION_SUPPRESSION_MS = 6 * 60 * 60 * 1000;

/**
 * Per-affected-user cooldown between HIGH-severity operator notifications.
 *
 * Detectors run every 5 minutes, so an unthrottled condition is 12 pushes an
 * hour for the same person. One hour caps it at one, which is still faster
 * than any human response loop, and the throttle is derived from the fraud
 * rows themselves (`lastAction = 'notify'` + `detectedAt`) rather than from an
 * in-memory map — so a process restart cannot reset it.
 */
const NOTIFY_COOLDOWN_MS = 60 * 60 * 1000;

/**
 * How long a signal whose detection window has already closed must go without
 * re-detection before the reconcile pass ages it out.
 *
 * A day-bucketed fingerprint can never be produced again once the day rolls
 * over, so without this those rows are immortal. A full day of silence means
 * the key difference alone never closes anything — 288 consecutive runs
 * declined to re-raise it first.
 */
const STALE_BUCKET_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * How many consecutive OBSERVING runs must produce a condition before its
 * signal is allowed to open.
 *
 * Until now the first detection was the accusation. A momentary panel state, a
 * transient IP reading, one live-connection job caught mid-handoff — each was
 * enough to file a row against a paying customer and, at HIGH, to page someone.
 * Three runs at the 5-minute cadence is ~15 minutes of the condition refusing to
 * go away, which is short enough that no genuine abuse escapes (the abuse has to
 * stop within a quarter of an hour and never come back) and long enough that
 * nothing which merely blinked survives it.
 *
 * Set to 1 this constant disables the gate entirely, which is the honest reading
 * of "1 consecutive observation" — useful to know when reading the tests.
 */
const REQUIRED_OBSERVATIONS = 3;

/**
 * How far apart two observations may be and still count as consecutive.
 *
 * A streak is not "3 sightings ever", it is "3 sightings of the same episode".
 * Without a bound, a condition seen twice in March and once in July would open a
 * signal in July on the strength of March — the streak table has no other reason
 * to forget, because a run that could not observe deliberately does not break
 * the streak (see `reconcileCandidateStreaks`).
 *
 * One hour is twelve runs. It is far more than the 5-minute cadence needs, and
 * that slack is the point: a panel outage, a node-flap suppression or a
 * capability toggle can swallow eleven consecutive runs without costing the
 * streak. Longer than that and the evidence is stale enough that starting over —
 * fifteen more minutes — is the cheaper mistake.
 */
const STREAK_MAX_GAP_MS = 60 * 60 * 1000;

/**
 * How long an untouched streak row survives before the run deletes it.
 *
 * Streaks normally die on their own: on the run that opens the signal, and on
 * the run that could see the condition and did not name it. What is left over
 * is rows whose detector stopped speaking altogether — a retired detector, a
 * capability switched off, a panel that has been unreachable for a day. Those
 * can never contribute to a decision again (they are past `STREAK_MAX_GAP_MS`),
 * so keeping them only makes the pending list lie about what is being watched.
 *
 * Deliberately much longer than the gap bound: an exempted condition is
 * refreshed on every run and must never be swept, and a day of headroom means
 * this only ever removes something genuinely abandoned.
 */
const STREAK_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Upper bound on streak rows a single reconcile pass deletes. */
const STREAK_SCAN_LIMIT = 2000;

/** Upper bound on rows pulled by the fingerprint-family / verdict lookup. */
const RELATED_SCAN_LIMIT = 200;

/** Upper bound on OPEN rows examined by a single reconcile pass. */
const RECONCILE_SCAN_LIMIT = 1000;

/**
 * `resolutionNote` written when a run that could see the condition no longer
 * produced it. `resolvedBy` stays `null`, which is what separates a system
 * resolution from an operator's (`transitionStatus` always stamps an admin id).
 */
export const AUTO_RESOLVED_NOTE =
  'Auto-resolved by the detector run: the condition was no longer detected.';

/** `resolutionNote` written when a closed-window signal aged out. */
export const AUTO_SUPERSEDED_NOTE =
  'Auto-resolved by the detector run: the detection window closed and the condition ' +
  'was not re-detected for 24h.';

/**
 * How much an *empty* candidate list from a detector is worth.
 *
 * `authoritative` — the detector reads only local Postgres. It cannot "skip":
 * either the query ran (empty ⇒ the condition is genuinely absent) or it threw,
 * and a throw is visible to us as a rejected promise.
 *
 * `observational` — the detector reads the Remnawave panel and, by its own
 * documented contract, "fails soft so a panel outage never aborts the cron
 * detector batch". It returns `[]` when the panel is unreachable, when the
 * node-flap guard suppresses the run, and when the panel is too old for the
 * capability — none of which mean the condition cleared. An empty result from
 * one of these is therefore *no information at all*, and never auto-resolves.
 */
type DetectorEvidence = 'authoritative' | 'observational';

/** One detector in a run, with the codes it owns and its evidence class. */
interface DetectorPlanEntry {
  readonly name: string;
  readonly codes: readonly string[];
  readonly evidence: DetectorEvidence;
  readonly run: () => Promise<readonly FraudSignalCandidate[]>;
}

/** Result of an `upsertSignal` call — useful for logging and tests. */
interface UpsertSignalResult {
  readonly signal: FraudSignalInterface;
  /** Fingerprint of the row that was actually written (may carry a `#ts`). */
  readonly fingerprint: string;
  readonly action: FraudSignalAction;
  readonly created: boolean;
  /** True when this run raised the severity of an already-live signal. */
  readonly escalated: boolean;
}

/**
 * WHICH CODES HAVE TO WAIT, AND WHY IT IS NOT A SECOND LIST.
 *
 * The answer is already in the run plan. `DetectorEvidence` splits the detectors
 * by what an observation *is*:
 *
 *   `authoritative` — the detector counts rows this system already committed to
 *     Postgres. `EXCESSIVE_FAILED_PAYMENTS` counts FAILED transactions, `PROMO_ABUSE`
 *     counts promocode activations, `RAPID_REFERRAL_VELOCITY` counts referrals,
 *     `RAPID_CHURN` counts expired subscriptions. Those rows are immutable
 *     history: the fifth failed payment happened, and looking again in five
 *     minutes cannot make it un-happen. A second observation adds literally no
 *     information, so waiting for one would delay the signal by fifteen minutes
 *     and buy nothing. These do NOT wait.
 *
 *   `observational` — the detector reads a live snapshot of the Remnawave panel.
 *     `SUBSCRIPTION_SHARING_HWID` reads the device list (a stale HWID, a
 *     reinstall, a device the panel has not reaped yet),
 *     `SHARED_DEVICE_MULTI_ACCOUNT` reads the whole device inventory (a walk
 *     stopped at its ceiling, a user list that came back short, a profile
 *     whose subscription row is mid-write), `SUBSCRIPTION_SHARING_IP`
 *     reads which IPs were concurrent (a mobile handoff, CGNAT, a VPN reconnect),
 *     `NODE_TRAFFIC_USER_ABUSE` reads traffic counters against a moving median
 *     (a counter reset moves every node's share at once), `SUBSCRIPTION_UA_TUNNEL`
 *     reads the panel's subscription-request log (a truncated User-Agent, a
 *     numeric owner id the panel user list has not caught up with). Every one of
 *     these is a reading that can be wrong for a moment and right again by the
 *     next run. These DO wait.
 *
 * Deriving the set from the plan rather than restating it means a detector added
 * later is classified once, in the place its evidence class is already declared,
 * and cannot end up in one list but not the other.
 *
 * A code no detector in the run declares is not gated: we know nothing about how
 * its evidence behaves, and a streak nobody ever breaks would gate it forever.
 * `runDetectors` already warns loudly about undeclared codes.
 */
function codesRequiringSustainedEvidence(
  plan: readonly DetectorPlanEntry[],
): ReadonlySet<string> {
  const codes = new Set<string>();
  for (const entry of plan) {
    if (entry.evidence !== 'observational') continue;
    for (const code of entry.codes) codes.add(code);
  }
  return codes;
}

/** An exemption that is in force right now. */
interface ActiveExemption {
  readonly id: string;
  readonly userId: string;
  readonly codes: readonly string[];
  readonly expiresAt: Date;
  readonly reason: string;
}

/** Everything one detector run resolves once and shares across its candidates. */
interface RunContext {
  /** Live exemptions, indexed by the user they cover. */
  readonly exemptionsByUser: ReadonlyMap<string, readonly ActiveExemption[]>;
  /** Codes whose evidence class means a single sighting is not enough. */
  readonly gatedCodes: ReadonlySet<string>;
  /**
   * `code` + NUL + condition key for every candidate this run saw but declined
   * to file. Feeds the reconcile pass: "we chose not to act" is not "it cleared".
   */
  readonly heldConditions: Set<string>;
  /** `code` + NUL + condition key for every candidate this run observed at all. */
  readonly observedConditions: Set<string>;
}

/**
 * Why a run declined to open a candidate. Mirrors `held_by` in the table, which
 * is a plain string column with a `'streak'` default, so a new kind costs no
 * migration.
 *
 * `'verdict'` — an operator RESOLVED or DISMISSED this exact condition inside
 * its suppression window. It is recorded rather than left silent because the
 * pending surface exists to answer "which detector quietly stopped detecting",
 * and a mute that writes no row is indistinguishable from a clean panel.
 */
type CandidateHold = 'streak' | 'exemption' | 'verdict';

/** A candidate a run saw but did not file, as the operator UI reads it. */
export interface PendingFraudCandidateInterface {
  readonly id: string;
  readonly code: string;
  readonly conditionKey: string;
  readonly observations: number;
  readonly requiredObservations: number;
  readonly severity: FraudSignalSeverity;
  readonly lastSeverity: FraudSignalSeverity;
  readonly score: number;
  readonly title: string;
  readonly affectedUserIds: readonly string[];
  readonly heldBy: CandidateHold;
  readonly exemptionId: string | null;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
}

/** An exemption as the operator UI reads it. */
export interface FraudExemptionInterface {
  readonly id: string;
  readonly userId: string;
  readonly codes: readonly string[];
  readonly reason: string;
  readonly expiresAt: string;
  readonly createdBy: string | null;
  readonly createdByLogin: string | null;
  readonly revokedAt: string | null;
  readonly revokedBy: string | null;
  readonly createdAt: string;
  /** Derived: not revoked and not past `expiresAt`. */
  readonly active: boolean;
}

@Injectable()
export class AntiFraudService {
  private readonly logger = new Logger(AntiFraudService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly fraudDetectors: FraudDetectors,
    private readonly remnawaveDetectors: RemnawaveDetectors,
    private readonly sharingDetectors: SharingDetectors,
    private readonly subscriptionUaDetectors: SubscriptionUaDetectors,
    private readonly devicesClient: PanelDevicesClient,
    private readonly systemEventsService: SystemEventsService,
  ) {}

  // ── Public read API ────────────────────────────────────────────────────

  public async listSignals(query: ListFraudSignalsQuery): Promise<ListFraudSignalsResult> {
    const where: Prisma.FraudSignalWhereInput = {
      status: query.status,
      severity: query.severity,
      code: query.code,
    };
    if (query.cursor) {
      // Cursor is the `id` of the last seen row. We order by detectedAt
      // DESC + id DESC so the cursor gives a stable seek key.
      const last = await this.prismaService.fraudSignal.findUnique({
        where: { id: query.cursor },
        select: { id: true, detectedAt: true },
      });
      if (last) {
        where.OR = [
          { detectedAt: { lt: last.detectedAt } },
          { detectedAt: last.detectedAt, id: { lt: last.id } },
        ];
      }
    }
    const rows = await this.prismaService.fraudSignal.findMany({
      where,
      orderBy: [{ detectedAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    const items = rows.slice(0, query.limit).map(mapSignal);
    const nextCursor = rows.length > query.limit ? items[items.length - 1].id : null;
    return { items, nextCursor };
  }

  public async getStats(): Promise<{
    readonly open: number;
    readonly acknowledged: number;
    readonly resolved: number;
    readonly dismissed: number;
    readonly bySeverity: Record<FraudSignalSeverity, number>;
  }> {
    const [byStatus, bySev] = await Promise.all([
      this.prismaService.fraudSignal.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
      this.prismaService.fraudSignal.groupBy({
        by: ['severity'],
        where: { status: FraudSignalStatus.OPEN },
        _count: { _all: true },
      }),
    ]);
    const statusMap: Record<FraudSignalStatus, number> = {
      OPEN: 0,
      ACKNOWLEDGED: 0,
      RESOLVED: 0,
      DISMISSED: 0,
    };
    for (const row of byStatus) statusMap[row.status] = row._count._all;
    const bySeverity: Record<FraudSignalSeverity, number> = { LOW: 0, MEDIUM: 0, HIGH: 0 };
    for (const row of bySev) bySeverity[row.severity] = row._count._all;
    return {
      open: statusMap.OPEN,
      acknowledged: statusMap.ACKNOWLEDGED,
      resolved: statusMap.RESOLVED,
      dismissed: statusMap.DISMISSED,
      bySeverity,
    };
  }

  public async getSignal(id: string): Promise<FraudSignalInterface> {
    const row = await this.prismaService.fraudSignal.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Fraud signal not found');
    return mapSignal(row);
  }

  /**
   * Severity-segmented signals-per-day trend for the last `days` days
   * (inclusive of today). Zero-filled so the chart has a continuous axis.
   */
  public async getTrend(days: number): Promise<readonly FraudTrendPoint[]> {
    const span = Math.min(Math.max(days, 1), 90);
    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);
    since.setUTCDate(since.getUTCDate() - (span - 1));

    const rows = await this.prismaService.fraudSignal.findMany({
      where: { detectedAt: { gte: since } },
      select: { detectedAt: true, severity: true },
    });

    const buckets = new Map<string, { high: number; medium: number; low: number }>();
    for (let i = 0; i < span; i++) {
      const d = new Date(since);
      d.setUTCDate(since.getUTCDate() + i);
      buckets.set(d.toISOString().slice(0, 10), { high: 0, medium: 0, low: 0 });
    }
    for (const row of rows) {
      const key = row.detectedAt.toISOString().slice(0, 10);
      const bucket = buckets.get(key);
      if (!bucket) continue;
      if (row.severity === FraudSignalSeverity.HIGH) bucket.high += 1;
      else if (row.severity === FraudSignalSeverity.MEDIUM) bucket.medium += 1;
      else bucket.low += 1;
    }
    return [...buckets.entries()].map(([date, b]) => ({ date, ...b }));
  }

  /**
   * Top sharing offenders derived from OPEN sharing signals, ordered by
   * score. Reads the per-signal metadata (count vs limit) for the table.
   */
  public async getTopOffenders(limit: number): Promise<readonly FraudSharingOffender[]> {
    const take = Math.min(Math.max(limit, 1), 50);
    const rows = await this.prismaService.fraudSignal.findMany({
      where: {
        status: FraudSignalStatus.OPEN,
        code: { in: ['SUBSCRIPTION_SHARING_HWID', 'SUBSCRIPTION_SHARING_IP'] },
      },
      orderBy: [{ score: 'desc' }, { detectedAt: 'desc' }],
      take,
    });
    const allUserIds = [...new Set(rows.flatMap((r) => r.affectedUserIds))];
    const telegramByUserId = new Map<string, string | null>();
    if (allUserIds.length > 0) {
      const users = await this.prismaService.user.findMany({
        where: { id: { in: allUserIds } },
        select: { id: true, telegramId: true },
      });
      for (const u of users) {
        telegramByUserId.set(u.id, u.telegramId !== null ? u.telegramId.toString() : null);
      }
    }
    return rows.map((row) => {
      const meta = (row.metadata as Record<string, unknown>) ?? {};
      const isIp = row.code === 'SUBSCRIPTION_SHARING_IP';
      const count = isIp
        ? typeof meta.distinctNetworkCount === 'number'
          ? meta.distinctNetworkCount
          : typeof meta.distinctIpCount === 'number'
            ? meta.distinctIpCount
            : 0
        : typeof meta.deviceCount === 'number'
          ? meta.deviceCount
          : 0;
      const firstUserId = row.affectedUserIds[0];
      return {
        signalId: row.id,
        code: row.code,
        severity: row.severity,
        kind: isIp ? 'ip_sharing' : 'hwid_overage',
        count,
        deviceLimit: typeof meta.deviceLimit === 'number' ? meta.deviceLimit : 0,
        remnawaveUuid: typeof meta.remnawaveUuid === 'string' ? meta.remnawaveUuid : null,
        affectedUserIds: row.affectedUserIds,
        telegramId: firstUserId ? (telegramByUserId.get(firstUserId) ?? null) : null,
        score: row.score,
      } satisfies FraudSharingOffender;
    });
  }

  // ── Public write API ───────────────────────────────────────────────────

  public async transitionStatus(input: {
    readonly id: string;
    readonly status: FraudSignalStatus;
    readonly note: string | null;
    readonly adminId: string | null;
  }): Promise<FraudSignalInterface> {
    if (input.status === FraudSignalStatus.OPEN) {
      throw new BadRequestException('Cannot transition back to OPEN');
    }
    const row = await this.prismaService.fraudSignal.findUnique({ where: { id: input.id } });
    if (!row) throw new NotFoundException('Fraud signal not found');
    const updated = await this.prismaService.fraudSignal.update({
      where: { id: input.id },
      data: {
        status: input.status,
        resolvedAt:
          input.status === FraudSignalStatus.RESOLVED ||
          input.status === FraudSignalStatus.DISMISSED
            ? new Date()
            : null,
        resolvedBy: input.adminId,
        resolutionNote: input.note,
      },
    });
    // Category `FRAUD`, like every other `fraud.*` emit in this file. It used to
    // pass `SYSTEM`, and that single word was two operator-visible defects:
    //
    //   * `resolveTelegramDeliveryTarget` picks the forum topic from
    //     `event.category`, so a signal an operator had just resolved announced
    //     itself in whatever topic SYSTEM maps to — for a real install, the
    //     backups topic — while every sibling `fraud.*` card arrived in the
    //     anti-fraud one;
    //   * the card renderer suppresses its promocode block for FRAUD precisely
    //     so a detector code is not read as a coupon. Emitting SYSTEM walked
    //     around that guard, and `NODES_OFFLINE` was captioned «🎟 Промокод».
    //
    // It was previously left alone on the grounds that changing a category
    // silently moves an operator's cards between topics. That is exactly the
    // move being asked for here, so it is no longer silent — and the release
    // notes name it.
    this.systemEventsService.info(
      EVENT_TYPES.FRAUD_SIGNAL_TRANSITIONED,
      'FRAUD',
      `Fraud signal ${row.code} → ${input.status}`,
      {
        signalId: row.id,
        code: row.code,
        previousStatus: row.status,
        newStatus: input.status,
        adminId: input.adminId,
      },
    );
    return mapSignal(updated);
  }

  /**
   * Drops a flagged user's (or specific IPs') live connections across all
   * nodes. Resolves the panel's own user ids from the signal
   * (`metadata.remnawaveUuid` first, then the affected rezeis users'
   * subscriptions). Writes an audit entry + FRAUD event; does not change the
   * signal status (the operator still acknowledges/resolves).
   *
   * THE USER ARM IS `userIds: number[]`, WHICH IS 3.x's SPELLING and the whole
   * reason the identity resolution below is as fussy as it is. The 2.x arm was
   * `userUuids: string[]`; a migration that turned a stored identity into an id
   * with `Number.parseInt` would read a LEADING run of digits out of a 2.x-era
   * uuid (`330f2b38-…` → `330`) — a valid-looking id belonging to somebody
   * else, whose connections this call then drops. `PanelDevicesClient` takes
   * numbers precisely so that parse cannot live in the client, and
   * {@link resolveSignalPanelUserIds} is where it does live: digits-only, safe
   * integer, or the identity is refused.
   */
  public async enforceDropConnections(input: {
    readonly signalId: string;
    readonly mode: 'user' | 'ip';
    readonly adminId: string;
    readonly requestMetadata: RequestMetadataInterface;
  }): Promise<{ readonly ok: boolean; readonly dropped: { readonly by: string; readonly count: number } }> {
    const signal = await this.prismaService.fraudSignal.findUnique({
      where: { id: input.signalId },
    });
    if (!signal) throw new NotFoundException('Fraud signal not found');

    const metadata = (signal.metadata as Record<string, unknown>) ?? {};
    let dropBy: PanelDropConnectionsBody['dropBy'];
    let auditTargets: readonly string[];

    if (input.mode === 'ip') {
      const ips = extractIps(metadata);
      if (ips.length === 0) {
        throw new BadRequestException('Signal has no IP addresses to drop');
      }
      dropBy = { by: 'ipAddresses', ipAddresses: [...ips] };
      auditTargets = ips;
    } else {
      const userIds = await this.resolveSignalPanelUserIds(signal.affectedUserIds, metadata);
      if (userIds.length === 0) {
        throw new BadRequestException('Signal has no resolvable Remnawave users to drop');
      }
      dropBy = { by: 'userIds', userIds: [...userIds] };
      auditTargets = userIds.map((id) => String(id));
    }

    const outcome = await this.devicesClient.dropConnections({
      dropBy,
      targetNodes: { target: 'allNodes' },
    });
    if (outcome.kind !== 'ok') {
      // A refusal is surfaced, never swallowed. This is an operator pressing a
      // button and being told what happened — and `invalid-request` in
      // particular is rezeis's own bug caught before the request left the
      // process, which must not be reported to them as a panel outage.
      throw new BadRequestException(
        `Failed to drop connections: ${describeDropFailure(outcome)}`,
      );
    }

    await this.prismaService.adminAuditLog.create({
      data: {
        action: 'fraud.connections_dropped',
        ipAddress: input.requestMetadata.remoteAddress,
        userAgent: input.requestMetadata.userAgent,
        metadata: {
          requestId: input.requestMetadata.requestId,
          signalId: signal.id,
          code: signal.code,
          mode: input.mode,
          targets: auditTargets,
        } as Prisma.InputJsonObject,
        adminUser: { connect: { id: input.adminId } },
      },
    });

    this.systemEventsService.warn(
      EVENT_TYPES.FRAUD_CONNECTIONS_DROPPED,
      'FRAUD',
      `Connections dropped for fraud signal ${signal.code}`,
      {
        signalId: signal.id,
        code: signal.code,
        mode: input.mode,
        targetCount: auditTargets.length,
        adminId: input.adminId,
      },
    );

    // `ok` here means ACCEPTED, not done: the panel answers a drop with `202`
    // and an empty body, so nothing on the wire confirms the connections
    // actually went away.
    return { ok: true, dropped: { by: input.mode, count: auditTargets.length } };
  }

  /**
   * On-demand live per-node IP drilldown for a signal's user (read-only) —
   * used by the detail sheet.
   *
   * FLATTENS "we could not look" INTO `[]`, and this is the one place in the
   * module where that is the right call. Everywhere else the distinction
   * decides whether somebody is accused; here it decides what a panel renders
   * in a drilldown an operator opened by hand, and the HTTP contract that
   * drilldown is built on is a list. The failure is not lost — it is logged
   * with its reason, and the operator is looking at the panel anyway.
   *
   * The timestamps are normalised to ISO strings on the way out. The contract
   * transforms `lastSeen` into a `Date` while the executor's drift path hands
   * back the wire string, and a drilldown that changes its payload shape
   * depending on whether the panel's response validated is a drilldown that
   * breaks intermittently.
   */
  public async getSignalLiveIps(signalId: string): Promise<readonly FraudSignalLiveNodeIps[]> {
    const signal = await this.prismaService.fraudSignal.findUnique({
      where: { id: signalId },
    });
    if (!signal) throw new NotFoundException('Fraud signal not found');
    const metadata = (signal.metadata as Record<string, unknown>) ?? {};
    const userIds = await this.resolveSignalPanelUserIds(signal.affectedUserIds, metadata);
    const userId = userIds[0];
    if (userId === undefined) return [];
    const nodes = await this.devicesClient.fetchUserConnections(userId);
    if (nodes === null) {
      this.logger.warn(
        `Live IP drilldown for fraud signal ${signalId}: the panel could not be read for user ` +
          `${userId} — the empty result is "we could not look", not "this user is offline"`,
      );
      return [];
    }
    return nodes.map((node) => ({
      nodeUuid: node.nodeUuid,
      nodeName: node.nodeName,
      countryCode: node.countryCode.length > 0 ? node.countryCode : null,
      ips: node.ips.map((sample) => ({
        ip: sample.ip,
        lastSeen: readInstantIso(sample.lastSeen),
      })),
    }));
  }

  /**
   * Resolves a signal's affected users to the panel's own NUMERIC user ids.
   *
   * Prefers `metadata.remnawaveUuid` (every sharing and UA signal carries it)
   * and falls back to the affected rezeis users' subscriptions.
   *
   * TWO ANGLES, because one is not enough on a panel that used to be 2.x. The
   * stored `remnawaveId` is the panel's identity as a string — a decimal id for
   * a profile created on 3.x, and a UUID, forever, for one created before the
   * operator upgraded. `Subscription.remnawavePanelId` carries the numeric id
   * for both, because every ordinary read of a 2.x row already returned one, so
   * it is the column that recovers the second population.
   *
   * DIGITS-ONLY, and never `Number.parseInt` on its own: `parseInt` reads a
   * LEADING run of digits and stops, so `330f2b38-1362-…` parses to `330` — a
   * valid-looking id belonging to a different customer, whose live connections
   * this call would then drop.
   */
  private async resolveSignalPanelUserIds(
    affectedUserIds: readonly string[],
    metadata: Record<string, unknown>,
  ): Promise<readonly number[]> {
    const identity = typeof metadata.remnawaveUuid === 'string' ? metadata.remnawaveUuid : null;
    if (identity !== null && identity.length > 0) {
      const direct = readPanelUserId(identity);
      if (direct !== null) return [direct];
      // A 2.x-era uuid in the metadata. The numeric id it maps to is on the
      // subscription row, and looking it up is the only alternative to
      // guessing.
      const rows = await this.prismaService.subscription.findMany({
        where: { remnawaveId: identity },
        select: { remnawavePanelId: true },
      });
      const mapped = dedupeIds(rows.map((row) => row.remnawavePanelId));
      if (mapped.length > 0) return mapped;
      this.logger.warn(
        `Fraud signal identity ${identity} is not a numeric panel id and no subscription row ` +
          'records one for it — the panel cannot be told which user to act on',
      );
      return [];
    }
    if (affectedUserIds.length === 0) return [];
    const subs = await this.prismaService.subscription.findMany({
      where: { userId: { in: [...affectedUserIds] }, remnawaveId: { not: null } },
      select: { remnawaveId: true, remnawavePanelId: true },
    });
    return dedupeIds(
      subs.map((s) => s.remnawavePanelId ?? readPanelUserId(s.remnawaveId ?? '')),
    );
  }

  /**
   * Runs every detector, upserts the fraud candidates as signals, and emits the
   * operational alerts as system events.
   *
   * The two outputs are not interchangeable and the split is the point. A fraud
   * signal is a row in a queue an operator reads to decide whether to act
   * against a customer; the four panel-wide Remnawave observations (nodes
   * offline, node traffic quota, geo concentration, panel-wide device average)
   * name no customer and are nobody's doing, so they go to `SystemEventsService`
   * — the same channel the panel's own webhooks already use for exactly these
   * facts — instead of accusing whoever happens to be online.
   *
   * WHAT THE SPLIT LEAVES BEHIND, AND WHY NOTHING HERE CLEANS IT UP.
   * `NODES_OFFLINE`, `NODE_TRAFFIC_CRITICAL`, `GEO_CONCENTRATION_RISK` and
   * `HWID_HIGH_AVERAGE_DEVICES` no longer appear in `plan`, so they are never
   * in `reconcilableCodes`, so an OPEN row carrying one of them can never
   * auto-resolve — it sits in the operator's queue until a human clears it.
   * That is guard 1 of `reconcileOpenSignals` working as documented ("codes no
   * detector in this run owns … are never touched"), not a hole. Do not widen
   * the set to sweep them: auto-resolution stamps `AUTO_RESOLVED_NOTE`, which
   * claims the condition is *no longer detected*, and nothing observed these
   * conditions this run — the nodes may well still be offline. Writing a false
   * resolution onto an operator's audit trail is worse than leaving the row.
   * Retiring the leftovers is an operator action (fraud queue → Status = OPEN →
   * select → Dismiss), and `DISMISSED` is the accurate status: the whole point
   * of the reclassification is that these were never accusations. It is called
   * out in the release notes. The backlog is bounded — none of the four
   * fingerprints carried a time bucket, so the rows never accumulated daily.
   *
   * Safe to call repeatedly: signals dedupe on the `(code, fingerprint)` unique
   * key, and the alerts are edge-triggered inside the detectors, so a condition
   * that holds for a week is one event, not one every five minutes.
   *
   * The run is also the only place the *full* candidate set exists, which is
   * what lets `reconcileOpenSignals` close the signals nobody re-raised. Every
   * detector is therefore run through `Promise.allSettled` rather than
   * `Promise.all`: a rejected detector must neither take the run down with it
   * nor — far worse — be mistaken for "this detector saw nothing wrong".
   */
  public async runDetectors(): Promise<readonly UpsertSignalResult[]> {
    const now = new Date();

    const plan: readonly DetectorPlanEntry[] = [
      {
        name: 'detectExcessiveFailedPayments',
        codes: ['EXCESSIVE_FAILED_PAYMENTS'],
        evidence: 'authoritative',
        run: () => this.fraudDetectors.detectExcessiveFailedPayments(now),
      },
      {
        name: 'detectRapidReferralVelocity',
        codes: ['RAPID_REFERRAL_VELOCITY'],
        evidence: 'authoritative',
        run: () => this.fraudDetectors.detectRapidReferralVelocity(now),
      },
      {
        name: 'detectPromoAbuse',
        codes: ['PROMO_ABUSE'],
        evidence: 'authoritative',
        run: () => this.fraudDetectors.detectPromoAbuse(now),
      },
      {
        name: 'detectRapidChurn',
        codes: ['RAPID_CHURN'],
        evidence: 'authoritative',
        run: () => this.fraudDetectors.detectRapidChurn(now),
      },
      {
        name: 'detectPerUserNodeTrafficAbuse',
        codes: ['NODE_TRAFFIC_USER_ABUSE'],
        evidence: 'observational',
        run: () => this.remnawaveDetectors.detectPerUserNodeTrafficAbuse(now),
      },
      {
        name: 'detectHwidOverage',
        codes: ['SUBSCRIPTION_SHARING_HWID'],
        evidence: 'observational',
        run: () => this.sharingDetectors.detectHwidOverage(now),
      },
      {
        name: 'detectSharedHwidAcrossAccounts',
        codes: ['SHARED_DEVICE_MULTI_ACCOUNT'],
        // `observational`, and the auto-resolve half is what makes it so. The
        // detector reads the panel's device inventory: it returns `[]` for an
        // unreachable panel, for a user list it could not vouch for, and for
        // being switched off. None of those mean the device stopped being
        // shared, so an empty run must never close an open signal.
        //
        // The hysteresis half is cheap here and worth having: the binding is a
        // stored row on the panel, so a genuine duplicate is re-observed by
        // every run and reaches three consecutive sightings in fifteen minutes
        // on its own. What the gate buys is that a single truncated inventory
        // walk — the one read that can group two profiles it should not have,
        // or drop one it should have kept — cannot file an accusation by
        // itself.
        evidence: 'observational',
        run: () => this.sharingDetectors.detectSharedHwidAcrossAccounts(now),
      },
      {
        name: 'detectConcurrentIpSharing',
        codes: ['SUBSCRIPTION_SHARING_IP'],
        evidence: 'observational',
        run: () => this.sharingDetectors.detectConcurrentIpSharing(now),
      },
      {
        name: 'detectSubscriptionUaTunnel',
        codes: ['SUBSCRIPTION_UA_TUNNEL'],
        // `observational`, and both halves of that classification are load-bearing.
        //
        // AUTO-RESOLVE. It reads the panel's subscription-request log, and returns
        // `[]` for a panel that is unreachable, a log whose shape it no longer
        // recognises, timestamps it cannot parse, and for being switched off in
        // the panel. None of those mean the condition cleared, so an empty run
        // must never close an open signal.
        //
        // HYSTERESIS — the same declaration also gates it, and it should be gated.
        // What a gated run costs it here is ~15 minutes and nothing else: the
        // evidence window (60m by default) is twelve times the 5-minute cadence,
        // so ONE re-hosted fetch is re-observed by every run for the whole hour
        // and reaches three consecutive observations on its own. The only finding
        // the gate can lose is one whose evidence scrolls out of a single
        // `uaRequestPageSize` page inside fifteen minutes — precisely the case the
        // detector has already flagged as `windowFullyCovered: false` and warned
        // about. Against that: this is a UA *heuristic* filing against a paying
        // customer, it is new and unproven in production, and its inputs flicker
        // (a truncated UA, a log page that scrolled). Ungating it would buy back
        // a quarter of an hour on a LOW/MEDIUM advisory signal in exchange for
        // letting one bad read accuse somebody. Gated.
        evidence: 'observational',
        run: () => this.subscriptionUaDetectors.detectSubscriptionUaTunnel(now),
      },
    ];
    const alertPlan: readonly {
      readonly name: string;
      readonly run: () => Promise<readonly OperationalAlert[]>;
    }[] = [
      { name: 'collectHwidAverageAlerts', run: () => this.remnawaveDetectors.collectHwidAverageAlerts(now) },
      { name: 'collectNodeTrafficAlerts', run: () => this.remnawaveDetectors.collectNodeTrafficAlerts(now) },
      { name: 'collectGeoConcentrationAlerts', run: () => this.remnawaveDetectors.collectGeoConcentrationAlerts(now) },
      { name: 'collectOfflineNodeAlerts', run: () => this.remnawaveDetectors.collectOfflineNodeAlerts(now) },
    ];

    const [candidateSettled, alertSettled] = await Promise.all([
      Promise.allSettled(plan.map((entry) => entry.run())),
      Promise.allSettled(alertPlan.map((entry) => entry.run())),
    ]);

    const candidates: FraudSignalCandidate[] = [];
    /** Codes whose detector observed the condition-space in *this* run. */
    const reconcilableCodes = new Set<string>();
    plan.forEach((entry, index) => {
      const settled = candidateSettled[index];
      if (settled.status === 'rejected') {
        // A detector that threw saw nothing. Its codes stay out of the
        // reconcile set so its open signals survive the failure untouched.
        this.logger.warn(
          `Detector ${entry.name} failed: ${(settled.reason as Error)?.message ?? String(settled.reason)}`,
        );
        return;
      }
      const produced = settled.value;
      candidates.push(...produced);
      for (const candidate of produced) {
        if (!entry.codes.includes(candidate.code)) {
          // The reconcile set is keyed by declared code; an undeclared one
          // would silently never auto-resolve, so say so out loud.
          this.logger.warn(
            `Detector ${entry.name} produced undeclared code ${candidate.code}; ` +
              'it cannot auto-resolve until the run plan declares it',
          );
        }
      }
      if (entry.evidence === 'observational' && produced.length === 0) return;
      for (const code of entry.codes) reconcilableCodes.add(code);
    });

    const alerts: OperationalAlert[] = [];
    alertPlan.forEach((entry, index) => {
      const settled = alertSettled[index];
      if (settled.status === 'rejected') {
        this.logger.warn(
          `Alert collector ${entry.name} failed: ${(settled.reason as Error)?.message ?? String(settled.reason)}`,
        );
        return;
      }
      alerts.push(...settled.value);
    });

    this.emitOperationalAlerts(alerts);

    const context: RunContext = {
      exemptionsByUser: await this.loadActiveExemptions(now),
      gatedCodes: codesRequiringSustainedEvidence(plan),
      heldConditions: new Set<string>(),
      observedConditions: new Set<string>(),
    };

    const results: UpsertSignalResult[] = [];
    /** `code` + NUL + `fingerprint` of every row this run raised or refreshed. */
    const seen = new Set<string>();
    let suppressed = 0;
    for (const candidate of candidates) {
      try {
        const result = await this.upsertSignal(candidate, now, context);
        if (result === null) {
          suppressed += 1;
          continue;
        }
        seen.add(signalKey(result.signal.code, result.fingerprint));
        results.push(result);
      } catch (err) {
        this.logger.warn(`Failed to upsert signal ${candidate.code}: ${(err as Error).message}`);
      }
    }

    const autoResolved = await this.reconcileOpenSignals({
      now,
      reconcilableCodes,
      seen,
      heldConditions: context.heldConditions,
    });

    await this.reconcileCandidateStreaks({
      now,
      reconcilableCodes,
      observedConditions: context.observedConditions,
    });

    if (
      results.length > 0 ||
      alerts.length > 0 ||
      suppressed > 0 ||
      autoResolved > 0 ||
      context.heldConditions.size > 0
    ) {
      this.logger.log(
        `Anti-fraud detectors processed ${candidates.length} candidates → ` +
          `${results.filter((r) => r.created).length} new signals, ` +
          `${results.filter((r) => r.escalated).length} escalated, ` +
          `${context.heldConditions.size} held back (sustained evidence / exemption), ` +
          `${suppressed} suppressed, ` +
          `${autoResolved} auto-resolved, ${alerts.length} operational alerts`,
      );
    }
    return results;
  }

  /**
   * Closes the OPEN signals that this run *could* have re-raised and did not.
   *
   * Two guards decide what "could have" means, and both exist because a silent
   * detector is not the same fact as a clean one:
   *
   *  1. Only codes in `reconcilableCodes` are considered. That set already
   *     excludes any detector that threw, and any panel-backed detector that
   *     returned nothing at all — so a panel outage, a node-flap suppression or
   *     a capability that is switched off reconciles *nothing* and cannot erase
   *     a live signal. Codes no detector in this run owns (retired detectors,
   *     automation-authored rows) are never touched either.
   *  2. A signal whose fingerprint carries a time bucket that has already
   *     closed is not resolved merely because today's key differs — it must
   *     also have gone `STALE_BUCKET_GRACE_MS` without any re-detection.
   *  3. A condition this run *saw* and deliberately declined to file — held for
   *     sustained evidence, or covered by an exemption — is not "no longer
   *     detected". It was detected; we chose not to act. Resolving on it would
   *     stamp `AUTO_RESOLVED_NOTE`, which says the opposite of what happened,
   *     onto a live signal every time an operator granted an exemption.
   *
   * ACKNOWLEDGED signals are deliberately out of scope: a human took ownership
   * of that row, and the system does not close somebody else's ticket.
   *
   * Failure here is logged and swallowed on purpose — reconciliation runs after
   * the upserts and must never be able to discard the run's real work.
   */
  private async reconcileOpenSignals(input: {
    readonly now: Date;
    readonly reconcilableCodes: ReadonlySet<string>;
    readonly seen: ReadonlySet<string>;
    readonly heldConditions: ReadonlySet<string>;
  }): Promise<number> {
    if (input.reconcilableCodes.size === 0) return 0;
    try {
      const open = await this.prismaService.fraudSignal.findMany({
        where: {
          status: FraudSignalStatus.OPEN,
          code: { in: [...input.reconcilableCodes] },
        },
        orderBy: [{ detectedAt: 'asc' }],
        take: RECONCILE_SCAN_LIMIT,
      });

      const resolvedIds: string[] = [];
      for (const signal of open) {
        if (input.seen.has(signalKey(signal.code, signal.fingerprint))) continue;
        // Held this run — see guard 3 in the doc comment. Matched on the
        // condition key rather than the fingerprint because the held candidate
        // carries today's time bucket while the open row may carry yesterday's.
        if (input.heldConditions.has(signalKey(signal.code, conditionKey(signal.fingerprint)))) {
          continue;
        }
        const note = this.classifyStaleSignal(signal, input.now);
        if (note === null) continue;
        await this.prismaService.fraudSignal.update({
          where: { id: signal.id },
          data: {
            status: FraudSignalStatus.RESOLVED,
            resolvedAt: input.now,
            resolvedBy: null,
            resolutionNote: note,
          },
        });
        resolvedIds.push(signal.id);
      }

      if (resolvedIds.length > 0) {
        // One summary event rather than one per row: a first deployment can
        // clear a large backlog at once, and the per-row audit trail already
        // lives in `resolvedAt` / `resolvedBy = null` / `resolutionNote`.
        this.systemEventsService.info(
          EVENT_TYPES.FRAUD_SIGNALS_AUTO_RESOLVED,
          'FRAUD',
          `${resolvedIds.length} fraud signal(s) auto-resolved: no longer detected`,
          { count: resolvedIds.length, signalIds: resolvedIds.slice(0, 25) },
        );
      }
      return resolvedIds.length;
    } catch (err) {
      this.logger.warn(`Fraud signal reconciliation failed: ${(err as Error).message}`);
      return 0;
    }
  }

  /**
   * Decides whether an un-re-raised OPEN signal may be closed now, and with
   * which note. `null` means "leave it alone".
   */
  private classifyStaleSignal(signal: FraudSignal, now: Date): string | null {
    const bucket = parseTimeBucket(signal.fingerprint);
    // No time component in the fingerprint: the detector would have produced
    // the identical key had the condition held, so its absence is the answer.
    if (bucket === null) return AUTO_RESOLVED_NOTE;
    const current = currentBucket(bucket.kind, now);
    if (bucket.token === current) return AUTO_RESOLVED_NOTE;
    // A bucket in the future is a clock disagreement, not a cleared condition.
    if (bucket.token > current) return null;
    if (now.getTime() - signal.updatedAt.getTime() < STALE_BUCKET_GRACE_MS) return null;
    return AUTO_SUPERSEDED_NOTE;
  }

  /**
   * Forwards infrastructure observations to the operator event channel.
   *
   * `SystemEventsService.emit` is fire-and-forget by contract, but the alerts
   * must never be able to take the fraud run down with them — this runs before
   * the signal upserts.
   */
  private emitOperationalAlerts(alerts: readonly OperationalAlert[]): void {
    for (const alert of alerts) {
      try {
        this.systemEventsService.emit({
          type: alert.type,
          category: alert.category,
          severity: alert.severity,
          message: alert.message,
          metadata: { ...alert.metadata, dedupeKey: alert.dedupeKey },
        });
      } catch (err) {
        this.logger.warn(
          `Failed to emit operational alert ${alert.type}: ${(err as Error).message}`,
        );
      }
    }
  }

  /** Cron driver — runs every 5 minutes. */
  @Cron(CronExpression.EVERY_5_MINUTES)
  public async runDetectorsScheduled(): Promise<void> {
    if (!shouldRunSchedules()) return;
    try {
      await this.runDetectors();
    } catch (err) {
      this.logger.error(`Scheduled detector run failed: ${(err as Error).message}`);
    }
  }

  // ── Internal upsert ────────────────────────────────────────────────────

  /**
   * Upserts a candidate keyed by `(code, fingerprint)`.
   *
   * Outcomes, in order of precedence:
   *
   *  - a **live** row for the same fingerprint family already exists → refresh
   *    it in place (and escalate its severity if the condition got worse);
   *  - an operator **exemption** covers this user for this code → the candidate
   *    is held, recorded as held, and nothing is written;
   *  - the condition has not yet been seen in enough consecutive runs → the
   *    candidate is held and its streak advanced;
   *  - an **operator** has recently RESOLVED or DISMISSED this condition → the
   *    candidate is suppressed, recorded as held, and nothing is written. A
   *    *system* auto-resolve is not a verdict and suppresses nothing; see
   *    `findSuppressingVerdict`.
   *  - otherwise → a new OPEN row.
   *
   * All three gates sit AFTER the live-refresh branches on purpose. They govern the
   * moment an accusation is *created*; a signal that already exists is already
   * somebody's problem, and letting a gate silently stop refreshing it would
   * freeze its score and — worse — block the escalation path that carries a
   * condition from MEDIUM to a HIGH that pages an operator.
   *
   * "Fingerprint family" is what stops the recreation loop. A closed row keeps
   * its history, so a re-occurrence is filed under `${fingerprint}#${ms}`; the
   * *next* run then looks up the bare fingerprint again, finds the same closed
   * row, and — before this — minted yet another suffix, forever. The family
   * lookup finds the suffixed row that is actually live and refreshes that one
   * instead. Returns `null` when the candidate was suppressed or held.
   */
  private async upsertSignal(
    candidate: FraudSignalCandidate,
    now: Date,
    context: RunContext,
  ): Promise<UpsertSignalResult | null> {
    context.observedConditions.add(
      signalKey(candidate.code, conditionKey(candidate.fingerprint)),
    );

    const existing = await this.prismaService.fraudSignal.findUnique({
      where: {
        code_fingerprint: {
          code: candidate.code,
          fingerprint: candidate.fingerprint,
        },
      },
    });
    if (existing && isLiveStatus(existing.status)) {
      return this.refreshLiveSignal(existing, candidate, now);
    }

    // The bare key is either free or closed. Before minting anything, look at
    // the rest of the fingerprint family and at the operator's recent verdicts
    // on this condition.
    const related = await this.findRelatedSignals(candidate, now);

    const live = related.find(
      (row) => isLiveStatus(row.status) && isSameFingerprintFamily(row.fingerprint, candidate.fingerprint),
    );
    if (live) return this.refreshLiveSignal(live, candidate, now);

    const key = conditionKey(candidate.fingerprint);

    // ── Gate 2: a standing operator exemption ───────────────────────────────
    const exemption = findCoveringExemption(context.exemptionsByUser, candidate, now);
    if (exemption) {
      // The observation is still recorded. Two reasons: the exemption must
      // leave a trace (this row IS the trace), and the evidence keeps
      // accumulating underneath it — so when the exemption lapses on a
      // condition that never stopped, the signal opens on the next run rather
      // than restarting a fifteen-minute count nobody is waiting for.
      await this.recordObservation(candidate, now, 'exemption', exemption);
      context.heldConditions.add(signalKey(candidate.code, key));
      return null;
    }

    // ── Gate 3: a recent OPERATOR verdict ───────────────────────────────────
    // RESOLVED here, APPLIED below the streak gate. The decision is the same
    // either way — a verdict always wins — but the ORDER decides whether the
    // condition leaves a row behind, and a suppression with no row is a
    // detector nobody knows stopped. That is the whole purpose of
    // `GET /admin/fraud/pending`, and with the gate applied first it answered
    // "nothing is being held" while a detector's entire output was being
    // swallowed: an operator who bulk-dismisses fifty findings mutes that
    // detector for a week, and the only trace was a log line.
    const verdict = findSuppressingVerdict(related, candidate, now);

    // ── Gate 1: sustained evidence ──────────────────────────────────────────
    if (context.gatedCodes.has(candidate.code)) {
      // Recorded under the hold that is actually about to win, so the pending
      // row says why. The evidence also keeps accumulating underneath a mute —
      // the same reason the exemption branch above records: when a seven-day
      // dismissal lapses on a condition that never stopped, the signal opens on
      // the next run instead of restarting a fifteen-minute count.
      const streak = await this.recordObservation(
        candidate,
        now,
        verdict === null ? 'streak' : 'verdict',
        null,
      );
      if (verdict === null && !streak.open) {
        context.heldConditions.add(signalKey(candidate.code, key));
        this.logger.log(
          `Fraud signal ${candidate.code} held: observed ${streak.observations}/` +
            `${REQUIRED_OBSERVATIONS} consecutive runs (condition ${key})`,
        );
        return null;
      }
    }

    if (verdict) {
      this.logger.log(
        `Fraud signal ${candidate.code} suppressed: operator ${verdict.resolvedBy} ` +
          `${verdict.status} this condition at ` +
          `${verdict.resolvedAt?.toISOString() ?? 'unknown time'} (signal ${verdict.id})`,
      );
      // "We chose not to act" is not "it cleared" — see guard 3 of
      // `reconcileOpenSignals`. Without this, a dismissal on today's key would
      // make the reconcile pass stamp AUTO_RESOLVED_NOTE ("no longer detected")
      // onto a still-open row for the same condition under an older bucket,
      // which is the opposite of what happened.
      context.heldConditions.add(signalKey(candidate.code, key));
      return null;
    }

    // The streak is satisfied, or the evidence escalated past it, and no
    // verdict stands in the way. The row is about to become a signal, so the
    // streak has served its purpose.
    if (context.gatedCodes.has(candidate.code)) {
      await this.clearCandidateStreak(candidate.code, key);
    }

    const action = DEFAULT_ACTIONS_BY_SEVERITY[candidate.severity];
    // Resolved/Dismissed rows with the same fingerprint exist — that's
    // the operator's verdict on a previous occurrence. We **don't**
    // re-open the same row; instead we vary the fingerprint by appending
    // a millisecond suffix so the new occurrence becomes a fresh row and the
    // verdict keeps its own audit trail intact.
    const fingerprint =
      existing && !isLiveStatus(existing.status)
        ? `${candidate.fingerprint}#${now.getTime()}`
        : candidate.fingerprint;

    const throttled = action === 'notify' ? await this.isNotificationThrottled(candidate, now) : false;

    const created = await this.prismaService.fraudSignal.create({
      data: {
        code: candidate.code,
        fingerprint,
        severity: candidate.severity,
        status: FraudSignalStatus.OPEN,
        title: candidate.title,
        description: candidate.description,
        score: candidate.score,
        confidence: candidate.confidence,
        affectedUserIds: [...candidate.affectedUserIds],
        metadata: (throttled
          ? { ...candidate.metadata, notificationThrottled: true }
          : candidate.metadata) as Prisma.InputJsonValue,
        // `lastAction` is the record of what we actually did, and it doubles as
        // the restart-proof notification cooldown — so a throttled signal must
        // not claim it notified.
        lastAction: action === 'notify' && !throttled ? 'notify' : 'none',
      },
    });

    if (action === 'notify' && !throttled) {
      const notifyMeta = await this.buildFraudNotifyPayload(created, candidate);
      this.systemEventsService.warn(
        EVENT_TYPES.FRAUD_SIGNAL_OPENED,
        'FRAUD',
        `Fraud signal: ${candidate.title}`,
        notifyMeta,
      );
    }

    return {
      signal: mapSignal(created),
      fingerprint,
      action: action === 'notify' && throttled ? 'none' : action,
      created: true,
      escalated: false,
    };
  }

  /**
   * Refreshes an OPEN/ACKNOWLEDGED signal from a fresh candidate.
   *
   * Severity is a high-water mark. It escalates when the condition gets worse —
   * a LOW that becomes egregious has to be able to reach the operator, which is
   * exactly what an untouched `severity` prevented — and it never quietly walks
   * back down: a milder re-detection records itself in `metadata`
   * (`observedSeverity` / `severityPeak`) and, on the edge, on the event
   * channel, but the row stays as urgent as the worst thing ever seen on it.
   */
  private async refreshLiveSignal(
    existing: FraudSignal,
    candidate: FraudSignalCandidate,
    now: Date,
  ): Promise<UpsertSignalResult> {
    const escalated = SEVERITY_RANK[candidate.severity] > SEVERITY_RANK[existing.severity];
    const receded = SEVERITY_RANK[candidate.severity] < SEVERITY_RANK[existing.severity];
    const severity = escalated ? candidate.severity : existing.severity;
    const action = escalated ? DEFAULT_ACTIONS_BY_SEVERITY[severity] : 'none';
    const throttled = action === 'notify' ? await this.isNotificationThrottled(candidate, now) : false;
    const notified = action === 'notify' && !throttled;

    const previousObserved = readObservedSeverity(existing.metadata);
    const metadata: Record<string, unknown> = { ...candidate.metadata };
    if (receded) {
      metadata.observedSeverity = candidate.severity;
      metadata.severityPeak = existing.severity;
    }

    const refreshed = await this.prismaService.fraudSignal.update({
      where: { id: existing.id },
      data: {
        score: candidate.score,
        confidence: candidate.confidence,
        affectedUserIds: [...candidate.affectedUserIds],
        metadata: metadata as Prisma.InputJsonValue,
        ...(escalated ? { severity } : {}),
        ...(notified ? { lastAction: 'notify' } : {}),
      },
    });

    if (escalated) {
      this.systemEventsService.info(
        EVENT_TYPES.FRAUD_SIGNAL_ESCALATED,
        'FRAUD',
        `Fraud signal ${existing.code} escalated ${existing.severity} → ${severity}`,
        {
          signalId: existing.id,
          code: existing.code,
          previousSeverity: existing.severity,
          newSeverity: severity,
          score: candidate.score,
          notified,
        },
      );
      if (notified) {
        const notifyMeta = await this.buildFraudNotifyPayload(refreshed, candidate);
        this.systemEventsService.warn(
          EVENT_TYPES.FRAUD_SIGNAL_OPENED,
          'FRAUD',
          `Fraud signal escalated to ${severity}: ${candidate.title}`,
          { ...notifyMeta, escalatedFrom: existing.severity },
        );
      }
    } else if (receded && previousObserved !== candidate.severity) {
      // Edge-triggered, so a condition that sits at the lower level does not
      // re-announce itself every five minutes.
      this.systemEventsService.info(
        EVENT_TYPES.FRAUD_SIGNAL_SEVERITY_RECEDED,
        'FRAUD',
        `Fraud signal ${existing.code} now measures ${candidate.severity} (peak ${existing.severity})`,
        {
          signalId: existing.id,
          code: existing.code,
          observedSeverity: candidate.severity,
          severityPeak: existing.severity,
          score: candidate.score,
        },
      );
    }

    return {
      signal: mapSignal(refreshed),
      fingerprint: refreshed.fingerprint,
      action: notified ? 'notify' : 'none',
      created: false,
      escalated,
    };
  }

  // ── The two gates' state ───────────────────────────────────────────────

  /**
   * Advances (or starts) the streak for a candidate and says whether the
   * evidence is now enough to file it.
   *
   * WHERE THIS STATE LIVES AND WHY. In `fraud_candidate_streaks`, a table, not a
   * `Map` on this instance. Two processes run this code — the API container and
   * the BullMQ worker — and either can serve the 5-minute cron or a manual
   * `POST /admin/fraud/detectors/run`. An in-process counter would give each of
   * them half a streak, so a condition alternating between them would reach 3
   * only after 6 runs, or never; and every deploy would reset both to zero,
   * which on a codebase that deploys during incidents is the same as switching
   * the detectors off exactly when they matter. The notification cooldown a few
   * methods down already refused to live in memory for precisely this reason,
   * and Redis was rejected for a third: `RawCacheService` degrades to a silent
   * no-op when it cannot reach the server, so a Redis outage would make every
   * `get` return "no streak" and NO signal would ever open again — a detector
   * death with no error anywhere.
   *
   * TWO OBSERVATIONS COUNT AS CONSECUTIVE if they are within
   * `STREAK_MAX_GAP_MS`. Runs that could not observe do not break the streak
   * (that is `reconcileCandidateStreaks`'s job and it uses the run plan's own
   * evidence classes to decide), but they must not let a stale sighting be
   * counted as fresh either, which is what the gap bound is for.
   */
  private async recordObservation(
    candidate: FraudSignalCandidate,
    now: Date,
    heldBy: CandidateHold,
    exemption: ActiveExemption | null,
  ): Promise<{ readonly observations: number; readonly open: boolean }> {
    const key = conditionKey(candidate.fingerprint);
    const existing = await this.prismaService.fraudCandidateStreak.findUnique({
      where: { code_conditionKey: { code: candidate.code, conditionKey: key } },
    });

    const continues =
      existing !== null && now.getTime() - existing.lastSeenAt.getTime() <= STREAK_MAX_GAP_MS;
    const observations = continues ? existing.observations + 1 : 1;
    // The basis for "did it get worse": the severity the streak STARTED at. A
    // basis that moved with each observation could never register a rise.
    const basis = continues ? existing.severity : candidate.severity;
    const escalated = SEVERITY_RANK[candidate.severity] > SEVERITY_RANK[basis];

    const shared = {
      observations,
      severity: basis,
      lastSeverity: candidate.severity,
      score: candidate.score,
      title: candidate.title,
      affectedUserIds: [...candidate.affectedUserIds],
      heldBy,
      exemptionId: exemption?.id ?? null,
      lastSeenAt: now,
    };

    await this.prismaService.fraudCandidateStreak.upsert({
      where: { code_conditionKey: { code: candidate.code, conditionKey: key } },
      create: {
        code: candidate.code,
        conditionKey: key,
        firstSeenAt: now,
        ...shared,
      },
      update: {
        ...shared,
        ...(continues ? {} : { firstSeenAt: now }),
      },
    });

    if (exemption !== null) {
      this.announceExemptionHold(candidate, exemption, existing?.heldBy ?? null);
    }

    return {
      observations,
      // Escalation bypasses the wait outright. Fifteen minutes of politeness is
      // the right price for a first reading; it is the wrong price for a
      // condition that has already been seen and has since got dramatically
      // worse, which is the one case where the delay could cost something real.
      open: escalated || observations >= REQUIRED_OBSERVATIONS,
    };
  }

  /**
   * Tells the operator channel that an exemption started swallowing a condition.
   *
   * Edge-triggered on the `heldBy` transition, the same shape the severity
   * recession a few methods up uses: a condition sitting under an exemption for
   * a month is one event, not 8,640. Fire-and-forget, and wrapped, because
   * nothing about announcing a hold may take the run down.
   */
  private announceExemptionHold(
    candidate: FraudSignalCandidate,
    exemption: ActiveExemption,
    previousHold: string | null,
  ): void {
    this.logger.log(
      `Fraud signal ${candidate.code} held by exemption ${exemption.id} for user ` +
        `${exemption.userId} until ${exemption.expiresAt.toISOString()}`,
    );
    if (previousHold === 'exemption') return;
    try {
      this.systemEventsService.info(
        EVENT_TYPES.FRAUD_CANDIDATE_EXEMPTED,
        'FRAUD',
        `Fraud candidate ${candidate.code} suppressed by an operator exemption`,
        {
          code: candidate.code,
          exemptionId: exemption.id,
          userId: exemption.userId,
          reason: exemption.reason,
          expiresAt: exemption.expiresAt.toISOString(),
          severity: candidate.severity,
          score: candidate.score,
        },
      );
    } catch (err) {
      this.logger.warn(
        `Failed to announce exemption hold for ${candidate.code}: ${(err as Error).message}`,
      );
    }
  }

  /** Drops a streak once its condition has become a signal. */
  private async clearCandidateStreak(code: string, key: string): Promise<void> {
    try {
      await this.prismaService.fraudCandidateStreak.deleteMany({
        where: { code, conditionKey: key },
      });
    } catch (err) {
      // Never fatal: a leftover streak is re-counted from the next observation
      // and the gap bound eventually retires it. Failing the upsert here would
      // lose the signal we just decided to open.
      this.logger.warn(`Failed to clear fraud streak ${code}/${key}: ${(err as Error).message}`);
    }
  }

  /**
   * Breaks the streaks a run *could* have re-observed and did not, and sweeps
   * the ones nothing speaks for any more.
   *
   * "Could have" is `reconcilableCodes` — the exact set `reconcileOpenSignals`
   * uses, and deliberately not a second notion of the same thing. It already
   * excludes any detector that threw and any panel-backed detector that returned
   * nothing at all, so a panel outage, a node-flap suppression or a capability
   * that is switched off leaves every streak standing. That is the whole of "a
   * skipped run is not a broken streak": the run plan already distinguishes a
   * completed run from a rejected one, and this reuses that answer rather than
   * asking the question again.
   *
   * Swallowed on failure for the same reason as the signal reconcile: this runs
   * last and must never be able to discard the run's real work.
   */
  private async reconcileCandidateStreaks(input: {
    readonly now: Date;
    readonly reconcilableCodes: ReadonlySet<string>;
    readonly observedConditions: ReadonlySet<string>;
  }): Promise<void> {
    try {
      if (input.reconcilableCodes.size > 0) {
        const live = await this.prismaService.fraudCandidateStreak.findMany({
          where: { code: { in: [...input.reconcilableCodes] } },
          take: STREAK_SCAN_LIMIT,
        });
        const broken = live
          .filter((row) => !input.observedConditions.has(signalKey(row.code, row.conditionKey)))
          .map((row) => row.id);
        if (broken.length > 0) {
          await this.prismaService.fraudCandidateStreak.deleteMany({
            where: { id: { in: broken } },
          });
        }
      }

      // Rows whose detector stopped speaking altogether. Past the gap bound they
      // can never contribute again, and leaving them makes the pending list
      // claim things are being watched that are not.
      await this.prismaService.fraudCandidateStreak.deleteMany({
        where: { lastSeenAt: { lt: new Date(input.now.getTime() - STREAK_RETENTION_MS) } },
      });
    } catch (err) {
      this.logger.warn(`Fraud streak reconciliation failed: ${(err as Error).message}`);
    }
  }

  /**
   * The exemptions in force right now, indexed by the user they name.
   *
   * Resolved once per run rather than per candidate: a sharing sweep can carry
   * dozens of candidates and this is the same answer for all of them.
   *
   * A failure here is NOT swallowed. Every other read in this run fails towards
   * "do less"; this one would fail towards "accuse a user the operator already
   * cleared", and re-accusing someone during a database blip is exactly the
   * behaviour the exemption exists to stop.
   */
  private async loadActiveExemptions(
    now: Date,
  ): Promise<ReadonlyMap<string, readonly ActiveExemption[]>> {
    const rows = await this.prismaService.fraudExemption.findMany({
      where: { revokedAt: null, expiresAt: { gt: now } },
      select: { id: true, userId: true, codes: true, expiresAt: true, reason: true },
    });
    const index = new Map<string, ActiveExemption[]>();
    for (const row of rows) {
      const bucket = index.get(row.userId);
      const entry: ActiveExemption = {
        id: row.id,
        userId: row.userId,
        codes: row.codes,
        expiresAt: row.expiresAt,
        reason: row.reason,
      };
      if (bucket) bucket.push(entry);
      else index.set(row.userId, [entry]);
    }
    return index;
  }

  // ── Pending candidates & exemptions: the operator surface ──────────────

  /**
   * Everything the detectors saw and did not file — the answer to "which
   * detector quietly stopped detecting". Ordered by how close each is to
   * opening, then by recency, so a condition one run away from a signal is at
   * the top and an exempted one is visibly parked.
   */
  public async listPendingCandidates(limit: number): Promise<readonly PendingFraudCandidateInterface[]> {
    const take = Math.min(Math.max(limit, 1), 200);
    const rows = await this.prismaService.fraudCandidateStreak.findMany({
      orderBy: [{ observations: 'desc' }, { lastSeenAt: 'desc' }],
      take,
    });
    return rows.map((row) => ({
      id: row.id,
      code: row.code,
      conditionKey: row.conditionKey,
      // Progress towards the bar, and progress cannot exceed the bar. The
      // ledger keeps the true count, but a condition parked under an exemption
      // or an operator verdict is re-observed every five minutes, and a surface
      // rendering "seen 2016 of 3" tells an operator nothing that
      // `firstSeenAt`/`lastSeenAt` do not already say properly.
      observations: Math.min(row.observations, REQUIRED_OBSERVATIONS),
      requiredObservations: REQUIRED_OBSERVATIONS,
      severity: row.severity,
      lastSeverity: row.lastSeverity,
      score: row.score,
      title: row.title,
      affectedUserIds: row.affectedUserIds,
      heldBy: isCandidateHold(row.heldBy) ? row.heldBy : 'streak',
      exemptionId: row.exemptionId,
      firstSeenAt: row.firstSeenAt.toISOString(),
      lastSeenAt: row.lastSeenAt.toISOString(),
    }));
  }

  /** Exemptions, newest first. Expired and revoked ones stay readable. */
  public async listExemptions(input: {
    readonly userId?: string;
    readonly activeOnly: boolean;
    readonly limit: number;
  }): Promise<readonly FraudExemptionInterface[]> {
    const now = new Date();
    const take = Math.min(Math.max(input.limit, 1), 200);
    const rows = await this.prismaService.fraudExemption.findMany({
      where: {
        userId: input.userId,
        ...(input.activeOnly ? { revokedAt: null, expiresAt: { gt: now } } : {}),
      },
      orderBy: [{ createdAt: 'desc' }],
      take,
      include: { creator: { select: { login: true } } },
    });
    return rows.map((row) => mapExemption(row, row.creator?.login ?? null, now));
  }

  /**
   * Grants an exemption.
   *
   * Every argument that could be omitted is required, and that is the design:
   * an expiry, because a permanent exemption is a permanent blind spot; at
   * least one code, because "exempt from everything" is not a judgement anybody
   * can defend later; and a reason, because in six months the only difference
   * between a considered decision and a mistake is the sentence next to it.
   */
  public async createExemption(input: {
    readonly userId: string;
    readonly codes: readonly string[];
    readonly reason: string;
    readonly expiresAt: Date;
    readonly adminId: string;
    readonly requestMetadata: RequestMetadataInterface;
  }): Promise<FraudExemptionInterface> {
    const now = new Date();
    if (!(input.expiresAt.getTime() > now.getTime())) {
      throw new BadRequestException('Exemption expiry must be in the future');
    }
    const codes = [...new Set(input.codes.map((c) => c.trim()).filter((c) => c.length > 0))];
    if (codes.length === 0) {
      throw new BadRequestException('An exemption must name at least one detector code');
    }
    const user = await this.prismaService.user.findUnique({
      where: { id: input.userId },
      select: { id: true },
    });
    if (!user) throw new NotFoundException('User not found');

    const created = await this.prismaService.fraudExemption.create({
      data: {
        userId: input.userId,
        codes,
        reason: input.reason,
        expiresAt: input.expiresAt,
        createdBy: input.adminId,
      },
    });

    await this.prismaService.adminAuditLog.create({
      data: {
        action: 'fraud.exemption_granted',
        ipAddress: input.requestMetadata.remoteAddress,
        userAgent: input.requestMetadata.userAgent,
        metadata: {
          requestId: input.requestMetadata.requestId,
          exemptionId: created.id,
          userId: input.userId,
          codes,
          reason: input.reason,
          expiresAt: input.expiresAt.toISOString(),
        } as Prisma.InputJsonObject,
        adminUser: { connect: { id: input.adminId } },
      },
    });

    this.systemEventsService.warn(
      EVENT_TYPES.FRAUD_EXEMPTION_GRANTED,
      'FRAUD',
      `Anti-fraud exemption granted for user ${input.userId} (${codes.join(', ')})`,
      {
        exemptionId: created.id,
        userId: input.userId,
        codes,
        reason: input.reason,
        expiresAt: input.expiresAt.toISOString(),
        adminId: input.adminId,
      },
    );

    return mapExemption(created, null, now);
  }

  /**
   * Revokes an exemption. The row is kept — granting an exemption is an
   * audit-relevant act, and so is taking one away.
   *
   * Also drops the streaks the exemption was holding, so the condition has to
   * re-earn its evidence from the next run rather than opening instantly on a
   * count accumulated while nobody was judging it.
   */
  public async revokeExemption(input: {
    readonly id: string;
    readonly adminId: string;
    readonly requestMetadata: RequestMetadataInterface;
  }): Promise<FraudExemptionInterface> {
    const now = new Date();
    const row = await this.prismaService.fraudExemption.findUnique({ where: { id: input.id } });
    if (!row) throw new NotFoundException('Fraud exemption not found');
    if (row.revokedAt !== null) throw new BadRequestException('Exemption is already revoked');

    const updated = await this.prismaService.fraudExemption.update({
      where: { id: input.id },
      data: { revokedAt: now, revokedBy: input.adminId },
    });

    try {
      await this.prismaService.fraudCandidateStreak.deleteMany({
        where: { exemptionId: input.id },
      });
    } catch (err) {
      this.logger.warn(
        `Failed to clear streaks held by exemption ${input.id}: ${(err as Error).message}`,
      );
    }

    await this.prismaService.adminAuditLog.create({
      data: {
        action: 'fraud.exemption_revoked',
        ipAddress: input.requestMetadata.remoteAddress,
        userAgent: input.requestMetadata.userAgent,
        metadata: {
          requestId: input.requestMetadata.requestId,
          exemptionId: row.id,
          userId: row.userId,
          codes: row.codes,
        } as Prisma.InputJsonObject,
        adminUser: { connect: { id: input.adminId } },
      },
    });

    this.systemEventsService.info(
      EVENT_TYPES.FRAUD_EXEMPTION_REVOKED,
      'FRAUD',
      `Anti-fraud exemption revoked for user ${row.userId}`,
      {
        exemptionId: row.id,
        userId: row.userId,
        codes: row.codes,
        adminId: input.adminId,
      },
    );

    return mapExemption(updated, null, now);
  }

  /**
   * Pulls the rows that could speak for this candidate: everything still live
   * for the code (the fingerprint family may carry a `#ms` suffix, so an exact
   * key lookup cannot find it) plus the operator verdicts still inside the
   * longest suppression window.
   */
  private async findRelatedSignals(
    candidate: FraudSignalCandidate,
    now: Date,
  ): Promise<readonly FraudSignal[]> {
    const floor = new Date(
      now.getTime() - Math.max(DISMISSAL_SUPPRESSION_MS, RESOLUTION_SUPPRESSION_MS),
    );
    return this.prismaService.fraudSignal.findMany({
      where: {
        code: candidate.code,
        OR: [
          { status: { in: [FraudSignalStatus.OPEN, FraudSignalStatus.ACKNOWLEDGED] } },
          {
            status: { in: [FraudSignalStatus.RESOLVED, FraudSignalStatus.DISMISSED] },
            resolvedAt: { gte: floor },
          },
        ],
      },
      orderBy: [{ resolvedAt: 'desc' }, { detectedAt: 'desc' }],
      take: RELATED_SCAN_LIMIT,
    });
  }

  /**
   * True when a HIGH-severity notification already went out for one of this
   * candidate's affected users inside `NOTIFY_COOLDOWN_MS`.
   *
   * The cooldown is read back out of the fraud rows (`lastAction = 'notify'`),
   * not held in memory, so restarting the process does not hand everyone a
   * fresh allowance. A candidate that names nobody falls back to a per-code
   * window — an unattributed HIGH still should not repeat every five minutes.
   *
   * A probe that fails errs towards notifying: silence is the dangerous
   * direction for this decision.
   */
  private async isNotificationThrottled(
    candidate: FraudSignalCandidate,
    now: Date,
  ): Promise<boolean> {
    const floor = new Date(now.getTime() - NOTIFY_COOLDOWN_MS);
    const where: Prisma.FraudSignalWhereInput =
      candidate.affectedUserIds.length > 0
        ? {
            lastAction: 'notify',
            detectedAt: { gte: floor },
            affectedUserIds: { hasSome: [...candidate.affectedUserIds] },
          }
        : { lastAction: 'notify', detectedAt: { gte: floor }, code: candidate.code };
    try {
      const recent = await this.prismaService.fraudSignal.findFirst({
        where,
        orderBy: [{ detectedAt: 'desc' }],
        select: { id: true, detectedAt: true },
      });
      if (recent === null) return false;
      this.logger.log(
        `Fraud notification for ${candidate.code} throttled: signal ${recent.id} already ` +
          `notified for these users at ${recent.detectedAt.toISOString()}`,
      );
      return true;
    } catch (err) {
      this.logger.warn(
        `Notification cooldown probe failed for ${candidate.code}, notifying anyway: ${(err as Error).message}`,
      );
      return false;
    }
  }

  /**
   * Builds the enriched Telegram payload for a fraud-signal notification:
   * the sharing metric (count vs limit), the Remnawave uuid, and — when the
   * offender maps to a rezeis user — a full profile snapshot plus a deep link
   * to the admin user page. Uses `fraud*`-prefixed keys so the generic event
   * formatter renders a single dedicated fraud block (no promocode/user
   * mislabeling).
   */
  private async buildFraudNotifyPayload(
    signal: FraudSignal,
    candidate: FraudSignalCandidate,
  ): Promise<Record<string, unknown>> {
    const meta = (candidate.metadata as Record<string, unknown>) ?? {};
    const kind = typeof meta.kind === 'string' ? meta.kind : null;
    const remnawaveUuid = typeof meta.remnawaveUuid === 'string' ? meta.remnawaveUuid : null;
    const deviceLimit = typeof meta.deviceLimit === 'number' ? meta.deviceLimit : null;
    const count =
      kind === 'ip_sharing'
        ? typeof meta.distinctNetworkCount === 'number'
          ? meta.distinctNetworkCount
          : typeof meta.distinctIpCount === 'number'
            ? meta.distinctIpCount
            : null
        : typeof meta.deviceCount === 'number'
          ? meta.deviceCount
          : null;

    const payload: Record<string, unknown> = {
      signalId: signal.id,
      signalCode: signal.code,
      fraudKind: kind,
      fraudScore: signal.score,
      fraudConfidence: signal.confidence,
      fraudCount: count,
      fraudLimit: deviceLimit,
      remnawaveUuid,
      affectedUserIds: candidate.affectedUserIds,
    };

    // ONE NAME ONLY WHEN THERE IS ONE. `affectedUserIds[0]` is the
        // lexicographically smallest id, which is a fine choice when the signal
        // names one customer and a wrong one when it names a relation between
        // several: `SHARED_DEVICE_MULTI_ACCOUNT` puts every co-owner on the
        // list, so the operator alert used to headline one arbitrary member of
        // the group as «Нарушитель», with their real name, @username, Telegram
        // id and e-mail — and never mention the others. The detector's own
        // design note says the evidence does not identify which of them it is.
        //
        // For a multi-user signal the identity block is left out entirely and
        // the count travels instead; the operator opens the signal to see who.
        const namesOneCustomer = candidate.affectedUserIds.length === 1;
        payload.fraudAffectedCount = candidate.affectedUserIds.length;
        const rezeisUserId = namesOneCustomer ? (candidate.affectedUserIds[0] ?? null) : null;
    if (rezeisUserId) {
      const user = await this.prismaService.user.findUnique({
        where: { id: rezeisUserId },
        select: {
          id: true,
          telegramId: true,
          username: true,
          name: true,
          email: true,
          role: true,
          isBlocked: true,
          webAccount: { select: { id: true } },
          _count: { select: { subscriptions: true } },
        },
      });
      if (user) {
        payload.fraudHasRezeisAccount = true;
        payload.fraudRezeisUserId = user.id;
        if (user.telegramId !== null) payload.fraudTelegramId = user.telegramId.toString();
        payload.fraudUsername = user.username ?? null;
        payload.fraudUserName = user.name || null;
        payload.fraudUserEmail = user.email ?? null;
        payload.fraudUserRole = user.role;
        payload.fraudUserBlocked = user.isBlocked;
        payload.fraudHasWebAccount = user.webAccount !== null;
        payload.fraudSubscriptions = user._count.subscriptions;
        const domain = process.env.REZEIS_DOMAIN;
        if (domain && domain !== 'localhost' && user.telegramId !== null) {
          const scheme = domain.includes('.') ? 'https' : 'http';
          payload.fraudProfileUrl = `${scheme}://${domain}/users/${user.telegramId.toString()}`;
        }
      } else {
        payload.fraudHasRezeisAccount = false;
      }
    } else {
      payload.fraudHasRezeisAccount = false;
    }

    return payload;
  }
}

/** Composite key used to match a run's candidates against the open rows. */
function signalKey(code: string, fingerprint: string): string {
  return `${code}\u0000${fingerprint}`;
}

/** OPEN and ACKNOWLEDGED are both "somebody's live problem". */
function isLiveStatus(status: FraudSignalStatus): boolean {
  return status === FraudSignalStatus.OPEN || status === FraudSignalStatus.ACKNOWLEDGED;
}

/**
 * `held_by` is a free-text column, so a row written by an older build (or by
 * hand) can carry anything. Anything unrecognised reads back as `'streak'` —
 * the column's own default and the only hold that carries no extra promise.
 */
function isCandidateHold(value: string): value is CandidateHold {
  return value === 'streak' || value === 'exemption' || value === 'verdict';
}

/**
 * Strips the `#<millis>` suffix `upsertSignal` adds when it has to file a
 * re-occurrence next to a closed verdict rather than overwrite it.
 */
function stripRecreationSuffix(fingerprint: string): string {
  return fingerprint.replace(/#\d+$/, '');
}

/** True when `rowFingerprint` is `base` itself or a `base#<millis>` re-file. */
function isSameFingerprintFamily(rowFingerprint: string, base: string): boolean {
  return rowFingerprint === base || stripRecreationSuffix(rowFingerprint) === base;
}

/**
 * The leading time bucket of a detector fingerprint, if it has one.
 *
 * Every detector in the run plan keys its fingerprint as `<bucket>|<rest>` with
 * the bucket being a UTC day (`2026-08-05`) or an ISO week (`2026-W32`) — see
 * `fraud-detectors.ts`, which documents the convention. Anything else is read
 * as "no time component", which is the safe reading: such a fingerprint is
 * reproducible on every run, so its absence really does mean the condition is
 * gone.
 */
function parseTimeBucket(fingerprint: string): { kind: 'day' | 'week'; token: string } | null {
  const separator = fingerprint.indexOf('|');
  if (separator < 0) return null;
  const token = fingerprint.slice(0, separator);
  if (/^\d{4}-\d{2}-\d{2}$/.test(token)) return { kind: 'day', token };
  if (/^\d{4}-W\d{2}$/.test(token)) return { kind: 'week', token };
  return null;
}

/**
 * The bucket token a detector would produce right now. Both formats sort
 * lexicographically in chronological order, so `<` / `>` compare eras.
 *
 * The week arithmetic mirrors `fraud-detectors.ts`'s private `isoWeekKey`; it
 * cannot be imported. A drift between the two would only ever make a signal
 * look like it belongs to a *closed* bucket, which is the conservative side —
 * such a signal then needs a full day of silence before it ages out.
 */
function currentBucket(kind: 'day' | 'week', now: Date): string {
  if (kind === 'day') return now.toISOString().slice(0, 10);
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

/**
 * The condition a fingerprint describes, with its time bucket and re-file
 * suffix removed — "this user, this rule", independent of the day it landed on.
 *
 * Suppression is deliberately keyed on *this* rather than on the fingerprint:
 * a dismissal that only silenced today's key would have the identical finding
 * back under tomorrow's, and the operator would be dismissing the same false
 * positive every morning.
 */
function conditionKey(fingerprint: string): string {
  const bare = stripRecreationSuffix(fingerprint);
  const bucket = parseTimeBucket(bare);
  return bucket === null ? bare : bare.slice(bucket.token.length + 1);
}

/**
 * The operator verdict that should stop this candidate from being filed, if
 * there is one.
 *
 * ONLY A HUMAN'S VERDICT COUNTS, and that is what `resolvedBy` decides.
 * `transitionStatus` — the sole path an operator's ruling takes — always stamps
 * an admin id; `reconcileOpenSignals` writes `RESOLVED` with `resolvedBy: null`
 * when a run that *could* see the condition stopped producing it.
 * `DetectorAccuracyService` already reads that null as "the system's own
 * signature" and refuses to score it as a verdict; this gate must make the same
 * distinction, and for a sharper reason.
 *
 * A system auto-resolve suppresses NOTHING. Its note says the condition was no
 * longer detected — it is a statement of ABSENCE, and a fresh detection is
 * precisely the observation that overturns it. Honouring it here made the
 * detector suppress a condition for six hours because it had itself closed it a
 * moment earlier: one run where a panel momentarily reported a user under their
 * limit bought that user immunity, the log claimed an operator had ruled, and a
 * condition blinking every ~6h re-opened for minutes a day at most. For a
 * detector whose readings flicker by nature — the concurrent-IP one — blinking
 * is the steady state, so the gate was a detector kill switch wearing an
 * operator's name.
 *
 * The same test is applied to DISMISSED and not only to RESOLVED. Nothing
 * writes a system dismissal today, but `transitionStatus` types its `adminId`
 * `string | null`, so one is a single caller away — and it would land here as a
 * seven-day mute rather than the six-hour one, which is the worse mistake to
 * leave waiting.
 *
 * What re-opens a dismissed condition, deliberately:
 *   - the window running out (7 days for a dismissal, 6 hours for a
 *     resolution) — the condition can always come back, so this is a mute, not
 *     a blind spot;
 *   - the condition getting **worse** — a verdict on a LOW does not buy silence
 *     on a HIGH, so an escalating problem breaks through immediately.
 */
function findSuppressingVerdict(
  related: readonly FraudSignal[],
  candidate: FraudSignalCandidate,
  now: Date,
): FraudSignal | null {
  const key = conditionKey(candidate.fingerprint);
  let strongest: FraudSignal | null = null;
  for (const row of related) {
    if (row.resolvedAt === null) continue;
    // Nobody signed this row, so nobody ruled on it — see the header.
    if (row.resolvedBy === null) continue;
    if (row.status !== FraudSignalStatus.DISMISSED && row.status !== FraudSignalStatus.RESOLVED) {
      continue;
    }
    if (conditionKey(row.fingerprint) !== key) continue;
    const window =
      row.status === FraudSignalStatus.DISMISSED
        ? DISMISSAL_SUPPRESSION_MS
        : RESOLUTION_SUPPRESSION_MS;
    if (now.getTime() - row.resolvedAt.getTime() >= window) continue;
    if (SEVERITY_RANK[candidate.severity] > SEVERITY_RANK[row.severity]) continue;
    if (strongest === null || row.resolvedAt > (strongest.resolvedAt as Date)) strongest = row;
  }
  return strongest;
}

/**
 * The exemption covering this candidate, if any.
 *
 * PARTIAL, NOT BLANKET, and that is the whole shape: the exemption has to name
 * this candidate's `code`, so clearing a power user's device count leaves every
 * other detector free to accuse them of everything else.
 *
 * A candidate that names no user cannot be exempted. That is a real limit and
 * an honest one: `SUBSCRIPTION_SHARING_*` produce `affectedUserIds: []` when the
 * Remnawave subscription maps to no rezeis user, and an exemption is granted
 * against a rezeis user id. Such a candidate simply falls through to the
 * hysteresis gate, which is the correct outcome — an operator who cannot name
 * the person has not cleared anybody.
 *
 * Expiry is re-checked here even though the loader already filtered on it, so
 * the predicate is true on its own terms and a long run cannot act on an
 * exemption that lapsed while it was working.
 */
function findCoveringExemption(
  exemptionsByUser: ReadonlyMap<string, readonly ActiveExemption[]>,
  candidate: FraudSignalCandidate,
  now: Date,
): ActiveExemption | null {
  if (exemptionsByUser.size === 0) return null;
  for (const userId of candidate.affectedUserIds) {
    const bucket = exemptionsByUser.get(userId);
    if (bucket === undefined) continue;
    for (const exemption of bucket) {
      if (exemption.expiresAt.getTime() <= now.getTime()) continue;
      if (!exemption.codes.includes(candidate.code)) continue;
      return exemption;
    }
  }
  return null;
}

/** Projects an exemption row for the operator UI. */
function mapExemption(
  row: {
    id: string;
    userId: string;
    codes: string[];
    reason: string;
    expiresAt: Date;
    createdBy: string | null;
    revokedAt: Date | null;
    revokedBy: string | null;
    createdAt: Date;
  },
  createdByLogin: string | null,
  now: Date,
): FraudExemptionInterface {
  return {
    id: row.id,
    userId: row.userId,
    codes: row.codes,
    reason: row.reason,
    expiresAt: row.expiresAt.toISOString(),
    createdBy: row.createdBy,
    createdByLogin,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    revokedBy: row.revokedBy,
    createdAt: row.createdAt.toISOString(),
    active: row.revokedAt === null && row.expiresAt.getTime() > now.getTime(),
  };
}

/** Reads back the severity a previous refresh recorded as currently observed. */
function readObservedSeverity(metadata: Prisma.JsonValue | null): FraudSignalSeverity | null {
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const raw = (metadata as Record<string, unknown>).observedSeverity;
  return typeof raw === 'string' && raw in SEVERITY_RANK ? (raw as FraudSignalSeverity) : null;
}

/** Pulls distinct IP strings out of a sharing signal's `metadata.ips`. */
function extractIps(metadata: Record<string, unknown>): readonly string[] {
  const raw = metadata.ips;
  if (!Array.isArray(raw)) return [];
  const ips = raw
    .map((entry) => {
      if (entry !== null && typeof entry === 'object' && 'ip' in entry) {
        const ip = (entry as { ip?: unknown }).ip;
        return typeof ip === 'string' ? ip : null;
      }
      return null;
    })
    .filter((ip): ip is string => ip !== null && ip.length > 0);
  return [...new Set(ips)];
}

/**
 * One node a flagged user is connected to, as the drilldown endpoint serves it.
 *
 * Declared here rather than re-exported from the panel client because it is a
 * WIRE shape: `GET /admin/fraud/signals/:id/live-ips` returns it verbatim, and
 * the client's own type follows the vendor contract — including a `lastSeen`
 * that is a `Date` after validation and a string after drift. Pinning the
 * response here is what stops the admin SPA's payload changing shape depending
 * on whether the panel's answer matched the pinned contract.
 */
export interface FraudSignalLiveNodeIps {
  readonly nodeUuid: string;
  readonly nodeName: string;
  readonly countryCode: string | null;
  readonly ips: ReadonlyArray<{ readonly ip: string; readonly lastSeen: string | null }>;
}

/**
 * Why a drop was not accepted, in words an operator can act on.
 *
 * `invalid-request` is called out separately and deliberately: it is rezeis's
 * own bug, caught by the contract before anything left the process, and telling
 * an operator "the panel refused" about it sends them to look at a healthy
 * panel.
 */
function describeDropFailure(outcome: PanelDevicesOutcome<unknown>): string {
  switch (outcome.kind) {
    case 'ok':
      // Unreachable — the caller checks `kind` first — but an empty string here
      // would surface to the operator as a bare "Failed to drop connections:".
      return 'the panel accepted it';
    case 'rejected':
      return `the panel refused it (HTTP ${outcome.status}${
        outcome.code === null ? '' : ` ${outcome.code}`
      })${outcome.detail === null ? '' : `: ${outcome.detail}`}`;
    case 'network':
      return `the panel did not answer: ${outcome.detail}`;
    case 'unconfigured':
      return 'the Remnawave connection is not configured';
    case 'invalid-request':
      return `rezeis built the request wrong, so nothing was sent: ${outcome.detail}`;
    case 'unreadable':
      return `the panel answered a shape this build could not read: ${outcome.detail}`;
  }
}

/**
 * A panel identity as its numeric user id, or `null`.
 *
 * The WHOLE string has to be digits. `Number.parseInt` reads a LEADING run and
 * stops, so a 2.x-era uuid (`330f2b38-1362-46ab-…`) would come back as `330` —
 * a perfectly valid-looking id belonging to somebody else, and this value
 * decides whose connections get dropped.
 */
function readPanelUserId(identity: string): number | null {
  const trimmed = identity.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** Safe-integer ids only, deduped, order preserved. */
function dedupeIds(values: ReadonlyArray<number | null | undefined>): readonly number[] {
  const seen = new Set<number>();
  for (const value of values) {
    if (typeof value === 'number' && Number.isSafeInteger(value)) seen.add(value);
  }
  return [...seen];
}

/**
 * A panel timestamp as ISO-8601, reading BOTH the `Date` the contract produces
 * and the wire string the executor's drift path hands back. `null` for anything
 * that is not a placeable instant, so a drilldown row never carries a
 * timestamp nobody can interpret.
 */
function readInstantIso(value: unknown): string | null {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? value.toISOString() : null;
  }
  if (typeof value === 'string' && value.length > 0) {
    return Number.isFinite(Date.parse(value)) ? value : null;
  }
  return null;
}

function mapSignal(row: FraudSignal): FraudSignalInterface {
  return {
    id: row.id,
    code: row.code,
    severity: row.severity,
    status: row.status,
    title: row.title,
    description: row.description,
    score: row.score,
    confidence: row.confidence,
    affectedUserIds: row.affectedUserIds,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    lastAction: row.lastAction,
    detectedAt: row.detectedAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    resolvedBy: row.resolvedBy,
    resolutionNote: row.resolutionNote,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
