import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../common/prisma/prisma.service';

export interface EntitlementInspectionRow {
  readonly id: string;
  readonly type: string;
  readonly state: string;
  readonly lifetime: string;
  readonly valuePerUnit: number;
  readonly totalValue: string;
  readonly currency: string;
  readonly totalAmount: string;
  readonly purchasedAt: string;
  readonly activatedAt: string | null;
  readonly expiresAt: string | null;
  readonly terminalReason: string | null;
  readonly sourceTransactionId: string;
  readonly sourceLineKey: string;
  readonly catalogRevision: number;
}

export interface ProjectionInspection {
  readonly desiredRevision: string;
  readonly state: string;
  readonly desiredTrafficLimitBytes: string | null;
  readonly desiredDeviceLimit: number | null;
  readonly lastAppliedRevision: string | null;
}

export interface IncidentInspection {
  readonly id: string;
  readonly kind: string;
  readonly severity: string;
  readonly state: string;
  readonly summaryCode: string;
  readonly createdAt: string;
}

export interface DevicePlanInspection {
  readonly id: string;
  readonly state: string;
  readonly desiredLimit: number;
  readonly projectionRevision: string;
  /** Bounded target COUNT only — raw HWIDs are never returned in the inspect view. */
  readonly targetCount: number;
  readonly attempts: number;
}

export interface SubscriptionEntitlementInspection {
  readonly subscriptionId: string;
  readonly entitlements: readonly EntitlementInspectionRow[];
  readonly projection: ProjectionInspection | null;
  readonly incidents: readonly IncidentInspection[];
  readonly deviceReductionPlans: readonly DevicePlanInspection[];
}

/**
 * AddOnEntitlementInspectionService (T-013)
 * ─────────────────────────────────────────
 * Read-only operator inspection of a subscription's durable add-on state:
 * the immutable ledger rows, the effective projection (desired vs applied
 * revision), open/closed incidents and device-reduction plans. Restricted
 * HWID display: device plans expose only a target COUNT, never the raw HWIDs.
 * No direct ledger editing — mutations go through the dedicated remediation
 * commands (retry/reconcile/reverse/approve) with their own permissions.
 */
@Injectable()
export class AddOnEntitlementInspectionService {
  public constructor(private readonly prismaService: PrismaService) {}

  public async inspectSubscription(subscriptionId: string): Promise<SubscriptionEntitlementInspection> {
    const [entitlements, projection, incidents, plans] = await Promise.all([
      this.prismaService.addOnEntitlement.findMany({
        where: { subscriptionId },
        orderBy: { purchasedAt: 'desc' },
        select: {
          id: true,
          type: true,
          state: true,
          lifetime: true,
          valuePerUnit: true,
          totalValue: true,
          currency: true,
          totalAmount: true,
          purchasedAt: true,
          activatedAt: true,
          expiresAt: true,
          terminalReason: true,
          sourceTransactionId: true,
          sourceLineKey: true,
          catalogRevision: true,
        },
      }),
      this.prismaService.subscriptionEffectiveProjection.findUnique({
        where: { subscriptionId },
        select: {
          desiredRevision: true,
          state: true,
          desiredTrafficLimitBytes: true,
          desiredDeviceLimit: true,
          lastAppliedRevision: true,
        },
      }),
      this.prismaService.entitlementIncident.findMany({
        where: { subscriptionId },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: { id: true, kind: true, severity: true, state: true, summaryCode: true, createdAt: true },
      }),
      this.prismaService.deviceReductionPlan.findMany({
        where: { subscriptionId },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: { id: true, state: true, desiredLimit: true, projectionRevision: true, selectedDevices: true, attempts: true },
      }),
    ]);

    return {
      subscriptionId,
      entitlements: entitlements.map((row) => ({
        id: row.id,
        type: row.type,
        state: row.state,
        lifetime: row.lifetime,
        valuePerUnit: row.valuePerUnit,
        totalValue: row.totalValue.toString(),
        currency: row.currency,
        totalAmount: row.totalAmount.toString(),
        purchasedAt: row.purchasedAt.toISOString(),
        activatedAt: row.activatedAt?.toISOString() ?? null,
        expiresAt: row.expiresAt?.toISOString() ?? null,
        terminalReason: row.terminalReason,
        sourceTransactionId: row.sourceTransactionId,
        sourceLineKey: row.sourceLineKey,
        catalogRevision: row.catalogRevision,
      })),
      projection:
        projection === null
          ? null
          : {
              desiredRevision: projection.desiredRevision.toString(),
              state: projection.state,
              desiredTrafficLimitBytes:
                projection.desiredTrafficLimitBytes === null
                  ? null
                  : projection.desiredTrafficLimitBytes.toString(),
              desiredDeviceLimit: projection.desiredDeviceLimit,
              lastAppliedRevision:
                projection.lastAppliedRevision === null ? null : projection.lastAppliedRevision.toString(),
            },
      incidents: incidents.map((row) => ({
        id: row.id,
        kind: row.kind,
        severity: row.severity,
        state: row.state,
        summaryCode: row.summaryCode,
        createdAt: row.createdAt.toISOString(),
      })),
      deviceReductionPlans: plans.map((row) => ({
        id: row.id,
        state: row.state,
        desiredLimit: row.desiredLimit,
        projectionRevision: row.projectionRevision.toString(),
        targetCount: Array.isArray(row.selectedDevices) ? row.selectedDevices.length : 0,
        attempts: row.attempts,
      })),
    };
  }
}
