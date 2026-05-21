import { BadRequestException, Injectable } from '@nestjs/common';
import { Currency, PlanAvailability, Prisma, SubscriptionStatus } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { RemnawaveApiService } from '../../remnawave/services/remnawave-api.service';
import { AdminPlanDurationDto } from '../dto/admin-plan-duration.dto';
import { ArchivedPlanRenewModeValue } from '../utils/archived-plan-renew-mode.util';

import { NormalizedPlanWriteInput } from './plans-admin.normalizers';

const ACTIVE_PUBLIC_AVAILABILITIES: ReadonlySet<PlanAvailability> = new Set([
  PlanAvailability.ALL,
  PlanAvailability.NEW,
  PlanAvailability.EXISTING,
  PlanAvailability.INVITED,
  PlanAvailability.ALLOWED,
  PlanAvailability.TRIAL,
]);

/**
 * Centralises the business invariants that must hold for any plan write
 * (create or update). Kept separate from `PlansAdminService` so the
 * orchestration class stays focused on persistence and audit, while the
 * "what is a valid plan" rules live next to each other and are easy to
 * reason about in isolation.
 */
@Injectable()
export class PlansAdminValidators {
  public constructor(
    private readonly prismaService: PrismaService,
    private readonly remnawaveApiService: RemnawaveApiService,
  ) {}

  public async assertPlanWriteIsValid(input: {
    readonly planId: string | null;
    readonly input: NormalizedPlanWriteInput;
  }): Promise<void> {
    await this.assertUniquePlanName(input.planId, input.input.name);
    this.assertDurationsAreValid(input.input.durations);
    this.assertTransitionReferencesAreWellFormed({ planId: input.planId, input: input.input });
    await this.assertTrialConstraints(input);
    await this.assertReferencedPlansExistAndAreAssignable(input.input);
    await this.assertAllowedUsersExist(input.input.allowedUserIds);
    await this.assertSquadsAreValid(input.input);
  }

  public async assertPlanDeleteIsAllowed(
    planId: string,
    transactionClient: Prisma.TransactionClient,
  ): Promise<void> {
    const transitionReference = await transactionClient.plan.findFirst({
      where: {
        OR: [
          { upgradeToPlanIds: { has: planId } },
          { replacementPlanIds: { has: planId } },
        ],
      },
      select: { id: true },
    });
    if (transitionReference !== null) {
      throw new BadRequestException(
        'Plan is referenced by subscriptions or transition rules. Archive it instead.',
      );
    }
    const subscriptionReference = await transactionClient.$queryRaw<
      readonly { readonly id: string }[]
    >(
      Prisma.sql`
        SELECT "id"
        FROM "subscriptions"
        WHERE "status" <> ${SubscriptionStatus.DELETED}
          AND "plan_snapshot"->>'id' = ${planId}
        LIMIT 1
      `,
    );
    if (subscriptionReference.length > 0) {
      throw new BadRequestException(
        'Plan is referenced by subscriptions or transition rules. Archive it instead.',
      );
    }
  }

  // ── Unique name ─────────────────────────────────────────────────────────

  private async assertUniquePlanName(planId: string | null, name: string): Promise<void> {
    const existingPlan = await this.prismaService.plan.findFirst({
      where: { name },
      select: { id: true },
    });
    if (existingPlan !== null && existingPlan.id !== planId) {
      throw new BadRequestException(`Plan with name '${name}' already exists`);
    }
  }

  // ── Durations / prices integrity ────────────────────────────────────────

  private assertDurationsAreValid(durations: readonly AdminPlanDurationDto[]): void {
    const durationDays = new Set<number>();
    for (const duration of durations) {
      if (durationDays.has(duration.days)) {
        throw new BadRequestException(`Duration ${duration.days} days is duplicated`);
      }
      durationDays.add(duration.days);
      const currencies = new Set<Currency>();
      for (const price of duration.prices) {
        if (currencies.has(price.currency)) {
          throw new BadRequestException(
            `Currency '${price.currency}' is duplicated for ${duration.days} days`,
          );
        }
        currencies.add(price.currency);
      }
    }
  }

  // ── Upgrade / replacement / archive coupling ────────────────────────────

  private assertTransitionReferencesAreWellFormed(input: {
    readonly planId: string | null;
    readonly input: NormalizedPlanWriteInput;
  }): void {
    const transitionIds = new Set([
      ...input.input.upgradeToPlanIds,
      ...input.input.replacementPlanIds,
    ]);
    if (input.planId !== null && transitionIds.has(input.planId)) {
      throw new BadRequestException('Plan transitions cannot reference the same plan');
    }
    if (
      input.input.isArchived &&
      input.input.archivedRenewMode === ArchivedPlanRenewModeValue.REPLACE_ON_RENEW &&
      input.input.replacementPlanIds.length === 0
    ) {
      throw new BadRequestException(
        'Archived plans with replacement renew mode must define replacement plans',
      );
    }
    if (
      !input.input.isArchived &&
      input.input.archivedRenewMode !== ArchivedPlanRenewModeValue.SELF_RENEW
    ) {
      throw new BadRequestException(
        'Only archived plans may define replacement renew behavior',
      );
    }
  }

  // ── Trial uniqueness ────────────────────────────────────────────────────

  private async assertTrialConstraints(input: {
    readonly planId: string | null;
    readonly input: NormalizedPlanWriteInput;
  }): Promise<void> {
    if (
      input.input.availability !== PlanAvailability.TRIAL ||
      !input.input.isActive ||
      input.input.isArchived
    ) {
      return;
    }
    const existingTrial = await this.prismaService.plan.findFirst({
      where: {
        availability: PlanAvailability.TRIAL,
        isActive: true,
        isArchived: false,
      },
      select: { id: true },
    });
    if (existingTrial !== null && existingTrial.id !== input.planId) {
      throw new BadRequestException('Only one active trial plan is allowed');
    }
    if (input.input.durations.length !== 1) {
      throw new BadRequestException('Trial plans must define exactly one duration');
    }
  }

  // ── Referenced plans must exist + be public/active ──────────────────────

  private async assertReferencedPlansExistAndAreAssignable(
    input: NormalizedPlanWriteInput,
  ): Promise<void> {
    const referencedIds = [...new Set([...input.upgradeToPlanIds, ...input.replacementPlanIds])];
    if (referencedIds.length === 0) {
      return;
    }
    const referencedPlans = await this.prismaService.plan.findMany({
      where: { id: { in: referencedIds } },
      select: {
        id: true,
        isActive: true,
        isArchived: true,
        availability: true,
      },
    });
    const referencedById = new Map(referencedPlans.map((plan) => [plan.id, plan]));
    const missingIds = referencedIds.filter((id) => !referencedById.has(id));
    if (missingIds.length > 0) {
      throw new BadRequestException(`Referenced plans not found: ${missingIds.join(', ')}`);
    }
    const invalidIds = referencedPlans
      .filter(
        (plan) =>
          !plan.isActive ||
          plan.isArchived ||
          !ACTIVE_PUBLIC_AVAILABILITIES.has(plan.availability),
      )
      .map((plan) => plan.id);
    if (invalidIds.length > 0) {
      throw new BadRequestException(
        `Replacement and upgrade plans must be active public plans: ${invalidIds.join(', ')}`,
      );
    }
  }

  // ── Allowed users must exist ────────────────────────────────────────────

  private async assertAllowedUsersExist(allowedUserIds: readonly string[]): Promise<void> {
    if (allowedUserIds.length === 0) {
      return;
    }
    const users = await this.prismaService.user.findMany({
      where: { id: { in: [...allowedUserIds] } },
      select: { id: true },
    });
    const userIds = new Set(users.map((user) => user.id));
    const missingUserIds = allowedUserIds.filter((userId) => !userIds.has(userId));
    if (missingUserIds.length > 0) {
      throw new BadRequestException(`Allowed users not found: ${missingUserIds.join(', ')}`);
    }
  }

  // ── Squads (Remnawave) ──────────────────────────────────────────────────

  private async assertSquadsAreValid(input: NormalizedPlanWriteInput): Promise<void> {
    if (input.internalSquads.length === 0 && input.externalSquad === null) {
      return;
    }

    let internalSquads: readonly { uuid: string }[] = [];
    let externalSquads: readonly { uuid: string }[] = [];

    try {
      [internalSquads, externalSquads] = await Promise.all([
        input.internalSquads.length > 0
          ? this.remnawaveApiService.getInternalSquadOptions()
          : Promise.resolve([]),
        input.externalSquad !== null
          ? this.remnawaveApiService.getExternalSquadOptions()
          : Promise.resolve([]),
      ]);
    } catch {
      // Remnawave is unavailable — skip squad validation gracefully so an
      // upstream outage doesn't block plan writes. Squads will be
      // re-validated on the next edit.
      return;
    }

    const internalSquadIds = new Set(internalSquads.map((squad) => squad.uuid));
    const externalSquadIds = new Set(externalSquads.map((squad) => squad.uuid));
    const missingInternalSquads = input.internalSquads.filter(
      (squad) => !internalSquadIds.has(squad),
    );
    if (missingInternalSquads.length > 0) {
      throw new BadRequestException(
        `Internal squads not found: ${missingInternalSquads.join(', ')}`,
      );
    }
    if (input.externalSquad !== null && !externalSquadIds.has(input.externalSquad)) {
      throw new BadRequestException(`External squad not found: ${input.externalSquad}`);
    }
  }
}
