import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

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
        // defaults to false. Limit edits reach existing subscribers at their
        // next renewal or upgrade, both of which re-read the live plan row; the
        // plan editor states this to the operator while they are typing (see
        // `web/src/features/plans/plan-limit-scope.ts`). Full reasoning, and what
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
        await this.logAdminAction({
          transactionClient,
          action: 'plans.updated',
          context,
          metadata: {
            planId: updatedPlan.id,
            name: updatedPlan.name,
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
