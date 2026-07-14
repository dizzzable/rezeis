import { Injectable, Logger } from '@nestjs/common';
import {
  DeviceReductionPlanState,
  EntitlementIncidentKind,
  EntitlementIncidentSeverity,
  Prisma,
  SubscriptionStatus,
} from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { resolveAddOnRolloutFlags } from '../add-on-rollout.config';
import { RemnawaveApiService } from '../../remnawave/services/remnawave-api.service';
import { EntitlementBoundaryService } from './entitlement-boundary.service';

export type DeviceReductionExecutionOutcome =
  | { readonly status: 'AUTO_DISABLED' }
  | { readonly status: 'SKIPPED'; readonly reason: string }
  | { readonly status: 'APPLIED'; readonly deleted: number }
  | { readonly status: 'DEFERRED'; readonly reason: string }
  | { readonly status: 'BLOCKED'; readonly reason: string }
  | { readonly status: 'SUPERSEDED' }
  | { readonly status: 'REMEDIATION_REQUIRED' };

interface PlanTarget {
  readonly hwid: string;
  readonly createdAt: string;
}

type Guard =
  | { readonly kind: 'ok'; readonly remnawaveId: string; readonly desiredLimit: number }
  | { readonly kind: 'superseded'; readonly reason: string };

/**
 * DeviceReductionExecutionService (T-011, execution half)
 * ───────────────────────────────────────────────────────
 * Executes a persisted, immutable {@link DeviceReductionPlan} with the strict
 * adapter — the ONLY component that deletes HWID devices. It is dormant unless
 * the `deviceCleanupAuto` rollout flag is on (operator-reviewed plans first).
 *
 * Safety (design D-7):
 *  - fail-closed guards BEFORE and BEFORE-EACH delete: subscription not
 *    deleted, projection revision not superseded, desired limit still finite;
 *  - strict-list read-back each pass so we never delete more than the current
 *    overage, and a concurrent user change converges instead of over-deleting;
 *  - a planned target already absent is a no-op (idempotent), never a re-delete
 *    of a different victim;
 *  - transient panel failure → DEFERRED (retry); malformed/unsupported →
 *    BLOCKED + incident; still-over after targets exhausted →
 *    REMEDIATION_REQUIRED + incident.
 */
@Injectable()
export class DeviceReductionExecutionService {
  private readonly logger = new Logger(DeviceReductionExecutionService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly remnawaveApiService: RemnawaveApiService,
    private readonly entitlementBoundaryService: EntitlementBoundaryService,
  ) {}

  public async executePlan(
    planId: string,
    options: { readonly force?: boolean } = {},
  ): Promise<DeviceReductionExecutionOutcome> {
    if (!options.force && !resolveAddOnRolloutFlags().deviceCleanupAuto) {
      return { status: 'AUTO_DISABLED' };
    }

    const plan = await this.prismaService.deviceReductionPlan.findUnique({ where: { id: planId } });
    if (plan === null) {
      return { status: 'SKIPPED', reason: 'PLAN_NOT_FOUND' };
    }
    if (
      plan.state !== DeviceReductionPlanState.PENDING &&
      plan.state !== DeviceReductionPlanState.IN_PROGRESS
    ) {
      return { status: 'SKIPPED', reason: `PLAN_STATE_${plan.state}` };
    }

    const guard = await this.loadGuard(plan.subscriptionId, plan.projectionRevision);
    if (guard.kind === 'superseded') {
      await this.markState(planId, DeviceReductionPlanState.SUPERSEDED, guard.reason);
      return { status: 'SUPERSEDED' };
    }

    await this.prismaService.deviceReductionPlan.update({
      where: { id: planId },
      data: {
        state: DeviceReductionPlanState.IN_PROGRESS,
        startedAt: new Date(),
        attempts: { increment: 1 },
      },
    });

    const targets = readTargets(plan.selectedDevices);
    const { remnawaveId } = guard;
    let deleted = 0;

    for (const target of targets) {
      // Re-guard cheaply before every delete: a concurrent renewal/upgrade or
      // deletion must abort the saga rather than delete against a stale plan.
      const reguard = await this.loadGuard(plan.subscriptionId, plan.projectionRevision);
      if (reguard.kind === 'superseded') {
        await this.markState(planId, DeviceReductionPlanState.SUPERSEDED, reguard.reason);
        return { status: 'SUPERSEDED' };
      }
      const desiredLimit = reguard.desiredLimit;

      const listing = await this.remnawaveApiService.strictListUserDevices(remnawaveId);
      if (listing.kind === 'unavailable') {
        return { status: 'DEFERRED', reason: 'PANEL_UNAVAILABLE' };
      }
      if (listing.kind === 'notFound') {
        await this.markState(planId, DeviceReductionPlanState.SUPERSEDED, 'PANEL_PROFILE_ABSENT');
        return { status: 'SUPERSEDED' };
      }
      if (listing.kind !== 'ok') {
        return this.block(plan.subscriptionId, planId, `STRICT_LIST_${listing.kind.toUpperCase()}`);
      }

      // Never delete beyond the current overage — converge if a concurrent
      // change already brought the device count within the limit.
      if (listing.value.total - desiredLimit <= 0) {
        break;
      }
      const present = listing.value.devices.some((d) => d.hwid === target.hwid);
      if (!present) {
        // Already gone (read-back proved absence) — idempotent, no re-delete.
        continue;
      }

      const del = await this.remnawaveApiService.strictDeleteUserDevice(remnawaveId, target.hwid);
      if (del.kind === 'unavailable') {
        return { status: 'DEFERRED', reason: 'PANEL_UNAVAILABLE' };
      }
      if (del.kind === 'notFound') {
        // Raced to absent between list and delete — a later read-back confirms.
        continue;
      }
      if (del.kind !== 'ok') {
        return this.block(plan.subscriptionId, planId, `STRICT_DELETE_${del.kind.toUpperCase()}`);
      }
      deleted += 1;
    }

    // Final strict read-back proves the post-condition.
    const final = await this.remnawaveApiService.strictListUserDevices(remnawaveId);
    if (final.kind === 'unavailable') {
      return { status: 'DEFERRED', reason: 'PANEL_UNAVAILABLE' };
    }
    if (final.kind !== 'ok') {
      return this.block(plan.subscriptionId, planId, `FINAL_${final.kind.toUpperCase()}`);
    }

    if (final.value.total <= guard.desiredLimit) {
      const applied = await this.prismaService.$transaction(async (tx) => {
        const completion = await this.entitlementBoundaryService.completeVerifiedDeviceExpiryInTransaction(
          tx,
          plan.subscriptionId,
          plan.projectionRevision,
        );
        if (completion.status === 'SUPERSEDED') return false;

        await tx.deviceReductionPlan.update({
          where: { id: planId },
          data: {
            state: DeviceReductionPlanState.APPLIED,
            completedAt: new Date(),
            postconditionMetadata: {
              finalCount: final.value.total,
              deleted,
              desiredLimit: guard.desiredLimit,
            } as Prisma.InputJsonValue,
          },
        });
        return true;
      });
      if (!applied) {
        await this.markState(planId, DeviceReductionPlanState.SUPERSEDED, 'REVISION_ADVANCED');
        return { status: 'SUPERSEDED' };
      }
      return { status: 'APPLIED', deleted };
    }

    // Targets exhausted but still over the limit → operator remediation.
    await this.markState(planId, DeviceReductionPlanState.REMEDIATION_REQUIRED, 'STILL_OVER_LIMIT');
    await this.raiseIncident(
      plan.subscriptionId,
      planId,
      'STILL_OVER_LIMIT',
      EntitlementIncidentSeverity.WARNING,
    );
    return { status: 'REMEDIATION_REQUIRED' };
  }

  private async loadGuard(subscriptionId: string, planRevision: bigint): Promise<Guard> {
    const projection = await this.prismaService.subscriptionEffectiveProjection.findUnique({
      where: { subscriptionId },
      select: { desiredRevision: true, desiredDeviceLimit: true },
    });
    if (projection === null) return { kind: 'superseded', reason: 'NO_PROJECTION' };
    if (projection.desiredRevision !== planRevision) {
      return { kind: 'superseded', reason: 'REVISION_ADVANCED' };
    }
    if (projection.desiredDeviceLimit === null) {
      return { kind: 'superseded', reason: 'LIMIT_RELAXED_UNLIMITED' };
    }
    const subscription = await this.prismaService.subscription.findUnique({
      where: { id: subscriptionId },
      select: { remnawaveId: true, status: true },
    });
    if (subscription === null || subscription.remnawaveId === null) {
      return { kind: 'superseded', reason: 'NO_PANEL_PROFILE' };
    }
    if (subscription.status === SubscriptionStatus.DELETED) {
      return { kind: 'superseded', reason: 'SUBSCRIPTION_DELETED' };
    }
    return { kind: 'ok', remnawaveId: subscription.remnawaveId, desiredLimit: projection.desiredDeviceLimit };
  }

  private async markState(
    planId: string,
    state: DeviceReductionPlanState,
    lastErrorCode?: string,
  ): Promise<void> {
    await this.prismaService.deviceReductionPlan.update({
      where: { id: planId },
      data: { state, ...(lastErrorCode !== undefined ? { lastErrorCode } : {}) },
    });
  }

  private async block(
    subscriptionId: string,
    planId: string,
    reason: string,
  ): Promise<DeviceReductionExecutionOutcome> {
    this.logger.warn(`Device reduction plan ${planId} blocked: ${reason}`);
    await this.markState(planId, DeviceReductionPlanState.BLOCKED, reason);
    await this.raiseIncident(subscriptionId, planId, reason, EntitlementIncidentSeverity.CRITICAL);
    return { status: 'BLOCKED', reason };
  }

  private async raiseIncident(
    subscriptionId: string,
    planId: string,
    summaryCode: string,
    severity: EntitlementIncidentSeverity,
  ): Promise<void> {
    await this.prismaService.entitlementIncident.upsert({
      where: { supportRef: `device-reduction:${planId}` },
      update: {},
      create: {
        subscriptionId,
        kind: EntitlementIncidentKind.DEVICE_REDUCTION_BLOCKED,
        severity,
        supportRef: `device-reduction:${planId}`,
        summaryCode,
        metadata: { planId } as Prisma.InputJsonValue,
      },
    });
  }
}

function readTargets(selectedDevices: unknown): PlanTarget[] {
  if (!Array.isArray(selectedDevices)) return [];
  const out: PlanTarget[] = [];
  for (const raw of selectedDevices) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const hwid = typeof r['hwid'] === 'string' ? r['hwid'] : '';
    const createdAt = typeof r['createdAt'] === 'string' ? r['createdAt'] : '';
    if (hwid.length > 0) out.push({ hwid, createdAt });
  }
  return out;
}
