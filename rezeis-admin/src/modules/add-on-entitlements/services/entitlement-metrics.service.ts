import { Injectable } from '@nestjs/common';
import {
  AddOnEntitlementState,
  DeviceReductionPlanState,
  EffectiveProjectionState,
  EntitlementIncidentKind,
  EntitlementIncidentState,
  PurchaseType,
  SyncJobStatus,
  TransactionStatus,
} from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';

const DEFAULT_OBJECTIVE_MS = 5 * 60_000;
const DEFAULT_ALERT_MS = 15 * 60_000;

export interface EntitlementSlo {
  readonly objectiveMs: number;
  readonly alertMs: number;
  /** COMPLETED add-on transactions with no `fulfilledAt`, older than the objective/alert. */
  readonly strandedCapturedOverObjective: number;
  readonly strandedCapturedOverAlert: number;
  readonly oldestStrandedAgeMs: number | null;
  /** Non-superseded PENDING profile-sync jobs older than the objective/alert. */
  readonly pendingSyncOverObjective: number;
  readonly pendingSyncOverAlert: number;
  readonly oldestPendingSyncAgeMs: number | null;
}

export interface EntitlementMetrics {
  readonly entitlementsByState: Readonly<Record<AddOnEntitlementState, number>>;
  readonly projectionsByState: Readonly<Record<EffectiveProjectionState, number>>;
  readonly deviceReductionPlansByState: Readonly<Record<DeviceReductionPlanState, number>>;
  readonly openIncidentsByKind: Readonly<Record<EntitlementIncidentKind, number>>;
  readonly slo: EntitlementSlo;
}

function parseMs(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

function zeroFill<E extends string>(
  enumValues: readonly E[],
  groups: ReadonlyArray<{ readonly _count: { readonly _all: number } } & Record<string, unknown>>,
  key: string,
): Record<E, number> {
  const record = Object.fromEntries(enumValues.map((v) => [v, 0])) as Record<E, number>;
  for (const group of groups) {
    const label = group[key];
    if (typeof label === 'string' && label in record) {
      record[label as E] = group._count._all;
    }
  }
  return record;
}

/**
 * EntitlementMetricsService (T-012)
 * ─────────────────────────────────
 * Read-only observability over the durable add-on pipeline. It separates the
 * three truths — MONEY (captured transaction), LOCAL COMMITMENT (entitlement
 * ledger / projection) and VERIFIED SERVICE (applied sync) — into bounded
 * counters, plus an SLO view of the actionable backlog (paid-but-unfulfilled
 * lines and stalled projection pushes) with configurable objective/alert
 * thresholds. Labels are bounded enum states only — NO user ids, HWIDs, tokens
 * or provider payloads (those belong in correlated logs, not metrics).
 */
@Injectable()
export class EntitlementMetricsService {
  public constructor(private readonly prismaService: PrismaService) {}

  public async collect(now: Date = new Date()): Promise<EntitlementMetrics> {
    const objectiveMs = parseMs(process.env['ADDON_SLO_OBJECTIVE_MS'], DEFAULT_OBJECTIVE_MS);
    const alertMs = parseMs(process.env['ADDON_SLO_ALERT_MS'], DEFAULT_ALERT_MS);
    const objectiveCutoff = new Date(now.getTime() - objectiveMs);
    const alertCutoff = new Date(now.getTime() - alertMs);

    const [entGroups, projGroups, planGroups, incidentGroups] = await Promise.all([
      this.prismaService.addOnEntitlement.groupBy({ by: ['state'], _count: { _all: true } }),
      this.prismaService.subscriptionEffectiveProjection.groupBy({ by: ['state'], _count: { _all: true } }),
      this.prismaService.deviceReductionPlan.groupBy({ by: ['state'], _count: { _all: true } }),
      this.prismaService.entitlementIncident.groupBy({
        by: ['kind'],
        where: { state: EntitlementIncidentState.OPEN },
        _count: { _all: true },
      }),
    ]);

    const strandedWhere = {
      status: TransactionStatus.COMPLETED,
      purchaseType: PurchaseType.ADDITIONAL,
      fulfilledAt: null,
    };
    const pendingSyncWhere = { status: SyncJobStatus.PENDING, supersededAt: null };

    const [
      strandedObjective,
      strandedAlert,
      oldestStranded,
      pendingSyncObjective,
      pendingSyncAlert,
      oldestPendingSync,
    ] = await Promise.all([
      this.prismaService.transaction.count({ where: { ...strandedWhere, createdAt: { lt: objectiveCutoff } } }),
      this.prismaService.transaction.count({ where: { ...strandedWhere, createdAt: { lt: alertCutoff } } }),
      this.prismaService.transaction.findFirst({
        where: strandedWhere,
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
      this.prismaService.profileSyncJob.count({ where: { ...pendingSyncWhere, createdAt: { lt: objectiveCutoff } } }),
      this.prismaService.profileSyncJob.count({ where: { ...pendingSyncWhere, createdAt: { lt: alertCutoff } } }),
      this.prismaService.profileSyncJob.findFirst({
        where: pendingSyncWhere,
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
    ]);

    const ageMs = (row: { createdAt: Date } | null): number | null =>
      row === null ? null : Math.max(0, now.getTime() - row.createdAt.getTime());

    return {
      entitlementsByState: zeroFill(Object.values(AddOnEntitlementState), entGroups, 'state'),
      projectionsByState: zeroFill(Object.values(EffectiveProjectionState), projGroups, 'state'),
      deviceReductionPlansByState: zeroFill(Object.values(DeviceReductionPlanState), planGroups, 'state'),
      openIncidentsByKind: zeroFill(Object.values(EntitlementIncidentKind), incidentGroups, 'kind'),
      slo: {
        objectiveMs,
        alertMs,
        strandedCapturedOverObjective: strandedObjective,
        strandedCapturedOverAlert: strandedAlert,
        oldestStrandedAgeMs: ageMs(oldestStranded),
        pendingSyncOverObjective: pendingSyncObjective,
        pendingSyncOverAlert: pendingSyncAlert,
        oldestPendingSyncAgeMs: ageMs(oldestPendingSync),
      },
    };
  }
}
