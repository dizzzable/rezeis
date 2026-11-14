import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Plan, PlanBundle, Prisma } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import { RequestMetadataInterface } from '../../auth/interfaces/request-metadata.interface';
import {
  BundleFaceMemberPlan,
  BundleFacePlanService,
} from '../../plans/services/bundle-face-plan.service';
import {
  canFaceMergedLink,
  orderBundleMembers,
  resolveVisiblePlanId,
} from '../utils/visible-plan.util';
import {
  AdminPlanBundleCreateDto,
  AdminPlanBundleMemberTrafficLabelDto,
  AdminPlanBundleUpdateDto,
  PLAN_BUNDLE_MAX_PLANS,
  PLAN_BUNDLE_MIN_PLANS,
} from '../dto/admin-plan-bundle.dto';
import { PlanBundleInterface } from '../interfaces/plan-bundle.interface';

/**
 * The member plans of a bundle, with every column the face plan copies from its
 * visible member. `select` rather than `include`: a plan row carries prices,
 * trial settings and allow-lists the bundle has no opinion about.
 */
const BUNDLE_MEMBER_PLAN_SELECT = {
  select: {
    planId: true,
    isVisibleInApp: true,
    // The operator's own caption for this plan's «Трафик доп.» line, if any.
    trafficLabel: true,
    plan: {
      select: {
        id: true,
        orderIndex: true,
        type: true,
        trafficLimit: true,
        trafficLimitStrategy: true,
        internalSquads: true,
        externalSquad: true,
        deviceLimit: true,
      },
    },
  },
} as const;

/**
 * What the plans page reads for one grouping: its name and members, the plan it
 * is issued as, and the plan the app shows on the merged link.
 */
const PLAN_BUNDLE_SELECT = {
  id: true,
  name: true,
  description: true,
  isActive: true,
  orderIndex: true,
  secondaryPlanId: true,
  createdAt: true,
  updatedAt: true,
  plan: { select: { id: true, deviceLimit: true } },
  members: BUNDLE_MEMBER_PLAN_SELECT,
} as const;

type PlanBundleMemberRecord = {
  readonly planId: string;
  readonly isVisibleInApp: boolean;
  readonly trafficLabel: string | null;
  readonly plan: BundleFaceMemberPlan['plan'];
};

type PlanBundleRecord = Pick<
  PlanBundle,
  | 'id'
  | 'name'
  | 'description'
  | 'isActive'
  | 'orderIndex'
  | 'secondaryPlanId'
  | 'createdAt'
  | 'updatedAt'
> & {
  readonly plan: Pick<Plan, 'id' | 'deviceLimit'> | null;
  readonly members: readonly PlanBundleMemberRecord[];
};

export interface PlanBundleMutationContext {
  readonly currentAdmin: CurrentAdminInterface;
  readonly requestMetadata: RequestMetadataInterface;
}

/**
 * CRUD for plan bundles — the operator's «эти тарифы объединяются в одну
 * ссылку» grouping, and the ONE plan it is issued as.
 *
 * A bundle owns a `Plan` row (see `BundleFacePlanService`): the operator grants
 * it as «объединённая подписка» from the user card, and it appears in «Тарифы»
 * like any other plan. The row is created, renamed and retired WITH the
 * grouping, so the two can never drift apart. Prices and durations belong to
 * the plan and are edited in the ordinary plan form; the plan is not sold by
 * the checkout — one payment creates one subscription, and a merge needs one
 * profile per member plan.
 */
@Injectable()
export class PlanBundlesService {
  public constructor(
    private readonly prismaService: PrismaService,
    private readonly bundleFacePlanService: BundleFacePlanService,
  ) {}

  public async list(): Promise<readonly PlanBundleInterface[]> {
    const records = await this.prismaService.planBundle.findMany({
      select: PLAN_BUNDLE_SELECT,
      orderBy: [{ orderIndex: 'asc' }, { createdAt: 'asc' }],
    });
    return records.map((record) => mapPlanBundle(record));
  }

  public async create(input: AdminPlanBundleCreateDto): Promise<PlanBundleInterface> {
    const planIds = normalizePlanIds(input.planIds);
    this.assertPlanCount(planIds);
    const memberPlans = await this.loadMemberPlans(planIds);
    await this.assertPlansNotGrouped(planIds);
    const visiblePlanId = this.requestedVisiblePlanId(input.visiblePlanId, memberPlans);
    const deviceLimit = this.requestedDeviceLimit(input.deviceLimit, memberPlans, visiblePlanId);
    const secondaryPlanId = this.requestedSecondaryPlanId(input.secondaryPlanId, memberPlans);
    // A new grouping has no stored captions, so what the dialog sent is the
    // whole set; the cap and the membership check live in the helper.
    const memberTrafficLabels = this.requestedMemberTrafficLabels(
      input.memberTrafficLabels,
      planIds,
    );
    const name = input.name.trim();
    const description = input.description?.trim() || null;
    const lastRecord = await this.prismaService.planBundle.findFirst({
      orderBy: { orderIndex: 'desc' },
      select: { orderIndex: true },
    });
    try {
      const record = await this.prismaService.$transaction(async (transactionClient) => {
        const created = await transactionClient.planBundle.create({
          data: {
            name,
            description,
            isActive: input.isActive ?? true,
            orderIndex: (lastRecord?.orderIndex ?? 0) + 1,
            secondaryPlanId,
            members: {
              create: planIds.map((planId) => ({
                planId,
                isVisibleInApp: planId === visiblePlanId,
                trafficLabel: memberTrafficLabels.get(planId) ?? null,
              })),
            },
          },
          select: { id: true },
        });
        // The plan is created in the SAME transaction: a grouping whose tariff
        // failed to save would offer a merged link with nothing to grant.
        const planId = await this.bundleFacePlanService.createInTransaction(transactionClient, {
          bundleName: name,
          bundleDescription: description,
          deviceLimit,
          members: orderedMembers(memberPlans, visiblePlanId),
        });
        return transactionClient.planBundle.update({
          where: { id: created.id },
          data: { planId },
          select: PLAN_BUNDLE_SELECT,
        });
      });
      return mapPlanBundle(record);
    } catch (error) {
      throw this.translateConflict(error, name);
    }
  }

  public async update(
    id: string,
    input: AdminPlanBundleUpdateDto,
    context?: PlanBundleMutationContext,
  ): Promise<PlanBundleInterface> {
    const existing = await this.prismaService.planBundle.findUnique({
      where: { id },
      select: { id: true, name: true, description: true, planId: true, secondaryPlanId: true },
    });
    if (existing === null) {
      throw new NotFoundException('Plan bundle not found');
    }
    const currentMembers = await this.prismaService.planBundleMember.findMany({
      where: { bundleId: id },
      select: { planId: true, isVisibleInApp: true, trafficLabel: true },
    });
    const planIds = input.planIds === undefined ? null : normalizePlanIds(input.planIds);
    if (planIds !== null) {
      this.assertPlanCount(planIds);
      // A plan may be in one bundle only: two bundles overlapping on a plan
      // would make "which link does this card show" ambiguous.
      await this.assertPlansNotGrouped(planIds, id);
    }
    const memberPlanIds = planIds ?? currentMembers.map((member) => member.planId);
    const memberPlans = await this.loadMemberPlans(memberPlanIds);
    const memberPlanIdsInOrder = memberPlanIds;

    // The captions the member rows must carry after this save. Read from the
    // CURRENT rows because the update path recreates every member (`deleteMany`
    // + `create`): a save that does not mention captions keeps them, so they
    // have to be carried into the new rows by plan id. A plan that left the
    // bundle drops its own; a save that DOES send captions replaces the set.
    const storedTrafficLabels = new Map<string, string>();
    for (const member of currentMembers) {
      if (member.trafficLabel !== null) storedTrafficLabels.set(member.planId, member.trafficLabel);
    }
    const requestedTrafficLabels =
      input.memberTrafficLabels === undefined
        ? null
        : this.requestedMemberTrafficLabels(input.memberTrafficLabels, memberPlanIds);
    const memberTrafficLabels: ReadonlyMap<string, string | null> =
      requestedTrafficLabels ?? keepMemberTrafficLabels(storedTrafficLabels, memberPlanIds);

    const previousVisiblePlanId =
      currentMembers.find((member) => member.isVisibleInApp)?.planId ?? null;
    let visibleToStore: string | null = null;
    if (planIds !== null) {
      if (input.visiblePlanId !== undefined && input.visiblePlanId !== null) {
        visibleToStore = this.requestedVisiblePlanId(input.visiblePlanId, memberPlans);
      } else if (previousVisiblePlanId !== null && planIds.includes(previousVisiblePlanId)) {
        // Keep the operator's earlier choice only while it can still face the
        // app: a member the operator flipped to unlimited must not stay in
        // front, and the read-side resolver would ignore the flag anyway.
        const previous = memberPlans.find((plan) => plan.id === previousVisiblePlanId);
        visibleToStore = previous !== undefined && canFaceMergedLink(previous) ? previous.id : null;
      }
    } else if (input.visiblePlanId !== undefined) {
      visibleToStore =
        input.visiblePlanId === null
          ? null
          : this.requestedVisiblePlanId(input.visiblePlanId, memberPlans);
    }

    const name = input.name?.trim() ?? existing.name;
    const description =
      input.description === undefined ? existing.description : input.description?.trim() || null;
    // The card's second line: an explicit choice wins; a save that does not
    // mention it KEEPS it, but only while the plan is still a member of this
    // bundle (the operator may have just removed it from the list).
    const secondaryPlanId =
      input.secondaryPlanId === undefined
        ? keepSecondaryPlanId(existing.secondaryPlanId, memberPlans)
        : this.requestedSecondaryPlanId(input.secondaryPlanId, memberPlans);
    const previousDeviceLimit = await this.currentDeviceLimit(existing.planId, memberPlans);
    // A save that does not mention the device limit KEEPS it: the field belongs
    // to this dialog, and a rename must not silently reset it to the visible
    // member's own limit.
    const deviceLimit =
      input.deviceLimit ??
      (previousDeviceLimit === null
        ? this.requestedDeviceLimit(undefined, memberPlans, visibleToStore)
        : previousDeviceLimit);

    try {
      const record = await this.prismaService.$transaction(async (transactionClient) => {
        const updated = await transactionClient.planBundle.update({
          where: { id },
          data: {
            name,
            description,
            secondaryPlanId,
            ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
            ...(planIds === null
              ? {}
              : {
                  members: {
                    deleteMany: {},
                    create: planIds.map((planId) => ({
                      planId,
                      isVisibleInApp: planId === visibleToStore,
                      trafficLabel: memberTrafficLabels.get(planId) ?? null,
                    })),
                  },
                }),
          },
          select: { id: true, planId: true },
        });
        // Written without touching the member list — the one-at-a-time rule is
        // enforced by clearing every row before setting the chosen one, so a
        // partial write can never leave two plans facing the app.
        if (planIds === null && input.visiblePlanId !== undefined) {
          await transactionClient.planBundleMember.updateMany({
            where: { bundleId: id },
            data: { isVisibleInApp: false },
          });
          if (visibleToStore !== null) {
            await transactionClient.planBundleMember.update({
              where: { planId: visibleToStore },
              data: { isVisibleInApp: true },
            });
          }
        }
        // Without a member rebuild the rows stay, so the submitted set is
        // written onto them plan by plan. A field that was not sent at all is
        // left alone (`requestedTrafficLabels` is null then); a submitted set
        // is the whole truth, so a plan it does not name loses its caption.
        if (planIds === null && requestedTrafficLabels !== null) {
          for (const planId of memberPlanIds) {
            await transactionClient.planBundleMember.updateMany({
              where: { bundleId: id, planId },
              data: { trafficLabel: memberTrafficLabels.get(planId) ?? null },
            });
          }
        }
        const planId = await this.bundleFacePlanService.syncInTransaction(transactionClient, {
          planId: updated.planId,
          bundleName: name,
          bundleDescription: description,
          deviceLimit,
          // The flag the member rows carry after this save — the writer reads
          // it to decide whose traffic limit and squads the face plan shows.
          members: orderedMembers(
            memberPlans,
            planIds === null
              ? input.visiblePlanId === undefined
                ? previousVisiblePlanId
                : visibleToStore
              : visibleToStore,
          ),
        });
        if (planId !== updated.planId) {
          await transactionClient.planBundle.update({ where: { id }, data: { planId } });
        }
        if (context !== undefined) {
          await transactionClient.adminAuditLog.create({
            data: {
              action: 'plan-bundles.updated',
              ipAddress: context.requestMetadata.remoteAddress,
              userAgent: context.requestMetadata.userAgent,
              metadata: {
                requestId: context.requestMetadata.requestId,
                bundleId: id,
                name,
                planId,
                visiblePlanId: visibleToStore,
                deviceLimit,
                previousDeviceLimit,
              },
              adminUser: { connect: { id: context.currentAdmin.id } },
            },
          });
        }
        return transactionClient.planBundle.findUniqueOrThrow({
          where: { id },
          select: PLAN_BUNDLE_SELECT,
        });
      });
      // A merged subscription is ONE product: its device count must change on
      // the customer's existing profiles too, not only on the next grant.
      // Only customers holding two of this bundle's plans are touched — see
      // `BundleFacePlanService.propagateDeviceLimit`.
      //
      // Skipped when this save CREATES the plan for a grouping that predates
      // it: the default it was given is the visible member's own limit, so
      // nothing the operator chose has changed for existing subscribers.
      if (existing.planId !== null && previousDeviceLimit !== deviceLimit) {
        await this.bundleFacePlanService.propagateDeviceLimit({
          bundleId: id,
          memberPlanIds: memberPlanIdsInOrder,
          deviceLimit,
        });
      }
      return mapPlanBundle(record);
    } catch (error) {
      throw this.translateConflict(error, name);
    }
  }

  /**
   * Removes the grouping AND retires the plan it is issued as. Member rows and
   * every merge link minted for it go with it (`onDelete: Cascade`) — the link
   * existed only to serve the grouping, and a token that still answered would
   * point at plans the operator just said are no longer combined.
   *
   * The plan is SOFT-deleted, never removed: a merged subscription an operator
   * granted keeps resolving its snapshot by id, and the nightly sweeper removes
   * the row once nothing uses it (the contract every deleted plan follows).
   */
  public async delete(id: string, context?: PlanBundleMutationContext): Promise<void> {
    try {
      await this.prismaService.$transaction(async (transactionClient) => {
        const bundle = await transactionClient.planBundle.findUnique({
          where: { id },
          select: { id: true, name: true, planId: true },
        });
        if (bundle === null) {
          throw new NotFoundException('Plan bundle not found');
        }
        if (bundle.planId !== null) {
          await this.bundleFacePlanService.softDeleteInTransaction(transactionClient, bundle.planId);
        }
        await transactionClient.planBundle.delete({ where: { id } });
        if (context !== undefined) {
          await transactionClient.adminAuditLog.create({
            data: {
              action: 'plan-bundles.deleted',
              ipAddress: context.requestMetadata.remoteAddress,
              userAgent: context.requestMetadata.userAgent,
              metadata: {
                requestId: context.requestMetadata.requestId,
                bundleId: id,
                name: bundle.name,
                planId: bundle.planId,
              },
              adminUser: { connect: { id: context.currentAdmin.id } },
            },
          });
        }
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        throw new NotFoundException('Plan bundle not found');
      }
      throw error;
    }
  }

  /**
   * The plan the operator asked to face the app, checked against the member
   * list AND the owner's rule (14.11.2026): an UNLIMITED plan can never face a
   * merged link — the app would report «unlimited» and hide the limit the
   * other half of the bundle still has to show. Empty string reads as "no
   * choice" so a cleared field falls back to the default.
   */
  private requestedVisiblePlanId(
    visiblePlanId: string | null | undefined,
    memberPlans: readonly MemberPlan[],
  ): string | null {
    if (visiblePlanId === undefined || visiblePlanId === null) return null;
    const normalized = visiblePlanId.trim();
    if (normalized.length === 0) return null;
    const selected = memberPlans.find((plan) => plan.id === normalized);
    if (selected === undefined) {
      throw new BadRequestException('visiblePlanId must be one of the bundle plans');
    }
    if (!canFaceMergedLink(selected)) {
      throw new BadRequestException(
        'An unlimited plan cannot be the plan the VPN app shows: the merged link would hide the traffic limit of the other plan',
      );
    }
    return normalized;
  }

  /**
   * The «Трафик доп.» captions a save submits, keyed by member plan id; `null`
   * means "this plan has no caption of its own". An empty label reads as `null`
   * for the same reason an empty field on the page means "no caption": the bot
   * then falls back to its own `profile.traffic_extra` text.
   *
   * A submitted list is the WHOLE set for the bundle (the dialog always sends
   * every input it draws), so a plan it does not name simply ends up without a
   * caption — there is nothing to merge with the stored rows here.
   *
   * A plan that is not a member of THIS bundle is refused: the caption belongs
   * to the merged product, and a stale one would silently never show. The count
   * is capped at `members - 2` — the first two traffic lines of a merged
   * subscription are the main plan and the default «Трафик доп.» row, both
   * captioned by the bot's own texts rather than by a member plan. Since a
   * bundle now links exactly `PLAN_BUNDLE_MAX_PLANS` plans, that allowance is
   * always zero: the path is kept for wire compatibility and refuses any
   * caption, so an old client cannot resurrect a third line.
   */
  private requestedMemberTrafficLabels(
    requested: readonly AdminPlanBundleMemberTrafficLabelDto[] | undefined,
    memberPlanIds: readonly string[],
  ): ReadonlyMap<string, string | null> {
    const labels = new Map<string, string | null>();
    if (requested === undefined) return labels;
    const memberIds = new Set(memberPlanIds);
    for (const entry of requested) {
      const planId = entry.planId.trim();
      if (!memberIds.has(planId)) {
        throw new BadRequestException('memberTrafficLabels planId must be one of the bundle plans');
      }
      const label = entry.label.trim();
      labels.set(planId, label.length === 0 ? null : label);
    }
    const captionCount = [...labels.values()].filter((label) => label !== null).length;
    const captionLimit = Math.max(0, memberPlanIds.length - 2);
    if (captionCount > captionLimit) {
      throw new BadRequestException(
        `A bundle of ${memberPlanIds.length} plans captions at most ${captionLimit} extra traffic lines: the first two are the main plan and the default «Трафик доп.» row`,
      );
    }
    return labels;
  }

  /**
   * The plan whose traffic the CABINET CARD prints on its second line
   * («0.01/50 ГБ»), or `null` for "no second line". Only a LIMITED member can
   * be chosen: an unlimited plan has no used/limit pair to print, and the card
   * already says «Безлимит» on its own traffic row.
   *
   * The choice belongs to this dialog, not to the plan editor: it is a property
   * of the merged product, like the device limit (the owner, 14.11.2026).
   */
  private requestedSecondaryPlanId(
    secondaryPlanId: string | null | undefined,
    memberPlans: readonly SecondaryPlanCandidate[],
  ): string | null {
    if (secondaryPlanId === undefined || secondaryPlanId === null) return null;
    const normalized = secondaryPlanId.trim();
    if (normalized.length === 0) return null;
    const selected = memberPlans.find((plan) => plan.id === normalized);
    if (selected === undefined) {
      throw new BadRequestException('secondaryPlanId must be one of the bundle plans');
    }
    if (selected.trafficLimit === null) {
      throw new BadRequestException(
        'An unlimited plan has no used/limit pair to print, so it cannot be the plan the card shows below its own traffic',
      );
    }
    return normalized;
  }

  /**
   * The device limit of the merged subscription. Omitted on create — the
   * visible member plan's own limit, so an existing grouping that gains a face
   * plan changes nobody's limit by surprise.
   */
  private requestedDeviceLimit(
    requested: number | undefined,
    memberPlans: readonly MemberPlan[],
    visiblePlanId: string | null,
  ): number {
    if (requested !== undefined) return requested;
    const visible =
      memberPlans.find((plan) => plan.id === visiblePlanId) ??
      memberPlans.find((plan) => canFaceMergedLink(plan)) ??
      memberPlans[0];
    // The plans table spells "unlimited devices" as -1 on some plan types; the
    // bundle form's field starts at 0, so the inherited value is floored there
    // and both spellings mean the same to the customer.
    return Math.max(0, visible?.deviceLimit ?? 0);
  }

  private async currentDeviceLimit(
    planId: string | null,
    memberPlans: readonly MemberPlan[],
  ): Promise<number | null> {
    if (planId === null) return null;
    const plan = await this.prismaService.plan.findUnique({
      where: { id: planId },
      select: { deviceLimit: true },
    });
    if (plan !== null) return plan.deviceLimit;
    return memberPlans.find((member) => canFaceMergedLink(member))?.deviceLimit ?? null;
  }

  /**
   * A bundle links EXACTLY two plans. One plan is not a merge — it is the
   * plan's own subscription URL — and a third would need a traffic row and a
   * caption nobody designed (the owner, 14.11.2026).
   */
  private assertPlanCount(planIds: readonly string[]): void {
    if (planIds.length < PLAN_BUNDLE_MIN_PLANS) {
      throw new BadRequestException(
        `A plan bundle needs at least ${PLAN_BUNDLE_MIN_PLANS} plans`,
      );
    }
    if (planIds.length > PLAN_BUNDLE_MAX_PLANS) {
      throw new BadRequestException(
        `A plan bundle links at most ${PLAN_BUNDLE_MAX_PLANS} plans: two halves of one merged link`,
      );
    }
  }

  /**
   * Loads the member plans and rejects any id that does not exist, so the
   * grouping cannot store orphans. Also refuses a plan that is ITSELF the face
   * of another bundle: it carries no config of its own (its squads and traffic
   * come from that other bundle's members), so merging it would produce an
   * empty profile.
   */
  private async loadMemberPlans(planIds: readonly string[]): Promise<readonly MemberPlan[]> {
    const plans = await this.prismaService.plan.findMany({
      where: { id: { in: [...planIds] }, deletedAt: null },
      select: {
        id: true,
        orderIndex: true,
        type: true,
        trafficLimit: true,
        trafficLimitStrategy: true,
        internalSquads: true,
        externalSquad: true,
        deviceLimit: true,
      },
    });
    const foundIds = new Set(plans.map((plan) => plan.id));
    const missing = planIds.filter((planId) => !foundIds.has(planId));
    if (missing.length > 0) {
      throw new BadRequestException(`Unknown plan id(s): ${missing.join(', ')}`);
    }
    const faces = await this.prismaService.planBundle.findMany({
      where: { planId: { in: [...planIds] } },
      select: { name: true, planId: true },
    });
    if (faces.length > 0) {
      const byPlanId = new Map(faces.map((face) => [face.planId, face.name]));
      const described = faces
        .map((face) => `${byPlanId.get(face.planId) ?? face.planId} (is the plan of «${face.name}»)`)
        .join(', ');
      throw new BadRequestException(`A merged plan cannot be a member of another bundle: ${described}`);
    }
    return plans;
  }

  /**
   * A plan belongs to at most one bundle — overlapping groupings would ask one
   * card to offer two different merged links. Named plans, not ids: the operator
   * picked them by name and the refusal has to be readable on the page.
   */
  private async assertPlansNotGrouped(
    planIds: readonly string[],
    exceptBundleId?: string,
  ): Promise<void> {
    const taken = await this.prismaService.planBundleMember.findMany({
      where: {
        planId: { in: [...planIds] },
        ...(exceptBundleId === undefined ? {} : { bundleId: { not: exceptBundleId } }),
      },
      select: { planId: true, bundle: { select: { name: true } } },
    });
    if (taken.length === 0) {
      return;
    }
    const names = await this.prismaService.plan.findMany({
      where: { id: { in: taken.map((member) => member.planId) } },
      select: { id: true, name: true },
    });
    const nameById = new Map(names.map((plan) => [plan.id, plan.name]));
    const described = taken
      .map((member) => {
        const planName = nameById.get(member.planId) ?? member.planId;
        return `${planName} (already in «${member.bundle.name}»)`;
      })
      .join(', ');
    throw new ConflictException(`Plan already grouped: ${described}`);
  }

  /**
   * Two unique indexes can answer a save with P2002 and they mean different
   * things to the operator: the grouping's own name, or the PLAN name the
   * grouping creates. Named as what the operator typed rather than as a
   * generic conflict — the fix differs (rename the bundle, or the plan).
   */
  private translateConflict(error: unknown, bundleName: string): unknown {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
      return error;
    }
    const target = error.meta?.['target'];
    const targetText = Array.isArray(target) ? target.join(',') : String(target ?? '');
    if (targetText.includes('name') && !targetText.includes('bundle')) {
      // The plan's name is the bundle's: a live plan already holds it.
      return new ConflictException(
        `A plan named «${bundleName}» already exists: rename the bundle to give its merged tariff a free name`,
      );
    }
    return new ConflictException('A plan bundle with this name already exists');
  }
}

type MemberPlan = Pick<
  Plan,
  | 'id'
  | 'orderIndex'
  | 'type'
  | 'trafficLimit'
  | 'trafficLimitStrategy'
  | 'internalSquads'
  | 'externalSquad'
  | 'deviceLimit'
>;

/**
 * What picking the card's SECOND traffic line needs from a plan: an id and
 * whether it has a limit. Narrower than `MemberPlan` on purpose — the read side
 * hands over `BundleFaceMemberPlan['plan']` rows, which carry `readonly` arrays
 * that a mutable `MemberPlan` would reject.
 */
type SecondaryPlanCandidate = {
  readonly id: string;
  readonly trafficLimit: number | null;
};

/**
 * Member plans in the shape the face-plan writer reads, with the chosen
 * visible plan flagged. The flag is stored on the member row itself, so the
 * writer cannot be handed a plan id that is not among the members.
 */
function orderedMembers(
  memberPlans: readonly MemberPlan[],
  visiblePlanId: string | null,
): readonly BundleFaceMemberPlan[] {
  return orderBundleMembers(
    memberPlans.map((plan) => ({
      planId: plan.id,
      isVisibleInApp: plan.id === visiblePlanId,
      plan,
    })),
  );
}

function normalizePlanIds(planIds: readonly string[]): string[] {
  return [...new Set(planIds.map((planId) => planId.trim()).filter((planId) => planId.length > 0))];
}

/**
 * The stored second-line plan as the member list can still honour it: a plan the
 * operator just removed from the bundle (or flipped to unlimited) silently loses
 * its place, so a rename can never fail because of a stale choice.
 */
function keepSecondaryPlanId(
  stored: string | null,
  memberPlans: readonly SecondaryPlanCandidate[],
): string | null {
  if (stored === null) return null;
  const selected = memberPlans.find((plan) => plan.id === stored);
  return selected !== undefined && selected.trafficLimit !== null ? stored : null;
}

/**
 * The captions stored for the plans that are still members: the ones a save that
 * does not mention captions (a rename, a device-limit change) must keep. A plan
 * the operator removed from the bundle drops its caption with its row, so it is
 * filtered out here and cannot be written back by the rebuild.
 */
function keepMemberTrafficLabels(
  stored: ReadonlyMap<string, string>,
  memberPlanIds: readonly string[],
): ReadonlyMap<string, string> {
  const kept = new Map<string, string>();
  for (const planId of memberPlanIds) {
    const label = stored.get(planId);
    if (label !== undefined) kept.set(planId, label);
  }
  return kept;
}

function mapPlanBundle(record: PlanBundleRecord): PlanBundleInterface {
  const members = orderBundleMembers(record.members);
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    isActive: record.isActive,
    orderIndex: record.orderIndex,
    planIds: members.map((member) => member.planId),
    planId: record.plan?.id ?? null,
    deviceLimit: record.plan?.deviceLimit ?? null,
    visiblePlanId: resolveVisiblePlanId(members),
    secondaryPlanId: keepSecondaryPlanId(
      record.secondaryPlanId,
      members.map((member) => member.plan),
    ),
    // Only the plans that HAVE their own caption: an absent one means "the
    // bot's default text", which the page already knows.
    memberTrafficLabels: members.flatMap((member) =>
      member.trafficLabel === null ? [] : [{ planId: member.planId, label: member.trafficLabel }],
    ),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}
