import { ConflictException, HttpException, Injectable, Logger } from '@nestjs/common';
import {
  PlanAvailability,
  PlanMigrationItemStatus,
  Prisma,
  SubscriptionStatus,
  SubscriptionTermStatus,
  SyncAction,
  SyncJobStatus,
} from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { resolveRecordedAddOnContribution } from '../../add-on-entitlements/services/configured-baseline.util';
import {
  EffectiveProjectionService,
  type RecomputeProjectionResult,
} from '../../add-on-entitlements/services/effective-projection.service';
import { rotatePlanChangeTermInTransaction } from '../../add-on-entitlements/services/subscription-term-hooks.service';
import { SubscriptionTermService } from '../../add-on-entitlements/services/subscription-term.service';
import { OPERATOR_LIMIT_SOURCE } from '../../anti-fraud/detectors/sharing-detectors';
import { ProfileSyncQueueService } from '../../profile-sync/profile-sync-queue.service';
import { isRetryableTransactionConflict } from '../../referrals/services/referral-qualification.service';
import { subscriptionsOnPlanWhere } from '../utils/subscriptions-on-plan.util';
import {
  PLAN_MIGRATION_BENIGN_SKIP_REASONS,
  PLAN_MIGRATION_REASONS,
  PLAN_MIGRATION_SYNC_SOURCE,
  type PlanMigrationReason,
} from './plan-migration.codes';
import {
  PLAN_MIGRATION_DETAIL_MAX_LENGTH,
  PLAN_MIGRATION_ITEM_TIMEOUT_MS,
  PLAN_MIGRATION_MAX_ATTEMPTS,
} from './plan-migration.constants';
import {
  computePlanMigration,
  diffLimits,
  numericColumnsFromProjection,
  pushesToRemnawave,
  type MigrationTargetPlan,
} from './plan-migration-compute.util';
import {
  MIGRATION_SUBJECT_SELECT,
  MIGRATION_TARGET_SELECT,
  scheduledTermBlocksMove,
  type MigrationSubjectRow,
} from './plan-migration-facts.util';

/** Audit action for the move itself — one row per subscription. */
export const PLAN_MIGRATED_AUDIT_ACTION = 'user.subscription.plan_migrated';

/**
 * The limits row. The SAME action the subscription editor writes
 * (`admin-user-subscriptions.controller.ts`), so "who changed this
 * subscription's limits" stays one query. `source: 'plan_migration'` (declared
 * in that controller's `SubscriptionLimitChangeSource`) means: every listed key
 * now comes from `assignedPlanId`'s plan; unlisted keys did not change; keys the
 * operator owns stay individual and are never listed.
 */
export const LIMITS_CHANGED_AUDIT_ACTION = 'user.subscription.limits_changed';
export const PLAN_MIGRATION_AUDIT_SOURCE = 'plan_migration';

/** `cause` of a move's sync job, next to the upgrade's `PLAN_CHANGE`. */
export const PLAN_MIGRATION_SYNC_CAUSE = 'PLAN_MIGRATION';

/** `snapshotSource` of the term a move rotates a subscription onto. */
const PLAN_MIGRATION_TERM = 'PLAN_MIGRATION_TERM';

/** The run fields one move needs: identity, source, and the creator's audit context. */
export interface PlanMigrationRunContext {
  readonly id: string;
  readonly sourcePlanId: string;
  readonly createdByAdminId: string | null;
  readonly requestId: string | null;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
}

export type PlanMigrationItemOutcome =
  /** The item — and the twins moved with it — reached a final status. */
  | { readonly kind: 'PROCESSED'; readonly moved: number; readonly syncJobIds: readonly string[] }
  /** Not PENDING any more, or (part of) its group is being moved by another tick right now. */
  | { readonly kind: 'NOOP' };

interface LockedItem {
  readonly id: string;
  readonly subscriptionId: string;
  readonly fromPlanId: string;
  readonly toPlanId: string;
  readonly status: PlanMigrationItemStatus;
  readonly actorAdminId: string | null;
  readonly actorRequestId: string | null;
  readonly actorIpAddress: string | null;
  readonly actorUserAgent: string | null;
}

interface LockedPlan {
  readonly id: string;
  readonly deletedAt: Date | null;
  readonly availability: PlanAvailability;
}

interface SettledTwin {
  readonly id: string;
  readonly subscriptionId: string;
  readonly toPlanId: string;
  readonly status: PlanMigrationItemStatus;
  readonly reason: string | null;
}

type Verdict =
  | { readonly kind: 'MOVE' }
  | {
      readonly kind: typeof PlanMigrationItemStatus.SKIPPED | typeof PlanMigrationItemStatus.FAILED;
      readonly reason: PlanMigrationReason;
    };

interface Blocker {
  readonly subscriptionId: string;
  readonly status: PlanMigrationItemStatus;
  readonly reason: string;
}

/**
 * MOVES SUBSCRIPTIONS OFF A PLAN — ONE TRANSACTION PER SUBSCRIPTION, OR PER
 * GROUP OF TWINS ON ONE PANEL PROFILE.
 *
 * ── Lock order (spec §5.1), and why ──────────────────────────────────────────
 *
 *   0. the item rows, `FOR UPDATE SKIP LOCKED`, in id order — a second tick of
 *      the same run passes over items another transaction is moving, and a
 *      finished item is never moved twice (only PENDING is processed);
 *   1. the source and target plans, `FOR SHARE`, in id order — a plan edit or
 *      delete (both `FOR UPDATE`) waits for the move instead of interleaving,
 *      and the target is re-checked: deleted → FAILED `TARGET_DELETED`;
 *   2. the subscriptions, `FOR UPDATE`, in id order, then re-read under the
 *      lock — the same lock renewal fulfilment takes, so a renewal and a move
 *      of one subscription serialize, and the move sees what the renewal
 *      committed: DELETED → SKIPPED `SUBSCRIPTION_DELETED`; no longer on the
 *      source plan (`subscriptionsOnPlanWhere`, the reference guard's
 *      predicate) → SKIPPED `NOT_ON_SOURCE_PLAN`.
 *
 * A deadlock is still possible against writers that lock in another order (the
 * combined renewal locks its subscriptions unsorted; a plan delete strips other
 * plans' transition lists while holding its own row). PostgreSQL aborts one
 * side; this side runs again from the start, bounded by
 * `PLAN_MIGRATION_MAX_ATTEMPTS`, recognised by `isRetryableTransactionConflict`
 * — through Prisma 7's driver adapter a deadlock is P2039/P2010 with the
 * SQLSTATE under `meta.driverAdapterError.cause`, never the documented P2034.
 *
 * ── Twins move together or not at all ───────────────────────────────────────
 *
 * Live subscriptions sharing one `remnawaveId` feed ONE Remnawave profile. If
 * one moved to Q while its twin stayed on P, Q's push would put Q's limits on
 * the shared profile, the panel's `user.modified` webhook would copy them into
 * the twin while its snapshot still named P, and the twin's next P term or
 * renewal would push P back — the profile flipping between plans. So the PENDING
 * items of a run whose subscriptions share a profile are processed in ONE
 * transaction: every twin row is locked, every recheck and skip rule runs for
 * each, and then
 *
 *   - a twin that left the plan or was deleted does not hold the others back
 *     (benign: it no longer shares the source plan with them);
 *   - any other twin that cannot move — a paid scheduled term, a target gone or
 *     turned trial, an earlier failure of a twin still on the plan — BLOCKS the
 *     group: the twins that could move get `SHARED_PROFILE_TWIN_BLOCKED`, with
 *     the blocker's status (FAILED when a retry could clear it) and a `detail`
 *     naming the blocking twin and its reason;
 *   - movable twins headed to different plans (or to a plan other than a twin
 *     already MOVED) are FAILED `SHARED_PROFILE_TARGET_CONFLICT`;
 *   - otherwise every movable twin moves, in that transaction.
 *
 * An unexpected error rolls the whole group back and fails all of it.
 *
 * ── What is written ─────────────────────────────────────────────────────────
 *
 * The limits and snapshot come from `computePlanMigration`, the function the
 * preview showed the operator. A subscription with an ACTIVE durable term gets
 * that term rotated onto the target through the shared plan-change rotation
 * (`rotatePlanChangeTermInTransaction`: align the tail, then
 * `SubscriptionTermService.rotateForPlanChangeInTransaction`, then the ACTIVE
 * `EffectiveProjectionService.recomputeInTransaction`) WITHOUT an expiry reset:
 * the new term ends where the subscription does —
 * and its numeric columns mirror the recomputed projection. Add-ons bound to the
 * ended term stay ACTIVE and keep counting, exactly as after an upgrade: the
 * projection sums a subscription's active add-ons whatever term they hang on.
 *
 * Never touched: `expiresAt`, `status`, `startedAt`, the panel identity.
 *
 * Audit rows name the admin who asked for THIS attempt: the item's `actor_*`
 * columns when a retry stamped them, the run's creator otherwise.
 *
 * The item turns MOVED in the same transaction, with `moved_at` taken from the
 * database clock at that last statement — the late-renewal guard in payment
 * fulfilment compares it with the payment's `created_at`.
 */
@Injectable()
export class PlanMigrationMoveService {
  private readonly logger = new Logger(PlanMigrationMoveService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly subscriptionTermService: SubscriptionTermService,
    private readonly effectiveProjectionService: EffectiveProjectionService,
    private readonly profileSyncQueueService: ProfileSyncQueueService,
  ) {}

  public async processItem(
    run: PlanMigrationRunContext,
    itemId: string,
  ): Promise<PlanMigrationItemOutcome> {
    let group = await this.readPendingGroup(run.id, itemId);
    let outcome: PlanMigrationItemOutcome;
    for (let attempt = 1; ; attempt += 1) {
      try {
        outcome = await this.prismaService.$transaction(
          (tx) => this.moveGroupInTransaction(tx, run, itemId, group),
          { timeout: PLAN_MIGRATION_ITEM_TIMEOUT_MS, maxWait: PLAN_MIGRATION_ITEM_TIMEOUT_MS },
        );
        break;
      } catch (error: unknown) {
        if (isRetryableTransactionConflict(error) && attempt < PLAN_MIGRATION_MAX_ATTEMPTS) {
          this.logger.warn(
            `Plan migration ${run.id}: item ${itemId} lost a lock conflict (attempt ${attempt}); running it again`,
          );
          group = await this.readPendingGroup(run.id, itemId);
          continue;
        }
        return this.recordFailure(run, group, error);
      }
    }

    // After the commit, and tolerated: a job row is committed PENDING, and the
    // profile-sync sweep re-enqueues PENDING rows every five minutes — a Redis
    // hiccup delays the push, it does not lose it.
    if (outcome.kind === 'PROCESSED') {
      for (const syncJobId of outcome.syncJobIds) {
        try {
          await this.profileSyncQueueService.enqueue(syncJobId);
        } catch (error: unknown) {
          this.logger.warn(
            `Plan migration ${run.id}: sync job ${syncJobId} persisted; the sweep will enqueue it: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }
    return outcome;
  }

  /**
   * The item and the PENDING items of the same run whose subscriptions share its
   * Remnawave profile, sorted. Read before the transaction to know what to lock;
   * the transaction re-checks it under the locks.
   */
  private async readPendingGroup(runId: string, itemId: string): Promise<string[]> {
    const rows = await this.prismaService.$queryRaw<Array<{ readonly id: string }>>(Prisma.sql`
      SELECT i."id"
        FROM "plan_migration_items" AS i
        JOIN "subscriptions" AS s ON s."id" = i."subscription_id"
       WHERE i."run_id" = ${runId}
         AND i."status" = 'PENDING'
         AND s."status" <> 'DELETED'
         AND s."remnawave_id" = (
               SELECT s2."remnawave_id"
                 FROM "plan_migration_items" AS i2
                 JOIN "subscriptions" AS s2 ON s2."id" = i2."subscription_id"
                WHERE i2."id" = ${itemId}
             )
    `);
    return [...new Set([itemId, ...rows.map((row) => row.id)])].sort();
  }

  private async moveGroupInTransaction(
    tx: Prisma.TransactionClient,
    run: PlanMigrationRunContext,
    leaderId: string,
    groupIds: readonly string[],
  ): Promise<PlanMigrationItemOutcome> {
    // 0. The items.
    const items = await tx.$queryRaw<LockedItem[]>(Prisma.sql`
      SELECT "id", "subscription_id" AS "subscriptionId", "from_plan_id" AS "fromPlanId",
             "to_plan_id" AS "toPlanId", "status"::text AS "status",
             "actor_admin_id" AS "actorAdminId", "actor_request_id" AS "actorRequestId",
             "actor_ip_address" AS "actorIpAddress", "actor_user_agent" AS "actorUserAgent"
        FROM "plan_migration_items"
       WHERE "run_id" = ${run.id} AND "id" IN (${Prisma.join([...groupIds])})
       ORDER BY "id"
         FOR UPDATE SKIP LOCKED
    `);
    const leader = items.find((item) => item.id === leaderId);
    if (leader === undefined || leader.status !== PlanMigrationItemStatus.PENDING) {
      return { kind: 'NOOP' };
    }
    if (items.length !== groupIds.length) {
      // A twin is being moved by another tick: the group is not ours to decide.
      return { kind: 'NOOP' };
    }
    const pending = items.filter((item) => item.status === PlanMigrationItemStatus.PENDING);
    const sourcePlanId = leader.fromPlanId;

    // 1. The plans, in id order.
    const planIds = [...new Set([sourcePlanId, ...pending.map((item) => item.toPlanId)])].sort();
    const plans = new Map(
      (
        await tx.$queryRaw<LockedPlan[]>(Prisma.sql`
          SELECT "id", "deleted_at" AS "deletedAt", "availability"::text AS "availability"
            FROM "plans"
           WHERE "id" IN (${Prisma.join(planIds)})
           ORDER BY "id"
             FOR SHARE
        `)
      ).map((plan) => [plan.id, plan]),
    );

    // 2. The subscriptions, in id order, re-read under their locks.
    const subscriptionIds = [...new Set(pending.map((item) => item.subscriptionId))].sort();
    await tx.$queryRaw(Prisma.sql`
      SELECT "id" FROM "subscriptions" WHERE "id" IN (${Prisma.join(subscriptionIds)}) ORDER BY "id" FOR UPDATE
    `);
    const rows = new Map(
      (
        await tx.subscription.findMany({
          where: { id: { in: subscriptionIds } },
          select: MIGRATION_SUBJECT_SELECT,
        })
      ).map((row) => [row.id, row]),
    );

    // The group as it is under the locks.
    const leaderRow = rows.get(leader.subscriptionId);
    const profile =
      leaderRow === undefined || leaderRow.status === SubscriptionStatus.DELETED ? null : leaderRow.remnawaveId;
    const members =
      profile === null
        ? [leader]
        : pending.filter((item) => {
            if (item.id === leader.id) return true;
            const row = rows.get(item.subscriptionId);
            return row !== undefined && row.status !== SubscriptionStatus.DELETED && row.remnawaveId === profile;
          });
    let settled: SettledTwin[] = [];
    if (profile !== null) {
      const memberIds = members.map((item) => item.id);
      const [late] = await tx.$queryRaw<Array<{ readonly count: number }>>(Prisma.sql`
        SELECT count(*)::int AS "count"
          FROM "plan_migration_items" AS i
          JOIN "subscriptions" AS s ON s."id" = i."subscription_id"
         WHERE i."run_id" = ${run.id}
           AND i."status" = 'PENDING'
           AND s."status" <> 'DELETED'
           AND s."remnawave_id" = ${profile}
           AND i."id" NOT IN (${Prisma.join(memberIds)})
      `);
      if ((late?.count ?? 0) > 0) {
        // A twin joined the profile after the group was read and is not locked.
        return { kind: 'NOOP' };
      }
      settled = await tx.$queryRaw<SettledTwin[]>(Prisma.sql`
        SELECT i."id", i."subscription_id" AS "subscriptionId", i."to_plan_id" AS "toPlanId",
               i."status"::text AS "status", i."reason"
          FROM "plan_migration_items" AS i
          JOIN "subscriptions" AS s ON s."id" = i."subscription_id"
         WHERE i."run_id" = ${run.id}
           AND i."status" <> 'PENDING'
           AND s."status" <> 'DELETED'
           AND s."remnawave_id" = ${profile}
           AND i."id" NOT IN (${Prisma.join(memberIds)})
      `);
    }

    // 3. Every recheck and skip rule, for each member.
    const memberSubscriptionIds = members.map((item) => item.subscriptionId);
    const onSource = new Set(
      (
        await tx.subscription.findMany({
          where: {
            AND: [
              { id: { in: [...memberSubscriptionIds, ...settled.map((twin) => twin.subscriptionId)] } },
              subscriptionsOnPlanWhere(sourcePlanId),
            ],
          },
          select: { id: true },
        })
      ).map((row) => row.id),
    );
    const terms = await tx.subscriptionTerm.findMany({
      where: {
        subscriptionId: { in: memberSubscriptionIds },
        status: { in: [SubscriptionTermStatus.ACTIVE, SubscriptionTermStatus.SCHEDULED] },
      },
      select: { subscriptionId: true, status: true, planId: true },
    });
    const verdicts = new Map<string, Verdict>();
    for (const item of members) {
      const row = rows.get(item.subscriptionId);
      const target = plans.get(item.toPlanId);
      let verdict: Verdict;
      if (row === undefined || row.status === SubscriptionStatus.DELETED) {
        verdict = { kind: PlanMigrationItemStatus.SKIPPED, reason: PLAN_MIGRATION_REASONS.SUBSCRIPTION_DELETED };
      } else if (!onSource.has(row.id)) {
        verdict = { kind: PlanMigrationItemStatus.SKIPPED, reason: PLAN_MIGRATION_REASONS.NOT_ON_SOURCE_PLAN };
      } else if (target === undefined || target.deletedAt !== null) {
        verdict = { kind: PlanMigrationItemStatus.FAILED, reason: PLAN_MIGRATION_REASONS.TARGET_DELETED };
      } else if (target.availability === PlanAvailability.TRIAL) {
        verdict = { kind: PlanMigrationItemStatus.FAILED, reason: PLAN_MIGRATION_REASONS.TARGET_IS_TRIAL };
      } else if (
        scheduledTermBlocksMove(
          terms.filter((term) => term.subscriptionId === row.id),
          sourcePlanId,
        )
      ) {
        verdict = { kind: PlanMigrationItemStatus.SKIPPED, reason: PLAN_MIGRATION_REASONS.SCHEDULED_TERM };
      } else {
        verdict = { kind: 'MOVE' };
      }
      verdicts.set(item.id, verdict);
    }

    // 4. The group rule.
    const movers = members.filter((item) => verdicts.get(item.id)?.kind === 'MOVE');
    const blockers: Blocker[] = [];
    for (const item of members) {
      const verdict = verdicts.get(item.id);
      if (verdict === undefined || verdict.kind === 'MOVE' || PLAN_MIGRATION_BENIGN_SKIP_REASONS.has(verdict.reason)) {
        continue;
      }
      blockers.push({ subscriptionId: item.subscriptionId, status: verdict.kind, reason: verdict.reason });
    }
    for (const twin of settled) {
      if (twin.status === PlanMigrationItemStatus.MOVED) continue;
      if (twin.reason !== null && PLAN_MIGRATION_BENIGN_SKIP_REASONS.has(twin.reason)) continue;
      if (!onSource.has(twin.subscriptionId)) continue;
      blockers.push({
        subscriptionId: twin.subscriptionId,
        status: twin.status,
        reason: twin.reason ?? PLAN_MIGRATION_REASONS.INTERNAL_ERROR,
      });
    }
    const movedTargets = settled
      .filter((twin) => twin.status === PlanMigrationItemStatus.MOVED)
      .map((twin) => twin.toPlanId);

    let moverOutcome:
      | { readonly kind: 'MOVE' }
      | {
          readonly kind: typeof PlanMigrationItemStatus.SKIPPED | typeof PlanMigrationItemStatus.FAILED;
          readonly reason: PlanMigrationReason;
          readonly detail: string | null;
        } = { kind: 'MOVE' };
    if (movers.length > 0 && blockers.length > 0) {
      moverOutcome = {
        kind: blockers.some((blocker) => blocker.status === PlanMigrationItemStatus.FAILED)
          ? PlanMigrationItemStatus.FAILED
          : PlanMigrationItemStatus.SKIPPED,
        reason: PLAN_MIGRATION_REASONS.SHARED_PROFILE_TWIN_BLOCKED,
        detail: describeTwinBlockers(blockers),
      };
    } else if (new Set([...movers.map((item) => item.toPlanId), ...movedTargets]).size > 1) {
      moverOutcome = {
        kind: PlanMigrationItemStatus.FAILED,
        reason: PLAN_MIGRATION_REASONS.SHARED_PROFILE_TARGET_CONFLICT,
        detail: null,
      };
    }

    for (const item of members) {
      const verdict = verdicts.get(item.id);
      if (verdict !== undefined && verdict.kind !== 'MOVE') {
        await this.decide(tx, item, verdict.kind, verdict.reason, null);
      }
    }
    if (moverOutcome.kind !== 'MOVE') {
      for (const item of movers) {
        await this.decide(tx, item, moverOutcome.kind, moverOutcome.reason, moverOutcome.detail);
      }
      return { kind: 'PROCESSED', moved: 0, syncJobIds: [] };
    }

    // 5. Every mover, in subscription order.
    const targets = new Map(
      (
        await tx.plan.findMany({
          where: { id: { in: [...new Set(movers.map((item) => item.toPlanId))] } },
          select: MIGRATION_TARGET_SELECT,
        })
      ).map((plan) => [plan.id, plan as MigrationTargetPlan]),
    );
    const syncJobIds: string[] = [];
    for (const item of [...movers].sort((left, right) => (left.subscriptionId < right.subscriptionId ? -1 : 1))) {
      const syncJobId = await this.moveOne(tx, run, item, rows.get(item.subscriptionId) as MigrationSubjectRow, {
        target: targets.get(item.toPlanId) as MigrationTargetPlan,
        hasActiveTerm: terms.some(
          (term) => term.subscriptionId === item.subscriptionId && term.status === SubscriptionTermStatus.ACTIVE,
        ),
      });
      if (syncJobId !== null) syncJobIds.push(syncJobId);
    }
    return { kind: 'PROCESSED', moved: movers.length, syncJobIds };
  }

  /** Steps 4–12 of spec §5.1 for one subscription whose locks and rechecks are done. */
  private async moveOne(
    tx: Prisma.TransactionClient,
    run: PlanMigrationRunContext,
    item: LockedItem,
    subscription: MigrationSubjectRow,
    context: { readonly target: MigrationTargetPlan; readonly hasActiveTerm: boolean },
  ): Promise<string | null> {
    const { target } = context;

    // 4–6. Limits, snapshot, trial flag: the preview's computation.
    const recorded = await resolveRecordedAddOnContribution(tx, subscription.id);
    const computed = computePlanMigration({
      subscription,
      target,
      recorded,
      // Warnings are the preview's; nothing below reads them.
      targetRenewable: true,
      pendingRenewalForSource: false,
    });

    // 7. The subscription FIRST — the target's snapshot, the limits the
    // computation chose, the squads — and only then the term. The recompute
    // below builds `desired` on the subscription's own share of its columns
    // (`entitlement-baseline.ts`), so the target reaches `desired`
    // through what is written here, as it does for «Назначить план» and the
    // bulk assignment; a kept individual value stays the absolute number it
    // was, because it is written as that number. Run before this write, the
    // recompute read the SOURCE plan's columns and the move wrote them back.
    //
    // Who moved the device limit, for the reduction trigger.
    if (computed.after.deviceLimit !== subscription.deviceLimit) {
      await tx.$executeRaw`SELECT set_config('rezeis.device_limit_source', ${OPERATOR_LIMIT_SOURCE}, true)`;
    }
    await tx.subscription.update({
      where: { id: subscription.id },
      data: {
        planSnapshot: computed.planSnapshot as Prisma.InputJsonValue,
        trafficLimit: computed.after.trafficLimit,
        deviceLimit: computed.after.deviceLimit,
        internalSquads: [...computed.after.internalSquads],
        externalSquad: computed.after.externalSquad,
        isTrial: computed.after.isTrial,
      },
    });

    // 8. The durable term, decided by the term row and not by a rollout flag:
    // add-on expiry recomputes the projection with no flag in sight. The
    // shared plan-change rotation — the one «Назначить план» and the bulk
    // assignment use: align the tail, rotate onto the target, recompute in
    // ACTIVE mode. Queued terms REFUSE (nobody paid for the move), which the
    // skip rules above already guarantee under these locks.
    let projection: RecomputeProjectionResult | null = null;
    let rotatedTermId: string | null = null;
    if (context.hasActiveTerm) {
      const moved = await rotatePlanChangeTermInTransaction(
        tx,
        { terms: this.subscriptionTermService, projections: this.effectiveProjectionService },
        {
          subscriptionId: subscription.id,
          plan: target,
          snapshotSource: PLAN_MIGRATION_TERM,
          scheduledTerms: 'REFUSE',
        },
        { correlationId: `plan-migration:${run.id}:${subscription.id}` },
      );
      if (moved.outcome !== 'ROTATED') {
        // Unreachable: the ACTIVE term, the absence of a queued one and the
        // row's status were all read under the locks this transaction holds.
        // Refused loudly rather than moving the plan without its term.
        throw new ConflictException(
          `The durable term of subscription ${subscription.id} could not be rotated (${moved.outcome}). Retry.`,
        );
      }
      rotatedTermId = moved.termId;
      projection = moved.projection;
    }
    const numeric =
      projection === null
        ? { trafficLimit: computed.after.trafficLimit, deviceLimit: computed.after.deviceLimit }
        : numericColumnsFromProjection(projection, computed.after);
    const written = {
      trafficLimit: numeric.trafficLimit,
      deviceLimit: numeric.deviceLimit,
      internalSquads: [...computed.after.internalSquads],
      externalSquad: computed.after.externalSquad,
    };

    // 9. The columns mirror `desired` where the projection lands elsewhere —
    // a live add-on or a term's bonus summed on top — as every projection
    // writer leaves them.
    if (written.trafficLimit !== computed.after.trafficLimit || written.deviceLimit !== computed.after.deviceLimit) {
      if (written.deviceLimit !== subscription.deviceLimit) {
        await tx.$executeRaw`SELECT set_config('rezeis.device_limit_source', ${OPERATOR_LIMIT_SOURCE}, true)`;
      }
      await tx.subscription.update({
        where: { id: subscription.id },
        data: { trafficLimit: written.trafficLimit, deviceLimit: written.deviceLimit },
      });
    }

    // 10. The push, only for a linked ACTIVE/LIMITED row. UPDATE, no status, no
    // traffic reset; versioned when a projection backs it, as the upgrade does.
    let syncJobId: string | null = null;
    if (pushesToRemnawave(subscription)) {
      const job = await tx.profileSyncJob.create({
        data: {
          subscriptionId: subscription.id,
          action: SyncAction.UPDATE,
          status: SyncJobStatus.PENDING,
          ...(projection === null
            ? {}
            : {
                aggregateKey: subscription.id,
                desiredRevision: projection.desiredRevision,
                cause: PLAN_MIGRATION_SYNC_CAUSE,
              }),
          payload: {
            source: PLAN_MIGRATION_SYNC_SOURCE,
            planMigrationRunId: run.id,
            planMigrationItemId: item.id,
            fromPlanId: item.fromPlanId,
            toPlanId: item.toPlanId,
            propagateStatus: false,
          } satisfies Prisma.InputJsonObject,
        },
        select: { id: true },
      });
      syncJobId = job.id;
    }

    // 11. The audit rows, one per subscription, inside the move. The limits row
    // lists only keys handed to Q — never a key the operator owns, even one a
    // projection recompute moved.
    await this.writeAudit(tx, run, item, {
      subscriptionId: subscription.id,
      userId: subscription.userId,
      kept: computed.kept,
      trialCleared: computed.before.isTrial && !computed.after.isTrial,
      rotatedTermId,
      syncJobId,
      limitChanges: diffLimits(computed.before, written, new Set(computed.individualKeys)),
    });

    // 12. The item, last, on the database clock.
    await tx.$executeRaw(Prisma.sql`
      UPDATE "plan_migration_items"
         SET "status" = 'MOVED',
             "moved_at" = clock_timestamp(),
             "reason" = NULL,
             "detail" = NULL,
             "sync_job_id" = ${syncJobId},
             "attempts" = "attempts" + 1,
             "updated_at" = clock_timestamp()
       WHERE "id" = ${item.id}
    `);
    return syncJobId;
  }

  private async decide(
    tx: Prisma.TransactionClient,
    item: LockedItem,
    status: typeof PlanMigrationItemStatus.SKIPPED | typeof PlanMigrationItemStatus.FAILED,
    reason: PlanMigrationReason,
    detail: string | null,
  ): Promise<void> {
    await tx.planMigrationItem.update({
      where: { id: item.id },
      data: { status, reason, detail, attempts: { increment: 1 } },
    });
  }

  private async writeAudit(
    tx: Prisma.TransactionClient,
    run: PlanMigrationRunContext,
    item: LockedItem,
    input: {
      readonly subscriptionId: string;
      readonly userId: string;
      readonly kept: readonly string[];
      readonly trialCleared: boolean;
      readonly rotatedTermId: string | null;
      readonly syncJobId: string | null;
      readonly limitChanges: ReturnType<typeof diffLimits>;
    },
  ): Promise<void> {
    // The admin who asked for this attempt: the retrying one when a retry
    // stamped the item, the run's creator otherwise.
    const retried = item.actorAdminId !== null;
    const actorId = retried ? item.actorAdminId : run.createdByAdminId;
    const requestId = retried ? item.actorRequestId : run.requestId;
    // Only an account that still exists: an audit row naming a deleted admin
    // would fail its foreign key and take the move down with it.
    const actor =
      actorId === null ? null : await tx.adminUser.findUnique({ where: { id: actorId }, select: { id: true } });
    const common = {
      adminUserId: actor?.id ?? null,
      ipAddress: retried ? item.actorIpAddress : run.ipAddress,
      userAgent: retried ? item.actorUserAgent : run.userAgent,
    };
    await tx.adminAuditLog.create({
      data: {
        ...common,
        action: PLAN_MIGRATED_AUDIT_ACTION,
        metadata: {
          requestId,
          source: PLAN_MIGRATION_AUDIT_SOURCE,
          planMigrationRunId: run.id,
          planMigrationItemId: item.id,
          userId: input.userId,
          subscriptionId: input.subscriptionId,
          fromPlanId: item.fromPlanId,
          toPlanId: item.toPlanId,
          kept: [...input.kept],
          trialCleared: input.trialCleared,
          rotatedTermId: input.rotatedTermId,
          syncJobId: input.syncJobId,
        },
      },
    });
    if (Object.keys(input.limitChanges).length > 0) {
      await tx.adminAuditLog.create({
        data: {
          ...common,
          action: LIMITS_CHANGED_AUDIT_ACTION,
          metadata: {
            requestId,
            userId: input.userId,
            subscriptionId: input.subscriptionId,
            source: PLAN_MIGRATION_AUDIT_SOURCE,
            assignedPlanId: item.toPlanId,
            planMigrationRunId: run.id,
            changes: input.limitChanges as Prisma.InputJsonObject,
          },
        },
      });
    }
  }

  /** Any other error: the whole group is FAILED `INTERNAL_ERROR` and the run goes on. */
  private async recordFailure(
    run: PlanMigrationRunContext,
    itemIds: readonly string[],
    error: unknown,
  ): Promise<PlanMigrationItemOutcome> {
    this.logger.error(
      `Plan migration ${run.id}: item(s) ${itemIds.join(', ')} failed: ${
        error instanceof Error ? error.stack ?? error.message : String(error)
      }`,
    );
    try {
      await this.prismaService.planMigrationItem.updateMany({
        where: { id: { in: [...itemIds] }, runId: run.id, status: PlanMigrationItemStatus.PENDING },
        data: {
          status: PlanMigrationItemStatus.FAILED,
          reason: PLAN_MIGRATION_REASONS.INTERNAL_ERROR,
          detail: describeMoveError(error),
          attempts: { increment: 1 },
        },
      });
    } catch (recordError: unknown) {
      // The items stay PENDING and the next tick tries them again — never lost.
      this.logger.error(
        `Plan migration ${run.id}: failure of ${itemIds.join(', ')} could not be recorded: ${
          recordError instanceof Error ? recordError.message : String(recordError)
        }`,
      );
    }
    return { kind: 'PROCESSED', moved: 0, syncJobIds: [] };
  }
}

/** `detail` of a twin held back: which twin, and why it cannot move. */
export function describeTwinBlockers(blockers: ReadonlyArray<{ readonly subscriptionId: string; readonly reason: string }>): string {
  const [first] = blockers;
  if (first === undefined) return '';
  const more = blockers.length > 1 ? `; ${blockers.length - 1} more twin(s) cannot move either` : '';
  const text = `Twin ${first.subscriptionId} on the same Remnawave profile: ${first.reason}${more}`;
  return text.length <= PLAN_MIGRATION_DETAIL_MAX_LENGTH ? text : `${text.slice(0, PLAN_MIGRATION_DETAIL_MAX_LENGTH - 1)}…`;
}

/**
 * The operator-facing half of an unexpected failure: short, and never the raw
 * driver text, which can carry SQL and parameter values. The full error goes to
 * the log.
 */
export function describeMoveError(error: unknown): string {
  let text: string;
  if (isRetryableTransactionConflict(error)) {
    text = 'The subscription was being changed by another operation at the same time. Retry.';
  } else if (error instanceof Prisma.PrismaClientKnownRequestError) {
    text =
      error.code === 'P2028'
        ? 'The move timed out waiting for the subscription. Retry.'
        : `Database error ${error.code}.`;
  } else if (error instanceof HttpException) {
    // Our own refusals (the term service's ConflictExceptions): sentences
    // written in this codebase, not driver output.
    const response = error.getResponse();
    text =
      typeof response === 'string'
        ? response
        : typeof (response as { message?: unknown }).message === 'string'
          ? ((response as { message: string }).message)
          : error.message;
  } else {
    text = 'Unexpected error.';
  }
  return text.length <= PLAN_MIGRATION_DETAIL_MAX_LENGTH
    ? text
    : `${text.slice(0, PLAN_MIGRATION_DETAIL_MAX_LENGTH - 1)}…`;
}
