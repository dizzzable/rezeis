import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  ArchivedPlanRenewMode,
  Currency,
  PaymentGatewayType,
  PlanAvailability,
  Prisma,
  PurchaseChannel,
  SubscriptionStatus,
} from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  findOpenEndedQueuedTerm,
  isLifetimeSubscription,
  SUBSCRIPTION_IS_LIFETIME_CODE,
  subscriptionIsLifetime,
} from '../../payments/utils/lifetime-renewal.util';
import type { CatalogDiscountSource } from '../../plans/interfaces/plan-catalog.interface';
import { isPlanSoftDeleted } from '../../plans/utils/plan-deletion.util';
import {
  SubscriptionQuotePlanInterface,
  SubscriptionQuoteWarningInterface,
} from '../interfaces/subscription-quote.interface';
import {
  PricedRenewalInterface,
  PricedRenewalItemInterface,
  RenewalItemInterface,
  RenewalOptionsInterface,
} from '../interfaces/subscription-renewal.interface';
import { SubscriptionQuoteService, TRANSITION_TARGET_WHERE } from './subscription-quote.service';

interface RenewalIdentity {
  readonly userId?: string;
  readonly telegramId?: string;
}

/** Internal result of pricing a single subscription's renewal. */
interface SingleRenewalQuote {
  readonly subscriptionId: string;
  readonly planId: string | null;
  readonly planName: string | null;
  readonly durationDays: number | null;
  readonly availableDurations: readonly { readonly id: string; readonly days: number }[];
  readonly currency: Currency | null;
  readonly amount: string | null;
  readonly discountPercent: number;
  readonly discountSource: CatalogDiscountSource;
  readonly renewable: boolean;
  readonly requiresPlanSelection: boolean;
  readonly warnings: readonly SubscriptionQuoteWarningInterface[];
  readonly targetPlan: SubscriptionQuotePlanInterface | null;
}

const DURATION_ADJUSTED: SubscriptionQuoteWarningInterface = {
  code: 'DURATION_NOT_AVAILABLE',
  message: 'The originally purchased duration is no longer offered; the nearest available duration was used.',
};

const DURATION_INVALID: SubscriptionQuoteWarningInterface = {
  code: 'DURATION_INVALID',
  message: 'The requested duration is not offered by this plan; the original duration was used instead.',
};

/**
 * The refusal `priceRenewalItems` throws when a subscription cannot be renewed
 * on the terms asked for — usually a plan withdrawn between the buyer's review
 * and their Pay, or a plan-less renewal sent without a plan.
 *
 * `{ code, message }`, not the bare string it used to be: the safe filter
 * forwards a product code only from that shape (`SAFE_PRODUCT_CODES`), and the
 * cabinet BFF branches on `code` alone. As a bare string the refusal left the
 * panel as an untyped 400 and the cabinet as a 500 "Failed to create renewal
 * checkout". The message stays the code, so the autopay log line that prints
 * `error.message` reads as it always has.
 *
 * A factory rather than an inline `throw` so the wire spec
 * (`internal-payments-renewal-refusals.http.spec.ts`) feeds the filter the
 * exception this service really throws, not a copy that can drift from it.
 */
export function renewalItemNotPriceable(): BadRequestException {
  return new BadRequestException({
    code: 'RENEWAL_ITEM_NOT_PRICEABLE',
    message: 'RENEWAL_ITEM_NOT_PRICEABLE',
  });
}

/**
 * Builds renewal options and prices a renewal selection for a combined,
 * multi-subscription payment. Pricing delegates to {@link SubscriptionQuoteService}
 * so per-user discounts and promocode-driven discount fields are applied
 * identically to the single-item RENEW quote.
 */
@Injectable()
export class SubscriptionRenewalService {
  public constructor(
    private readonly prismaService: PrismaService,
    private readonly subscriptionQuoteService: SubscriptionQuoteService,
  ) {}

  /**
   * Re-checks the immutable renewal policy without repricing. Keyed checkout
   * replays call this before returning a persisted payment link, so a draft
   * created before a subscription became a trial/disabled row cannot bypass
   * the same policy enforced by quote creation.
   */
  public async assertRenewalPolicy(input: {
    readonly identity: RenewalIdentity;
    readonly subscriptionIds: readonly string[];
    readonly targetPlanIds?: readonly string[];
  }): Promise<void> {
    const userId = await this.resolveUserId(input.identity);
    const subscriptionIds = [...new Set(input.subscriptionIds)];
    const subscriptions = await this.prismaService.subscription.findMany({
      where: {
        userId,
        id: { in: subscriptionIds },
        status: { not: SubscriptionStatus.DELETED },
      },
      select: { id: true, status: true, isTrial: true, expiresAt: true },
    });
    if (subscriptions.length !== subscriptionIds.length) {
      throw new NotFoundException('RENEWAL_SUBSCRIPTION_NOT_FOUND');
    }
    if (subscriptions.some((subscription) => subscription.isTrial)) {
      throw new BadRequestException('TRIAL_NOT_RENEWABLE');
    }
    // A draft made before its subscription lost its end date must not hand back
    // its payment link: the replay is the one path that skips the pricing below.
    // Nor one whose paid periods now end in a queued period without an end.
    if (subscriptions.some(isLifetimeSubscription)) {
      throw subscriptionIsLifetime();
    }
    for (const subscription of subscriptions) {
      if ((await findOpenEndedQueuedTerm(this.prismaService, subscription)) !== null) {
        throw subscriptionIsLifetime();
      }
    }
    if (
      subscriptions.some(
        (subscription) => subscription.status === SubscriptionStatus.DISABLED,
      )
    ) {
      throw new BadRequestException('SUBSCRIPTION_DISABLED_NOT_RENEWABLE');
    }

    const targetPlanIds = [...new Set(input.targetPlanIds ?? [])];
    if (targetPlanIds.length === 0) {
      return;
    }
    const trialTarget = await this.prismaService.plan.findFirst({
      where: {
        id: { in: targetPlanIds },
        availability: PlanAvailability.TRIAL,
      },
      select: { id: true },
    });
    if (trialTarget !== null) {
      throw new BadRequestException('TRIAL_PLAN_NOT_RENEWAL_TARGET');
    }
  }

  /**
   * Lists the user's renewable subscriptions, each priced against the given
   * (or default-resolved) gateway. Non-priceable subscriptions are returned
   * with `renewable: false` and their warnings rather than dropped.
   */
  public async getRenewalOptions(input: {
    readonly identity: RenewalIdentity;
    readonly subscriptionIds?: readonly string[];
    readonly gatewayType?: PaymentGatewayType;
    readonly channel?: PurchaseChannel;
    /** Optional per-subscription chosen renewal duration (days). */
    readonly durations?: ReadonlyMap<string, number>;
    /** Optional per-subscription chosen plan id (for plan-less subscriptions). */
    readonly plans?: ReadonlyMap<string, string>;
  }): Promise<RenewalOptionsInterface> {
    const userId = await this.resolveUserId(input.identity);
    const channel = input.channel ?? PurchaseChannel.WEB;
    const subscriptions = await this.loadCandidateSubscriptions(userId, input.subscriptionIds);

    const quotes: SingleRenewalQuote[] = [];
    for (const subscription of subscriptions) {
      quotes.push(
        await this.quoteSubscriptionRenewal({
          userId,
          subscriptionId: subscription.id,
          gatewayType: input.gatewayType,
          channel,
          chosenDurationDays: input.durations?.get(subscription.id) ?? null,
          chosenPlanId: input.plans?.get(subscription.id) ?? null,
        }),
      );
    }

    const items: RenewalItemInterface[] = quotes.map((quote) => ({
      subscriptionId: quote.subscriptionId,
      planId: quote.planId,
      planName: quote.planName,
      durationDays: quote.durationDays,
      availableDurations: quote.availableDurations,
      currency: quote.currency,
      amount: quote.amount,
      discountPercent: quote.discountPercent,
      discountSource: quote.discountSource,
      renewable: quote.renewable,
      requiresPlanSelection: quote.requiresPlanSelection,
      warnings: quote.warnings,
    }));

    const priceable = quotes.filter(
      (q): q is SingleRenewalQuote & { amount: string; currency: Currency } =>
        q.amount !== null && q.currency !== null,
    );
    const currencies = new Set(priceable.map((q) => q.currency));
    const singleCurrency = currencies.size === 1 ? [...currencies][0] : null;
    const total =
      singleCurrency !== null
        ? priceable
            .reduce((sum, q) => sum.add(new Prisma.Decimal(q.amount)), new Prisma.Decimal(0))
            .toString()
        : null;

    return { userId, items, currency: singleCurrency, total };
  }

  /**
   * Prices a concrete renewal selection for checkout. Throws when the
   * selection is empty, contains a non-priceable item, or mixes currencies.
   */
  public async priceRenewalItems(input: {
    readonly identity: RenewalIdentity;
    readonly subscriptionIds: readonly string[];
    readonly gatewayType: PaymentGatewayType;
    readonly channel?: PurchaseChannel;
    /** Optional per-subscription chosen renewal duration (days). */
    readonly durations?: ReadonlyMap<string, number>;
    /** Optional per-subscription chosen plan id (for plan-less subscriptions). */
    readonly plans?: ReadonlyMap<string, string>;
  }): Promise<PricedRenewalInterface> {
    if (input.subscriptionIds.length === 0) {
      throw new BadRequestException('RENEWAL_NO_ITEMS');
    }
    const userId = await this.resolveUserId(input.identity);
    const channel = input.channel ?? PurchaseChannel.WEB;
    const uniqueIds = [...new Set(input.subscriptionIds)];
    const subscriptions = await this.loadCandidateSubscriptions(userId, uniqueIds);
    if (subscriptions.length !== uniqueIds.length) {
      throw new NotFoundException('RENEWAL_SUBSCRIPTION_NOT_FOUND');
    }
    // Before any line is priced, and by name. Its quote would only read as an
    // unpriceable line (`RENEWAL_ITEM_NOT_PRICEABLE`), which the cabinet answers
    // by re-pricing the review — for a subscription no review can ever price.
    if (subscriptions.some(isLifetimeSubscription)) {
      throw subscriptionIsLifetime();
    }

    const items: PricedRenewalItemInterface[] = [];
    for (const subscription of subscriptions) {
      const quote = await this.quoteSubscriptionRenewal({
        userId,
        subscriptionId: subscription.id,
        gatewayType: input.gatewayType,
        channel,
        chosenDurationDays: input.durations?.get(subscription.id) ?? null,
        chosenPlanId: input.plans?.get(subscription.id) ?? null,
      });
      // A line its quote closed for the lifetime reason — its paid periods end
      // in a queued period without an end (`findOpenEndedQueuedTerm`) — is
      // refused by that name too, not as an unpriceable line to re-price.
      if (!quote.renewable && quote.warnings.some((warning) => warning.code === SUBSCRIPTION_IS_LIFETIME_CODE)) {
        throw subscriptionIsLifetime();
      }
      if (
        !quote.renewable ||
        quote.amount === null ||
        quote.currency === null ||
        quote.planId === null ||
        quote.durationDays === null ||
        quote.targetPlan === null
      ) {
        throw renewalItemNotPriceable();
      }
      items.push({
        subscriptionId: quote.subscriptionId,
        planId: quote.planId,
        planName: quote.planName ?? '',
        durationDays: quote.durationDays,
        currency: quote.currency,
        amount: quote.amount,
        discountPercent: quote.discountPercent,
        discountSource: quote.discountSource,
        planSnapshot: {
          id: quote.planId,
          name: quote.planName,
          selectedDurationDays: quote.durationDays,
          description: quote.targetPlan?.description ?? null,
          tag: quote.targetPlan?.tag ?? null,
          type: quote.targetPlan?.type ?? 'BOTH',
          icon: quote.targetPlan?.icon ?? null,
          trafficLimit: quote.targetPlan?.trafficLimit ?? null,
          deviceLimit: quote.targetPlan?.deviceLimit ?? 0,
          trafficLimitStrategy: quote.targetPlan?.trafficLimitStrategy ?? 'NO_RESET',
          internalSquads: quote.targetPlan?.internalSquads ?? [],
          externalSquad: quote.targetPlan?.externalSquad ?? null,
          snapshotVersion: 2,
          availability: quote.targetPlan.availability,
          amount: quote.amount,
          currency: quote.currency,
          gatewayType: input.gatewayType,
          purchaseType: 'RENEW',
          snapshotSource: 'RENEWAL_DRAFT',
        },
      });
    }

    const currencies = new Set(items.map((item) => item.currency));
    if (currencies.size > 1) {
      throw new BadRequestException('MIXED_CURRENCY');
    }
    const currency = items[0]!.currency;
    // Total = every plan line.
    const total = items
      .reduce((sum, item) => sum.add(new Prisma.Decimal(item.amount)), new Prisma.Decimal(0))
      .toString();

    return { userId, currency, total, items };
  }

  /**
   * Prices a single subscription's renewal. Resolves the renewal target plan
   * (original, or replacement for an archived plan) and the renewal duration
   * (originally purchased, or nearest available) via two quote passes:
   * one to discover the available renewal plans, one to price the choice.
   */
  private async quoteSubscriptionRenewal(input: {
    readonly userId: string;
    readonly subscriptionId: string;
    readonly gatewayType?: PaymentGatewayType;
    readonly channel: PurchaseChannel;
    readonly chosenDurationDays?: number | null;
    readonly chosenPlanId?: string | null;
  }): Promise<SingleRenewalQuote> {
    const subscription = await this.prismaService.subscription.findUnique({
      where: { id: input.subscriptionId },
    });
    if (subscription === null) {
      throw new NotFoundException('RENEWAL_SUBSCRIPTION_NOT_FOUND');
    }
    const original = readSnapshotSelection(subscription.planSnapshot);

    const discovery = await this.subscriptionQuoteService.getQuote({
      userId: input.userId,
      purchaseType: 'RENEW',
      subscriptionId: input.subscriptionId,
      channel: input.channel,
      gatewayType: input.gatewayType,
    });

    // The subscriber has to CHOOSE the plan when there is none to renew onto:
    // a plan-less (panel-imported) subscription, one whose plan was deleted —
    // the row gone, or soft-deleted and hidden — or an archived
    // REPLACE_ON_RENEW plan with no replacement left on sale. In each case the
    // discovery quote offers the active catalogue. Until a plan is picked the
    // sub is reported renewable-but-needs-a-plan (no price yet); once chosen it
    // is priced like a normal renewal onto that plan.
    //
    // Read AFTER discovery, which settles one direction only: a plan deleted
    // (or a last replacement taken off sale) between the two reads still asks
    // for a choice. The other direction CAN happen — an operator puts a
    // replacement back on sale, unarchives the plan or switches it to
    // SELF_RENEW between the reads — and then this read says "no choice" while
    // discovery has already offered the catalogue. That is why `pickTargetPlan`
    // accepts nothing but the plan itself or one of its own replacements: a
    // catalogue plan nobody chose is never the renewal target, whatever order
    // the two reads land in.
    const source = await this.readRenewalSource(original.planId);
    const selectionRequired = source.selectionRequired;
    const chosenPlanId = input.chosenPlanId ?? null;
    if (selectionRequired && chosenPlanId === null) {
      const canSelect = discovery.availablePlans.length > 0;
      return {
        subscriptionId: input.subscriptionId,
        planId: null,
        planName: null,
        durationDays: null,
        availableDurations: [],
        currency: null,
        amount: null,
        discountPercent: 0,
        discountSource: 'NONE',
        renewable: canSelect,
        requiresPlanSelection: canSelect,
        warnings: discovery.warnings,
        targetPlan: null,
      };
    }

    const targetPlan = selectionRequired
      ? (discovery.availablePlans.find((plan) => plan.id === chosenPlanId) ?? null)
      : pickTargetPlan(discovery.availablePlans, original.planId, source.replacementPlanIds);
    if (targetPlan === null) {
      return {
        subscriptionId: input.subscriptionId,
        planId: null,
        planName: null,
        durationDays: null,
        availableDurations: [],
        currency: null,
        amount: null,
        discountPercent: 0,
        discountSource: 'NONE',
        renewable: false,
        requiresPlanSelection: false,
        warnings: discovery.warnings,
        targetPlan: null,
      };
    }

    const availableDurations = targetPlan.durations.map((d) => ({ id: d.id, days: d.days }));
    const durationChoice = resolveDuration(
      targetPlan,
      original.durationDays,
      input.chosenDurationDays ?? null,
    );
    if (durationChoice === null) {
      return {
        subscriptionId: input.subscriptionId,
        planId: targetPlan.id,
        planName: targetPlan.name,
        durationDays: null,
        availableDurations,
        currency: null,
        amount: null,
        discountPercent: 0,
        discountSource: 'NONE',
        renewable: false,
        requiresPlanSelection: false,
        warnings: discovery.warnings,
        targetPlan: null,
      };
    }

    const priced = await this.subscriptionQuoteService.getQuote({
      userId: input.userId,
      purchaseType: 'RENEW',
      subscriptionId: input.subscriptionId,
      channel: input.channel,
      gatewayType: input.gatewayType,
      planId: targetPlan.id,
      durationDays: durationChoice.days,
    });

    const adjustWarnings: SubscriptionQuoteWarningInterface[] = [];
    if (durationChoice.invalidChosen) adjustWarnings.push(DURATION_INVALID);
    else if (durationChoice.adjusted) adjustWarnings.push(DURATION_ADJUSTED);
    const warnings = mergeWarnings(discovery.warnings, adjustWarnings);

    if (!priced.isEligible || priced.price === null) {
      return {
        subscriptionId: input.subscriptionId,
        planId: targetPlan.id,
        planName: targetPlan.name,
        durationDays: durationChoice.days,
        availableDurations,
        currency: null,
        amount: null,
        discountPercent: 0,
        discountSource: 'NONE',
        renewable: false,
        requiresPlanSelection: false,
        warnings: mergeWarnings(warnings, priced.warnings),
        targetPlan,
      };
    }

    return {
      subscriptionId: input.subscriptionId,
      planId: targetPlan.id,
      planName: targetPlan.name,
      durationDays: durationChoice.days,
      availableDurations,
      currency: priced.price.currency,
      amount: priced.price.price,
      discountPercent: priced.price.discountPercent,
      discountSource: priced.price.discountSource,
      renewable: true,
      requiresPlanSelection: false,
      warnings,
      targetPlan,
    };
  }

  /**
   * Whether renewing this subscription needs the SUBSCRIBER to choose a plan —
   * the plan it was on is gone, or it never had one.
   *
   * Public for `AutoRenewService`, which cannot choose on anybody's behalf and
   * must therefore not try to charge such a subscription at all. It is the same
   * predicate `quoteSubscriptionRenewal` renews by, so autopay and the cabinet
   * cannot disagree about which subscriptions need a choice. A subscription
   * that is not there answers `false`: the charge path reports that itself.
   */
  public async requiresPlanSelection(subscriptionId: string): Promise<boolean> {
    const subscription = await this.prismaService.subscription.findUnique({
      where: { id: subscriptionId },
      select: { planSnapshot: true },
    });
    if (subscription === null) {
      return false;
    }
    return this.renewalPlanIsGone(readSnapshotSelection(subscription.planSnapshot).planId);
  }

  /**
   * No plan id, no row, or a soft-deleted row — or an archived REPLACE_ON_RENEW
   * plan with no replacement left on sale. A soft-deleted plan still RESOLVES by
   * id — fulfilment and grants depend on that — but it is never renewed onto: it
   * is gone for everyone (plan-deletion contract v2).
   *
   * The archived plan with no replacement has nothing to renew onto either. The
   * editor refuses to save one, so this state only ever arises when its
   * replacements are deleted (the delete strips them from the list) or taken off
   * sale; the discovery quote then offers the catalogue for it, and picking that
   * catalogue's first plan silently is exactly what this predicate prevents.
   * `TRANSITION_TARGET_WHERE` is the quote's own definition of "on sale".
   */
  private async renewalPlanIsGone(planId: string | null): Promise<boolean> {
    return (await this.readRenewalSource(planId)).selectionRequired;
  }

  /**
   * {@link renewalPlanIsGone}, read together with the list an archived
   * REPLACE_ON_RENEW plan renews onto — the only plans besides itself
   * `pickTargetPlan` may pick, and empty for every other plan — so the renewal
   * takes both from the same row.
   */
  private async readRenewalSource(planId: string | null): Promise<{
    readonly selectionRequired: boolean;
    readonly replacementPlanIds: readonly string[];
  }> {
    if (planId === null) {
      return { selectionRequired: true, replacementPlanIds: [] };
    }
    const plan = await this.prismaService.plan.findUnique({
      where: { id: planId },
      select: { deletedAt: true, isArchived: true, archivedRenewMode: true, replacementPlanIds: true },
    });
    if (plan === null || isPlanSoftDeleted(plan)) {
      return { selectionRequired: true, replacementPlanIds: [] };
    }
    if (!plan.isArchived || plan.archivedRenewMode !== ArchivedPlanRenewMode.REPLACE_ON_RENEW) {
      return { selectionRequired: false, replacementPlanIds: [] };
    }
    const replacementsOnSale = await this.prismaService.plan.count({
      where: { id: { in: plan.replacementPlanIds }, ...TRANSITION_TARGET_WHERE },
    });
    return {
      selectionRequired: replacementsOnSale === 0,
      replacementPlanIds: plan.replacementPlanIds,
    };
  }

  private async loadCandidateSubscriptions(
    userId: string,
    subscriptionIds?: readonly string[],
  ): Promise<readonly { id: string; planSnapshot: Prisma.JsonValue; expiresAt: Date | null }[]> {
    return this.prismaService.subscription.findMany({
      where: {
        userId,
        status: { not: SubscriptionStatus.DELETED },
        ...(subscriptionIds !== undefined ? { id: { in: [...subscriptionIds] } } : {}),
      },
      orderBy: [{ createdAt: 'asc' }],
      select: { id: true, planSnapshot: true, expiresAt: true },
    });
  }

  private async resolveUserId(identity: RenewalIdentity): Promise<string> {
    if (typeof identity.userId === 'string' && identity.userId.length > 0) {
      return identity.userId;
    }
    if (typeof identity.telegramId === 'string' && identity.telegramId.length > 0) {
      const user = await this.prismaService.user.findUnique({
        where: { telegramId: BigInt(identity.telegramId) },
        select: { id: true },
      });
      if (user === null) {
        throw new NotFoundException('User not found');
      }
      return user.id;
    }
    throw new NotFoundException('A userId or telegramId is required');
  }
}

function readSnapshotSelection(planSnapshot: Prisma.JsonValue): {
  readonly planId: string | null;
  readonly durationDays: number | null;
} {
  const snapshot =
    typeof planSnapshot === 'object' && planSnapshot !== null && !Array.isArray(planSnapshot)
      ? (planSnapshot as Record<string, unknown>)
      : {};
  const planId = typeof snapshot['id'] === 'string' ? (snapshot['id'] as string) : null;
  const durationDays =
    typeof snapshot['selectedDurationDays'] === 'number'
      ? (snapshot['selectedDurationDays'] as number)
      : null;
  return { planId, durationDays };
}

/**
 * The renewal target for a subscription whose plan still EXISTS and needs no
 * choice: the plan itself, or — for an archived `REPLACE_ON_RENEW` plan, whose
 * quote offers its replacements — the first of its own replacements the quote
 * offers.
 *
 * Nothing else, and `null` when neither is offered. The fallback used to be
 * "whatever the quote listed first", which for a missing, soft-deleted or
 * replacement-less plan was the catalogue's first plan, and autopay charged the
 * saved card for it. Those now require the subscriber's choice
 * (`renewalPlanIsGone`), but its read and the discovery quote can still
 * disagree for a moment (see `quoteSubscriptionRenewal`); a subscription caught
 * in that moment is reported not renewable, which the next read corrects,
 * rather than renewed onto a plan nobody picked.
 */
function pickTargetPlan(
  availablePlans: readonly SubscriptionQuotePlanInterface[],
  originalPlanId: string | null,
  replacementPlanIds: readonly string[],
): SubscriptionQuotePlanInterface | null {
  if (originalPlanId !== null) {
    const exact = availablePlans.find((plan) => plan.id === originalPlanId);
    if (exact !== undefined) {
      return exact;
    }
  }
  return availablePlans.find((plan) => replacementPlanIds.includes(plan.id)) ?? null;
}

interface DurationChoice {
  readonly days: number;
  /** The originally purchased duration was unavailable; nearest was used. */
  readonly adjusted: boolean;
  /** A user-supplied duration was rejected; the original was used instead. */
  readonly invalidChosen: boolean;
}

/**
 * Resolves the renewal duration for a target plan.
 *
 * When the user explicitly chose a duration (`chosenDurationDays`), it is
 * honoured if the plan offers it; otherwise the choice is rejected
 * (`invalidChosen`) and resolution falls back to the originally purchased
 * duration logic. When no choice is supplied, the originally purchased
 * duration is matched exactly, or the nearest available one is used
 * (`adjusted`). Returns `null` only when the plan offers no durations.
 */
function resolveDuration(
  plan: SubscriptionQuotePlanInterface,
  originalDurationDays: number | null,
  chosenDurationDays: number | null,
): DurationChoice | null {
  if (plan.durations.length === 0) {
    return null;
  }

  if (chosenDurationDays !== null) {
    const chosen = plan.durations.find((duration) => duration.days === chosenDurationDays);
    if (chosen !== undefined) {
      return { days: chosen.days, adjusted: false, invalidChosen: false };
    }
    const fallback = resolveOriginalDuration(plan, originalDurationDays);
    return fallback === null ? null : { ...fallback, invalidChosen: true };
  }

  const resolved = resolveOriginalDuration(plan, originalDurationDays);
  return resolved === null ? null : { ...resolved, invalidChosen: false };
}

/** Matches the originally purchased duration exactly, or the nearest one. */
function resolveOriginalDuration(
  plan: SubscriptionQuotePlanInterface,
  originalDurationDays: number | null,
): { readonly days: number; readonly adjusted: boolean } | null {
  if (originalDurationDays !== null) {
    const exact = plan.durations.find((duration) => duration.days === originalDurationDays);
    if (exact !== undefined) {
      return { days: exact.days, adjusted: false };
    }
    // Nearest available duration by absolute day distance.
    const nearest = [...plan.durations].sort(
      (a, b) => Math.abs(a.days - originalDurationDays) - Math.abs(b.days - originalDurationDays),
    )[0];
    if (nearest !== undefined) {
      return { days: nearest.days, adjusted: true };
    }
  }
  const first = plan.durations[0];
  return first !== undefined ? { days: first.days, adjusted: originalDurationDays !== null } : null;
}

function mergeWarnings(
  ...groups: readonly (readonly SubscriptionQuoteWarningInterface[])[]
): readonly SubscriptionQuoteWarningInterface[] {
  const byCode = new Map<string, SubscriptionQuoteWarningInterface>();
  for (const group of groups) {
    for (const warning of group) {
      byCode.set(warning.code, warning);
    }
  }
  return [...byCode.values()];
}
