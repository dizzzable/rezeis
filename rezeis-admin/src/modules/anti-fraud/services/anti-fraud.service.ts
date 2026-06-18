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
  RemnawaveApiService,
  RemnawaveDropConnectionsInput,
  RemnawaveUserNodeIps,
} from '../../remnawave/services/remnawave-api.service';
import { FraudDetectors } from '../detectors/fraud-detectors';
import { RemnawaveDetectors } from '../detectors/remnawave-detectors';
import { SharingDetectors } from '../detectors/sharing-detectors';
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

/** Result of an `upsertSignal` call — useful for logging and tests. */
interface UpsertSignalResult {
  readonly signal: FraudSignalInterface;
  readonly action: FraudSignalAction;
  readonly created: boolean;
}

@Injectable()
export class AntiFraudService {
  private readonly logger = new Logger(AntiFraudService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly fraudDetectors: FraudDetectors,
    private readonly remnawaveDetectors: RemnawaveDetectors,
    private readonly sharingDetectors: SharingDetectors,
    private readonly remnawaveApiService: RemnawaveApiService,
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
        ? typeof meta.distinctIpCount === 'number'
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
    this.systemEventsService.info(
      'fraud.signal_transitioned',
      'SYSTEM',
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
   * nodes via Remnawave `ip-control`. Resolves the Remnawave subscription
   * UUIDs from the signal (`metadata.remnawaveUuid` first, then the affected
   * rezeis users' subscriptions). Writes an audit entry + FRAUD event; does
   * not change the signal status (the operator still acknowledges/resolves).
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
    let dropBy: RemnawaveDropConnectionsInput['dropBy'];
    let auditTargets: readonly string[];

    if (input.mode === 'ip') {
      const ips = extractIps(metadata);
      if (ips.length === 0) {
        throw new BadRequestException('Signal has no IP addresses to drop');
      }
      dropBy = { by: 'ipAddresses', ipAddresses: [...ips] };
      auditTargets = ips;
    } else {
      const uuids = await this.resolveSignalUserUuids(signal.affectedUserIds, metadata);
      if (uuids.length === 0) {
        throw new BadRequestException('Signal has no resolvable Remnawave users to drop');
      }
      dropBy = { by: 'userUuids', userUuids: [...uuids] };
      auditTargets = uuids;
    }

    let outcome: { ok: boolean };
    try {
      outcome = await this.remnawaveApiService.dropConnections({
        dropBy,
        targetNodes: { target: 'allNodes' },
      });
    } catch (err) {
      throw new BadRequestException(
        `Failed to drop connections: ${(err as Error).message}`,
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

    return { ok: outcome.ok, dropped: { by: input.mode, count: auditTargets.length } };
  }

  /**
   * On-demand live IP drilldown for a signal's user (read-only) — used by the
   * detail sheet. Returns the per-node IP breakdown via `ip-control`, or `[]`.
   */
  public async getSignalLiveIps(signalId: string): Promise<readonly RemnawaveUserNodeIps[]> {
    const signal = await this.prismaService.fraudSignal.findUnique({
      where: { id: signalId },
    });
    if (!signal) throw new NotFoundException('Fraud signal not found');
    const metadata = (signal.metadata as Record<string, unknown>) ?? {};
    const uuids = await this.resolveSignalUserUuids(signal.affectedUserIds, metadata);
    if (uuids.length === 0) return [];
    return this.remnawaveApiService.fetchUserIps(uuids[0]);
  }

  /**
   * Resolves a signal's affected users to Remnawave subscription UUIDs.
   * Prefers `metadata.remnawaveUuid` (sharing signals carry it) and falls
   * back to the affected rezeis users' subscriptions.
   */
  private async resolveSignalUserUuids(
    affectedUserIds: readonly string[],
    metadata: Record<string, unknown>,
  ): Promise<readonly string[]> {
    const fromMeta = typeof metadata.remnawaveUuid === 'string' ? [metadata.remnawaveUuid] : [];
    if (fromMeta.length > 0) return fromMeta;
    if (affectedUserIds.length === 0) return [];
    const subs = await this.prismaService.subscription.findMany({
      where: { userId: { in: [...affectedUserIds] }, remnawaveId: { not: null } },
      select: { remnawaveId: true },
    });
    const uuids = subs
      .map((s) => s.remnawaveId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    return [...new Set(uuids)];
  }

  /**
   * Runs every detector and upserts any candidates as fraud signals.
   * Safe to call repeatedly — the `(code, fingerprint)` unique key keeps
   * the table from growing unboundedly.
   */
  public async runDetectors(): Promise<readonly UpsertSignalResult[]> {
    const now = new Date();
    const candidateBatches = await Promise.all([
      this.fraudDetectors.detectExcessiveFailedPayments(now),
      this.fraudDetectors.detectRapidReferralVelocity(now),
      this.fraudDetectors.detectPromoAbuse(now),
      this.fraudDetectors.detectRapidChurn(now),
      this.remnawaveDetectors.detectHwidAnomalies(now),
      this.remnawaveDetectors.detectNodeTrafficAbuse(now),
      this.remnawaveDetectors.detectGeoAnomalies(now),
      this.remnawaveDetectors.detectOfflineNodes(now),
      this.sharingDetectors.detectHwidOverage(now),
      this.sharingDetectors.detectConcurrentIpSharing(now),
    ]);
    const candidates = candidateBatches.flat();
    const results: UpsertSignalResult[] = [];
    for (const candidate of candidates) {
      try {
        results.push(await this.upsertSignal(candidate));
      } catch (err) {
        this.logger.warn(`Failed to upsert signal ${candidate.code}: ${(err as Error).message}`);
      }
    }
    if (results.length > 0) {
      this.logger.log(
        `Anti-fraud detectors processed ${candidates.length} candidates → ${results.filter((r) => r.created).length} new signals`,
      );
    }
    return results;
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
   * Upserts a candidate keyed by `(code, fingerprint)`. If an open
   * signal with the same key exists, only `updatedAt` and `score` are
   * refreshed — the operator-facing identity stays stable.
   */
  private async upsertSignal(candidate: FraudSignalCandidate): Promise<UpsertSignalResult> {
    const existing = await this.prismaService.fraudSignal.findUnique({
      where: {
        code_fingerprint: {
          code: candidate.code,
          fingerprint: candidate.fingerprint,
        },
      },
    });
    if (existing && existing.status === FraudSignalStatus.OPEN) {
      const refreshed = await this.prismaService.fraudSignal.update({
        where: { id: existing.id },
        data: {
          score: candidate.score,
          confidence: candidate.confidence,
          affectedUserIds: [...candidate.affectedUserIds],
          metadata: candidate.metadata as Prisma.InputJsonValue,
        },
      });
      return { signal: mapSignal(refreshed), action: 'none', created: false };
    }

    const action = DEFAULT_ACTIONS_BY_SEVERITY[candidate.severity];
    // Resolved/Dismissed rows with the same fingerprint exist — that's
    // the operator's verdict on a previous occurrence. We **don't**
    // re-open the same row; instead we vary the fingerprint by appending
    // a millisecond suffix so the new occurrence becomes a fresh row.
    const fingerprint =
      existing && existing.status !== FraudSignalStatus.OPEN
        ? `${candidate.fingerprint}#${Date.now()}`
        : candidate.fingerprint;

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
        metadata: candidate.metadata as Prisma.InputJsonValue,
        lastAction: action,
      },
    });

    if (action === 'notify') {
      const notifyMeta = await this.buildFraudNotifyPayload(created, candidate);
      this.systemEventsService.warn(
        EVENT_TYPES.FRAUD_SIGNAL_OPENED,
        'FRAUD',
        `Fraud signal: ${candidate.title}`,
        notifyMeta,
      );
    }

    return { signal: mapSignal(created), action, created: true };
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
        ? typeof meta.distinctIpCount === 'number'
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

    const rezeisUserId = candidate.affectedUserIds[0] ?? null;
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
