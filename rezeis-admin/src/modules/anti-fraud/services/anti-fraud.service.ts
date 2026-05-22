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
import { FraudDetectors } from '../detectors/fraud-detectors';
import { RemnawaveDetectors } from '../detectors/remnawave-detectors';
import {
  FraudSignalAction,
  FraudSignalCandidate,
  FraudSignalInterface,
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

  // ── Detector orchestration ─────────────────────────────────────────────

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
      this.systemEventsService.warn(
        EVENT_TYPES.SYSTEM_ERROR,
        'SYSTEM',
        `Fraud signal: ${candidate.title}`,
        {
          signalId: created.id,
          code: created.code,
          severity: created.severity,
          score: created.score,
          confidence: created.confidence,
          affectedUserIds: candidate.affectedUserIds,
        },
      );
    }

    return { signal: mapSignal(created), action, created: true };
  }
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
