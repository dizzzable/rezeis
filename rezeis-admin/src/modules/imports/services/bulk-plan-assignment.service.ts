import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AddOnEntitlementActorType, Prisma, SubscriptionStatus, SyncAction } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { resolvePlanChangeLimitCarryInTransaction } from '../../add-on-entitlements/services/configured-baseline.util';
import type { RecomputeProjectionResult } from '../../add-on-entitlements/services/effective-projection.service';
import { SubscriptionTermHooksService } from '../../add-on-entitlements/services/subscription-term-hooks.service';
import type { PlanChangeTarget } from '../../add-on-entitlements/services/subscription-term.service';
import { numericColumnsFromProjection } from '../../plans/migrations/plan-migration-compute.util';
import { ProfileSyncQueueService } from '../../profile-sync/profile-sync-queue.service';

/** `snapshotSource` of the term a bulk assignment rotates a subscription onto. */
export const BULK_PLAN_ASSIGNMENT_TERM = 'BULK_PLAN_ASSIGNMENT_TERM';

/**
 * What «Назначить план импортированным» makes of one subscription of a targeted
 * user. It RE-PLANS ONLY A SUBSCRIPTION THAT IS REALLY IMPORTED AND WAS NEVER
 * ASSIGNED — and never one bought or renewed in this panel:
 *
 *  - `ALREADY_ASSIGNED`: the snapshot names a plan under EITHER key — `id`,
 *    which every panel writer puts there (a payment, «Назначить план», a plan
 *    migration, this assignment, the plan cloner), or `planId`, the import
 *    domain's link marker, which the importers that rebuild a snapshot from
 *    donor facts (altshop, remnashop, bedolaga) carry across a re-import while
 *    dropping `id`. Asked FIRST: a row this assignment linked before no longer
 *    carries the import marker, and is "already assigned", not "not imported".
 *  - `NOT_IMPORTED`: no import marker — `importedFrom`, which every importer
 *    writes, or the legacy «IMPORTED» placeholder name. A subscription given by
 *    «Выдать подписку», a trial or a promo code is not an import.
 *  - `PURCHASED_HERE`: imported and unassigned by its snapshot, yet a payment
 *    of its own was fulfilled in this panel — a payment row, or an applied line
 *    of a combined renewal. THE SNAPSHOT ALONE CANNOT TELL: the Remnawave import
 *    MERGES `importedFrom` into rows it matches by panel identity, bought ones
 *    included; a rebuilding import replaces the snapshot wholesale; and a
 *    renewal of a never-assigned import keeps its import snapshot. The payment
 *    row is immutable history, the one signal nothing rewrites.
 *  - `ASSIGN`: none of those.
 */
export type BulkAssignmentVerdict = 'ASSIGN' | 'ALREADY_ASSIGNED' | 'NOT_IMPORTED' | 'PURCHASED_HERE';

/** The snapshot's half of {@link BulkAssignmentVerdict}; a `CANDIDATE` still needs the payment check. */
export function readBulkAssignmentSnapshot(planSnapshot: unknown): 'ALREADY_ASSIGNED' | 'NOT_IMPORTED' | 'CANDIDATE' {
  const snapshot =
    planSnapshot !== null && typeof planSnapshot === 'object' && !Array.isArray(planSnapshot)
      ? (planSnapshot as Record<string, unknown>)
      : {};
  const named = (key: string): boolean => {
    const value = snapshot[key];
    return typeof value === 'string' && value.length > 0;
  };
  if (named('id') || named('planId')) return 'ALREADY_ASSIGNED';
  const name = snapshot['name'];
  const marked = named('importedFrom') || (typeof name === 'string' && name.toUpperCase() === 'IMPORTED');
  return marked ? 'CANDIDATE' : 'NOT_IMPORTED';
}

/** {@link BulkAssignmentVerdict} for one subscription, read through `client`. */
async function bulkAssignmentVerdict(
  client: Pick<Prisma.TransactionClient, 'transaction' | 'transactionItem'>,
  subscriptionId: string,
  planSnapshot: unknown,
): Promise<BulkAssignmentVerdict> {
  const bySnapshot = readBulkAssignmentSnapshot(planSnapshot);
  if (bySnapshot !== 'CANDIDATE') return bySnapshot;
  const payment = await client.transaction.findFirst({
    where: { subscriptionId, fulfilledAt: { not: null } },
    select: { id: true },
  });
  if (payment !== null) return 'PURCHASED_HERE';
  const line = await client.transactionItem.findFirst({
    where: { subscriptionId, appliedAt: { not: null } },
    select: { id: true },
  });
  return line === null ? 'ASSIGN' : 'PURCHASED_HERE';
}

/** What the per-subscription transaction answers when the verdict under its row lock is no longer `ASSIGN`. */
class BulkAssignmentSkip {
  public constructor(public readonly verdict: Exclude<BulkAssignmentVerdict, 'ASSIGN'>) {}
}

/** The plan as {@link BulkPlanAssignmentService.assignPlan} loads it: the row and its active durations. */
type AssignedPlan = PlanChangeTarget & { readonly durations: ReadonlyArray<{ readonly days: number }> };

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
  /** Subscriptions whose snapshot already names a plan ({@link BulkAssignmentVerdict}). */
  readonly skippedAlreadyAssigned: number;
  /** Subscriptions that are not imports at all. */
  readonly skippedNotImported: number;
  /** Imports bought, renewed or topped up in this panel since. */
  readonly skippedPurchasedHere: number;
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
 *   - Re-plans only a subscription that is really imported and was never
 *     assigned, and never one bought or renewed in this panel
 *     ({@link BulkAssignmentVerdict}) — asked again under the row lock, so a
 *     payment that lands meanwhile wins. It used to take any snapshot without
 *     `planId` for unassigned, and so re-planned the same user's PAID
 *     subscriptions, whose snapshot carries `id`.
 *   - Skips DELETED subscriptions.
 *   - Counts every skip by its reason, so the result says what was changed.
 *   - Updates the subscription's planSnapshot with the selected plan's data.
 *   - Creates a ProfileSyncJob(UPDATE) to push the new limits/squads to Remnawave.
 */
@Injectable()
export class BulkPlanAssignmentService {
  private readonly logger = new Logger(BulkPlanAssignmentService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly profileSyncQueueService: ProfileSyncQueueService,
    private readonly subscriptionTermHooks: SubscriptionTermHooksService,
  ) {}

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
    let skippedNotImported = 0;
    let skippedPurchasedHere = 0;
    let skippedNoSubscription = 0;
    let errors = 0;
    let syncJobsCreated = 0;

    for (const userId of userIds) {
      try {
        const result = await this.assignPlanForUser(
          userId,
          plan,
          input.applyImmediately === true,
          input.createdBy,
        );
        updated += result.updated;
        skippedDeleted += result.skippedDeleted;
        skippedAlreadyAssigned += result.skippedAlreadyAssigned;
        skippedNotImported += result.skippedNotImported;
        skippedPurchasedHere += result.skippedPurchasedHere;
        if (result.subscriptions === 0) {
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
      `skippedAlreadyAssigned=${skippedAlreadyAssigned}, skippedNotImported=${skippedNotImported}, ` +
      `skippedPurchasedHere=${skippedPurchasedHere}, skippedNoSubscription=${skippedNoSubscription}, ` +
      `errors=${errors}, syncJobsCreated=${syncJobsCreated}`,
    );

    return {
      updated,
      skippedDeleted,
      skippedAlreadyAssigned,
      skippedNotImported,
      skippedPurchasedHere,
      skippedNoSubscription,
      errors,
      syncJobsCreated,
    };
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private async resolveUserIds(input: BulkPlanAssignmentInput): Promise<string[]> {
    if (input.userIds && input.userIds.length > 0) {
      return [...input.userIds];
    }

    if (input.importRecordId) {
      const importRecord = await this.prismaService.importRecord.findUnique({
        where: { id: input.importRecordId },
      });
      if (!importRecord) {
        throw new NotFoundException(`Import record '${input.importRecordId}' not found`);
      }

      // Durable link (preferred): importers stamp `planSnapshot.importRecordId`
      // onto every subscription they create/update, so we can target EXACTLY
      // the subscriptions produced by this import — regardless of how long the
      // import ran or how many other imports of the same source type happened
      // around it.
      const byRecord = await this.prismaService.subscription.findMany({
        where: { planSnapshot: { path: ['importRecordId'], equals: importRecord.id } },
        select: { userId: true },
        distinct: ['userId'],
      });
      if (byRecord.length > 0) {
        return byRecord.map((s) => s.userId);
      }

      // Legacy fallback: subscriptions imported BEFORE the durable stamp
      // existed carry no `importRecordId`. Fall back to the old heuristic
      // (source type + a creation-time window around the import) so re-plan
      // still works for those historical imports. The window is intentionally
      // wide on the tail because a large import can run well past 5 minutes.
      const importTime = importRecord.createdAt;
      const windowStart = new Date(importTime.getTime() - 60_000); // 1 min before
      const windowEnd = new Date(importTime.getTime() + 6 * 60 * 60_000); // 6 h after

      const subscriptions = await this.prismaService.subscription.findMany({
        where: {
          createdAt: { gte: windowStart, lte: windowEnd },
          planSnapshot: { path: ['importedFrom'], equals: importRecord.sourceType },
        },
        select: { userId: true },
        distinct: ['userId'],
      });

      this.logger.warn(
        `Bulk plan assignment: import ${importRecord.id} has no durable importRecordId stamp on its ` +
          `subscriptions (legacy import); falling back to the source-type + time-window heuristic ` +
          `(matched ${subscriptions.length} users). New imports use the exact stamp.`,
      );

      return subscriptions.map((s) => s.userId);
    }

    return [];
  }

  private async assignPlanForUser(
    userId: string,
    plan: AssignedPlan,
    applyImmediately: boolean,
    createdBy: string,
  ): Promise<{
    subscriptions: number;
    updated: number;
    skippedDeleted: number;
    skippedAlreadyAssigned: number;
    skippedNotImported: number;
    skippedPurchasedHere: number;
    syncJobsCreated: number;
  }> {
    const subscriptions = await this.prismaService.subscription.findMany({
      where: { userId },
      select: { id: true, status: true, planSnapshot: true, remnawaveId: true },
    });

    let updated = 0;
    let skippedDeleted = 0;
    let skippedAlreadyAssigned = 0;
    let skippedNotImported = 0;
    let skippedPurchasedHere = 0;
    let syncJobsCreated = 0;
    const skip = (verdict: Exclude<BulkAssignmentVerdict, 'ASSIGN'>): void => {
      if (verdict === 'ALREADY_ASSIGNED') skippedAlreadyAssigned += 1;
      else if (verdict === 'NOT_IMPORTED') skippedNotImported += 1;
      else skippedPurchasedHere += 1;
    };

    for (const subscription of subscriptions) {
      if (subscription.status === SubscriptionStatus.DELETED) {
        skippedDeleted += 1;
        continue;
      }

      const verdict = await bulkAssignmentVerdict(this.prismaService, subscription.id, subscription.planSnapshot);
      if (verdict !== 'ASSIGN') {
        skip(verdict);
        continue;
      }

      // Resolve duration: use first available from plan
      const durationDays = plan.durations.length > 0 ? plan.durations[0].days : 30;

      // Build new plan snapshot
      const newPlanSnapshot: Prisma.InputJsonValue = {
        // `id` is the CANONICAL key for "which plan is this subscription on",
        // and it is the one every reader outside this module uses:
        // `PlanSnapshotSyncService` selects on `plan_snapshot->>'id'`,
        // `AddOnEligibilityService` and `EntitlementCutoverService` read
        // `snapshot['id']`, the broadcast audience filter matches
        // `path: ['id']`, and the payment paths compare it against the paid
        // plan. This writer used to emit ONLY `planId`, so a bulk-assigned
        // subscription matched none of them: a renamed plan kept showing its
        // old name on the cabinet card, in the bot and on invoices forever, and
        // no add-on restricted to that plan was ever offered.
        id: plan.id,
        // `planId` stays, and is NOT a duplicate to be tidied away. It is the
        // IMPORT domain's "this imported row has been linked to a real plan"
        // marker, and three readers depend on it:
        //   - `readBulkAssignmentSnapshot` above, which (with `id`) is what stops
        //     a second run of this assignment from re-planning a subscription an
        //     operator already assigned — also after a re-import dropped `id`;
        //   - `BackupPlanClonerService`, which skips a row that already carries
        //     one;
        //   - `AltshopImporterService` / `RemnashopImporterService`, whose
        //     `buildSubscriptionPlanSnapshot` rebuilds the snapshot from donor
        //     facts and carries `planId` — and ONLY `planId` — across, so a
        //     re-import of an assigned subscription keeps its plan link.
        // Dropping it here would make a re-import silently unlink the plan.
        planId: plan.id,
        name: plan.name,
        tag: plan.tag,
        type: plan.type,
        // This is a FULL snapshot replacement, so the icon has to be written
        // here too — attaching a real plan to imported subscriptions is exactly
        // the case where the card should stop showing the status-glyph fallback.
        icon: plan.icon,
        trafficLimit: plan.trafficLimit,
        deviceLimit: plan.deviceLimit,
        trafficLimitStrategy: plan.trafficLimitStrategy,
        duration: durationDays,
        internalSquads: [...plan.internalSquads],
        externalSquad: plan.externalSquad,
      };

      // Push the new limits to Remnawave only if the operator explicitly
      // requested an immediate reshape. Default behaviour is to defer.
      const pushNow =
        applyImmediately &&
        (subscription.status === SubscriptionStatus.ACTIVE ||
          subscription.status === SubscriptionStatus.LIMITED);

      // Update subscription with new plan data — one transaction per
      // subscription, so the limits, the term and the job land together.
      //
      // Note: we only persist the plan link (planSnapshot + cached limits)
      // here. The actual Remnawave-side reshape (traffic / device cap /
      // squad membership) is gated by `applyImmediately` — we do
      // not silently shrink a customer's panel limits as a side-effect of
      // an admin re-plan. The new plan applies the next time the customer
      // renews or upgrades through the user-facing flow (which is
      // expected to compare panel state vs plan and emit the proper
      // ProfileSyncJob then).
      const syncJobId = await this.prismaService.$transaction(async (tx) => {
        // ASKED AGAIN UNDER THE ROW LOCK — the lock every payment takes first,
        // so a payment or an assignment that committed since the read above
        // wins, and nothing below is written for it.
        await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "subscriptions" WHERE "id" = ${subscription.id} FOR UPDATE`);
        const current = await tx.subscription.findUnique({
          where: { id: subscription.id },
          select: { planSnapshot: true },
        });
        const locked = await bulkAssignmentVerdict(tx, subscription.id, current?.planSnapshot ?? null);
        if (locked !== 'ASSIGN') return new BulkAssignmentSkip(locked);

        // THE LIMITS ARE CARRIED, exactly as «Назначить план» carries them
        // (`resolvePlanChangeLimitCarry`, owner's decision of 24.09.2026): the
        // plan's own, plus what sat above the OLD plan. A never-assigned
        // import has no old plan to measure against — its snapshot records
        // the donor's facts, not a `trafficLimit`/`deviceLimit` — so it gets
        // the plan's raw limits, which is what normalising an import means. (A
        // subscription assigned before is not reached here at all: its
        // snapshot names a plan — `BulkAssignmentVerdict`.) Read under the row
        // lock.
        const carry = await resolvePlanChangeLimitCarryInTransaction(tx, subscription.id, {
          trafficLimit: plan.trafficLimit,
          deviceLimit: plan.deviceLimit,
        });
        await tx.subscription.update({
          where: { id: subscription.id },
          data: {
            trafficLimit: carry.columns.trafficLimit,
            deviceLimit: carry.columns.deviceLimit,
            internalSquads: [...plan.internalSquads],
            externalSquad: plan.externalSquad,
            planSnapshot: newPlanSnapshot,
          },
        });

        // THE TERM ROTATES, where one exists — the imports the background
        // cutover has already brought into the model. Without it the next
        // recompute stood on the import's cutover term and mirrored its
        // limits back over the plan. No flag is read; a subscription with no
        // term stays on the columns just written.
        const moved = await this.subscriptionTermHooks.rotateForPlanChangeInTransaction(
          tx,
          {
            subscriptionId: subscription.id,
            plan,
            snapshotSource: BULK_PLAN_ASSIGNMENT_TERM,
            scheduledTerms: 'CANCEL_UNBOUND',
          },
          {
            correlationId: `bulk-plan-assignment:${subscription.id}`,
            actorType: AddOnEntitlementActorType.ADMIN,
            actorId: createdBy,
          },
        );
        if (moved.outcome === 'SCHEDULED_TERMS_BLOCK') {
          throw new ConflictException(
            `Subscription ${subscription.id} has a paid renewal period queued that carries add-ons ` +
              `(${moved.boundEntitlements}); it keeps its plan until that period starts`,
          );
        }
        let projection: RecomputeProjectionResult | null = null;
        if (moved.outcome === 'ROTATED') {
          projection = moved.projection;
          const mirrored = numericColumnsFromProjection(projection, carry.columns);
          if (
            mirrored.trafficLimit !== carry.columns.trafficLimit ||
            mirrored.deviceLimit !== carry.columns.deviceLimit
          ) {
            await tx.subscription.update({ where: { id: subscription.id }, data: mirrored });
          }
        }

        if (!pushNow) return null;
        const action = subscription.remnawaveId ? SyncAction.UPDATE : SyncAction.CREATE;
        const syncJob = await tx.profileSyncJob.create({
          data: {
            subscriptionId: subscription.id,
            action,
            // Versioned only when a projection backs it, as every plan change.
            ...(projection === null
              ? {}
              : {
                  aggregateKey: subscription.id,
                  desiredRevision: projection.desiredRevision,
                  cause: 'PLAN_CHANGE',
                }),
            payload: { bulkPlanAssignment: true, planId: plan.id, applyImmediately: true } satisfies Prisma.InputJsonValue,
          },
          select: { id: true },
        });
        return syncJob.id;
      });

      if (syncJobId instanceof BulkAssignmentSkip) {
        skip(syncJobId.verdict);
        continue;
      }
      updated += 1;

      if (syncJobId !== null) {
        syncJobsCreated += 1;
        try {
          await this.profileSyncQueueService.enqueue(syncJobId);
        } catch (error: unknown) {
          this.logger.warn(
            `Bulk plan assignment persisted sync job ${syncJobId} for ${subscription.id}; sweep will retry enqueue: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }

    return {
      subscriptions: subscriptions.length,
      updated,
      skippedDeleted,
      skippedAlreadyAssigned,
      skippedNotImported,
      skippedPurchasedHere,
      syncJobsCreated,
    };
  }
}
