import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PlanAvailability, Prisma } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import { RequestMetadataInterface } from '../../auth/interfaces/request-metadata.interface';
import { RemnawaveSquadOptionInterface } from '../../remnawave/interfaces/remnawave-squad-option.interface';
import { RemnawaveApiService } from '../../remnawave/services/remnawave-api.service';
import { PlanSnapshotSyncService } from '../../subscriptions/services/plan-snapshot-sync.service';
import { CreatePlanDto } from '../dto/create-plan.dto';
import { PlanMoveDirection } from '../dto/move-plan.dto';
import { UpdatePlanDto } from '../dto/update-plan.dto';
import { AdminPlanInterface } from '../interfaces/admin-plan.interface';
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
 * PlansAdminService
 * ─────────────────
 * Orchestrates plan-write operations exposed to the admin panel. Pure
 * normalisation and validation live in dedicated sibling files
 * (`plans-admin.normalizers.ts`, `plans-admin.validators.ts`); this class
 * keeps only the persistence / audit / cross-system sync logic.
 */
@Injectable()
export class PlansAdminService {
  public constructor(
    private readonly prismaService: PrismaService,
    private readonly remnawaveApiService: RemnawaveApiService,
    private readonly planSnapshotSyncService: PlanSnapshotSyncService,
    private readonly plansAdminValidators: PlansAdminValidators,
    private readonly planSquadPropagationService: PlanSquadPropagationService,
  ) {}

  /** Live progress of this plan's most recent squad propagation. */
  public async getSquadPropagationStatus(planId: string): Promise<PlanSquadPropagationStatus> {
    await this.getRequiredPlan(planId);
    return this.planSquadPropagationService.getStatus(planId);
  }

  public async listPlans(): Promise<readonly AdminPlanInterface[]> {
    const plans = await this.prismaService.plan.findMany({
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
    const createdPlan = await this.prismaService.$transaction(async (transactionClient) => {
      const lastPlan = await transactionClient.plan.findFirst({
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
    const { updated, propagation } = await this.prismaService.$transaction(
      async (transactionClient) => {
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
        await this.planSnapshotSyncService.syncPlanSnapshotMetadata(transactionClient, {
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
          },
        });
        return { updated: updatedPlan, propagation: squadPropagation };
      },
    );
    // Outside the transaction: enqueueing is a Redis write, and no worker may
    // see a job id whose row has not committed.
    await this.planSquadPropagationService.enqueueAfterCommit(propagation.syncJobIds);
    return { ...mapAdminPlan(updated), squadPropagation: propagation.summary };
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
      where: { id: input.planId },
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
      const existing = await transactionClient.plan.findMany({ select: { id: true } });
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

  public async deletePlan(planId: string, context: AdminMutationContext): Promise<void> {
    await this.prismaService.$transaction(async (transactionClient) => {
      const existingPlan = await transactionClient.plan.findUnique({
        where: { id: planId },
        select: { id: true, name: true, orderIndex: true },
      });
      if (existingPlan === null) {
        throw new NotFoundException('Plan not found');
      }
      await this.plansAdminValidators.assertPlanDeleteIsAllowed(planId, transactionClient);
      await transactionClient.plan.delete({ where: { id: planId } });
      const remainingPlans = await transactionClient.plan.findMany({
        where: { orderIndex: { gt: existingPlan.orderIndex } },
        orderBy: { orderIndex: 'asc' },
        select: { id: true, orderIndex: true },
      });
      for (const plan of remainingPlans) {
        await transactionClient.plan.update({
          where: { id: plan.id },
          data: { orderIndex: plan.orderIndex - 1 },
        });
      }
      await this.logAdminAction({
        transactionClient,
        action: 'plans.deleted',
        context,
        metadata: {
          planId,
          name: existingPlan.name,
        },
      });
    });
  }

  // ── Internal helpers ─────────────────────────────────────────────────────

  private async getRequiredPlan(planId: string) {
    const plan = await this.prismaService.plan.findUnique({
      where: { id: planId },
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
