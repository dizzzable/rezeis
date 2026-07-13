import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  AddOnEntitlementActorType,
  EntitlementIncidentState,
  Prisma,
  SyncAction,
  SyncJobStatus,
} from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { ProfileSyncQueueService } from '../../profile-sync/profile-sync-queue.service';
import { GIB_BYTES } from '../domain/cutover-baseline';
import { AddOnEntitlementService } from './add-on-entitlement.service';
import { DeviceReductionExecutionService } from './device-reduction-execution.service';
import { EffectiveProjectionService } from './effective-projection.service';

export interface RemediationActor {
  readonly actorId: string;
  readonly commandKey: string;
  readonly reason: string;
}

/**
 * AddOnEntitlementRemediationService (T-013)
 * ──────────────────────────────────────────
 * The mutating operator remediation commands over the durable add-on state.
 * Each is idempotent (conditional claims / command keys / already-terminal
 * short-circuits) so a replayed command key is safe. The controller layer
 * gates each command with a distinct least-privilege permission and writes an
 * immutable `AdminAuditLog` (reason + command key + actor). There is NO direct
 * ledger editing — reversal goes through the entitlement state machine.
 */
@Injectable()
export class AddOnEntitlementRemediationService {
  private readonly logger = new Logger(AddOnEntitlementRemediationService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly addOnEntitlementService: AddOnEntitlementService,
    private readonly effectiveProjectionService: EffectiveProjectionService,
    private readonly profileSyncQueueService: ProfileSyncQueueService,
    private readonly deviceReductionExecutionService: DeviceReductionExecutionService,
  ) {}

  /** `run` — reset a subscription's FAILED (non-superseded) sync jobs and re-enqueue. */
  public async retryProfileSync(
    subscriptionId: string,
  ): Promise<{ readonly retried: number; readonly jobIds: readonly string[] }> {
    const failed = await this.prismaService.profileSyncJob.findMany({
      where: { subscriptionId, status: SyncJobStatus.FAILED, supersededAt: null },
      select: { id: true },
      take: 100,
    });
    const jobIds: string[] = [];
    for (const job of failed) {
      const reset = await this.prismaService.profileSyncJob.updateMany({
        where: { id: job.id, status: SyncJobStatus.FAILED, supersededAt: null },
        data: { status: SyncJobStatus.PENDING, attempts: 0, lastError: null },
      });
      if (reset.count === 1) {
        await this.profileSyncQueueService.enqueue(job.id, /* force */ true);
        jobIds.push(job.id);
      }
    }
    return { retried: jobIds.length, jobIds };
  }

  /** `resolve` — recompute the projection and push the latest desired state. */
  public async forceReconcile(
    subscriptionId: string,
  ): Promise<{ readonly changed: boolean; readonly desiredRevision: string | null; readonly syncJobId: string | null }> {
    const result = await this.prismaService.$transaction(async (tx) => {
      const projection = await this.effectiveProjectionService.recomputeInTransaction(tx, {
        subscriptionId,
        mode: 'ACTIVE',
      });
      if (!projection.changed) {
        return { changed: false, desiredRevision: projection.desiredRevision, syncJobId: null as string | null };
      }
      const subscription = await tx.subscription.update({
        where: { id: subscriptionId },
        data: {
          trafficLimit:
            projection.desiredTrafficLimitBytes === null
              ? null
              : Number(projection.desiredTrafficLimitBytes / GIB_BYTES),
          deviceLimit: projection.desiredDeviceLimit === null ? 0 : projection.desiredDeviceLimit,
        },
        select: { id: true, remnawaveId: true },
      });
      const syncJob = await tx.profileSyncJob.create({
        data: {
          subscriptionId,
          action: subscription.remnawaveId === null ? SyncAction.CREATE : SyncAction.UPDATE,
          status: SyncJobStatus.PENDING,
          aggregateKey: subscriptionId,
          desiredRevision: projection.desiredRevision,
          cause: 'OPERATOR_FORCE_RECONCILE',
          payload: { source: 'OPERATOR_FORCE_RECONCILE' } as Prisma.InputJsonObject,
        },
        select: { id: true },
      });
      return { changed: true, desiredRevision: projection.desiredRevision, syncJobId: syncJob.id };
    });
    if (result.syncJobId !== null) {
      await this.profileSyncQueueService.enqueue(result.syncJobId, /* force */ true);
    }
    return {
      changed: result.changed,
      desiredRevision: result.desiredRevision.toString(),
      syncJobId: result.syncJobId,
    };
  }

  /** `resolve` — acknowledge an OPEN incident (idempotent). */
  public async acknowledgeIncident(
    incidentId: string,
    actor: RemediationActor,
  ): Promise<{ readonly changed: boolean }> {
    const acknowledged = await this.prismaService.entitlementIncident.updateMany({
      where: { id: incidentId, state: EntitlementIncidentState.OPEN },
      data: {
        state: EntitlementIncidentState.ACKNOWLEDGED,
        acknowledgedBy: actor.actorId,
        acknowledgedAt: new Date(),
      },
    });
    if (acknowledged.count === 0) {
      const exists = await this.prismaService.entitlementIncident.findUnique({
        where: { id: incidentId },
        select: { id: true },
      });
      if (exists === null) throw new NotFoundException('Incident not found');
    }
    return { changed: acknowledged.count === 1 };
  }

  /** `enforce` — compensating reversal of an entitlement through the state machine. */
  public async reverseEntitlement(
    entitlementId: string,
    actor: RemediationActor,
  ): Promise<{ readonly state: string; readonly changed: boolean }> {
    const entitlement = await this.prismaService.addOnEntitlement.findUnique({
      where: { id: entitlementId },
      select: { subscriptionId: true },
    });
    if (entitlement === null) throw new NotFoundException('Entitlement not found');

    const outcome = await this.prismaService.$transaction(async (tx) => {
      const transition = await this.addOnEntitlementService.transitionInTransaction(tx, {
        entitlementId,
        command: 'REVERSE',
        commandKey: actor.commandKey,
        correlationId: `operator-reverse:${entitlementId}`,
        actorType: AddOnEntitlementActorType.ADMIN,
        actorId: actor.actorId,
        reason: actor.reason,
      });
      let syncJobId: string | null = null;
      if (transition.changed) {
        const projection = await this.effectiveProjectionService.recomputeInTransaction(tx, {
          subscriptionId: entitlement.subscriptionId,
          mode: 'ACTIVE',
        });
        const subscription = await tx.subscription.update({
          where: { id: entitlement.subscriptionId },
          data: {
            trafficLimit:
              projection.desiredTrafficLimitBytes === null
                ? null
                : Number(projection.desiredTrafficLimitBytes / GIB_BYTES),
            deviceLimit: projection.desiredDeviceLimit === null ? 0 : projection.desiredDeviceLimit,
          },
          select: { remnawaveId: true },
        });
        const syncJob = await tx.profileSyncJob.create({
          data: {
            subscriptionId: entitlement.subscriptionId,
            action: subscription.remnawaveId === null ? SyncAction.CREATE : SyncAction.UPDATE,
            status: SyncJobStatus.PENDING,
            aggregateKey: entitlement.subscriptionId,
            desiredRevision: projection.desiredRevision,
            cause: 'OPERATOR_REVERSAL',
            payload: { source: 'OPERATOR_REVERSAL', entitlementId } as Prisma.InputJsonObject,
          },
          select: { id: true },
        });
        syncJobId = syncJob.id;
      }
      return { state: transition.state, changed: transition.changed, syncJobId };
    });
    if (outcome.syncJobId !== null) {
      await this.profileSyncQueueService.enqueue(outcome.syncJobId, /* force */ true);
    }
    return { state: outcome.state, changed: outcome.changed };
  }

  /** `moderate` — approve + execute a BLOCKED/PENDING device-reduction plan (operator override). */
  public async approveDevicePlan(planId: string): Promise<{ readonly status: string }> {
    const outcome = await this.deviceReductionExecutionService.executePlan(planId, { force: true });
    return { status: outcome.status };
  }
}
