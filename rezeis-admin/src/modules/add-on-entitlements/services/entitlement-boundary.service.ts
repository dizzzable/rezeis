import { Injectable, Logger } from '@nestjs/common';
import {
  AddOnEntitlementActorType,
  AddOnEntitlementState,
  AddOnType,
  Prisma,
  SubscriptionTermStatus,
  SyncAction,
  SyncJobStatus,
} from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { resolveResetCapabilities } from '../add-on-rollout.config';
import { GIB_BYTES } from '../domain/cutover-baseline';
import { ResetStrategy } from '../domain/reset-cycle-policy';
import { AddOnEntitlementService } from './add-on-entitlement.service';
import { ensureLiveResetEpoch } from './reset-epoch.util';
import { EffectiveProjectionService } from './effective-projection.service';
import { SubscriptionTermService } from './subscription-term.service';

export interface BoundaryActivationResult {
  readonly activated: boolean;
  readonly termId: string | null;
  readonly activatedEntitlements: number;
  readonly desiredRevision: bigint | null;
  readonly syncJobIds: readonly string[];
}

export interface BoundaryExpiryResult {
  readonly began: number;
  readonly expired: number;
  readonly changed: boolean;
  readonly desiredRevision: bigint | null;
  readonly syncJobIds: readonly string[];
  /** True when a due EXTRA_DEVICES entitlement began expiry — the caller should
   *  build a device-reduction plan (the desired device limit just dropped). */
  readonly deviceExpiryTriggered: boolean;
}

/**
 * EntitlementBoundaryService (T-008)
 * ──────────────────────────────────
 * Expires ACTIVE add-on entitlements at their authoritative LOCAL boundary
 * (`expiresAt <= now`) — a term end (UNTIL_SUBSCRIPTION_END) or, once reset
 * expiry is enabled, a reset epoch (UNTIL_NEXT_RESET; those only carry an
 * `expiresAt` when their strategy capability is on, so this service processes
 * them automatically without its own flag). A manual panel reset can NEVER
 * expire a commercial entitlement — expiry is driven purely by the local
 * `expiresAt`, not by a Remnawave observation.
 *
 * Per due entitlement (idempotent via per-entitlement command keys):
 *  - `BEGIN_EXPIRY` (ACTIVE → EXPIRING): the desired projection drops
 *    immediately because the projection sums only ACTIVE entitlements;
 *  - EXTRA_TRAFFIC has no reconciliation saga, so it is completed in the same
 *    pass (`COMPLETE_EXPIRY` → EXPIRED);
 *  - EXTRA_DEVICES stays EXPIRING — the device-reduction saga (T-011) reduces
 *    the panel HWIDs and completes the expiry.
 *
 * All transitions + the single projection recompute commit in ONE transaction
 * (atomic boundary). Concurrent scheduler/webhook runs converge: the command
 * keys make transitions idempotent and the recompute is value-idempotent.
 */
@Injectable()
export class EntitlementBoundaryService {
  private readonly logger = new Logger(EntitlementBoundaryService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly addOnEntitlementService: AddOnEntitlementService,
    private readonly subscriptionTermService: SubscriptionTermService,
    private readonly effectiveProjectionService: EffectiveProjectionService,
  ) {}

  /**
   * Activates a due SCHEDULED term at its start boundary (early-renewal flow,
   * design D-4). Finds the earliest SCHEDULED term whose `startsAt <= now`,
   * activates it (which atomically closes the prior ACTIVE term via
   * {@link SubscriptionTermService.activateInTransaction}), then ACTIVATEs its
   * PENDING_ACTIVATION entitlements whose `scheduledActivationAt <= now`, and
   * recomputes the projection + enqueues a versioned sync — all in ONE
   * transaction. Idempotent: re-running finds no due scheduled term (or the
   * entitlement ACTIVATE command keys short-circuit).
   */
  public async activateDueScheduledTerm(
    subscriptionId: string,
    now: Date = new Date(),
  ): Promise<BoundaryActivationResult> {
    return this.prismaService.$transaction(async (tx) => {
      const due = await tx.subscriptionTerm.findFirst({
        where: {
          subscriptionId,
          status: SubscriptionTermStatus.SCHEDULED,
          startsAt: { lte: now },
        },
        orderBy: { generation: 'asc' },
        select: { id: true, startsAt: true, trafficResetStrategy: true, resetAnchorAt: true },
      });
      if (due === null) {
        return { activated: false, termId: null, activatedEntitlements: 0, desiredRevision: null, syncJobIds: [] };
      }

      const activation = await this.subscriptionTermService.activateInTransaction(tx, due.id, now);
      const correlationId = `boundary-activate:${subscriptionId}`;

      // Reset expiry (design D-4): on term activation the cycle policy creates
      // the term's first reset epoch + planned UTC boundary — but ONLY when the
      // strategy's capability is ENABLED (staging parity verified). Gated by
      // `resetExpiry.<strategy>` (OFF by default → no epoch, so UNTIL_NEXT_RESET
      // stays on the legacy path). Idempotent per term.
      await this.createResetEpochIfEnabled(tx, {
        termId: due.id,
        strategy: due.trafficResetStrategy as ResetStrategy,
        anchorAt: due.resetAnchorAt ?? due.startsAt,
        now,
      });

      const pending = await tx.addOnEntitlement.findMany({
        where: {
          subscriptionId,
          termId: due.id,
          state: AddOnEntitlementState.PENDING_ACTIVATION,
          scheduledActivationAt: { lte: now },
        },
        select: { id: true },
      });
      let activatedEntitlements = 0;
      for (const entitlement of pending) {
        const result = await this.addOnEntitlementService.transitionInTransaction(tx, {
          entitlementId: entitlement.id,
          command: 'ACTIVATE',
          commandKey: `boundary-activate:${entitlement.id}`,
          correlationId,
          actorType: AddOnEntitlementActorType.SYSTEM,
          reason: 'TERM_START_ACTIVATION',
        });
        if (result.changed) activatedEntitlements += 1;
      }

      const projection = await this.effectiveProjectionService.recomputeInTransaction(tx, {
        subscriptionId,
        mode: 'ACTIVE',
      });
      const syncJobIds: string[] = [];
      if (projection.changed) {
        const subscription = await tx.subscription.update({
          where: { id: subscriptionId },
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
            subscriptionId,
            action: subscription.remnawaveId === null ? SyncAction.CREATE : SyncAction.UPDATE,
            status: SyncJobStatus.PENDING,
            aggregateKey: subscriptionId,
            desiredRevision: projection.desiredRevision,
            cause: 'TERM_ACTIVATION',
            payload: { source: 'TERM_ACTIVATION', termId: due.id } as Prisma.InputJsonObject,
          },
          select: { id: true },
        });
        syncJobIds.push(syncJob.id);
      }

      this.logger.log(
        `Activated scheduled term ${due.id} for ${subscriptionId}: term-changed ${activation.changed}, entitlements ${activatedEntitlements}`,
      );
      return {
        activated: activation.changed || activatedEntitlements > 0,
        termId: due.id,
        activatedEntitlements,
        desiredRevision: projection.desiredRevision,
        syncJobIds,
      };
    });
  }

  /**
   * Ensures the term's CURRENT reset-cycle epoch exists when the strategy's
   * capability is ENABLED (`resetExpiry.<strategy>` flag). Delegates to the
   * shared {@link ensureLiveResetEpoch} (find-or-create the window containing
   * `now`), so this is idempotent and also covers a term that was already
   * ACTIVE when the flag was enabled. No-op for NO_RESET / disabled capability.
   */
  private async createResetEpochIfEnabled(
    tx: Prisma.TransactionClient,
    input: { readonly termId: string; readonly strategy: ResetStrategy; readonly anchorAt: Date | null; readonly now: Date },
  ): Promise<void> {
    const capability = resolveResetCapabilities()[input.strategy] ?? 'DISABLED';
    const epoch = await ensureLiveResetEpoch(tx, {
      termId: input.termId,
      strategy: input.strategy,
      anchorAt: input.anchorAt,
      capability,
      now: input.now,
    });
    if (epoch !== null) {
      this.logger.log(
        `Reset epoch ensured for term ${input.termId} (${input.strategy}, ends ${epoch.plannedEndsAt.toISOString()})`,
      );
    }
  }

  public async expireDueForSubscription(
    subscriptionId: string,
    now: Date = new Date(),
  ): Promise<BoundaryExpiryResult> {
    return this.prismaService.$transaction(async (tx) => {
      const due = await tx.addOnEntitlement.findMany({
        where: {
          subscriptionId,
          state: AddOnEntitlementState.ACTIVE,
          expiresAt: { not: null, lte: now },
        },
        select: { id: true, type: true },
      });
      if (due.length === 0) {
        return { began: 0, expired: 0, changed: false, desiredRevision: null, syncJobIds: [], deviceExpiryTriggered: false };
      }

      const correlationId = `boundary:${subscriptionId}`;
      let began = 0;
      let expired = 0;
      let deviceExpiryTriggered = false;
      for (const entitlement of due) {
        const begin = await this.addOnEntitlementService.transitionInTransaction(tx, {
          entitlementId: entitlement.id,
          command: 'BEGIN_EXPIRY',
          commandKey: `boundary-begin:${entitlement.id}`,
          correlationId,
          actorType: AddOnEntitlementActorType.SYSTEM,
          reason: 'BOUNDARY_EXPIRY',
        });
        if (begin.changed) began += 1;

        // Traffic entitlements have no HWID reconciliation — complete now.
        if (entitlement.type === AddOnType.EXTRA_TRAFFIC) {
          const complete = await this.addOnEntitlementService.transitionInTransaction(tx, {
            entitlementId: entitlement.id,
            command: 'COMPLETE_EXPIRY',
            commandKey: `boundary-complete:${entitlement.id}`,
            correlationId,
            actorType: AddOnEntitlementActorType.SYSTEM,
            reason: 'TRAFFIC_BOUNDARY_EXPIRY',
          });
          if (complete.changed) expired += 1;
        } else if (entitlement.type === AddOnType.EXTRA_DEVICES && begin.changed) {
          // Device slots dropped — a device-reduction plan must be built.
          deviceExpiryTriggered = true;
        }
      }

      // Recompute the desired projection only when a baseline term is active;
      // a lapsed subscription (no active term) has nothing to project against —
      // the entitlements are still expired above and any future renewal rebuilds
      // the projection.
      const activeTerm = await tx.subscriptionTerm.findFirst({
        where: { subscriptionId, status: SubscriptionTermStatus.ACTIVE },
        select: { id: true },
      });
      let desiredRevision: bigint | null = null;
      const syncJobIds: string[] = [];
      if (activeTerm !== null) {
        const projection = await this.effectiveProjectionService.recomputeInTransaction(tx, {
          subscriptionId,
          mode: 'ACTIVE',
        });
        desiredRevision = projection.desiredRevision;

        // Propagate the dropped desired limits: mirror into the legacy
        // compatibility columns and enqueue a versioned profile-sync push so
        // the panel converges to the reduced limit (T-009 supersession keeps
        // only the latest revision).
        if (projection.changed) {
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
              cause: 'BOUNDARY_EXPIRY',
              payload: { source: 'BOUNDARY_EXPIRY' } as Prisma.InputJsonObject,
            },
            select: { id: true },
          });
          syncJobIds.push(syncJob.id);
        }
      }

      this.logger.log(
        `Boundary expiry for ${subscriptionId}: began ${began}, completed ${expired}`,
      );
      return { began, expired, changed: true, desiredRevision, syncJobIds, deviceExpiryTriggered };
    });
  }
}
