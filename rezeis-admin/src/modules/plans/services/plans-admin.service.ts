import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { PlanAvailability, Prisma } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { enqueueResetRulePushes, followResetRules } from '../../add-on-entitlements/services/reset-rule-follow';
import { SubscriptionTermService } from '../../add-on-entitlements/services/subscription-term.service';
import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import { RequestMetadataInterface } from '../../auth/interfaces/request-metadata.interface';
import { ProfileSyncQueueService } from '../../profile-sync/profile-sync-queue.service';
import { RemnawaveSquadOptionInterface } from '../../remnawave/interfaces/remnawave-squad-option.interface';
import { RemnawaveApiService } from '../../remnawave/services/remnawave-api.service';
import {
  PlanSnapshotSyncResult,
  PlanSnapshotSyncService,
} from '../../subscriptions/services/plan-snapshot-sync.service';
import { CreatePlanDto } from '../dto/create-plan.dto';
import { PlanMoveDirection } from '../dto/move-plan.dto';
import { UpdatePlanDto } from '../dto/update-plan.dto';
import { AdminPlanInterface } from '../interfaces/admin-plan.interface';
import {
  LIVE_PLAN_WHERE,
  ReleasedPlanName,
  releasePlanNameFromDeletedPlan,
} from '../utils/plan-deletion.util';
import { mapAdminPlan, PLAN_INCLUDE } from '../utils/plan-record.util';

import {
  PlanSquadPropagationService,
  PlanSquadPropagationStatus,
  PlanSquadPropagationSummary,
} from './plan-squad-propagation.service';
import {
  buildPlanDurationCreateInput,
  buildPlanWriteData,
  normalizeCreatePlanInput,
  normalizeUpdatePlanInput,
} from './plans-admin.normalizers';
import { PlansAdminValidators } from './plans-admin.validators';

interface AdminMutationContext {
  readonly currentAdmin: CurrentAdminInterface;
  readonly requestMetadata: RequestMetadataInterface;
}

/**
 * Which screen produced a `plans.updated` audit row.
 *
 * Two surfaces write that action: the plan editor on the Plans tab
 * ({@link PlansAdminService.updatePlan}) and the per-user allow-list toggle on
 * the user card ({@link PlansAdminService.setUserPlanAccess}). One action name
 * with the origin in `metadata.source` — rather than two action names — is the
 * shape `partner.balance.adjusted` settled on, and for the same reason: the
 * question an auditor asks is "who moved this", not "which button did they
 * press", and it must not need two queries to answer.
 */
export const PLAN_UPDATE_SOURCES = Object.freeze({
  PLANS_TAB: 'plans_tab',
  USER_CARD_PLAN_ACCESS: 'user_card_plan_access',
} as const);

export type PlanUpdateSource =
  (typeof PLAN_UPDATE_SOURCES)[keyof typeof PLAN_UPDATE_SOURCES];

/**
 * What the allow-list toggle did, as the caller's HTTP response needs to know
 * it. `changed: false` is the idempotent case — the user was already on (or
 * already off) the list and the database matched no row to change.
 */
export interface PlanAccessChangeResultInterface {
  readonly granted: boolean;
  readonly changed: boolean;
  readonly allowedUserIds: readonly string[];
}

/**
 * A plan as saved, plus what the save set in motion. `squadPropagation` is how
 * the operator learns that a squad edit is on its way to existing subscribers
 * instead of having to trust that it is — `GET /admin/plans/:planId/squad-propagation`
 * then answers whether it has finished.
 */
export interface AdminPlanUpdateResultInterface extends AdminPlanInterface {
  readonly squadPropagation: PlanSquadPropagationSummary;
}

/**
 * How long a stop waits for the reset-rule follow under way to finish the
 * subscriber it is on; see `onModuleDestroy`. One step takes milliseconds, so
 * this is a bound, not a pause — well inside the 10 s Docker gives a container,
 * beside the 5 s the refund cards may take (`AFTER_RESPONSE_SHUTDOWN_WAIT_MS`).
 */
export const RESET_RULE_FOLLOW_SHUTDOWN_WAIT_MS = 2_000;

/**
 * PlansAdminService
 * ─────────────────
 * Orchestrates plan-write operations exposed to the admin panel. Pure
 * normalisation and validation live in dedicated sibling files
 * (`plans-admin.normalizers.ts`, `plans-admin.validators.ts`); this class
 * keeps only the persistence / audit / cross-system sync logic.
 */
@Injectable()
export class PlansAdminService implements OnModuleDestroy {
  private readonly logger = new Logger(PlansAdminService.name);
  /** The terms of a plan's subscribers follow a changed reset rule through it. Stateless. */
  private readonly subscriptionTermService = new SubscriptionTermService();
  /** Reset-rule follows started after an edit's commit and not finished yet. */
  private readonly resetRuleFollows = new Set<Promise<void>>();
  /** Set when the process stops: a follow under way ends after the subscriber it is on. */
  private stopping = false;

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly remnawaveApiService: RemnawaveApiService,
    private readonly planSnapshotSyncService: PlanSnapshotSyncService,
    private readonly plansAdminValidators: PlansAdminValidators,
    private readonly planSquadPropagationService: PlanSquadPropagationService,
    /**
     * Pushes a subscriber's changed reset rule the moment its follow commits.
     * `@Optional()` at the tail for the specs that build this by hand: without
     * it the pushes stay PENDING for the profile-sync sweep.
     */
    @Optional() private readonly profileSyncQueueService?: ProfileSyncQueueService,
  ) {}

  /**
   * A STOP ENDS A FOLLOW BETWEEN TWO SUBSCRIBERS, NOT IN ONE. The follow under
   * way finishes the subscriber it is on — its short transaction commits, and
   * its push is enqueued — and starts no other; {@link RESET_RULE_FOLLOW_SHUTDOWN_WAIT_MS}
   * bounds the wait. Nothing is lost by stopping: a subscriber in the term
   * model not reached yet still has a term naming the old rule, which the
   * boundary scheduler's sweep finds; every other one got its push with the
   * edit itself (`PlanSnapshotSyncService`), which the profile-sync sweep sends.
   *
   * `onModuleDestroy`, not `onApplicationShutdown` (review R4): Nest destroys
   * this module before the global one whose `PrismaService` disconnects, and
   * runs every shutdown hook only after that — the wait used to sit there, with
   * the database already gone under the follow it waited for.
   */
  public async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.resetRuleFollows.size === 0) return;
    let timer: NodeJS.Timeout | undefined;
    const settled = await Promise.race([
      this.settleResetRuleFollows().then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), RESET_RULE_FOLLOW_SHUTDOWN_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
    if (!settled) {
      this.logger.warn('A reset-rule follow was still running at the stop; the sweeps finish what it left');
    }
  }

  /** Resolves once every reset-rule follow started so far has finished (it never rejects). */
  public async settleResetRuleFollows(): Promise<void> {
    await Promise.all([...this.resetRuleFollows]);
  }

  /** Live progress of this plan's most recent squad propagation. */
  public async getSquadPropagationStatus(planId: string): Promise<PlanSquadPropagationStatus> {
    await this.getRequiredPlan(planId);
    return this.planSquadPropagationService.getStatus(planId);
  }

  public async listPlans(): Promise<readonly AdminPlanInterface[]> {
    const plans = await this.prismaService.plan.findMany({
      // A soft-deleted plan is gone for the operator: the row is kept only so
      // obligations already taken can resolve it by id (`PlanDeletionService`).
      where: LIVE_PLAN_WHERE,
      include: PLAN_INCLUDE,
      orderBy: [{ orderIndex: 'asc' }, { createdAt: 'asc' }],
    });
    return plans.map(mapAdminPlan);
  }

  public async getPlan(planId: string): Promise<AdminPlanInterface> {
    const plan = await this.getRequiredPlan(planId);
    return mapAdminPlan(plan);
  }

  public async getInternalSquadOptions(): Promise<readonly RemnawaveSquadOptionInterface[]> {
    return this.remnawaveApiService.getInternalSquadOptions();
  }

  public async getExternalSquadOptions(): Promise<readonly RemnawaveSquadOptionInterface[]> {
    return this.remnawaveApiService.getExternalSquadOptions();
  }

  public async createPlan(
    input: CreatePlanDto,
    context: AdminMutationContext,
  ): Promise<AdminPlanInterface> {
    const normalizedInput = normalizeCreatePlanInput(input);
    await this.plansAdminValidators.assertPlanWriteIsValid({ planId: null, input: normalizedInput });
    const nameHolder = await this.plansAdminValidators.findDeletedPlanHoldingName(
      null,
      normalizedInput.name,
    );
    const createdPlan = await this.prismaService.$transaction(async (transactionClient) => {
      // A DELETED plan holding the name gives it up instead of refusing the
      // operator over a plan they can no longer see — in this transaction, so
      // the rename and the create commit together or not at all.
      const releasedName =
        nameHolder === null
          ? null
          : await releasePlanNameFromDeletedPlan(transactionClient, nameHolder);
      const lastPlan = await transactionClient.plan.findFirst({
        // The last VISIBLE plan: a hidden one's index is meaningless, and
        // appending after it would open a gap in the order on screen.
        where: LIVE_PLAN_WHERE,
        orderBy: { orderIndex: 'desc' },
        select: { orderIndex: true },
      });
      const created = await transactionClient.plan.create({
        data: {
          ...buildPlanWriteData(normalizedInput),
          orderIndex: (lastPlan?.orderIndex ?? 0) + 1,
          durations: {
            create: buildPlanDurationCreateInput(normalizedInput.durations),
          },
        },
        include: PLAN_INCLUDE,
      });
      await this.logAdminAction({
        transactionClient,
        action: 'plans.created',
        context,
        metadata: {
          planId: created.id,
          name: created.name,
          ...releasedNameMetadata(releasedName),
        },
      });
      return created;
    });
    return mapAdminPlan(createdPlan);
  }

  public async updatePlan(
    planId: string,
    input: UpdatePlanDto,
    context: AdminMutationContext,
  ): Promise<AdminPlanUpdateResultInterface> {
    const currentPlan = await this.getRequiredPlan(planId);
    const normalizedInput = normalizeUpdatePlanInput(input, currentPlan);
    await this.plansAdminValidators.assertPlanWriteIsValid({
      planId,
      input: normalizedInput,
      // The persisted selection, so a panel outage only blocks a write that
      // actually CHANGES the squads (see `assertSquadsAreValid`).
      persistedSquads: {
        internalSquads: currentPlan.internalSquads,
        externalSquad: currentPlan.externalSquad,
      },
    });
    // Only a RENAME can collide with a deleted plan: the current name is this
    // row's own, and the unique index guarantees no other row holds it.
    const nameHolder =
      normalizedInput.name === currentPlan.name
        ? null
        : await this.plansAdminValidators.findDeletedPlanHoldingName(planId, normalizedInput.name);
    const { updated, propagation, snapshots } = await this.prismaService.$transaction(
      async (transactionClient) => {
        // ── LOCKED AND RE-READ BEFORE ANYTHING IS WRITTEN ──────────────────
        //
        // `currentPlan` was read outside this transaction, before validation —
        // which asks Remnawave about squads and can take a while — and the
        // write below carries `isActive` / `isArchived` from that read. A
        // delete that committed in between used to be overwritten by them:
        // the plan stamped deleted AND back on sale, sold by the catalogue
        // while no panel screen could see it. `PlanDeletionService` takes the
        // same `FOR UPDATE`, so the two queue on the row; read under the lock,
        // a plan deleted in the meantime is not found, as it would have been
        // had the edit arrived a moment later. First, so a refused edit has
        // renamed no hidden plan either.
        const locked = await transactionClient.$queryRaw<{ readonly deletedAt: Date | null }[]>(
          Prisma.sql`
            SELECT "deleted_at" AS "deletedAt"
              FROM "plans"
             WHERE "id" = ${planId}
               FOR UPDATE
          `,
        );
        if (locked[0] === undefined || locked[0].deletedAt !== null) {
          throw new NotFoundException('Plan not found');
        }
        const releasedName =
          nameHolder === null
            ? null
            : await releasePlanNameFromDeletedPlan(transactionClient, nameHolder);
        const updatedPlan = await transactionClient.plan.update({
          where: { id: planId },
          data: {
            ...buildPlanWriteData(normalizedInput),
            durations:
              normalizedInput.durations === undefined
                ? undefined
                : {
                    deleteMany: {},
                    create: buildPlanDurationCreateInput(normalizedInput.durations),
                  },
          },
          include: PLAN_INCLUDE,
        });
        // The snapshots, in one statement whatever the plan's size. A changed
        // reset rule reaches the terms of the subscribers in the term model,
        // their «до сброса» add-ons and then Remnawave AFTER the commit
        // (`followResetRuleAfterCommit`); every other live linked subscriber's
        // push is written here, with the rule (review R4-01).
        const snapshotSync = await this.planSnapshotSyncService.syncPlanSnapshotMetadata(transactionClient, {
          id: updatedPlan.id,
          name: updatedPlan.name,
          tag: updatedPlan.tag,
          type: updatedPlan.type,
          trafficLimit: updatedPlan.trafficLimit,
          deviceLimit: updatedPlan.deviceLimit,
          trafficLimitStrategy: updatedPlan.trafficLimitStrategy,
          internalSquads: updatedPlan.internalSquads,
          externalSquad: updatedPlan.externalSquad,
        });
        // The snapshot write above is NOT enough on its own: the sync processor
        // reads squads from the subscription's columns, not from the snapshot,
        // so without this fan-out an operator's squad edit never reaches anyone
        // who already bought the plan.
        //
        // Squads fan out; `trafficLimit` / `deviceLimit` deliberately do NOT.
        // A squad is the route to the service and a stale one is a broken
        // service; a limit is the priced good, and pushing a smaller one would
        // take back what a customer already paid for as a side effect of an
        // admin edit — the same reason `BulkPlanAssignmentService.applyImmediately`
        // defaults to false.
        //
        // Limit edits reach existing subscribers at their next renewal or
        // upgrade. Upgrade re-copies the plan unconditionally; renewal
        // re-applies it only to the fields whose columns still match the
        // subscription's own snapshot, so it reaches everyone who was never
        // individually adjusted and leaves an operator's per-subscription
        // limit standing. The plan editor states the renewal rule to the
        // operator while they are typing (see
        // `web/src/features/plans/plan-limit-scope.ts`); it does not yet
        // mention the individually-adjusted exception. Full reasoning, and what
        // an opt-in propagation would have to write, is on
        // `PlanSnapshotSyncService.syncPlanSnapshotMetadata`.
        const squadPropagation = await this.planSquadPropagationService.propagateInTransaction(
          transactionClient,
          {
            planId: updatedPlan.id,
            previousInternalSquads: currentPlan.internalSquads,
            previousExternalSquad: currentPlan.externalSquad,
            nextInternalSquads: updatedPlan.internalSquads,
            nextExternalSquad: updatedPlan.externalSquad,
          },
        );
        // Logged after the fan-out so the audit row records what the edit
        // actually set in motion, not just that it happened.
        //
        // `source` discriminates the surface, the way
        // `partner.balance.adjusted` does. `plans.updated` is now written by
        // two screens — this one and the allow-list toggle on the user card
        // ({@link setUserPlanAccess}) — and an auditor asking "who moved this
        // plan's allow-list" has to be able to find both in ONE query and then
        // tell them apart. Splitting the action name instead would put the
        // second surface back where it was: invisible to anyone who queries
        // for the name they know.
        await this.logAdminAction({
          transactionClient,
          action: 'plans.updated',
          context,
          metadata: {
            planId: updatedPlan.id,
            name: updatedPlan.name,
            source: PLAN_UPDATE_SOURCES.PLANS_TAB,
            squadPropagation: { ...squadPropagation.summary },
            // How many subscribers' reset rule the edit changed: they follow it
            // after the commit, each on its own, or were pushed with it
            // (`followResetRuleAfterCommit`).
            ...(snapshotSync.strategyChanged > 0
              ? { resetRuleChange: { subscriptions: snapshotSync.strategyChanged } }
              : {}),
            ...releasedNameMetadata(releasedName),
          },
        });
        return { updated: updatedPlan, propagation: squadPropagation, snapshots: snapshotSync };
      },
    );
    // Outside the transaction: enqueueing is a Redis write, and no worker may
    // see a job id whose row has not committed.
    await this.planSquadPropagationService.enqueueAfterCommit(propagation.syncJobIds);
    this.followResetRuleAfterCommit(updated.id, snapshots);
    return { ...mapAdminPlan(updated), squadPropagation: propagation.summary };
  }

  /**
   * A CHANGED RESET RULE REACHES THE SUBSCRIBERS AFTER THE COMMIT (P6, review
   * R3a-01), in two groups:
   *  - the pushes the edit wrote for the subscribers outside the term model
   *    (`snapshots.syncJobIds`, review R4-01) are put on the queue first;
   *  - then each subscriber in the model follows: its terms take the rule, its
   *    «до сброса» add-ons end at the first reset under it (never later than
   *    promised), and then its live profile is pushed — each in a short
   *    transaction of its own (`followResetRules`), its push enqueued the
   *    moment that transaction commits.
   *
   * NOT AWAITED by the edit: a plan with tens of thousands of subscribers
   * would hold the operator's request for minutes, past the 30-second request
   * timeout. Nothing this leaves undone is lost — a restart, a stop
   * ({@link onModuleDestroy}), a failed step: a subscriber in the model still
   * has a term naming the old rule, which the boundary scheduler's sweep finds
   * (`EntitlementBoundarySchedulerService.followChangedResetRules`, 500 a run
   * every 5 minutes), and every other push is a PENDING row since the commit,
   * which the profile-sync sweep sends. How many subscribers the edit concerns
   * is on the audit row (`resetRuleChange`).
   */
  private followResetRuleAfterCommit(planId: string, snapshots: PlanSnapshotSyncResult): void {
    // `?? []`: a spec's double of the snapshot sync answers a bare count.
    const subscriptionIds = snapshots.followSubscriptionIds ?? [];
    const pushed = snapshots.syncJobIds ?? [];
    if (subscriptionIds.length === 0 && pushed.length === 0) return;
    const queue = this.profileSyncQueueService;
    const enqueue = queue === undefined ? undefined : (syncJobId: string) => queue.enqueue(syncJobId);
    const shouldStop = (): boolean => this.stopping;
    const run = (async () => {
      const outside =
        enqueue === undefined ? 0 : await enqueueResetRulePushes(enqueue, pushed, { logger: this.logger, shouldStop });
      const summary = await followResetRules(
        { prisma: this.prismaService, terms: this.subscriptionTermService, enqueue, logger: this.logger },
        subscriptionIds,
        { correlationId: `plan-edit:${planId}`, push: 'always', shouldStop },
      );
      this.logger.log(
        `Plan ${planId}: reset rule followed by ${summary.followed} of ${subscriptionIds.length} subscriber(s) ` +
          `in the term model, ${summary.enqueued + outside} push(es) enqueued (${outside} of ${pushed.length} ` +
          'written with the edit)' +
          (summary.failed > 0 ? `, ${summary.failed} left for the sweep` : '') +
          (this.stopping ? '; stopped by the shutdown, the sweeps finish the rest' : ''),
      );
    })().catch((error: unknown) => {
      this.logger.warn(
        `Plan ${planId}: reset-rule follow stopped, the sweeps finish it: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
    this.resetRuleFollows.add(run);
    void run.finally(() => this.resetRuleFollows.delete(run));
  }

  /**
   * The single implementation of "an operator moved one user on or off a
   * plan's allow-list" — the toggle on the user card
   * (`POST`/`DELETE /admin/users/:telegramId/plan-access/:planId`).
   *
   * `Plan.allowedUserIds` decides who may buy an `ALLOWED` plan
   * (`plan-catalog.service.ts` — `plan.allowedUserIds.includes(user.id)`), and
   * it had TWO writers. The Plans-tab editor wrote it inside {@link updatePlan}
   * under `plans:edit`, with validation, a transaction and a `plans.updated`
   * audit row. The user card wrote it inline in the controller under
   * `users:edit`, with no transaction, no validation and NO AUDIT ROW — so the
   * shipped `operator` role, which holds `users:edit` and only `plans:view`,
   * could add or remove anybody from any restricted plan and leave no trace
   * that the allow-list had moved at all. Both routes now come here and are
   * gated on `plans:edit`, the permission that already guarded the column.
   *
   * ── THE WRITE IS A MEMBERSHIP CHANGE, NOT AN ARRAY OVERWRITE ───────────────
   *
   * The revoke used to be `plan.allowedUserIds.filter(...)` computed in this
   * process and written back whole. Under READ COMMITTED that is a lost update
   * in the plainest form: a grant that commits between the read and the write
   * is simply overwritten, and so is anything the Plans tab saved in the same
   * window. Both directions now hand Postgres a statement that names ONLY the
   * element being moved, and let it apply that to the row it locks:
   *
   *   grant   `updateMany` — `data: { allowedUserIds: { push: userId } }`,
   *           with `NOT: { allowedUserIds: { has: userId } }` in the `where` of
   *           that same statement, so the "not already listed" test cannot be
   *           raced the way a JS `includes` before the write could.
   *   revoke  `array_remove("allowed_user_ids", $userId)` — no Prisma operator
   *           removes one element of a scalar list, and the alternative (read
   *           under a row lock, write the filtered array) would put the whole
   *           array back on the wire for no gain.
   *
   * `count === 0` is therefore the only "nothing to do" signal either direction
   * gets, and it means the row did not match: the plan is gone, or the user was
   * already in the state asked for. That case is a no-op — it returns the list
   * as it stands and writes NO audit row, because nothing moved.
   *
   * As everywhere else in this tree, the transaction buys ALL-OR-NOTHING (the
   * membership change and its audit row commit together or not at all) and
   * nothing more. Serialisability is Postgres's, from evaluating the `WHERE` of
   * an `UPDATE` against the row it locks and holding that lock until commit.
   *
   * ── WHY A NON-`ALLOWED` PLAN IS REFUSED ───────────────────────────────────
   *
   * `allowedUserIds` is read by exactly one branch of the catalog gate, the
   * `ALLOWED` one. On any other availability the column is dead weight — and
   * worse than dead: `normalizePlanWriteInput` CLEARS it on every Plans-tab
   * save of a non-`ALLOWED` plan, so a grant written here would be silently
   * wiped by the next unrelated edit of that plan. Writing a row that grants
   * nothing today and disappears tomorrow is the kind of success an operator
   * acts on and cannot audit, so the write is refused instead. The SPA never
   * offers the toggle for such a plan (it filters to `availability === 'ALLOWED'`),
   * which makes this a defence against a hand-made request, not a UI change.
   */
  public async setUserPlanAccess(input: {
    readonly planId: string;
    readonly userId: string;
    readonly granted: boolean;
    readonly context: AdminMutationContext;
  }): Promise<PlanAccessChangeResultInterface> {
    const plan = await this.prismaService.plan.findUnique({
      // A deleted plan is not offered on the user card, so a toggle for one is
      // a stale page: answered like any other plan that is not there.
      where: { id: input.planId, deletedAt: null },
      select: { id: true, name: true, availability: true },
    });
    if (plan === null) {
      throw new NotFoundException('Plan not found');
    }
    if (plan.availability !== PlanAvailability.ALLOWED) {
      // Deliberately UNCODED, unlike the seventeen refusals in
      // `plan-write-refusal-codes.ts`. Those exist because the SPA has to
      // translate them for an operator who typed something wrong in the plan
      // editor; this one is unreachable from any screen — the toggle is only
      // rendered for `availability === 'ALLOWED'` — so it answers a hand-made
      // request, and a code would be a wire contract with no reader. See the
      // method comment for why refusing beats writing.
      throw new BadRequestException(
        `Plan availability is ${plan.availability}: the per-user allow-list is only read for ALLOWED plans`,
      );
    }
    // The same existence check the Plans tab runs over the whole array, so a
    // stale id refuses identically whichever screen submits it.
    await this.plansAdminValidators.assertAllowedUsersExist([input.userId]);

    return this.prismaService.$transaction(async (transactionClient) => {
      const changedRows = input.granted
        ? (
            await transactionClient.plan.updateMany({
              where: { id: input.planId, NOT: { allowedUserIds: { has: input.userId } } },
              data: { allowedUserIds: { push: input.userId } },
            })
          ).count
        : await transactionClient.$executeRaw`
            UPDATE "plans"
               SET "allowed_user_ids" = array_remove("allowed_user_ids", ${input.userId})
             WHERE "id" = ${input.planId}
               AND ${input.userId} = ANY("allowed_user_ids")
          `;
      // Read back the row this transaction has just written and still holds the
      // lock on, so the list reported and audited is this change's own result
      // rather than a number read before it.
      const after = await transactionClient.plan.findUnique({
        where: { id: input.planId },
        select: { name: true, allowedUserIds: true },
      });
      if (after === null) {
        throw new NotFoundException('Plan not found');
      }
      const newAllowedUserIds = [...after.allowedUserIds];
      if (changedRows === 0) {
        // Nothing moved: already listed on a grant, already absent on a revoke.
        // The old inline code answered the same way, and an audit row for a
        // write that changed no row would be a false trail.
        return { granted: input.granted, changed: false, allowedUserIds: newAllowedUserIds };
      }
      // Derived from the row that came back, never from a read taken before the
      // write — the same reason `applyBalanceAdjustment` subtracts rather than
      // pre-reads. Order inside the column carries no meaning; the catalog gate
      // asks `.includes`.
      const previousAllowedUserIds = input.granted
        ? newAllowedUserIds.filter((userId) => userId !== input.userId)
        : [...newAllowedUserIds, input.userId];
      await this.logAdminAction({
        transactionClient,
        action: 'plans.updated',
        context: input.context,
        metadata: {
          planId: input.planId,
          name: after.name,
          source: PLAN_UPDATE_SOURCES.USER_CARD_PLAN_ACCESS,
          planAccess: {
            userId: input.userId,
            change: input.granted ? 'granted' : 'revoked',
          },
          previousAllowedUserIds,
          newAllowedUserIds,
        },
      });
      return { granted: input.granted, changed: true, allowedUserIds: newAllowedUserIds };
    });
  }

  public async movePlan(
    planId: string,
    direction: PlanMoveDirection,
    context: AdminMutationContext,
  ): Promise<AdminPlanInterface> {
    const updatedPlan = await this.prismaService.$transaction(async (transactionClient) => {
      const plans = await transactionClient.plan.findMany({
        // The neighbours on SCREEN: swapping with a hidden plan would move
        // nothing the operator can see, and a deleted plan cannot be moved.
        where: LIVE_PLAN_WHERE,
        orderBy: [{ orderIndex: 'asc' }, { createdAt: 'asc' }],
        select: { id: true, orderIndex: true },
      });
      const currentIndex = plans.findIndex((plan) => plan.id === planId);
      if (currentIndex < 0) {
        throw new NotFoundException('Plan not found');
      }
      const targetIndex =
        direction === PlanMoveDirection.UP ? currentIndex - 1 : currentIndex + 1;
      if (targetIndex < 0 || targetIndex >= plans.length) {
        return transactionClient.plan.findUniqueOrThrow({
          where: { id: planId },
          include: PLAN_INCLUDE,
        });
      }
      const currentPlan = plans[currentIndex]!;
      const targetPlan = plans[targetIndex]!;
      await transactionClient.plan.update({
        where: { id: currentPlan.id },
        data: { orderIndex: targetPlan.orderIndex },
      });
      await transactionClient.plan.update({
        where: { id: targetPlan.id },
        data: { orderIndex: currentPlan.orderIndex },
      });
      const updated = await transactionClient.plan.findUniqueOrThrow({
        where: { id: planId },
        include: PLAN_INCLUDE,
      });
      await this.logAdminAction({
        transactionClient,
        action: 'plans.moved',
        context,
        metadata: {
          planId: updated.id,
          direction,
        },
      });
      return updated;
    });
    return mapAdminPlan(updatedPlan);
  }

  /**
   * Bulk reorder: writes each plan's `orderIndex` to its position in
   * `orderedIds` (index 0 → shown first). Ids not present in the DB are
   * skipped; plans omitted from `orderedIds` keep their previous index.
   * Backs the free drag-and-drop reorder on the admin Plans page.
   */
  public async reorderPlans(
    orderedIds: readonly string[],
    context: AdminMutationContext,
  ): Promise<readonly AdminPlanInterface[]> {
    await this.prismaService.$transaction(async (transactionClient) => {
      // A stale page may still send a deleted plan's id; it takes no slot.
      const existing = await transactionClient.plan.findMany({
        where: LIVE_PLAN_WHERE,
        select: { id: true },
      });
      const existingIds = new Set(existing.map((plan) => plan.id));
      let index = 0;
      for (const id of orderedIds) {
        if (!existingIds.has(id)) continue;
        await transactionClient.plan.update({
          where: { id },
          data: { orderIndex: index },
        });
        index += 1;
      }
      await this.logAdminAction({
        transactionClient,
        action: 'plans.reordered',
        context,
        metadata: { count: index },
      });
    });
    return this.listPlans();
  }

  // Deleting a plan lives in `PlanDeletionService`: it is decided by the shared
  // reference guard, not by the write validators this class orchestrates.

  // ── Internal helpers ─────────────────────────────────────────────────────

  /**
   * The plan an operator is about to read or change. A soft-deleted plan is
   * NOT FOUND here, which is what keeps it gone for every route built on this:
   * the editor, archive/unarchive and the squad propagation status. An edit
   * could otherwise switch a deleted plan back on sale.
   */
  private async getRequiredPlan(planId: string) {
    const plan = await this.prismaService.plan.findUnique({
      where: { id: planId, deletedAt: null },
      include: PLAN_INCLUDE,
    });
    if (plan === null) {
      throw new NotFoundException('Plan not found');
    }
    return plan;
  }

  private async logAdminAction(input: {
    readonly transactionClient: Prisma.TransactionClient;
    readonly action: string;
    readonly context: AdminMutationContext;
    readonly metadata: Prisma.InputJsonObject;
  }): Promise<void> {
    await input.transactionClient.adminAuditLog.create({
      data: {
        action: input.action,
        ipAddress: input.context.requestMetadata.remoteAddress,
        userAgent: input.context.requestMetadata.userAgent,
        metadata: {
          requestId: input.context.requestMetadata.requestId,
          ...input.metadata,
        },
        adminUser: {
          connect: { id: input.context.currentAdmin.id },
        },
      },
    });
  }
}

/**
 * Audit metadata for a create or rename that took a deleted plan's name. Absent
 * when nothing was released, so the rows every other write produces keep the
 * exact shape they always had.
 */
function releasedNameMetadata(released: ReleasedPlanName | null): Prisma.InputJsonObject {
  if (released === null) {
    return {};
  }
  return {
    releasedNameFromDeletedPlan: {
      planId: released.planId,
      renamedTo: released.newName,
    },
  };
}
