import { Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import {
  DeviceReductionPlanState,
  EffectiveProjectionState,
  Prisma,
  SubscriptionStatus,
  SyncAction,
  SyncJobStatus,
} from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { EVENT_TYPES, SystemEventsService } from '../../../common/services/system-events.service';
import { AddOnEntitlementService } from '../../add-on-entitlements/services/add-on-entitlement.service';
import { SubscriptionTermService } from '../../add-on-entitlements/services/subscription-term.service';
import { ProfileSyncQueueService } from '../../profile-sync/profile-sync-queue.service';

export interface SubscriptionDeleteInput {
  readonly userId?: string;
  readonly telegramId?: string;
  readonly subscriptionId: string;
}

export interface SubscriptionDeleteResult {
  readonly deleted: true;
}

export interface OperatorSubscriptionDeleteResult extends SubscriptionDeleteResult {
  readonly userId: string;
  readonly hadRemnawaveProfile: boolean;
}

type DeletableSubscription = {
  readonly id: string;
  readonly userId: string;
  readonly status: SubscriptionStatus;
  readonly remnawaveId: string | null;
  readonly expiresAt: Date | null;
};

/**
 * The row as read under `FOR UPDATE`, which carries two columns the callers'
 * own snapshots do not.
 *
 * They are read here, in the same locked read that decides whether a DELETE job
 * is created at all, because this is the last moment they can be trusted — see
 * the payload note in {@link SubscriptionDeletionService.deleteSubscription}.
 */
type LockedSubscription = DeletableSubscription & {
  readonly remnawavePanelId: number | null;
  readonly remnawavePanelUsername: string | null;
  /**
   * Read for one reason: together with a null `remnawaveId` it is half the
   * signature of a row whose panel profile is LIVE but whose link was lost —
   * see {@link orphanRiskOf}.
   */
  readonly configUrl: string | null;
};

/**
 * True when retiring this row leaves a panel profile behind that nothing will
 * ever come back for.
 *
 * THE ROW HAS NO ID TO DELETE BY, AND THAT IS NOT THE SAME AS HAVING NO
 * PROFILE. The create/update decoder used to CAST an undecoded panel body into
 * the typed shape; on 3.x that yielded `uuid === undefined` and
 * `id === undefined`, both of which Prisma reads as "leave the column alone",
 * while `remnawavePanelUsername` and `configUrl` came from arguments and DID
 * land. The write succeeded, the sync job reported COMPLETED, and the row was
 * left owning a live profile it cannot name. `PanelLinkReconciliationService`
 * selects on exactly this signature, and it is the only thing that can repair
 * such a row — and it skips `DELETED` rows, so the retirement below closes the
 * repair window for good.
 *
 * Narrow on purpose. A row that was never provisioned has neither column, and
 * every path that detaches a profile (`reprovisionMissingProfile`, the DELETE
 * worker's retirement, the manual re-link) clears all of them in one statement.
 * So this asks a question only the damaged rows answer yes to, which is what
 * keeps the alert worth reading.
 */
function orphanRiskOf(current: LockedSubscription): boolean {
  return (
    current.remnawaveId === null &&
    typeof current.remnawavePanelUsername === 'string' &&
    current.remnawavePanelUsername.length > 0 &&
    typeof current.configUrl === 'string' &&
    current.configUrl.length > 0
  );
}

export interface ExpiredSubscriptionDeleteInput {
  readonly subscriptionId: string;
  readonly expectedExpiresAt: Date;
  readonly expectedRemnawaveId: string | null;
  readonly cutoff: Date;
}

export interface ExpiredSubscriptionDeleteResult {
  readonly deleted: boolean;
  readonly syncJobId: string | null;
}

interface LifecycleDeleteOptions {
  readonly source: 'SELF_SERVICE_DELETE' | 'ADMIN_PANEL' | 'EXPIRED_PROFILE_CLEANUP';
  readonly correlationId: string;
}

interface LifecycleDeleteOutcome {
  readonly committed: boolean;
  readonly syncJobId: string | null;
  readonly userId: string | null;
  /**
   * Set only when the row was retired WITHOUT a revocation job while still
   * carrying the fingerprint of a live panel profile. Carried out of the
   * transaction rather than reported inside it: the event write must not be
   * able to roll the deletion back, and must not fire for a transaction that
   * later aborts.
   */
  readonly orphanedPanelUsername?: string | null;
}

/**
 * SubscriptionDeletionService
 * ───────────────────────────
 * Self-service subscription deletion. The user chose to delete, so deletion is
 * final and no refund is issued (digital goods, no-refund policy).
 *
 * Flow:
 *   1. Resolve the canonical user from `userId` (reiwa_id) or `telegramId`.
 *   2. Ownership-check the target subscription (must belong to that user).
 *   3. Already DELETED → idempotent no-op.
 *   4. In one transaction: close commercial lifecycle, supersede narrower
 *      projection/device/sync work, enqueue a Remnawave revocation job
 *      (`ProfileSyncJob` with `SyncAction.DELETE`) and flip the subscription to
 *      `DELETED`. After commit the job is pushed to BullMQ on a best-effort
 *      basis; a durable PENDING row is recovered by the queue sweep if that
 *      immediate push fails. The revocation job reads
 *      `subscription.remnawaveId` (left intact), so revoking after the status
 *      flip is safe — there is never a `DELETED` row with a live profile that
 *      isn't already queued for removal.
 */
@Injectable()
export class SubscriptionDeletionService {
  private readonly logger = new Logger(SubscriptionDeletionService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly profileSyncQueueService: ProfileSyncQueueService,
    private readonly addOnEntitlementService: AddOnEntitlementService,
    private readonly subscriptionTermService: SubscriptionTermService,
    @Optional()
    private readonly systemEventsService?: SystemEventsService,
  ) {}

  public async delete(input: SubscriptionDeleteInput): Promise<SubscriptionDeleteResult> {
    const userId = await this.resolveUserId(input);
    const subscription = await this.findSubscription(input.subscriptionId);

    // Ownership check: unknown id or foreign owner → 404 (no existence leak).
    if (subscription.userId !== userId) {
      throw new NotFoundException('Subscription not found');
    }
    const outcome = await this.deleteSubscription(subscription, {
      source: 'SELF_SERVICE_DELETE',
      correlationId: `subscription-delete:${subscription.id}`,
    });

    if (outcome.committed) {
      this.logger.log(`Subscription ${subscription.id} deleted by owner ${userId}`);
    }
    return { deleted: true };
  }

  public async deleteByOperator(subscriptionId: string): Promise<OperatorSubscriptionDeleteResult> {
    const subscription = await this.findSubscription(subscriptionId);
    await this.deleteSubscription(subscription, {
      source: 'ADMIN_PANEL',
      correlationId: `subscription-delete:${subscription.id}`,
    });
    return {
      deleted: true,
      userId: subscription.userId,
      hadRemnawaveProfile: subscription.remnawaveId !== null,
    };
  }

  private async findSubscription(subscriptionId: string): Promise<DeletableSubscription> {
    const subscription = await this.prismaService.subscription.findUnique({
      where: { id: subscriptionId },
      select: { id: true, userId: true, status: true, remnawaveId: true, expiresAt: true },
    });
    if (subscription === null) {
      throw new NotFoundException('Subscription not found');
    }
    return subscription;
  }

  public async deleteExpiredIfUnchanged(
    input: ExpiredSubscriptionDeleteInput,
  ): Promise<ExpiredSubscriptionDeleteResult> {
    const subscription: DeletableSubscription = {
      id: input.subscriptionId,
      userId: '',
      status: SubscriptionStatus.EXPIRED,
      remnawaveId: input.expectedRemnawaveId,
      expiresAt: input.expectedExpiresAt,
    };
    const outcome = await this.deleteSubscription(
      subscription,
      {
        source: 'EXPIRED_PROFILE_CLEANUP',
        correlationId: `expired-profile-cleanup:${input.subscriptionId}:${input.expectedExpiresAt.toISOString()}`,
      },
      input,
    );
    return { deleted: outcome.committed, syncJobId: outcome.syncJobId };
  }

  private async deleteSubscription(
    subscription: DeletableSubscription,
    options: LifecycleDeleteOptions,
    expiryGuard?: ExpiredSubscriptionDeleteInput,
  ): Promise<LifecycleDeleteOutcome> {
    // Idempotent: deleting an already-deleted subscription is a no-op.
    if (subscription.status === SubscriptionStatus.DELETED) {
      return {
        committed: false,
        syncJobId: null,
        userId: subscription.userId || null,
      };
    }

    const outcome = await this.prismaService.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<LockedSubscription[]>(Prisma.sql`
        SELECT
          "id",
          "user_id" AS "userId",
          "status"::text AS "status",
          "remnawave_id" AS "remnawaveId",
          "remnawave_panel_id" AS "remnawavePanelId",
          "remnawave_panel_username" AS "remnawavePanelUsername",
          "config_url" AS "configUrl",
          "expires_at" AS "expiresAt"
        FROM "subscriptions"
        WHERE "id" = ${subscription.id}
        FOR UPDATE
      `);
      const current = locked[0];
      if (current === undefined) {
        throw new NotFoundException('Subscription not found');
      }
      if (current.status === SubscriptionStatus.DELETED) {
        return {
          committed: false,
          syncJobId: null,
          userId: current.userId,
        };
      }
      if (
        expiryGuard !== undefined &&
        (current.expiresAt === null ||
          current.expiresAt.getTime() !== expiryGuard.expectedExpiresAt.getTime() ||
          current.expiresAt.getTime() >= expiryGuard.cutoff.getTime() ||
          current.remnawaveId !== expiryGuard.expectedRemnawaveId)
      ) {
        return {
          committed: false,
          syncJobId: null,
          userId: current.userId,
        };
      }
      await this.addOnEntitlementService.terminateForSubscriptionDeletion(tx, {
        subscriptionId: subscription.id,
        correlationId: options.correlationId,
        reason: 'SUBSCRIPTION_DELETED',
      });
      await this.subscriptionTermService.closeForSubscriptionDeletion(tx, subscription.id);

      const supersededAt = new Date();
      await tx.subscriptionEffectiveProjection.updateMany({
        where: { subscriptionId: subscription.id },
        data: { state: EffectiveProjectionState.DELETED },
      });
      await tx.deviceReductionPlan.updateMany({
        where: {
          subscriptionId: subscription.id,
          state: {
            in: [
              DeviceReductionPlanState.PENDING,
              DeviceReductionPlanState.IN_PROGRESS,
              DeviceReductionPlanState.BLOCKED,
            ],
          },
        },
        data: {
          state: DeviceReductionPlanState.SUPERSEDED,
        },
      });
      await tx.profileSyncJob.updateMany({
        where: {
          subscriptionId: subscription.id,
          action: { not: SyncAction.DELETE },
          status: { in: [SyncJobStatus.PENDING, SyncJobStatus.RUNNING, SyncJobStatus.FAILED] },
          supersededAt: null,
        },
        data: { supersededAt },
      });

      let createdJobId: string | null = null;
      // NOT a bare `else`. Most rows that reach here with a null id never had a
      // profile, and warning about those would bury the ones that did — so the
      // question asked is the narrow one {@link orphanRiskOf} defines.
      const orphanedPanelUsername = orphanRiskOf(current) ? current.remnawavePanelUsername : null;
      if (current.remnawaveId !== null) {
        const job = await tx.profileSyncJob.create({
          data: {
            subscriptionId: subscription.id,
            action: SyncAction.DELETE,
            status: SyncJobStatus.PENDING,
            // The WHOLE panel identity travels in the payload, not just the id.
            //
            // This job outlives the row it was built from. By the time the
            // worker runs, the subscription may have been retired and its
            // identity columns cleared, or re-provisioned onto a DIFFERENT
            // panel profile — so a worker that re-read the row would either
            // find nothing to address the doomed profile with, or address the
            // live replacement and delete that instead. The three fields are
            // captured together, under the same `FOR UPDATE`, so they can only
            // ever describe one profile: the one that existed when the operator
            // (or the sweep) asked for it to go.
            payload: {
              source: options.source,
              targetRemnawaveId: current.remnawaveId,
              targetRemnawavePanelId: current.remnawavePanelId ?? null,
              targetRemnawavePanelUsername: current.remnawavePanelUsername ?? null,
            } as Prisma.InputJsonObject,
          },
          select: { id: true },
        });
        createdJobId = job.id;
      }
      await tx.subscription.update({
        where: { id: subscription.id },
        data: { status: SubscriptionStatus.DELETED },
      });
      return {
        committed: true,
        syncJobId: createdJobId,
        userId: current.userId,
        orphanedPanelUsername,
      };
    });

    if (!outcome.committed) {
      return outcome;
    }

    this.publishDeletedEvent(subscription.id, outcome.userId, options.source);
    this.publishOrphanRiskEvent(subscription.id, outcome, options.source);

    if (outcome.syncJobId !== null) {
      try {
        await this.profileSyncQueueService.enqueue(outcome.syncJobId);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        this.logger.error(
          `Profile sync DELETE job ${outcome.syncJobId} was committed but could not be enqueued; ` +
            `the pending-job sweep will retry it: ${message}`,
        );
      }
    }
    return outcome;
  }

  /**
   * Says out loud that a subscription was retired with a live panel profile
   * still behind it.
   *
   * This is the one outcome of the `remnawaveId !== null` branch above that
   * nothing downstream can notice on its own. The row is now `DELETED`, so it
   * is out of the cabinet, out of every sweep, and — because
   * `PanelLinkReconciliationService` skips `DELETED` rows — out of reach of the
   * only repair that could have named the profile again. The profile keeps
   * serving traffic for a customer who is no longer being billed, and the
   * previous behaviour was to say nothing at all: `deleteSubscription` simply
   * did not enter the branch, and returned `syncJobId: null` exactly as it does
   * for the ordinary never-provisioned row.
   *
   * WARNING, not ERROR: nothing is broken in rezeis and the deletion itself is
   * correct and final. What is needed is a human going to the panel with the
   * username below.
   */
  private publishOrphanRiskEvent(
    subscriptionId: string,
    outcome: LifecycleDeleteOutcome,
    source: LifecycleDeleteOptions['source'],
  ): void {
    const panelUsername = outcome.orphanedPanelUsername ?? null;
    if (panelUsername === null) {
      return;
    }
    const message =
      `Subscription ${subscriptionId} was retired without a Remnawave revocation: its panel ` +
      `link was lost, so the profile '${panelUsername}' is still live on the panel and nothing ` +
      'points at it any more. Delete it by hand.';
    this.logger.warn(message);
    if (this.systemEventsService === undefined) {
      return;
    }
    try {
      this.systemEventsService.warn(
        EVENT_TYPES.SYSTEM_REMNAWAVE_SYNC,
        'SYSTEM',
        'Subscription deleted with an orphaned Remnawave profile',
        {
          subscriptionId,
          userId: outcome.userId,
          panelUsername,
          source,
        },
      );
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(
        `Could not publish the orphaned-profile warning for subscription ${subscriptionId}: ${detail}`,
      );
    }
  }

  private publishDeletedEvent(
    subscriptionId: string,
    userId: string | null,
    source: LifecycleDeleteOptions['source'],
  ): void {
    if (userId === null || this.systemEventsService === undefined) {
      return;
    }
    try {
      this.systemEventsService.info(
        EVENT_TYPES.SUBSCRIPTION_DELETED,
        'SUBSCRIPTION',
        'Subscription deleted',
        { subscriptionId, userId, source },
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(
        `Subscription ${subscriptionId} was deleted but its realtime event could not be published: ${message}`,
      );
    }
  }

  private async resolveUserId(input: SubscriptionDeleteInput): Promise<string> {
    if (typeof input.userId === 'string' && input.userId.length > 0) {
      return input.userId;
    }
    if (typeof input.telegramId === 'string' && input.telegramId.length > 0) {
      const user = await this.prismaService.user.findFirst({
        where: { telegramId: BigInt(input.telegramId) },
        select: { id: true },
      });
      if (user === null) {
        throw new NotFoundException('User not found');
      }
      return user.id;
    }
    throw new NotFoundException('A userId or telegramId is required');
  }
}
