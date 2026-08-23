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
import { resolveIntakeResetCapabilities } from '../../add-on-entitlements/add-on-rollout.config';
import { resolveAddOnLifetimeGrant } from '../../add-on-entitlements/domain/add-on-lifetime';
import { deriveCutoverBaseline } from '../../add-on-entitlements/domain/cutover-baseline';
import { ResetCapabilityMap } from '../../add-on-entitlements/domain/reset-cycle-policy';
import {
  isBaselineExtendable,
  resolveConfiguredEntitlementBaseline,
} from '../../add-on-entitlements/services/configured-baseline.util';

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
 * ── The term is not the whole baseline ────────────────────────────────────
 *
 * A `SubscriptionTerm` records what the customer BOUGHT, minted from the plan
 * and never mutated afterwards. It is NOT automatically what this ONE
 * subscription is entitled to: an operator can configure a single customer from
 * the admin Users page while that customer keeps being billed for the plan, and
 * that individually-configured value is deliberately preserved rather than
 * reset. Judging an OFFER against the term alone is therefore how a customer
 * gets sold an add-on that changes nothing — an operator-set unlimited
 * (`deviceLimit <= 0`, `trafficLimit === null`) is ABSORBING, so
 * `addDeviceLimit(null, …)` / `addTrafficLimit(null, …)` swallow the whole
 * contribution while the term's finite number still reads as extendable.
 *
 * So the offer is judged against the SAME baseline the fulfillment side builds:
 * {@link resolveConfiguredEntitlementBaseline}, the shared reader of the
 * override rule that `EffectiveProjectionService`, the direct-purchase checkout
 * and both capture paths also call. It is CALLED, never re-derived — a second
 * copy of that rule is a defect on the day the two disagree, and that day
 * already happened once between this file and checkout. The rule itself,
 * including why UNDECIDABLE stays separate from OVERRIDDEN, lives in
 * `../../add-on-entitlements/domain/entitlement-baseline.ts`.
 *
 * The no-term fallback needs no such correction: it derives the baseline from
 * the subscription's OWN columns, so the operator's value is already the
 * baseline there.
 *
 * ── Resource rules ────────────────────────────────────────────────────────
 *
 * Eligibility is computed against the subscription's authoritative baseline
 * (canonical `null` = unlimited), NOT the plan alone:
 *  - EXTRA_TRAFFIC is eligible only for a finite traffic baseline.
 *  - EXTRA_DEVICES is eligible only for a finite device baseline (this closes
 *    the legacy footgun where a device add-on turned an unlimited profile
 *    finite).
 *  - `UNTIL_SUBSCRIPTION_END` expires at the term end (requires a term end).
 *  - `UNTIL_NEXT_RESET` binds expiry to the plan's reset cycle and is valid for
 *    BOTH traffic and devices (the reset epoch is the profile's monthly refresh
 *    boundary — traffic rolls back and extra devices are removed on it). It is
 *    offered only when the strategy has a boundary (not NO_RESET) AND its reset
 *    capability is ENABLED (disabled until staging parity, so withheld for now).
 *    Availability is gated by the strategy/capability, NOT by the add-on type.
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
    // On the term path the resource limits pass through
    // `resolveConfiguredBaseline` so an individually-configured limit is the
    // one the offer is judged against; the fallback already reads those
    // columns directly.
    const resolved =
      term === null
        ? this.deriveFallbackBaseline(subscription)
        : {
            termId: term.id,
            planId: term.planId ?? '',
            baseline: {
              endsAt: term.endsAt,
              ...(await this.resolveConfiguredBaseline(subscriptionId, term, subscription)),
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
   * No-term fallback: synthesize only the non-reset authoritative baseline from
   * the subscription's own columns + planSnapshot. `subscription.createdAt`
   * is local provenance, not a trustworthy panel reset anchor (especially for
   * MONTH_ROLLING), so reset-scoped add-ons remain fail-closed until a durable
   * ACTIVE term carries a panel-derived `resetAnchorAt`.
   *
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
        resetAnchorAt: null,
      },
    };
  }

  /**
   * The ACTIVE term's resource baseline with the operator's individually
   * configured limits substituted in — the SAME baseline
   * `EffectiveProjectionService.recomputeInTransaction` builds when this
   * purchase is fulfilled, produced by the SAME
   * {@link resolveConfiguredEntitlementBaseline} call that the direct-purchase
   * checkout and both capture paths make. Offer, checkout, capture and
   * fulfillment therefore cannot disagree about whether a limit is finite.
   *
   * This is deliberately a two-field adapter and nothing more: the shared
   * reader owns the projection read, the `?? 0` fallback and the override rule
   * (INHERITED / OVERRIDDEN / UNDECIDABLE, and the deliberate separation of the
   * last two). None of them is restated here.
   */
  private async resolveConfiguredBaseline(
    subscriptionId: string,
    term: {
      readonly baseTrafficLimitBytes: bigint | null;
      readonly baseDeviceLimit: number | null;
    },
    subscription: {
      readonly trafficLimit: number | null;
      readonly deviceLimit: number;
      readonly planSnapshot: unknown;
    },
  ): Promise<{
    readonly baseTrafficLimitBytes: bigint | null;
    readonly baseDeviceLimit: number | null;
  }> {
    const baseline = await resolveConfiguredEntitlementBaseline(this.prismaService, {
      subscriptionId,
      term,
      subscription,
    });
    return {
      baseTrafficLimitBytes: baseline.baseTrafficLimitBytes,
      baseDeviceLimit: baseline.baseDeviceLimit,
    };
  }

  /**
   * `baseline` is the subscription's authoritative baseline, NOT the raw term:
   * on the term path it has already been through
   * {@link resolveConfiguredBaseline}. Reading `term.base*` here again would
   * re-open the offer↔fulfillment gap this method's first two checks close.
   */
  private evaluate(
    type: AddOnType,
    lifetime: AddOnLifetime,
    baseline: {
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
    // The predicate is shared with the direct-purchase checkout and both
    // capture paths so the OFFER and the money paths cannot answer it
    // differently — an offer nobody can buy was exactly the defect that put
    // this call here. The two encodings, and why they are not "harmonised",
    // are documented on {@link isBaselineExtendable}.
    if (!isBaselineExtendable(type, baseline)) {
      return null;
    }

    // The LIFETIME axis — "until when can this actually be delivered?" — is the
    // shared {@link resolveAddOnLifetimeGrant}, not a rule restated here. It is
    // the same function the direct-purchase CHECKOUT calls with the same
    // capability map, so an add-on this listing withholds for a lifetime reason
    // cannot be bought through a crafted or stale checkout either. Until that
    // call existed the checkout asked nothing about lifetime, drafted anyway,
    // and the intake fell through to the PERMANENT legacy increment.
    //
    // Both arms activate NOW: an offer is a direct purchase, which the capture
    // path activates at the transaction's creation instant.
    const grant = resolveAddOnLifetimeGrant({ lifetime, baseline, capabilities, now });
    if (grant === null) return null;
    return {
      eligible: true,
      activation: 'NOW',
      expiresAt: grant.expiresAt.toISOString(),
      explanationCode: grant.explanationCode,
    };
  }

  /**
   * OFFER-side reset-capability seam. The rule — a reset strategy is usable for
   * SELLING a `UNTIL_NEXT_RESET` add-on only when its `reset_expiry_<strategy>`
   * flag is on AND `directPurchase` is on — is
   * {@link resolveIntakeResetCapabilities} and is NOT restated here: the
   * direct-purchase checkout has to apply the identical gate, and the moment
   * there were two copies of it the offer and the checkout could disagree about
   * whether a lifetime can be honoured. That is the same class of defect the
   * resource axis already suffered between these two files.
   *
   * This stays a `protected` method rather than becoming a direct call at the
   * use site because it is the seam a test subclasses to fix a capability map
   * without touching `process.env`.
   */
  protected getResetCapabilities(): ResetCapabilityMap {
    return resolveIntakeResetCapabilities();
  }
}
