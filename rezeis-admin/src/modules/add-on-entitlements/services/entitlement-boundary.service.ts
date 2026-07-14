import { ConflictException, Injectable, Logger } from '@nestjs/common';
import {
  AddOnEntitlementActorType,
  AddOnEntitlementState,
  AddOnLifetime,
  AddOnType,
  Prisma,
  SubscriptionTermStatus,
  SyncAction,
  SyncJobStatus,
} from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { RemnawaveApiService } from '../../remnawave/services/remnawave-api.service';
import { resolveResetCapabilities } from '../add-on-rollout.config';
import { GIB_BYTES } from '../domain/cutover-baseline';
import { ResetStrategy } from '../domain/reset-cycle-policy';
import { AddOnEntitlementService } from './add-on-entitlement.service';
import { ensureLiveResetEpoch, LiveResetEpoch } from './reset-epoch.util';
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

export type VerifiedDeviceExpiryCompletionResult =
  | { readonly status: 'COMPLETED'; readonly completed: number }
  | { readonly status: 'SUPERSEDED'; readonly completed: 0 };

interface DeferredPlanActivation {
  readonly planSnapshot: Prisma.InputJsonValue;
  readonly internalSquads?: readonly string[];
  readonly externalSquad?: string | null;
}

function decodeDeferredPlanActivation(
  snapshot: Prisma.JsonValue | undefined,
): DeferredPlanActivation | null {
  if (snapshot === null || snapshot === undefined || Array.isArray(snapshot) || typeof snapshot !== 'object') {
    return null;
  }
  const value = snapshot as Record<string, unknown>;
  if (typeof value.id !== 'string' || value.id.trim().length === 0) return null;
  const decoded: {
    planSnapshot: Prisma.InputJsonValue;
    internalSquads?: readonly string[];
    externalSquad?: string | null;
  } = { planSnapshot: snapshot as Prisma.InputJsonValue };
  if (Array.isArray(value.internalSquads) && value.internalSquads.every((entry) => typeof entry === 'string')) {
    decoded.internalSquads = value.internalSquads;
  }
  const externalSquad = value.externalSquad;
  if (externalSquad === null) {
    decoded.externalSquad = null;
  } else if (typeof externalSquad === 'string') {
    decoded.externalSquad = externalSquad;
  }
  return decoded;
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
    private readonly remnawaveApiService?: RemnawaveApiService,
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
    const panelAnchor = await this.resolveDueMonthRollingPanelAnchor(subscriptionId, now);
    return this.prismaService.$transaction(async (tx) => {
      const due = await tx.subscriptionTerm.findFirst({
        where: {
          subscriptionId,
          status: SubscriptionTermStatus.SCHEDULED,
          startsAt: { lte: now },
        },
        orderBy: { generation: 'asc' },
        select: {
          id: true,
          startsAt: true,
          trafficResetStrategy: true,
          resetAnchorAt: true,
          planSnapshot: true,
        },
      });
      if (due === null) {
        return { activated: false, termId: null, activatedEntitlements: 0, desiredRevision: null, syncJobIds: [] };
      }

      let resetAnchorAt = due.resetAnchorAt ?? due.startsAt;
      if (
        due.trafficResetStrategy === 'MONTH_ROLLING' &&
        (resolveResetCapabilities().MONTH_ROLLING ?? 'DISABLED') === 'ENABLED'
      ) {
        resetAnchorAt = panelAnchor?.termId === due.id ? panelAnchor.anchorAt : null;
        await tx.subscriptionTerm.update({
          where: { id: due.id },
          data: { resetAnchorAt },
        });
      }

      const activation = await this.subscriptionTermService.activateInTransaction(tx, due.id, now);
      const correlationId = `boundary-activate:${subscriptionId}`;

      // Reset expiry (design D-4): on term activation the cycle policy creates
      // the term's first reset epoch + planned UTC boundary — but ONLY when the
      // strategy's capability is ENABLED (staging parity verified). Gated by
      // `resetExpiry.<strategy>` (OFF by default → no epoch, so UNTIL_NEXT_RESET
      // stays on the legacy path). Idempotent per term.
      const epoch = await this.createResetEpochIfEnabled(tx, {
        termId: due.id,
        strategy: due.trafficResetStrategy as ResetStrategy,
        anchorAt: resetAnchorAt,
        now: due.startsAt,
      });

      const pending = await tx.addOnEntitlement.findMany({
        where: {
          subscriptionId,
          termId: due.id,
          state: AddOnEntitlementState.PENDING_ACTIVATION,
          scheduledActivationAt: { lte: now },
        },
        select: { id: true, lifetime: true },
      });
      if (
        epoch === null &&
        pending.some((entitlement) => entitlement.lifetime === AddOnLifetime.UNTIL_NEXT_RESET)
      ) {
        throw new ConflictException(
          `Paid reset entitlement cannot activate without a reset epoch for term ${due.id}`,
        );
      }
      let activatedEntitlements = 0;
      for (const entitlement of pending) {
        if (entitlement.lifetime === AddOnLifetime.UNTIL_NEXT_RESET && epoch !== null) {
          await tx.addOnEntitlement.updateMany({
            where: {
              id: entitlement.id,
              state: AddOnEntitlementState.PENDING_ACTIVATION,
              lifetime: AddOnLifetime.UNTIL_NEXT_RESET,
            },
            data: {
              expiryEpochId: epoch.id,
              expiresAt: epoch.plannedEndsAt,
            },
          });
        }
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
      const deferredPlan = decodeDeferredPlanActivation(due.planSnapshot);
      if (projection.changed || deferredPlan !== null) {
        const subscription = await tx.subscription.update({
          where: { id: subscriptionId },
          data: {
            ...(deferredPlan === null
              ? {}
              : {
                  planSnapshot: deferredPlan.planSnapshot,
                  ...(deferredPlan.internalSquads === undefined
                    ? {}
                    : { internalSquads: [...deferredPlan.internalSquads] }),
                  ...(deferredPlan.externalSquad === undefined
                    ? {}
                    : { externalSquad: deferredPlan.externalSquad }),
                }),
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
   * Resolves the only reset strategy whose boundary depends on panel profile
   * metadata. The panel call happens before the interactive DB transaction.
   * A missing/unavailable/invalid profile timestamp is represented as a null
   * anchor so activation remains available while reset-scoped commerce stays
   * fail-closed.
   */
  private async resolveDueMonthRollingPanelAnchor(
    subscriptionId: string,
    now: Date,
  ): Promise<{ readonly termId: string; readonly anchorAt: Date | null } | undefined> {
    if ((resolveResetCapabilities().MONTH_ROLLING ?? 'DISABLED') !== 'ENABLED') {
      return undefined;
    }

    const due = await this.prismaService.subscriptionTerm.findFirst({
      where: {
        subscriptionId,
        status: SubscriptionTermStatus.SCHEDULED,
        startsAt: { lte: now },
        trafficResetStrategy: 'MONTH_ROLLING',
      },
      orderBy: { generation: 'asc' },
      select: {
        id: true,
        subscription: { select: { remnawaveId: true } },
      },
    });
    if (due === null) return undefined;
    if (due.subscription.remnawaveId === null || this.remnawaveApiService === undefined) {
      return { termId: due.id, anchorAt: null };
    }

    try {
      const panelUser = await this.remnawaveApiService.getPanelUser(due.subscription.remnawaveId);
      const timestamp = panelUser?.createdAt;
      const parsed = typeof timestamp === 'string' ? Date.parse(timestamp) : Number.NaN;
      return {
        termId: due.id,
        anchorAt: Number.isFinite(parsed) ? new Date(parsed) : null,
      };
    } catch (error) {
      this.logger.warn(
        `Cannot resolve MONTH_ROLLING panel anchor for term ${due.id}: ${(error as Error).message}`,
      );
      return { termId: due.id, anchorAt: null };
    }
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
  ): Promise<LiveResetEpoch | null> {
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
    return epoch;
  }

  public async completeVerifiedDeviceExpiryForSubscription(
    subscriptionId: string,
    projectionRevision: bigint,
    now: Date = new Date(),
  ): Promise<VerifiedDeviceExpiryCompletionResult> {
    return this.prismaService.$transaction((tx) =>
      this.completeVerifiedDeviceExpiryInTransaction(tx, subscriptionId, projectionRevision, now),
    );
  }

  public async completeVerifiedDeviceExpiryInTransaction(
    tx: Prisma.TransactionClient,
    subscriptionId: string,
    projectionRevision: bigint,
    now: Date = new Date(),
  ): Promise<VerifiedDeviceExpiryCompletionResult> {
    // Projection recomputes serialize on this same row. Reading the revision only
    // after acquiring the lock prevents an older panel verification from
    // completing entitlements introduced by a newer expiry boundary.
    const locked = await tx.$queryRaw<Array<{ readonly id: string }>>(Prisma.sql`
      SELECT "id"
      FROM "subscriptions"
      WHERE "id" = ${subscriptionId}
      FOR UPDATE
    `);
    if (locked.length !== 1) {
      return { status: 'SUPERSEDED', completed: 0 };
    }
    const projection = await tx.subscriptionEffectiveProjection.findUnique({
      where: { subscriptionId },
      select: { desiredRevision: true },
    });
    if (projection === null || projection.desiredRevision !== projectionRevision) {
      return { status: 'SUPERSEDED', completed: 0 };
    }

    const due = await tx.addOnEntitlement.findMany({
      where: {
        subscriptionId,
        type: AddOnType.EXTRA_DEVICES,
        state: AddOnEntitlementState.EXPIRING,
        expiresAt: { not: null, lte: now },
      },
      select: { id: true },
    });
    let completed = 0;
    for (const entitlement of due) {
      const transition = await this.addOnEntitlementService.transitionInTransaction(tx, {
        entitlementId: entitlement.id,
        command: 'COMPLETE_EXPIRY',
        commandKey: `device-expiry-complete:${entitlement.id}`,
        correlationId: `device-expiry:${subscriptionId}`,
        actorType: AddOnEntitlementActorType.SYSTEM,
        reason: 'DEVICE_REDUCTION_VERIFIED',
      });
      if (transition.changed) completed += 1;
    }
    return { status: 'COMPLETED', completed };
  }

  public async expireDueForSubscription(
    subscriptionId: string,
    now: Date = new Date(),
  ): Promise<BoundaryExpiryResult> {
    return this.prismaService.$transaction(async (tx) => {
      const due = await tx.addOnEntitlement.findMany({
        where: {
          subscriptionId,
          state: { in: [AddOnEntitlementState.ACTIVE, AddOnEntitlementState.EXPIRING] },
          expiresAt: { not: null, lte: now },
        },
        select: { id: true, type: true, state: true },
      });
      if (due.length === 0) {
        return { began: 0, expired: 0, changed: false, desiredRevision: null, syncJobIds: [], deviceExpiryTriggered: false };
      }

      const correlationId = `boundary:${subscriptionId}`;
      let began = 0;
      let expired = 0;
      let deviceExpiryTriggered = false;
      for (const entitlement of due) {
        if (entitlement.state === AddOnEntitlementState.ACTIVE) {
          const begin = await this.addOnEntitlementService.transitionInTransaction(tx, {
            entitlementId: entitlement.id,
            command: 'BEGIN_EXPIRY',
            commandKey: `boundary-begin:${entitlement.id}`,
            correlationId,
            actorType: AddOnEntitlementActorType.SYSTEM,
            reason: 'BOUNDARY_EXPIRY',
          });
          if (begin.changed) began += 1;
        }

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
        } else if (entitlement.type === AddOnType.EXTRA_DEVICES) {
          // Re-entry for an already EXPIRING row is intentional: transient
          // planning/execution failures remain durably retryable.
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
