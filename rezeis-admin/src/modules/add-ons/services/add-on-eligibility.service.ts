import { Injectable, NotFoundException } from '@nestjs/common';
import {
  AddOnLifetime,
  AddOnType,
  SubscriptionStatus,
  SubscriptionTermStatus,
  TrafficLimitStrategy,
} from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { readJsonObject } from '../../../common/utils/read-json-object.util';
import { resolveResetCapabilities } from '../../add-on-entitlements/add-on-rollout.config';
import { deriveCutoverBaseline } from '../../add-on-entitlements/domain/cutover-baseline';
import {
  ResetCapabilityMap,
  getResetCapability,
  planResetEpoch,
} from '../../add-on-entitlements/domain/reset-cycle-policy';

export type AddOnActivation = 'NOW' | 'TERM_START';

export interface AddOnEligibilityInfo {
  readonly eligible: true;
  readonly activation: AddOnActivation;
  readonly expiresAt: string;
  readonly explanationCode: string;
}

export interface EligibleAddOn {
  readonly id: string;
  readonly revision: number;
  readonly name: string;
  readonly description: string | null;
  readonly type: AddOnType;
  readonly icon: string | null;
  readonly value: number;
  readonly lifetime: AddOnLifetime;
  readonly eligibility: AddOnEligibilityInfo;
  readonly prices: ReadonlyArray<{ readonly currency: string; readonly price: string }>;
}

export interface AddOnEligibilityResult {
  readonly contractVersion: 2;
  readonly availability: 'AVAILABLE' | 'EMPTY';
  readonly target: { readonly subscriptionId: string; readonly termId: string; readonly planId: string } | null;
  readonly addOns: readonly EligibleAddOn[];
}

const EMPTY_RESULT = (): AddOnEligibilityResult => ({
  contractVersion: 2,
  availability: 'EMPTY',
  target: null,
  addOns: [],
});

/**
 * Subscription/term-specific add-on eligibility (contract v2).
 *
 * Eligibility is computed against the subscription's authoritative baseline
 * term (canonical `null` = unlimited), NOT the plan alone:
 *  - EXTRA_TRAFFIC is eligible only for a finite traffic baseline.
 *  - EXTRA_DEVICES is eligible only for a finite device baseline (this closes
 *    the legacy footgun where a device add-on turned an unlimited profile
 *    finite).
 *  - `UNTIL_SUBSCRIPTION_END` expires at the term end (requires a term end).
 *  - `UNTIL_NEXT_RESET` expires at the next reset epoch and is only offered
 *    when the strategy has a boundary AND its reset capability is ENABLED
 *    (disabled until staging parity, so such add-ons are withheld for now).
 *
 * Only eligible add-ons are returned; ineligible ones are withheld. This
 * endpoint is authoritative for discovery but never for money — checkout
 * re-validates and prices server-side.
 *
 * Baseline resolution prefers the subscription's ACTIVE durable term. When no
 * term exists yet (pre-cutover; rollout flags default OFF) it falls back to a
 * synthetic baseline derived server-side from the subscription's OWN columns +
 * planSnapshot via the same pure {@link deriveCutoverBaseline} the cutover uses
 * (with `resetAnchorAt = startsAt`). This keeps discovery authoritative and
 * drift-free: it matches the term the cutover WOULD create and keys off the
 * same `planSnapshot.id` that checkout validates against — never the client's
 * cached plan snapshot.
 */
@Injectable()
export class AddOnEligibilityService {
  public constructor(private readonly prismaService: PrismaService) {}

  public async listForSubscription(
    subscriptionId: string,
    owner?: { readonly userId?: string; readonly telegramId?: string },
  ): Promise<AddOnEligibilityResult> {
    const subscription = await this.prismaService.subscription.findUnique({
      where: { id: subscriptionId },
      select: {
        id: true,
        userId: true,
        status: true,
        trafficLimit: true,
        deviceLimit: true,
        expiresAt: true,
        createdAt: true,
        planSnapshot: true,
      },
    });
    if (subscription === null) {
      throw new NotFoundException('Subscription not found');
    }

    // Ownership scoping: when a caller identity is supplied (the reiwa cabinet
    // discovery path), the subscription MUST belong to that user — otherwise a
    // 404 (never leak another user's eligibility / plan / expiry). Trusted
    // in-process callers that have already resolved ownership (e.g. renewal
    // pricing) omit `owner` and skip this check. Mirrors the add-on checkout
    // ownership gate exactly.
    if (owner !== undefined) {
      const ownerUserId = await this.resolveOwnerUserId(owner);
      if (subscription.userId !== ownerUserId) {
        throw new NotFoundException('Subscription not found');
      }
    }
    if (
      subscription.status !== SubscriptionStatus.ACTIVE &&
      subscription.status !== SubscriptionStatus.LIMITED
    ) {
      return EMPTY_RESULT();
    }

    const term = await this.prismaService.subscriptionTerm.findFirst({
      where: { subscriptionId, status: SubscriptionTermStatus.ACTIVE },
      select: {
        id: true,
        planId: true,
        endsAt: true,
        baseTrafficLimitBytes: true,
        baseDeviceLimit: true,
        trafficResetStrategy: true,
        resetAnchorAt: true,
      },
    });

    // Prefer the ACTIVE durable term; otherwise derive a synthetic baseline
    // from the subscription's own columns (still server-side, no client drift).
    const resolved =
      term === null
        ? this.deriveFallbackBaseline(subscription)
        : {
            termId: term.id,
            planId: term.planId ?? '',
            baseline: {
              endsAt: term.endsAt,
              baseTrafficLimitBytes: term.baseTrafficLimitBytes,
              baseDeviceLimit: term.baseDeviceLimit,
              trafficResetStrategy: term.trafficResetStrategy,
              resetAnchorAt: term.resetAnchorAt,
            },
          };

    const catalog = await this.prismaService.addOn.findMany({
      where: { isActive: true, archivedAt: null },
      include: { prices: true },
      orderBy: [{ orderIndex: 'asc' }],
    });

    const capabilities = this.getResetCapabilities();
    const now = new Date();

    const addOns: EligibleAddOn[] = [];
    for (const addOn of catalog) {
      const appliesToPlan =
        addOn.applicablePlanIds.length === 0 ||
        addOn.applicablePlanIds.includes(resolved.planId);
      if (!appliesToPlan) continue;

      const eligibility = this.evaluate(
        addOn.type,
        addOn.lifetime,
        resolved.baseline,
        capabilities,
        now,
      );
      if (eligibility === null) continue;

      addOns.push({
        id: addOn.id,
        revision: addOn.revision,
        name: addOn.name,
        description: addOn.description,
        type: addOn.type,
        icon: addOn.icon,
        value: addOn.value,
        lifetime: addOn.lifetime,
        eligibility,
        prices: addOn.prices.map((p) => ({ currency: p.currency, price: p.price.toString() })),
      });
    }

    return {
      contractVersion: 2,
      availability: addOns.length > 0 ? 'AVAILABLE' : 'EMPTY',
      target: { subscriptionId, termId: resolved.termId, planId: resolved.planId },
      addOns,
    };
  }

  /**
   * Resolves the canonical owner userId from a reiwa_id or a Telegram id
   * (mirrors the add-on checkout resolution). Any failure to resolve maps to a
   * 404 on the caller side rather than leaking whether the id/subscription
   * exists.
   */
  private async resolveOwnerUserId(owner: {
    readonly userId?: string;
    readonly telegramId?: string;
  }): Promise<string> {
    if (typeof owner.userId === 'string' && owner.userId.length > 0) {
      return owner.userId;
    }
    if (typeof owner.telegramId === 'string' && owner.telegramId.length > 0) {
      // A non-numeric telegramId would make BigInt() throw a raw 500; treat any
      // unresolvable identity as a 404 (never leak, never crash).
      if (!/^\d+$/.test(owner.telegramId)) {
        throw new NotFoundException('Subscription not found');
      }
      const user = await this.prismaService.user.findFirst({
        where: { telegramId: BigInt(owner.telegramId) },
        select: { id: true },
      });
      if (user === null) {
        throw new NotFoundException('Subscription not found');
      }
      return user.id;
    }
    throw new NotFoundException('Subscription not found');
  }

  /**
   * No-term fallback: synthesize the authoritative baseline from the
   * subscription's own columns + planSnapshot. Uses the exact same pure
   * derivation as the grandfather cutover (`resetAnchorAt = startsAt`), so the
   * discovered eligibility matches the term the cutover would eventually create
   * and the `planId` matches the `planSnapshot.id` checkout validates against.
   * `termId` is `''` (sentinel) — nothing reads it for logic and the v2 Zod
   * contract accepts an empty string.
   */
  private deriveFallbackBaseline(subscription: {
    readonly trafficLimit: number | null;
    readonly deviceLimit: number;
    readonly expiresAt: Date | null;
    readonly createdAt: Date;
    readonly planSnapshot: unknown;
  }): {
    readonly termId: string;
    readonly planId: string;
    readonly baseline: {
      readonly endsAt: Date | null;
      readonly baseTrafficLimitBytes: bigint | null;
      readonly baseDeviceLimit: number | null;
      readonly trafficResetStrategy: TrafficLimitStrategy;
      readonly resetAnchorAt: Date | null;
    };
  } {
    const snapshot = readJsonObject(subscription.planSnapshot);
    const strategy =
      typeof snapshot['trafficLimitStrategy'] === 'string'
        ? (snapshot['trafficLimitStrategy'] as string)
        : null;
    const planId = typeof snapshot['id'] === 'string' ? (snapshot['id'] as string) : '';

    const baseline = deriveCutoverBaseline({
      trafficLimit: subscription.trafficLimit,
      deviceLimit: subscription.deviceLimit,
      trafficLimitStrategy: strategy,
      createdAt: subscription.createdAt,
      expiresAt: subscription.expiresAt,
    });

    return {
      termId: '',
      planId,
      baseline: {
        endsAt: baseline.endsAt,
        baseTrafficLimitBytes: baseline.baseTrafficLimitBytes,
        baseDeviceLimit: baseline.baseDeviceLimit,
        trafficResetStrategy: baseline.trafficResetStrategy,
        resetAnchorAt: baseline.startsAt,
      },
    };
  }

  private evaluate(
    type: AddOnType,
    lifetime: AddOnLifetime,
    term: {
      readonly endsAt: Date | null;
      readonly baseTrafficLimitBytes: bigint | null;
      readonly baseDeviceLimit: number | null;
      readonly trafficResetStrategy: TrafficLimitStrategy;
      readonly resetAnchorAt: Date | null;
    },
    capabilities: ResetCapabilityMap,
    now: Date,
  ): AddOnEligibilityInfo | null {
    // Resource-baseline eligibility: an add-on can only extend a FINITE limit.
    // Canonical unlimited is null; devices additionally treat `<= 0` as
    // unlimited (the product's rule), and a negative byte budget is a data
    // anomaly. All are withheld so an add-on can never turn an effectively-
    // unlimited baseline finite (the `0 + N` footgun) nor attach to a
    // nonsensical baseline. A finite 0 traffic budget (0n bytes = a real 0 GB
    // cap) stays eligible; a 0 device cap is unlimited, so it is withheld.
    if (
      type === AddOnType.EXTRA_TRAFFIC &&
      (term.baseTrafficLimitBytes === null || term.baseTrafficLimitBytes < 0n)
    ) {
      return null;
    }
    if (
      type === AddOnType.EXTRA_DEVICES &&
      (term.baseDeviceLimit === null || term.baseDeviceLimit <= 0)
    ) {
      return null;
    }

    if (lifetime === AddOnLifetime.UNTIL_SUBSCRIPTION_END) {
      if (term.endsAt === null) return null; // open-ended term has no expiry date
      return {
        eligible: true,
        activation: 'NOW',
        expiresAt: term.endsAt.toISOString(),
        explanationCode: 'ELIGIBLE_UNTIL_SUBSCRIPTION_END',
      };
    }

    // UNTIL_NEXT_RESET: only offered when the strategy has a boundary and its
    // reset capability is verified/enabled for commercial expiry.
    if (term.trafficResetStrategy === TrafficLimitStrategy.NO_RESET) return null;
    const capability = getResetCapability(term.trafficResetStrategy, capabilities);
    if (capability !== 'ENABLED') return null;
    // A boundary strategy with no anchor cannot yield an epoch — withhold
    // rather than letting planResetEpoch throw (which would 500 the whole
    // listing). The fallback path always supplies an anchor; this guards a
    // persisted term with a null anchor once a reset flag is enabled.
    if (term.resetAnchorAt === null) return null;

    const epoch = planResetEpoch({
      strategy: term.trafficResetStrategy,
      capability,
      anchorAt: term.resetAnchorAt,
      referenceAt: now,
    });
    if (epoch === null) return null;
    return {
      eligible: true,
      activation: 'NOW',
      expiresAt: epoch.plannedEndsAt.toISOString(),
      explanationCode: 'ELIGIBLE_UNTIL_NEXT_RESET',
    };
  }

  /**
   * Reset-capability seam derived from the staged rollout flags. All strategies
   * are DISABLED until their `reset_expiry_<strategy>` flag is turned on (after
   * staging parity is verified against both supported Remnawave versions).
   */
  protected getResetCapabilities(): ResetCapabilityMap {
    return resolveResetCapabilities();
  }
}
