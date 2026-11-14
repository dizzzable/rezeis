import { Injectable, NotFoundException, Optional } from '@nestjs/common';
import {
  PlanAvailability,
  PlanType,
  Prisma,
  SubscriptionStatus,
  TrafficLimitStrategy,
} from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { ProfileSyncQueueService } from '../../profile-sync/profile-sync-queue.service';
import { resolveVisibleMember } from '../../merge-links/utils/visible-plan.util';
import { compactLivePlanOrder, releasePlanNameFromDeletedPlan } from '../utils/plan-deletion.util';

/** The job payload marks a sync as caused by a bundle's device limit, for the logs. */
export const BUNDLE_DEVICE_LIMIT_SYNC_SOURCE = 'BUNDLE_DEVICE_LIMIT';

/** One member plan of a bundle, with everything the face plan copies from it. */
export interface BundleFaceMemberPlan {
  readonly planId: string;
  readonly isVisibleInApp: boolean;
  readonly plan: {
    readonly id: string;
    readonly orderIndex: number;
    readonly type: PlanType;
    readonly trafficLimit: number | null;
    readonly trafficLimitStrategy: TrafficLimitStrategy;
    readonly internalSquads: readonly string[];
    readonly externalSquad: string | null;
    readonly deviceLimit: number;
  };
}

/** Where the members of one bundle come from — the bundle select every caller shares. */
export const BUNDLE_FACE_MEMBERS_SELECT = {
  select: {
    planId: true,
    isVisibleInApp: true,
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

export interface BundleFacePlanSyncInput {
  readonly bundleName: string;
  readonly bundleDescription: string | null;
  /** The device limit the operator set on the bundle dialog. */
  readonly deviceLimit: number;
  readonly members: readonly BundleFaceMemberPlan[];
}

/** Fields a bundle OWNS on its plan row — the plan editor cannot change them. */
export interface BundleFaceWriteData {
  readonly bundleId: string;
  readonly memberPlanIds: readonly string[];
  readonly data: Prisma.PlanUncheckedUpdateInput;
}

/**
 * The `Plan` row a bundle is issued as — «объединённая подписка».
 *
 * The owner's decision (14.11.2026): a bundle must stop being a mere grouping and
 * become a tariff too, so it can be granted from the user card as one product
 * with one device limit. The row created here is an ordinary plan: it has a
 * name (the bundle's), a description, prices, durations and a device limit, and
 * it appears in the plans list like any other row.
 *
 * ── What the plan editor does NOT own ────────────────────────────────────────
 *
 * Type, traffic limit and Remnawave squads belong to the MEMBER plans — the
 * profiles the customer receives are theirs, so a face plan carrying its own
 * squads would describe a config nobody has. They are copied from the bundle's
 * visible member on every bundle save and re-derived on every plan save, which
 * is why the editor does not render those fields for a face plan.
 *
 * ── The face plan IS the tariff the customer buys ────────────────────────────
 *
 * The owner's decision (14.11.2026, second half): the merged plan must be sold
 * like any other — one card in the shop, one price, one «Продлить». So the row
 * goes into the catalogue like an ordinary plan (`hiddenFromBuyer` follows the
 * operator's own switch, and the catalogue no longer filters face plans out),
 * and the checkout is what knows how to fulfil it: one payment mints one
 * subscription per member plan, and a renewal of any of them extends the whole
 * set (`bundle-snapshot.util.ts` documents the marker that says so).
 *
 * `virtual` selling is NOT this row's price list bolted onto the members: the
 * operator sets durations and prices HERE, once, and every member profile is
 * covered by that one payment.
 */
@Injectable()
export class BundleFacePlanService {
  public constructor(
    private readonly prismaService: PrismaService,
    /**
     * Creates and enqueues the `ProfileSyncJob` of every subscription a device
     * limit change touches. `@Optional()` for the unit specs that build this by
     * hand: without it the change is still written, and the 5-minute sweep sends
     * the rows that stayed PENDING.
     */
    @Optional() private readonly profileSyncQueueService?: ProfileSyncQueueService,
  ) {}

  /**
   * Creates the face plan of a NEW bundle, inside the caller's transaction.
   * The name is the bundle's own — releasing a soft-deleted plan that still
   * holds it, exactly as the plan editor does, so a bundle can be re-created
   * under a name an operator once deleted.
   */
  public async createInTransaction(
    transactionClient: Prisma.TransactionClient,
    input: BundleFacePlanSyncInput,
  ): Promise<string> {
    const visible = this.requireVisibleMember(input.members);
    const nameHolder = await transactionClient.plan.findFirst({
      where: { name: input.bundleName, deletedAt: { not: null } },
      select: { id: true, name: true },
    });
    if (nameHolder !== null) {
      await releasePlanNameFromDeletedPlan(transactionClient, nameHolder);
    }
    const lastPlan = await transactionClient.plan.findFirst({
      where: { deletedAt: null },
      orderBy: { orderIndex: 'desc' },
      select: { orderIndex: true },
    });
    const created = await transactionClient.plan.create({
      data: {
        ...this.faceData(input, visible),
        orderIndex: (lastPlan?.orderIndex ?? 0) + 1,
      },
      select: { id: true },
    });
    return created.id;
  }

  /**
   * Re-derives the face plan of an EXISTING bundle, inside the caller's
   * transaction: creates it for a grouping that predates this release, or
   * rewrites the fields the bundle owns. Returns the plan id.
   */
  public async syncInTransaction(
    transactionClient: Prisma.TransactionClient,
    input: BundleFacePlanSyncInput & { readonly planId: string | null },
  ): Promise<string> {
    if (input.planId === null) {
      return this.createInTransaction(transactionClient, input);
    }
    const visible = this.requireVisibleMember(input.members);
    await transactionClient.plan.update({
      where: { id: input.planId },
      data: this.faceData(input, visible),
    });
    return input.planId;
  }

  /**
   * The fields a bundle owns on its plan, re-derived from the CURRENT members.
   * `null` when the plan is not a bundle's face (or its bundle is gone), which
   * is how `PlansAdminService` knows an ordinary save needs no override.
   *
   * `deviceLimit` is deliberately NOT in `data`: it belongs to the bundle CARD
   * («Объединённые тарифы»), not to the plan editor (the owner, 14.11.2026:
   * «оставим только в карточке»). `PlanBundlesService` writes it through
   * `faceData` on every bundle save, and `PlansAdminService.updatePlan` drops
   * whatever a plan patch carries so the row cannot be moved from two places.
   */
  public async deriveFaceWriteData(
    transactionClient: Prisma.TransactionClient,
    planId: string,
  ): Promise<BundleFaceWriteData | null> {
    const bundle = await transactionClient.planBundle.findUnique({
      where: { planId },
      select: {
        id: true,
        name: true,
        description: true,
        members: BUNDLE_FACE_MEMBERS_SELECT,
      },
    });
    if (bundle === null) return null;
    const visible = resolveVisibleMember(bundle.members);
    if (visible === null) {
      // A face plan whose bundle has lost every member cannot describe anything
      // real. Refusing beats writing a plan with no squads and no limit.
      throw new NotFoundException('The plan bundle has no member plans');
    }
    return {
      bundleId: bundle.id,
      memberPlanIds: bundle.members.map((member) => member.planId),
      data: {
        name: bundle.name,
        description: bundle.description,
        type: PlanType.BOTH,
        // Availability belongs to the SALE, not to the editor: a merged plan is
        // bought by anybody holding a slot, and a face plan flagged TRIAL would
        // send a merged purchase into the paid-trial claim path, which mints
        // one subscription and counts one claim. ALL is the only value the
        // checkout knows how to fulfil, and the row is rewritten to it on every
        // bundle save and every plan save.
        availability: PlanAvailability.ALL,
        trafficLimit: visible.plan.trafficLimit,
        trafficLimitStrategy: visible.plan.trafficLimitStrategy,
        internalSquads: [...visible.plan.internalSquads],
        externalSquad: visible.plan.externalSquad,
      },
    };
  }

  /**
   * Carries a bundle's device limit to the subscriptions it already covers.
   *
   * The owner asked for exactly this (14.11.2026): setting the limit in the
   * bundle CARD must change the limit of the customer's two existing profiles,
   * not only of the ones issued after the edit — and the card is the only place
   * the limit is set, so this fan-out is its whole reach. A plan edit normally
   * reaches existing subscribers at renewal; a merged subscription is ONE
   * product, so its two halves cannot be allowed to disagree about the device
   * count.
   *
   * Which subscriptions: live (not DELETED) rows on any member plan, for users
   * who hold at least TWO of this bundle's plans — the same condition the merge
   * itself uses. A customer who owns only one half of the bundle is not part of
   * a merged subscription and keeps that plan's own limit.
   */
  public async propagateDeviceLimit(input: {
    readonly bundleId: string;
    readonly memberPlanIds: readonly string[];
    readonly deviceLimit: number;
  }): Promise<{ readonly subscriptionsUpdated: number; readonly syncJobsEnqueued: number }> {
    if (input.memberPlanIds.length === 0) {
      return { subscriptionsUpdated: 0, syncJobsEnqueued: 0 };
    }
    const planFilters = input.memberPlanIds.flatMap((planId) => [
      { planSnapshot: { path: ['id'], equals: planId } },
      { planSnapshot: { path: ['planId'], equals: planId } },
    ]);
    const rows = await this.prismaService.subscription.findMany({
      where: {
        status: { not: SubscriptionStatus.DELETED },
        OR: planFilters,
      },
      select: { id: true, userId: true, deviceLimit: true },
    });
    const byUser = new Map<string, typeof rows>();
    for (const row of rows) {
      const held = byUser.get(row.userId);
      if (held === undefined) {
        byUser.set(row.userId, [row]);
      } else {
        held.push(row);
      }
    }
    const targets: typeof rows = [];
    for (const held of byUser.values()) {
      if (held.length < 2) continue;
      for (const row of held) {
        if (row.deviceLimit !== input.deviceLimit) targets.push(row);
      }
    }
    if (targets.length === 0) {
      return { subscriptionsUpdated: 0, syncJobsEnqueued: 0 };
    }
    await this.prismaService.subscription.updateMany({
      where: { id: { in: targets.map((row) => row.id) } },
      data: { deviceLimit: input.deviceLimit },
    });
    // Created and enqueued AFTER the write: `enqueueSubscriptionSync` reads the
    // row it is about, and a job id must never name an uncommitted change.
    let syncJobsEnqueued = 0;
    const queue = this.profileSyncQueueService;
    if (queue !== undefined) {
      for (const row of targets) {
        await queue.enqueueSubscriptionSync(row.id, {
          source: BUNDLE_DEVICE_LIMIT_SYNC_SOURCE,
          bundleId: input.bundleId,
        });
        syncJobsEnqueued += 1;
      }
    }
    return { subscriptionsUpdated: targets.length, syncJobsEnqueued };
  }

  /**
   * Retires a face plan with its bundle. Soft-deleted, never removed: the plan
   * row is what a granted subscription's snapshot still resolves by id, and the
   * nightly sweeper removes it once nothing uses it (the same contract every
   * deleted plan follows).
   */
  public async softDeleteInTransaction(
    transactionClient: Prisma.TransactionClient,
    planId: string,
  ): Promise<void> {
    const plan = await transactionClient.plan.findUnique({
      where: { id: planId },
      select: { isActive: true, isArchived: true, deletedAt: true },
    });
    if (plan === null || plan.deletedAt !== null) return;
    await transactionClient.plan.update({
      where: { id: planId },
      data: {
        deletedAt: new Date(),
        deletedWhileOnSale: plan.isActive && !plan.isArchived,
        isArchived: true,
        isActive: false,
      },
    });
    await compactLivePlanOrder(transactionClient);
  }

  private faceData(
    input: BundleFacePlanSyncInput,
    visible: BundleFaceMemberPlan,
  ): {
    readonly name: string;
    readonly description: string | null;
    readonly type: PlanType;
    readonly availability: PlanAvailability;
    readonly isActive: boolean;
    readonly isArchived: boolean;
    readonly hiddenFromBuyer: boolean;
    readonly trafficLimit: number | null;
    readonly trafficLimitStrategy: TrafficLimitStrategy;
    readonly internalSquads: string[];
    readonly externalSquad: string | null;
    readonly deviceLimit: number;
  } {
    return {
      name: input.bundleName,
      description: input.bundleDescription,
      type: PlanType.BOTH,
      availability: PlanAvailability.ALL,
      isActive: true,
      isArchived: false,
      // Sold like any plan. The operator's own «Скрыть от покупателя» switch
      // still works on this row afterwards — the bundle save above does not
      // touch it, and this value only seeds a NEW row.
      hiddenFromBuyer: false,
      trafficLimit: visible.plan.trafficLimit,
      trafficLimitStrategy: visible.plan.trafficLimitStrategy,
      internalSquads: [...visible.plan.internalSquads],
      externalSquad: visible.plan.externalSquad,
      deviceLimit: input.deviceLimit,
    };
  }

  private requireVisibleMember(
    members: readonly BundleFaceMemberPlan[],
  ): BundleFaceMemberPlan {
    const visible = resolveVisibleMember(members);
    if (visible === null) {
      throw new NotFoundException('The plan bundle has no member plans');
    }
    return visible;
  }
}
