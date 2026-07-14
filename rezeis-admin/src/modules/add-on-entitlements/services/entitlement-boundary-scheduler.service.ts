import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AddOnEntitlementState, SubscriptionTermStatus } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { shouldRunSchedules } from '../../../common/runtime/process-role.util';
import { ProfileSyncQueueService } from '../../profile-sync/profile-sync-queue.service';
import { resolveAddOnRolloutFlags } from '../add-on-rollout.config';
import { DeviceReductionExecutionService } from './device-reduction-execution.service';
import { DeviceReductionPlanService } from './device-reduction-plan.service';
import { EntitlementBoundaryService } from './entitlement-boundary.service';

/** Max subscriptions swept for due boundaries per tick. */
const MAX_PER_TICK = 200;

/**
 * EntitlementBoundarySchedulerService (T-008)
 * ───────────────────────────────────────────
 * The authoritative local-time driver of add-on expiry. It finds every
 * subscription that has an ACTIVE entitlement past its `expiresAt` boundary and
 * runs the idempotent {@link EntitlementBoundaryService} for each, enqueuing any
 * profile-sync jobs the boundary produced so the reduced desired limit
 * propagates upstream. Worker-only (`shouldRunSchedules`). A webhook-observed
 * reset/expiry can additionally trigger the SAME idempotent boundary at/after
 * the planned instant, but the scheduler guarantees convergence even if no
 * webhook arrives.
 */
@Injectable()
export class EntitlementBoundarySchedulerService {
  private readonly logger = new Logger(EntitlementBoundarySchedulerService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly entitlementBoundaryService: EntitlementBoundaryService,
    private readonly profileSyncQueueService: ProfileSyncQueueService,
    private readonly deviceReductionPlanService: DeviceReductionPlanService,
    private readonly deviceReductionExecutionService: DeviceReductionExecutionService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'entitlement-boundary-sweep' })
  public async sweep(): Promise<void> {
    if (!shouldRunSchedules()) return;
    const { subscriptions, enqueued } = await this.runDueBoundaries();
    if (subscriptions > 0) {
      this.logger.log(
        `Entitlement boundary sweep: processed ${subscriptions} subscription(s), enqueued ${enqueued} sync job(s)`,
      );
    }
  }

  public async runDueBoundaries(
    now: Date = new Date(),
  ): Promise<{ readonly subscriptions: number; readonly enqueued: number }> {
    const [dueEntitlements, dueTerms] = await Promise.all([
      this.prismaService.addOnEntitlement.findMany({
        where: {
          state: { in: [AddOnEntitlementState.ACTIVE, AddOnEntitlementState.EXPIRING] },
          expiresAt: { not: null, lte: now },
        },
        select: { subscriptionId: true },
        distinct: ['subscriptionId'],
        take: MAX_PER_TICK,
      }),
      this.prismaService.subscriptionTerm.findMany({
        where: { status: SubscriptionTermStatus.SCHEDULED, startsAt: { lte: now } },
        select: { subscriptionId: true },
        distinct: ['subscriptionId'],
        take: MAX_PER_TICK,
      }),
    ]);
    const subscriptionIds = [
      ...new Set([
        ...dueEntitlements.map((r) => r.subscriptionId),
        ...dueTerms.map((r) => r.subscriptionId),
      ]),
    ];

    let enqueued = 0;
    for (const subscriptionId of subscriptionIds) {
      try {
        // Activate a due scheduled (renewal) term first, then expire due
        // entitlements — the term-start boundary and the old-term expiry may
        // coincide at the same tick.
        const activation = await this.entitlementBoundaryService.activateDueScheduledTerm(
          subscriptionId,
          now,
        );
        for (const syncJobId of activation.syncJobIds) {
          await this.profileSyncQueueService.enqueue(syncJobId);
          enqueued += 1;
        }

        const result = await this.entitlementBoundaryService.expireDueForSubscription(
          subscriptionId,
          now,
        );
        for (const syncJobId of result.syncJobIds) {
          await this.profileSyncQueueService.enqueue(syncJobId);
          enqueued += 1;
        }
        // A device-slot boundary just dropped the desired device limit. Planning
        // is re-entered for EXPIRING rows until it reaches a verified terminal
        // outcome; transient DEFERRED/BLOCKED results remain durably retryable.
        if (result.deviceExpiryTriggered) {
          const planning = await this.deviceReductionPlanService.planForSubscription(subscriptionId);
          if (planning.status === 'VERIFIED') {
            await this.entitlementBoundaryService.completeVerifiedDeviceExpiryForSubscription(
              subscriptionId,
              planning.projectionRevision,
              now,
            );
          } else if (
            planning.status === 'PLANNED' &&
            resolveAddOnRolloutFlags().deviceCleanupAuto
          ) {
            await this.deviceReductionExecutionService.executePlan(planning.planId);
          }
        }
      } catch (err: unknown) {
        // One subscription's failure must not abort the whole sweep.
        this.logger.warn(
          `Boundary processing failed for ${subscriptionId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return { subscriptions: subscriptionIds.length, enqueued };
  }
}
