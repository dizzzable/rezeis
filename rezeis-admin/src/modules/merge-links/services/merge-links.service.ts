import { randomBytes } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { Prisma, SubscriptionStatus } from '@prisma/client';

import { mergeLinksConfig } from '../../../common/config/merge-links.config';
import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  MergeLinkGroupInterface,
  MergeLinkSourcesInterface,
  MergeLinkSourceInterface,
} from '../interfaces/plan-bundle.interface';
import { resolveVisiblePlanId } from '../utils/visible-plan.util';

/** 24 random bytes → 32 URL-safe characters. Same order of entropy as an API token. */
const MERGE_TOKEN_BYTES = 24;

/**
 * What counts as a live profile for a merged link: a subscription the panel is
 * still serving. `LIMITED` is a subscription that ran out of traffic — the
 * customer tops it up and it works again, so it stays in the merge (the panel
 * shows 0 GB next to it). `EXPIRED` is over by date and `DELETED` is gone; both
 * leave the link alone.
 *
 * Traffic is deliberately NOT part of the test, which is the whole point: a
 * bundle of an unlimited plan and a limited one keeps merging when the limited
 * half is spent, instead of silently dropping it from the config.
 */
const LIVE_SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] = [
  SubscriptionStatus.ACTIVE,
  SubscriptionStatus.LIMITED,
];

/**
 * Turns a plan grouping into one `/merge/<token>` link per customer, and answers
 * the merging service's question of which profiles a token stands for.
 *
 * Business truth lives here and is never mirrored: `remnawave-subscription-merge`
 * asks over HTTP on cache miss, so a renewed, replaced or deleted profile changes
 * the merged link on the next refresh without a synchronisation job.
 */
@Injectable()
export class MergeLinksService {
  private readonly logger = new Logger(MergeLinksService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    @Inject(mergeLinksConfig.KEY)
    private readonly config: ConfigType<typeof mergeLinksConfig>,
  ) {}

  /**
   * planId → merged URL for ONE customer, given the plans their live
   * subscriptions name.
   *
   * A bundle qualifies only when the customer holds at least two of its plans
   * (counting two subscriptions on the same plan as two — that is still two
   * profiles to merge). Every qualifying bundle is represented by the same URL on
   * EVERY one of its cards, which is what "one link that looks like one plan"
   * means to the customer; plans the customer does not hold are left out of the
   * map so their cards keep the panel's own URL.
   *
   * Empty map when the feature is off, when nothing qualifies, or when a link
   * was revoked — the caller then serves the panel's URL, which always works.
   */
  public async mergedUrlsByPlan(
    userId: string,
    planIds: readonly (string | null)[],
  ): Promise<ReadonlyMap<string, string>> {
    const groups = await this.mergedGroupsByPlan(userId, planIds);
    const urlByPlan = new Map<string, string>();
    for (const [planId, group] of groups) urlByPlan.set(planId, group.url);
    return urlByPlan;
  }

  /**
   * The same answer, plus what the cabinet and the bot need to draw ONE block
   * for a grouped set of subscriptions: which bundle it is and which of its
   * plans the app must show.
   *
   * `visiblePlanId` is resolved among the plans the CUSTOMER holds, not the
   * bundle's whole member list: the merged link faces a plan this customer
   * actually has, so the app never names a plan they never bought.
   */
  public async mergedGroupsByPlan(
    userId: string,
    planIds: readonly (string | null)[],
  ): Promise<ReadonlyMap<string, MergeLinkGroupInterface>> {
    const baseUrl = this.config.baseUrl;
    const livePlanIds = planIds.filter((planId): planId is string => planId !== null);
    if (baseUrl === null || livePlanIds.length < 2) {
      return new Map();
    }
    const held = new Set(livePlanIds);

    const bundles = await this.prismaService.planBundle.findMany({
      where: { isActive: true },
      select: {
        id: true,
        name: true,
        // The plan whose traffic the cabinet card prints on its second line.
        // Resolved against the plans this customer holds below.
        secondaryPlanId: true,
        // The plan the grouping is sold and renewed as: its durations decide
        // whether one payment can price the whole set (`renewalAsOneProduct`).
        plan: { select: { durations: { select: { days: true }, take: 1 } } },
        members: {
          select: {
            planId: true,
            isVisibleInApp: true,
            // The operator's own caption for this plan's extra traffic line, if
            // the bundle card set one.
            trafficLabel: true,
            plan: { select: { orderIndex: true, trafficLimit: true } },
          },
        },
      },
    });
    const qualifying = bundles
      .map((bundle) => ({
        bundle,
        heldMembers: [...bundle.members]
          .sort((left, right) => left.plan.orderIndex - right.plan.orderIndex)
          .filter((member) => held.has(member.planId)),
      }))
      // Counts the customer's subscriptions, not distinct plans: two profiles on
      // one plan are still two profiles to merge into one link.
      .filter(({ heldMembers }) => heldMembers.length >= 2);
    if (qualifying.length === 0) {
      return new Map();
    }

    const existingLinks = await this.prismaService.subscriptionMergeLink.findMany({
      where: { userId, bundleId: { in: qualifying.map(({ bundle }) => bundle.id) } },
      select: { bundleId: true, token: true, revokedAt: true },
    });
    const linkByBundle = new Map(existingLinks.map((link) => [link.bundleId, link]));

    const groupByPlan = new Map<string, MergeLinkGroupInterface>();
    for (const { bundle, heldMembers } of qualifying) {
      const token = await this.resolveToken(userId, bundle.id, linkByBundle.get(bundle.id));
      if (token === null) {
        continue;
      }
      // Captions for the plans this customer HOLDS: a caption of a plan they do
      // not have would name a line the greeting never draws. A plan without one
      // stays out of the map, and the bot falls back to `profile.traffic_extra`.
      const trafficLabelByPlanId: Record<string, string> = {};
      for (const member of heldMembers) {
        if (member.trafficLabel !== null) trafficLabelByPlanId[member.planId] = member.trafficLabel;
      }
      const group: MergeLinkGroupInterface = {
        bundleId: bundle.id,
        bundleName: bundle.name,
        visiblePlanId: resolveVisiblePlanId(heldMembers),
        // Only a plan the customer actually holds: the card must never print
        // the traffic of a subscription that is not his.
        secondaryPlanId:
          bundle.secondaryPlanId !== null &&
          heldMembers.some((member) => member.planId === bundle.secondaryPlanId)
            ? bundle.secondaryPlanId
            : null,
        renewalAsOneProduct: (bundle.plan?.durations.length ?? 0) > 0,
        trafficLabelByPlanId,
        url: `${baseUrl}/${token}`,
      };
      for (const member of heldMembers) groupByPlan.set(member.planId, group);
    }
    return groupByPlan;
  }

  /**
   * Which profiles does this token stand for? `null` = "not a merge link", which
   * the internal endpoint answers as 404.
   *
   * Answered from live subscriptions only, and only for a bundle that is still
   * active and a link that was not revoked — switching a bundle off is the
   * operator's way to retire a link without deleting the rows.
   *
   * Order matters: the merging service reads `profile-title` and the traffic
   * counters off the FIRST source that answered, so the plan the operator put in
   * front (or the bundle's default — its first limited plan) leads the list.
   */
  public async resolveSources(token: string): Promise<MergeLinkSourcesInterface | null> {
    if (this.config.baseUrl === null || token.length === 0) {
      return null;
    }
    const link = await this.prismaService.subscriptionMergeLink.findUnique({
      where: { token },
      select: {
        revokedAt: true,
        userId: true,
        bundle: {
          select: {
            name: true,
            isActive: true,
            members: {
              select: {
                planId: true,
                isVisibleInApp: true,
                plan: { select: { orderIndex: true, trafficLimit: true } },
              },
            },
          },
        },
      },
    });
    if (link === null || link.revokedAt !== null || !link.bundle.isActive) {
      return null;
    }

    const orderedMembers = [...link.bundle.members].sort(
      (left, right) => left.plan.orderIndex - right.plan.orderIndex,
    );
    const memberPlanIds = new Set(orderedMembers.map((member) => member.planId));
    const visiblePlanId = resolveVisiblePlanId(orderedMembers);
    const memberOrder = new Map(orderedMembers.map((member, index) => [member.planId, index]));
    const subscriptions = await this.prismaService.subscription.findMany({
      where: {
        userId: link.userId,
        status: { in: [...LIVE_SUBSCRIPTION_STATUSES] },
      },
      orderBy: [{ createdAt: 'asc' }],
      select: { configUrl: true, planSnapshot: true },
    });

    const seenUrls = new Set<string>();
    const collected: Array<MergeLinkSourceInterface & { readonly planId: string }> = [];
    for (const subscription of subscriptions) {
      const url = subscription.configUrl?.trim() ?? '';
      const planId = readPlanSnapshotId(subscription.planSnapshot);
      if (url.length === 0 || planId === null || !memberPlanIds.has(planId)) {
        continue;
      }
      // Two subscriptions can name the same panel profile after a repair; the
      // merged config must not carry the same nodes twice.
      if (seenUrls.has(url)) {
        continue;
      }
      seenUrls.add(url);
      collected.push({
        url,
        label: readPlanSnapshotName(subscription.planSnapshot) ?? '',
        planId,
      });
    }
    if (collected.length < 2) {
      // One profile is not a merge; the panel's own URL is the right answer there,
      // and the merging service treats a shorter list as unserviceable anyway.
      return null;
    }
    collected.sort((left, right) => {
      const visibleFirst = Number(left.planId !== visiblePlanId) - Number(right.planId !== visiblePlanId);
      if (visibleFirst !== 0) return visibleFirst;
      return (memberOrder.get(left.planId) ?? 0) - (memberOrder.get(right.planId) ?? 0);
    });
    return {
      label: link.bundle.name,
      sources: collected.map(({ url, label }) => ({ url, label })),
    };
  }

  /**
   * The customer's token for this bundle: an existing live one, a fresh one, or
   * `null` when the existing one was revoked — a revocation is an operator's
   * decision and must not be undone by the next page load.
   */
  private async resolveToken(
    userId: string,
    bundleId: string,
    known:
      | { readonly token: string; readonly revokedAt: Date | null }
      | undefined,
  ): Promise<string | null> {
    if (known !== undefined) {
      return known.revokedAt === null ? known.token : null;
    }
    try {
      const created = await this.prismaService.subscriptionMergeLink.create({
        data: { token: randomBytes(MERGE_TOKEN_BYTES).toString('base64url'), userId, bundleId },
        select: { token: true },
      });
      return created.token;
    } catch (error) {
      // Two cabinets asking at once both saw "no link": the second insert loses
      // on the (user, bundle) unique index and reads the winner's token instead
      // of minting a second one.
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
        throw error;
      }
      const existing = await this.prismaService.subscriptionMergeLink.findUnique({
        where: { userId_bundleId: { userId, bundleId } },
        select: { token: true, revokedAt: true },
      });
      if (existing === null || existing.revokedAt !== null) {
        this.logger.warn(
          `Merge link for user ${userId} and bundle ${bundleId} could not be read after a conflict`,
        );
        return null;
      }
      return existing.token;
    }
  }
}

function readPlanSnapshotId(planSnapshot: Prisma.JsonValue): string | null {
  return readSnapshotString(planSnapshot, 'id');
}

function readPlanSnapshotName(planSnapshot: Prisma.JsonValue): string | null {
  return readSnapshotString(planSnapshot, 'name');
}

function readSnapshotString(planSnapshot: Prisma.JsonValue, propertyName: string): string | null {
  if (typeof planSnapshot !== 'object' || planSnapshot === null || Array.isArray(planSnapshot)) {
    return null;
  }
  const value = (planSnapshot as Prisma.JsonObject)[propertyName];
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }
  return value;
}
