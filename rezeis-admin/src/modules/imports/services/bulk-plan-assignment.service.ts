import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, SubscriptionStatus, SyncAction } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';

export interface BulkPlanAssignmentInput {
  /** Plan ID to assign */
  readonly planId: string;
  /** Import record ID — assigns plan to all subscriptions created by this import */
  readonly importRecordId?: string;
  /** Explicit list of user IDs to target (alternative to importRecordId) */
  readonly userIds?: readonly string[];
  /** Admin who initiated the assignment */
  readonly createdBy: string;
  /**
   * Whether to push the new plan limits (traffic, devices, squads) to the
   * Remnawave panel right away. Defaults to **false** so a bulk re-plan
   * does not silently shrink customer limits — the new plan applies on
   * their next renewal/upgrade through the customer-facing flow.
   *
   * Set to `true` only for migrations where you explicitly want the
   * panel to be reshaped immediately.
   */
  readonly applyImmediately?: boolean;
}

export interface BulkPlanAssignmentResult {
  readonly updated: number;
  readonly skippedDeleted: number;
  readonly skippedAlreadyAssigned: number;
  readonly skippedNoSubscription: number;
  readonly errors: number;
  readonly syncJobsCreated: number;
}

/**
 * Bulk plan assignment service — assigns a plan to all imported/unassigned
 * subscriptions for a set of users.
 *
 * Donor: altshop `assign_plan_to_synced_users_task` in
 * `src/infrastructure/taskiq/tasks/importer.py`.
 *
 * Logic:
 *   - Only targets subscriptions where `planSnapshot.importedFrom` exists
 *     AND there's no real plan ID in the snapshot (or plan name is "IMPORTED").
 *   - Skips DELETED subscriptions.
 *   - Skips subscriptions that already have a real plan assigned.
 *   - Updates the subscription's planSnapshot with the selected plan's data.
 *   - Creates a ProfileSyncJob(UPDATE) to push the new limits/squads to Remnawave.
 */
@Injectable()
export class BulkPlanAssignmentService {
  private readonly logger = new Logger(BulkPlanAssignmentService.name);

  public constructor(private readonly prismaService: PrismaService) {}

  public async assignPlan(input: BulkPlanAssignmentInput): Promise<BulkPlanAssignmentResult> {
    // Load the plan with durations
    const plan = await this.prismaService.plan.findUnique({
      where: { id: input.planId },
      include: { durations: { where: { isActive: true }, orderBy: { days: 'asc' } } },
    });

    if (!plan) {
      throw new NotFoundException(`Plan '${input.planId}' not found`);
    }

    if (!plan.isActive) {
      throw new BadRequestException('Cannot assign an inactive plan');
    }

    // Determine target user IDs
    const userIds = await this.resolveUserIds(input);
    if (userIds.length === 0) {
      throw new BadRequestException('No users to assign plan to');
    }

    this.logger.log(
      `Starting bulk plan assignment: plan='${plan.name}' (${plan.id}), users=${userIds.length}`,
    );

    let updated = 0;
    let skippedDeleted = 0;
    let skippedAlreadyAssigned = 0;
    let skippedNoSubscription = 0;
    let errors = 0;
    let syncJobsCreated = 0;

    for (const userId of userIds) {
      try {
        const result = await this.assignPlanForUser(userId, plan, input.applyImmediately === true);
        updated += result.updated;
        skippedDeleted += result.skippedDeleted;
        skippedAlreadyAssigned += result.skippedAlreadyAssigned;
        if (result.updated === 0 && result.skippedDeleted === 0 && result.skippedAlreadyAssigned === 0) {
          skippedNoSubscription += 1;
        }
        syncJobsCreated += result.syncJobsCreated;
      } catch (err) {
        this.logger.warn(`Failed to assign plan for user ${userId}: ${(err as Error).message}`);
        errors += 1;
      }
    }

    this.logger.log(
      `Bulk plan assignment completed: updated=${updated}, skippedDeleted=${skippedDeleted}, ` +
      `skippedAlreadyAssigned=${skippedAlreadyAssigned}, skippedNoSubscription=${skippedNoSubscription}, ` +
      `errors=${errors}, syncJobsCreated=${syncJobsCreated}`,
    );

    return { updated, skippedDeleted, skippedAlreadyAssigned, skippedNoSubscription, errors, syncJobsCreated };
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private async resolveUserIds(input: BulkPlanAssignmentInput): Promise<string[]> {
    if (input.userIds && input.userIds.length > 0) {
      return [...input.userIds];
    }

    if (input.importRecordId) {
      // Find all users who have subscriptions created during this import
      // by looking at subscriptions with planSnapshot.importedFrom matching the import source
      const importRecord = await this.prismaService.importRecord.findUnique({
        where: { id: input.importRecordId },
      });
      if (!importRecord) {
        throw new NotFoundException(`Import record '${input.importRecordId}' not found`);
      }

      // Get all subscriptions that were imported from this source type
      // and created around the same time as the import
      const importTime = importRecord.createdAt;
      const windowStart = new Date(importTime.getTime() - 60_000); // 1 min before
      const windowEnd = new Date(importTime.getTime() + 300_000); // 5 min after

      const subscriptions = await this.prismaService.subscription.findMany({
        where: {
          createdAt: { gte: windowStart, lte: windowEnd },
          planSnapshot: { path: ['importedFrom'], equals: importRecord.sourceType },
        },
        select: { userId: true },
        distinct: ['userId'],
      });

      return subscriptions.map((s) => s.userId);
    }

    return [];
  }

  private async assignPlanForUser(
    userId: string,
    plan: {
      id: string;
      name: string;
      tag: string | null;
      type: string;
      trafficLimit: number | null;
      deviceLimit: number;
      trafficLimitStrategy: string;
      internalSquads: string[];
      externalSquad: string | null;
      durations: Array<{ days: number }>;
    },
    applyImmediately: boolean,
  ): Promise<{ updated: number; skippedDeleted: number; skippedAlreadyAssigned: number; syncJobsCreated: number }> {
    const subscriptions = await this.prismaService.subscription.findMany({
      where: { userId },
      select: { id: true, status: true, planSnapshot: true, remnawaveId: true },
    });

    let updated = 0;
    let skippedDeleted = 0;
    let skippedAlreadyAssigned = 0;
    let syncJobsCreated = 0;

    for (const subscription of subscriptions) {
      if (subscription.status === SubscriptionStatus.DELETED) {
        skippedDeleted += 1;
        continue;
      }

      if (!this.isImportedOrUnassigned(subscription.planSnapshot)) {
        skippedAlreadyAssigned += 1;
        continue;
      }

      // Resolve duration: use first available from plan
      const durationDays = plan.durations.length > 0 ? plan.durations[0].days : 30;

      // Build new plan snapshot
      const newPlanSnapshot: Prisma.InputJsonValue = {
        planId: plan.id,
        name: plan.name,
        tag: plan.tag,
        type: plan.type,
        trafficLimit: plan.trafficLimit,
        deviceLimit: plan.deviceLimit,
        trafficLimitStrategy: plan.trafficLimitStrategy,
        duration: durationDays,
        internalSquads: plan.internalSquads,
        externalSquad: plan.externalSquad,
      };

      // Update subscription with new plan data.
      //
      // Note: we only persist the plan link (planSnapshot + cached limits)
      // here. The actual Remnawave-side reshape (traffic / device cap /
      // squad membership) is gated by `applyImmediately` below — we do
      // not silently shrink a customer's panel limits as a side-effect of
      // an admin re-plan. The new plan applies the next time the customer
      // renews or upgrades through the user-facing flow (which is
      // expected to compare panel state vs plan and emit the proper
      // ProfileSyncJob then).
      await this.prismaService.subscription.update({
        where: { id: subscription.id },
        data: {
          trafficLimit: plan.trafficLimit,
          deviceLimit: plan.deviceLimit,
          internalSquads: plan.internalSquads,
          externalSquad: plan.externalSquad,
          planSnapshot: newPlanSnapshot,
        },
      });

      updated += 1;

      // Push the new limits to Remnawave only if the operator explicitly
      // requested an immediate reshape. Default behaviour is to defer.
      if (
        applyImmediately &&
        (subscription.status === SubscriptionStatus.ACTIVE ||
          subscription.status === SubscriptionStatus.LIMITED)
      ) {
        const action = subscription.remnawaveId ? SyncAction.UPDATE : SyncAction.CREATE;
        await this.prismaService.profileSyncJob.create({
          data: {
            subscriptionId: subscription.id,
            action,
            payload: { bulkPlanAssignment: true, planId: plan.id, applyImmediately: true } satisfies Prisma.InputJsonValue,
          },
        });
        syncJobsCreated += 1;
      }
    }

    return { updated, skippedDeleted, skippedAlreadyAssigned, syncJobsCreated };
  }

  /**
   * Checks if a subscription's planSnapshot indicates it was imported
   * and hasn't been assigned a real plan yet.
   *
   * Matches altshop's `_is_imported_or_unassigned_snapshot` logic.
   */
  private isImportedOrUnassigned(planSnapshot: unknown): boolean {
    if (!planSnapshot || typeof planSnapshot !== 'object') return true;

    const snapshot = planSnapshot as Record<string, unknown>;

    // If it has importedFrom, it's an imported subscription
    if (snapshot.importedFrom) return true;

    // If planId is missing or empty, it's unassigned
    if (!snapshot.planId) return true;

    // If name is "IMPORTED", it's unassigned
    if (typeof snapshot.name === 'string' && snapshot.name.toUpperCase() === 'IMPORTED') {
      return true;
    }

    return false;
  }
}
