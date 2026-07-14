import { Injectable, Logger } from '@nestjs/common';
import { Prisma, SubscriptionStatus } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { readJsonObject } from '../../../common/utils/read-json-object.util';
import {
  CutoverClassification,
  deriveCutoverBaseline,
} from '../domain/cutover-baseline';
import { provisionalResetAnchor } from '../domain/reset-cycle-policy';
import { EffectiveProjectionService } from './effective-projection.service';
import { SubscriptionTermService } from './subscription-term.service';

/** Bound the number of subscriptions grandfathered per batch. */
const CUTOVER_BATCH = 500;

export interface CutoverSubscriptionResult {
  readonly subscriptionId: string;
  readonly outcome: 'CREATED' | 'SKIPPED_DELETED' | 'SKIPPED_EXISTING';
  readonly classification: CutoverClassification | null;
  readonly ambiguousReasons: readonly string[];
  readonly termId?: string;
  readonly baseTrafficLimitBytes?: bigint | null;
  readonly baseDeviceLimit?: number | null;
}

export interface CutoverRunOptions {
  /** When true (default), only counts candidates — no writes. */
  readonly dryRun?: boolean;
  readonly batchSize?: number;
}

export interface CutoverRunReport {
  readonly dryRun: boolean;
  readonly candidates: number;
  readonly created: number;
  readonly matched: number;
  readonly ambiguous: number;
  readonly skippedDeleted: number;
  readonly skippedExisting: number;
  readonly ambiguousSamples: ReadonlyArray<{
    readonly subscriptionId: string;
    readonly reasons: readonly string[];
  }>;
}

type CutoverSubscriptionRow = {
  readonly id: string;
  readonly status: SubscriptionStatus;
  readonly trafficLimit: number | null;
  readonly deviceLimit: number;
  readonly planSnapshot: Prisma.JsonValue;
  readonly createdAt: Date;
  readonly expiresAt: Date | null;
};

/**
 * Grandfather cutover: create exactly one ACTIVE `SubscriptionTerm` and a
 * SHADOW `SubscriptionEffectiveProjection` per existing non-deleted
 * subscription, derived from its current local limits. Additive and
 * observation-only — legacy fulfillment stays authoritative and no upstream
 * (Remnawave) write happens. Idempotent per subscription: a subscription that
 * already has any term is skipped, so the cutover is rerunnable.
 *
 * Historical top-ups/rewards are NOT converted into entitlements and are NOT
 * subtracted; the baseline is exactly the current effective local limit, so
 * the shadow projection equals the legacy limits by construction.
 */
@Injectable()
export class EntitlementCutoverService {
  private readonly logger = new Logger(EntitlementCutoverService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly subscriptionTermService: SubscriptionTermService,
    private readonly effectiveProjectionService: EffectiveProjectionService,
  ) {}

  /**
   * Grandfather a single subscription inside the caller's transaction.
   * Creates a scheduled term, activates it, then builds the shadow projection.
   */
  public async cutoverSubscriptionInTransaction(
    tx: Prisma.TransactionClient,
    subscription: CutoverSubscriptionRow,
  ): Promise<CutoverSubscriptionResult> {
    // Serialize cutover with every writer that follows the subscription parent
    // lock protocol. The candidate row may have been read well before this
    // transaction, so re-read all baseline columns only after the lock.
    const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id"
      FROM "subscriptions"
      WHERE "id" = ${subscription.id}
      FOR UPDATE
    `);
    const current =
      locked.length === 1
        ? await tx.subscription.findUnique({
            where: { id: subscription.id },
            select: {
              id: true,
              status: true,
              trafficLimit: true,
              deviceLimit: true,
              planSnapshot: true,
              createdAt: true,
              expiresAt: true,
            },
          })
        : null;
    if (current === null || current.status === SubscriptionStatus.DELETED) {
      return {
        subscriptionId: subscription.id,
        outcome: 'SKIPPED_DELETED',
        classification: null,
        ambiguousReasons: [],
      };
    }

    const existingTerm = await tx.subscriptionTerm.findFirst({
      where: { subscriptionId: subscription.id },
      select: { id: true },
    });
    if (existingTerm !== null) {
      return {
        subscriptionId: subscription.id,
        outcome: 'SKIPPED_EXISTING',
        classification: null,
        ambiguousReasons: [],
      };
    }

    const snapshot = readJsonObject(current.planSnapshot);
    const strategy = typeof snapshot['trafficLimitStrategy'] === 'string'
      ? (snapshot['trafficLimitStrategy'] as string)
      : null;
    const planId = typeof snapshot['id'] === 'string' ? (snapshot['id'] as string) : undefined;

    const baseline = deriveCutoverBaseline({
      trafficLimit: current.trafficLimit,
      deviceLimit: current.deviceLimit,
      trafficLimitStrategy: strategy,
      createdAt: current.createdAt,
      expiresAt: current.expiresAt,
    });

    const scheduled = await this.subscriptionTermService.createScheduledInTransaction(tx, {
      subscriptionId: subscription.id,
      planId,
      planSnapshot: snapshot as Prisma.InputJsonValue,
      startsAt: baseline.startsAt,
      endsAt: baseline.endsAt,
      baseTrafficLimitBytes: baseline.baseTrafficLimitBytes,
      baseDeviceLimit: baseline.baseDeviceLimit,
      trafficResetStrategy: baseline.trafficResetStrategy,
      resetAnchorAt: provisionalResetAnchor(baseline.trafficResetStrategy, baseline.startsAt),
    });
    await this.subscriptionTermService.activateInTransaction(tx, scheduled.id, baseline.startsAt);
    await this.effectiveProjectionService.recomputeInTransaction(tx, {
      subscriptionId: subscription.id,
      mode: 'SHADOW',
    });

    return {
      subscriptionId: subscription.id,
      outcome: 'CREATED',
      classification: baseline.classification,
      ambiguousReasons: baseline.ambiguousReasons,
      termId: scheduled.id,
      baseTrafficLimitBytes: baseline.baseTrafficLimitBytes,
      baseDeviceLimit: baseline.baseDeviceLimit,
    };
  }

  /**
   * Run the cutover over subscriptions that have no term yet. Dry-run (default)
   * only counts candidates. Returns a report with match/ambiguous/skip counts.
   */
  public async runCutover(options: CutoverRunOptions = {}): Promise<CutoverRunReport> {
    const dryRun = options.dryRun ?? true;
    const batchSize = options.batchSize ?? CUTOVER_BATCH;

    const candidates = await this.prismaService.subscription.findMany({
      where: {
        status: { not: SubscriptionStatus.DELETED },
        terms: { none: {} },
      },
      select: {
        id: true,
        status: true,
        trafficLimit: true,
        deviceLimit: true,
        planSnapshot: true,
        createdAt: true,
        expiresAt: true,
      },
      take: batchSize,
      orderBy: { createdAt: 'asc' },
    });

    const report = {
      dryRun,
      candidates: candidates.length,
      created: 0,
      matched: 0,
      ambiguous: 0,
      skippedDeleted: 0,
      skippedExisting: 0,
      ambiguousSamples: [] as Array<{ subscriptionId: string; reasons: readonly string[] }>,
    };

    if (dryRun) {
      // Dry-run classifies from the pure derivation without any writes.
      for (const subscription of candidates) {
        const snapshot = readJsonObject(subscription.planSnapshot);
        const strategy = typeof snapshot['trafficLimitStrategy'] === 'string'
          ? (snapshot['trafficLimitStrategy'] as string)
          : null;
        const baseline = deriveCutoverBaseline({
          trafficLimit: subscription.trafficLimit,
          deviceLimit: subscription.deviceLimit,
          trafficLimitStrategy: strategy,
          createdAt: subscription.createdAt,
          expiresAt: subscription.expiresAt,
        });
        if (baseline.classification === 'AMBIGUOUS') {
          report.ambiguous += 1;
          if (report.ambiguousSamples.length < 20) {
            report.ambiguousSamples.push({
              subscriptionId: subscription.id,
              reasons: baseline.ambiguousReasons,
            });
          }
        } else {
          report.matched += 1;
        }
      }
      this.logger.log(
        `Cutover dry-run: ${report.candidates} candidate(s), ${report.matched} matched, ${report.ambiguous} ambiguous`,
      );
      return report;
    }

    for (const subscription of candidates) {
      const result = await this.prismaService.$transaction((tx) =>
        this.cutoverSubscriptionInTransaction(tx, subscription),
      );
      switch (result.outcome) {
        case 'CREATED':
          report.created += 1;
          if (result.classification === 'AMBIGUOUS') {
            report.ambiguous += 1;
            if (report.ambiguousSamples.length < 20) {
              report.ambiguousSamples.push({
                subscriptionId: result.subscriptionId,
                reasons: result.ambiguousReasons,
              });
            }
          } else {
            report.matched += 1;
          }
          break;
        case 'SKIPPED_DELETED':
          report.skippedDeleted += 1;
          break;
        case 'SKIPPED_EXISTING':
          report.skippedExisting += 1;
          break;
      }
    }

    this.logger.log(
      `Cutover applied: created ${report.created} (${report.matched} matched, ${report.ambiguous} ambiguous), ` +
        `skipped ${report.skippedExisting} existing / ${report.skippedDeleted} deleted`,
    );
    return report;
  }
}
