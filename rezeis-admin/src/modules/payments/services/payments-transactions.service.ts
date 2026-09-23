import { BadRequestException, Injectable } from '@nestjs/common';
import {
  PlanAvailability,
  Prisma,
  PurchaseChannel,
  PurchaseType,
  Subscription,
  Transaction,
  TransactionStatus,
  TrialClaimStatus,
} from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { readTrialSettings, TrialSettings } from '../../plans/utils/trial-settings.util';
import {
  isConvertibleTrial,
  isPlanAvailabilityRefusal,
  SubscriptionQuoteService,
} from '../../subscriptions/services/subscription-quote.service';
import {
  countCommittedTrialClaimUnits,
  lockTrialClaimUser,
  findResumablePaidTrialClaim,
  reservePaidTrialClaim,
} from '../../subscriptions/services/trial-claim-ledger.util';
import { CreateTransactionDraftDto } from '../dto/create-transaction-draft.dto';
import { ListTransactionsQueryDto } from '../dto/list-transactions-query.dto';
import {
  AdminPaymentTransactionInterface,
  AdminPaymentTransactionListItemInterface,
} from '../interfaces/admin-payment-transaction.interface';
import {
  autopayNotAvailable,
  PROVIDER_SUBSCRIPTION_SNAPSHOT_KEY,
  ProviderSubscriptionTerms,
  renewsOntoAnotherPlan,
  resolveProviderSubscriptionTerms,
} from '../utils/provider-subscription-terms.util';
import { readWithheldConversion, TRIAL_CONVERSION_SNAPSHOT_KEY } from '../utils/trial-conversion.util';

/**
 * The namespaces the importers put in front of a donor platform's payment id,
 * so an imported row can never collide with a live checkout:
 *
 *   - `altshop-importer.service.ts`   → `altshop:${source.id}`
 *   - `bedolaga-importer.service.ts`  → `bedolaga:${donor.id}`
 *   - `remnashop-importer.service.ts` → `'remnashop:' + transaction.id`
 *
 * (The StealthNet importer keeps the donor's `order_id` as it was.) The cabinet
 * shows a subscriber such a payment's number WITHOUT the namespace — it would
 * name the platform they came from — so a number quoted to support is looked
 * up under each of these too. `payments-transactions-list-filters.spec.ts`
 * reads the importers and fails when this list no longer matches them.
 */
export const IMPORTED_PAYMENT_ID_PREFIXES = ['altshop', 'bedolaga', 'remnashop'] as const;

/**
 * Upper bound of Postgres `int8`, which `users.telegram_id` is. A digit string
 * above it cannot be a Telegram id, and binding it anyway fails the whole
 * request in Postgres (`22003 value out of range for type bigint`, Prisma
 * P2020) — a 500 for what is only a search that matches nobody.
 */
const MAX_POSTGRES_BIGINT = 9223372036854775807n;

@Injectable()
export class PaymentsTransactionsService {
  public constructor(
    private readonly prismaService: PrismaService,
    private readonly subscriptionQuoteService: SubscriptionQuoteService,
  ) {}

  public async listTransactions(
    query: ListTransactionsQueryDto,
  ): Promise<{ readonly items: readonly AdminPaymentTransactionListItemInterface[]; readonly total: number }> {
    const where: Prisma.TransactionWhereInput = {};
    // Filters that are themselves a choice between columns. Collected apart and
    // joined under `AND`: written straight into `where.OR`, the second would
    // silently replace the first.
    const alternatives: Prisma.TransactionWhereInput[] = [];

    if (query.userId !== undefined) {
      where.userId = query.userId;
    }
    if (query.subscriptionId !== undefined) {
      // A combined renewal names no subscription of its own; each one it pays
      // for is a line item. Those payments are resolved FIRST, by the indexed
      // `transaction_items.subscription_id`, and joined in as plain ids: written
      // as `subscriptionId = X OR items: { some: … }` the second branch is a
      // subquery, Postgres cannot combine it with the first, and it scanned
      // every row of `transactions` (twice — page and count). As ids, the OR is
      // a BitmapOr of the `subscription_id` index and the primary key.
      const lineItems = await this.prismaService.transactionItem.findMany({
        where: { subscriptionId: query.subscriptionId },
        select: { transactionId: true },
      });
      const lineItemTransactionIds = [...new Set(lineItems.map((item) => item.transactionId))];
      alternatives.push({
        OR: [
          { subscriptionId: query.subscriptionId },
          ...(lineItemTransactionIds.length > 0 ? [{ id: { in: lineItemTransactionIds } }] : []),
        ],
      });
    }
    if (query.q !== undefined) {
      // Exact on all three, so each branch is an index lookup (`payment_id` is
      // unique, `gateway_id` indexed since 20260918120000, `id` the key).
      alternatives.push({
        OR: [
          { paymentId: { in: paymentIdCandidates(query.q) } },
          { gatewayId: query.q },
          { id: query.q },
        ],
      });
    }
    if (query.status) {
      where.status = query.status;
    }
    if (query.gatewayType) {
      where.gatewayType = query.gatewayType;
    }
    if (query.purchaseType) {
      where.purchaseType = query.purchaseType;
    }
    if (query.dateFrom || query.dateTo) {
      where.createdAt = {};
      if (query.dateFrom) {
        where.createdAt.gte = new Date(query.dateFrom);
      }
      if (query.dateTo) {
        where.createdAt.lte = new Date(query.dateTo);
      }
    }
    // Universal user search: Telegram ID, email, username, or internal CUID
    if (query.userSearch) {
      const search = query.userSearch.trim();
      if (search.length > 0) {
        const isNumeric = /^\d+$/.test(search);
        if (isNumeric && BigInt(search) > MAX_POSTGRES_BIGINT) {
          // All digits and past `int8`: not a Telegram id, and the other three
          // things this searches (a cuid, an email, a username) are never all
          // digits. Nobody matches — said without asking Postgres, which would
          // fail the request instead (see MAX_POSTGRES_BIGINT).
          return { items: [], total: 0 };
        }
        const matchingUsers = await this.prismaService.user.findMany({
          where: isNumeric
            ? { telegramId: BigInt(search) }
            : {
                OR: [
                  { id: search },
                  { email: { equals: search, mode: 'insensitive' } },
                  { username: { equals: search, mode: 'insensitive' } },
                ],
              },
          select: { id: true },
          take: 50,
        });
        if (matchingUsers.length === 0) {
          // No matching users — return empty result immediately
          return { items: [], total: 0 };
        }
        const matchingUserIds = matchingUsers.map((u) => u.id);
        if (query.userId === undefined) {
          where.userId = { in: matchingUserIds };
        } else if (!matchingUserIds.includes(query.userId)) {
          // Both filters name a customer, and not the same one. This used to
          // overwrite `where.userId`, so the search box silently replaced the
          // client a `?userId=` link had opened the list on — showing another
          // customer's payments under the first one's filter.
          return { items: [], total: 0 };
        }
      }
    }
    if (alternatives.length > 0) {
      where.AND = alternatives;
    }

    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;

    const [transactions, total] = await Promise.all([
      this.prismaService.transaction.findMany({
        where,
        include: {
          user: { select: { id: true, telegramId: true, username: true, name: true, email: true } },
          items: { select: { subscriptionId: true } },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
        skip: offset,
      }),
      this.prismaService.transaction.count({ where }),
    ]);

    return {
      items: transactions.map((tx) => ({
        ...mapAdminPaymentTransaction(tx, tx.user),
        fulfilledAt: tx.fulfilledAt?.toISOString() ?? null,
        lineItemSubscriptionIds: [...new Set(tx.items.map((item) => item.subscriptionId))],
        conversionWithheld: readWithheldConversion(tx.gatewayData),
      })),
      total,
    };
  }

  public async createDraft(
    input: CreateTransactionDraftDto,
  ): Promise<AdminPaymentTransactionInterface> {
    return this.createDraftInternal(input, false);
  }

  /**
   * Trusted checkout entry point. Unlike the admin draft endpoint it may
   * reserve a paid-trial quota slot because its callers proceed directly to a
   * provider charge or partner-balance debit.
   */
  public async createCheckoutDraft(
    input: CreateTransactionDraftDto,
    options: {
      /**
       * The buyer chose «для автоматического списания» on a gateway whose
       * provider runs the subscription. A separate option rather than a DTO
       * field so the admin draft endpoint can never create one.
       */
      readonly providerSubscription?: boolean;
    } = {},
  ): Promise<AdminPaymentTransactionInterface> {
    return this.createDraftInternal(input, true, options.providerSubscription === true);
  }

  private async createDraftInternal(
    input: CreateTransactionDraftDto,
    allowPaidTrialReservation: boolean,
    providerSubscription = false,
  ): Promise<AdminPaymentTransactionInterface> {
    if ((input.purchaseType as unknown as string) === 'TRIAL') {
      throw new BadRequestException({
        code: 'PAYMENT_DRAFT_TRIAL_UNSUPPORTED',
        message: 'Trial purchases cannot be converted to transaction drafts.',
      });
    }
    const channel = input.channel ?? PurchaseChannel.WEB;

    // Idempotent checkout replay must be resolved before quote eligibility:
    // the draft's own unresolved RESERVED unit intentionally consumes the last
    // slot and would otherwise make its replay quote look ineligible.
    const replay = await this.findReusablePendingDraftByRequest(input, channel);
    const replayAvailability =
      replay === null ? null : readSnapshotAvailability(replay.planSnapshot);

    // Enforce the per-user subscription cap for purchases that CREATE a new
    // subscription (NEW / ADDITIONAL). Previously the cap lived only in the
    // action-policy (UI gating), so a direct checkout call — or the reiwa
    // edge racing the policy — could exceed `maxSubscriptions` and buy an
    // unlimited number of subscriptions even with multi-subscription
    // disabled. RENEW / UPGRADE operate on an existing subscription and never
    // increase the count, so they are exempt (renewing an expired sub must
    // stay possible at the cap). Add-on top-ups run through
    // `AddOnPurchaseService` (not this draft path) and never create a new sub.
    //
    // A buyer holding a trial is refused first, and with a code of its own: the
    // purchase converts that trial (UPGRADE), which takes no slot, so at the cap
    // too "upgrade your trial" is the answer and "limit reached" is not. See
    // `isConvertibleTrial`.
    if (
      input.purchaseType === PurchaseType.NEW ||
      input.purchaseType === PurchaseType.ADDITIONAL
    ) {
      const capacity = await this.subscriptionQuoteService.getSubscriptionCapacity(input.userId);
      if (capacity.convertibleTrialId !== null) {
        throw new BadRequestException({
          code: 'TRIAL_UPGRADE_REQUIRED',
          message:
            'The user holds a trial subscription; a purchase upgrades it instead of creating another subscription.',
        });
      }
      if (!capacity.capacityAvailable) {
        throw new BadRequestException({
          code: 'SUBSCRIPTION_LIMIT_REACHED',
          message: 'The user has reached the maximum number of active subscriptions.',
        });
      }
    }
    const quote = await this.subscriptionQuoteService.getQuote({
      userId: input.userId,
      purchaseType: input.purchaseType,
      subscriptionId: input.sourceSubscriptionId,
      planId: input.planId,
      durationDays: input.durationDays,
      channel,
      gatewayType: input.gatewayType,
      currencyOverride: input.currencyOverride,
      // `replayAvailability` is only non-null when `replay` is, so the added
      // `replay !== null` selects the same branch — it is there so the compiler
      // can see the link the reader already knows, instead of a bare `!`. Same
      // shape as the paid-trial guard below.
      ...(replay !== null && replayAvailability === PlanAvailability.TRIAL
        ? { excludeTrialTransactionId: replay.id }
        : {}),
    });
    if (
      !quote.isEligible ||
      quote.price === null ||
      quote.selectedPlan === null ||
      quote.selectedDuration === null
    ) {
      // A plan or term no longer offered gets a code of its own. The safe
      // filter strips `warnings`, so under the shared code below a client
      // cannot tell a withdrawn plan from any other refusal — and the cabinet's
      // answer to a withdrawn plan (drop the stale list, choose again) is a
      // loop for everything else. Allowlisted in `AdminSafeExceptionFilter`.
      if (isPlanAvailabilityRefusal(quote.warnings)) {
        throw new BadRequestException({
          code: 'PAYMENT_DRAFT_PLAN_NOT_AVAILABLE',
          message: 'The selected plan or duration is no longer available.',
          warnings: quote.warnings,
        });
      }
      throw new BadRequestException({
        code: 'PAYMENT_DRAFT_QUOTE_NOT_ELIGIBLE',
        message: 'Quote is not eligible for transaction draft creation.',
        warnings: quote.warnings,
      });
    }
    // Bind the values the guard above just proved non-null. The paid-trial path
    // does its work inside a `$transaction` callback, and narrowing on a
    // property does not cross that function boundary — the compiler must be able
    // to see the proof at the point of use, not only where it was made.
    const selectedPlan = quote.selectedPlan;
    const price = quote.price;
    if (selectedPlan.availability === PlanAvailability.TRIAL && !allowPaidTrialReservation) {
      throw trialDraftRequiresCheckout();
    }
    // The subscription a RENEW or an UPGRADE acts on. The quote selects the
    // buyer's latest one when the request names none, and it does so for every
    // purchase type — which is why a purchase that CREATES a subscription (NEW,
    // ADDITIONAL) records none: its subscription does not exist until fulfilment
    // writes it. Recording the selected one pointed everything that reads the
    // payment before then at somebody else's subscription: a provider
    // subscription made from it renewed the OLD one while the new one lapsed,
    // or the sweep cancelled it as "moved to another plan".
    const sourceSubscriptionId = input.sourceSubscriptionId ?? quote.selectedSubscriptionId ?? null;
    const draftSubscriptionId = createsSubscription(input.purchaseType) ? null : sourceSubscriptionId;
    // Read for every UPGRADE: whether it converts the buyer's trial is marked on
    // the draft, and fulfilment refuses a second conversion of one trial
    // (`isTrialConversionSnapshot`). A RENEW needs it only to be a provider
    // subscription.
    const source =
      input.purchaseType === PurchaseType.UPGRADE ||
      (providerSubscription && input.purchaseType === PurchaseType.RENEW)
        ? await this.readSourceSubscription(input.userId, sourceSubscriptionId)
        : null;
    const convertsTrial =
      input.purchaseType === PurchaseType.UPGRADE && source !== null && isConvertibleTrial(source);
    let providerSubscriptionTerms: ProviderSubscriptionTerms | null = null;
    if (providerSubscription) {
      // The provider repeats the first charge's sum every period, and each
      // later charge is delivered as a RENEW of one subscription. So a purchase
      // may become one when its first charge buys what every later charge
      // will: the plan's full price for one whole term of it.
      //
      // A new subscription (NEW, ADDITIONAL) is created by its first charge and
      // renewed by the later ones; a RENEW renews the one it names. So is the
      // UPGRADE of a trial the buyer holds — what buying beside a trial is
      // (`isConvertibleTrial`). It is priced like a new purchase, the target
      // plan's full price with nothing credited for the trial, and its term
      // starts at payment (`UPGRADE_RESETS_EXPIRY`); the subscription it
      // converts is the one the later charges renew. Any other UPGRADE stays
      // refused: a change of a plan somebody already pays for was never
      // offered this way. A paid trial is a one-off by definition.
      if (
        input.purchaseType !== PurchaseType.NEW &&
        input.purchaseType !== PurchaseType.ADDITIONAL &&
        input.purchaseType !== PurchaseType.RENEW &&
        !convertsTrial
      ) {
        throw autopayNotAvailable('PURCHASE_TYPE');
      }
      if (selectedPlan.availability === PlanAvailability.TRIAL) {
        throw autopayNotAvailable('TRIAL');
      }
      // A renewal onto another plan — an archived plan's replacement, a plan
      // chosen at renewal — leaves the subscription on its old plan until the
      // new plan's term begins, which is the end of the current one when terms
      // are durable. The sweep would read that as a move and cancel the
      // sign-up, silently. Refused here instead, where the buyer is told.
      if (
        input.purchaseType === PurchaseType.RENEW &&
        source !== null &&
        renewsOntoAnotherPlan(source.planSnapshot, selectedPlan.id)
      ) {
        throw autopayNotAvailable('PLAN_CHANGE');
      }
      const resolved = resolveProviderSubscriptionTerms({
        gatewayType: input.gatewayType,
        currency: price.currency,
        amount: price.price,
        durationDays: quote.selectedDuration.days,
        discountSource: price.discountSource,
        planId: selectedPlan.id,
        // The trial is named from the start: it is the subscription the later
        // charges renew, and the checkout refuses a second live provider
        // subscription on it. Until its first charge lands the trial is still
        // on the trial's plan — `strandedReason` knows (`trialConversion`).
        subscriptionId:
          input.purchaseType === PurchaseType.RENEW || convertsTrial ? sourceSubscriptionId : null,
      });
      if ('refusal' in resolved) {
        throw autopayNotAvailable(resolved.refusal);
      }
      providerSubscriptionTerms = resolved.terms;
    }
    // The terms sit in the snapshot, so the pending-draft reuse below, which
    // compares snapshots, never hands an ordinary payment link to a buyer who
    // chose automatic charging, nor the reverse.
    const draftPlanSnapshot = buildTransactionDraftSnapshot({
      purchaseType: input.purchaseType,
      selectedPlan,
      selectedDurationDays: quote.selectedDuration.days,
      providerSubscription: providerSubscriptionTerms,
      convertsTrial,
    });
    const draftMatch = {
      userId: input.userId,
      subscriptionId: draftSubscriptionId,
      purchaseType: input.purchaseType,
      channel,
      gatewayType: input.gatewayType,
      currency: price.currency,
      amount: price.price,
      planSnapshot: draftPlanSnapshot,
    } as const;

    if (replay !== null && replayAvailability === PlanAvailability.TRIAL) {
      if (!matchesPendingDraft(replay, draftMatch)) {
        throw new BadRequestException({
          code: 'TRIAL_PENDING_CHECKOUT_STALE',
          message:
            'The pending paid-trial checkout no longer matches current terms and must be resolved before starting another.',
        });
      }
      await this.ensureExistingTrialReservation(replay, selectedPlan.trialSettings);
      return mapAdminPaymentTransaction(replay);
    }

    if (selectedPlan.availability === PlanAvailability.TRIAL) {
      const transaction = await this.prismaService.$transaction(async (tx) => {
        await lockTrialClaimUser(tx, input.userId);
        const existingPendingDraft = await this.findExistingPendingDraft(draftMatch, tx);
        if (existingPendingDraft !== null) {
          const existingClaim = await tx.trialClaim.findUnique({
            where: { transactionId: existingPendingDraft.id },
          });
          if (existingClaim === null || existingClaim.status === 'RELEASED') {
            const usedUnits = await countCommittedTrialClaimUnits(tx, input.userId);
            if (usedUnits >= selectedPlan.trialSettings.maxClaims) {
              throw trialClaimLimitReached();
            }
          }
          await reservePaidTrialClaim(tx, {
            userId: input.userId,
            planId: selectedPlan.id,
            transactionId: existingPendingDraft.id,
          });
          return existingPendingDraft;
        }
        const usedUnits = await countCommittedTrialClaimUnits(tx, input.userId);
        if (usedUnits >= selectedPlan.trialSettings.maxClaims) {
          // The draft could not be reused (different gateway, currency or
          // amount), so a second reservation would be required — which the
          // quota forbids. Name the real obstacle: if the block comes from the
          // buyer's own unfinished attempt, that attempt is resolvable.
          const resumable = await findResumablePaidTrialClaim(tx, input.userId);
          throw resumable === null ? trialClaimLimitReached() : trialPendingCheckoutBlocks();
        }
        const created = await tx.transaction.create({
          data: {
            userId: input.userId,
            subscriptionId: draftSubscriptionId,
            status: TransactionStatus.PENDING,
            purchaseType: input.purchaseType,
            channel,
            gatewayType: input.gatewayType,
            currency: price.currency,
            amount: price.price,
            planSnapshot: draftPlanSnapshot as Prisma.InputJsonValue,
            deviceTypes: input.deviceType ? [input.deviceType] : [],
          },
        });
        await reservePaidTrialClaim(tx, {
          userId: input.userId,
          planId: selectedPlan.id,
          transactionId: created.id,
        });
        return created;
      });
      return mapAdminPaymentTransaction(transaction);
    }

    const existingPendingDraft = await this.findExistingPendingDraft(draftMatch);
    if (existingPendingDraft !== null) {
      return mapAdminPaymentTransaction(existingPendingDraft);
    }
    const createdTransaction = await this.prismaService.transaction.create({
      data: {
        userId: input.userId,
        subscriptionId: draftSubscriptionId,
        status: TransactionStatus.PENDING,
        purchaseType: input.purchaseType,
        channel,
        gatewayType: input.gatewayType,
        currency: price.currency,
        amount: price.price,
        planSnapshot: draftPlanSnapshot as Prisma.InputJsonValue,
        deviceTypes: input.deviceType ? [input.deviceType] : [],
      },
    });
    return mapAdminPaymentTransaction(createdTransaction);
  }

  private async findExistingPendingDraft(input: {
    readonly userId: string;
    readonly subscriptionId: string | null;
    readonly purchaseType: PurchaseType;
    readonly channel: PurchaseChannel;
    readonly gatewayType: Transaction['gatewayType'];
    readonly currency: Transaction['currency'];
    readonly amount: string;
    readonly planSnapshot: Record<string, unknown>;
  }, client: Pick<Prisma.TransactionClient, 'transaction'> = this.prismaService): Promise<Transaction | null> {
    const pendingTransactions = await client.transaction.findMany({
      where: {
        userId: input.userId,
        subscriptionId: input.subscriptionId,
        status: TransactionStatus.PENDING,
        purchaseType: input.purchaseType,
        channel: input.channel,
        gatewayType: input.gatewayType,
        currency: input.currency,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 10,
    });
    return pendingTransactions.find((transaction) => matchesPendingDraft(transaction, input)) ?? null;
  }

  private async findReusablePendingDraftByRequest(
    input: CreateTransactionDraftDto,
    channel: PurchaseChannel,
  ): Promise<Transaction | null> {
    const pending = await this.prismaService.transaction.findMany({
      where: {
        userId: input.userId,
        subscriptionId: input.sourceSubscriptionId ?? null,
        status: TransactionStatus.PENDING,
        purchaseType: input.purchaseType,
        channel,
        gatewayType: input.gatewayType,
        ...(input.currencyOverride === undefined ? {} : { currency: input.currencyOverride }),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 10,
    });
    return (
      pending.find((transaction) => {
        const snapshot = readSnapshotRecord(transaction.planSnapshot);
        return (
          snapshot?.['id'] === input.planId &&
          snapshot['selectedDurationDays'] === input.durationDays &&
          snapshot['purchaseType'] === input.purchaseType
        );
      }) ?? null
    );
  }

  /**
   * The subscription a RENEW or an UPGRADE names: whether it is a trial of this
   * buyer's the purchase converts — the rule the draft guard above and the
   * action policy use (`isConvertibleTrial`) — and which plan it is on now.
   * Read by id and owner.
   */
  private async readSourceSubscription(
    userId: string,
    subscriptionId: string | null,
  ): Promise<Pick<Subscription, 'isTrial' | 'status' | 'planSnapshot'> | null> {
    if (subscriptionId === null) return null;
    return this.prismaService.subscription.findFirst({
      where: { id: subscriptionId, userId },
      select: { isTrial: true, status: true, planSnapshot: true },
    });
  }

  private async ensureExistingTrialReservation(
    transaction: Transaction,
    settings: TrialSettings,
  ): Promise<void> {
    await this.prismaService.$transaction(async (tx) => {
      await lockTrialClaimUser(tx, transaction.userId);
      const existing = await tx.trialClaim.findUnique({
        where: { transactionId: transaction.id },
      });
      if (
        existing?.status === TrialClaimStatus.RESERVED ||
        existing?.status === TrialClaimStatus.CONSUMED
      ) {
        return;
      }
      const usedUnits = await countCommittedTrialClaimUnits(tx, transaction.userId);
      if (usedUnits >= settings.maxClaims) {
        throw trialClaimLimitReached();
      }
      await reservePaidTrialClaim(tx, {
        userId: transaction.userId,
        planId: readSnapshotPlanId(transaction.planSnapshot),
        transactionId: transaction.id,
      });
    });
  }
}

function mapAdminPaymentTransaction(
  transaction: Transaction,
  user?: { id: string; telegramId: bigint | null; username: string | null; name: string; email: string | null } | null,
): AdminPaymentTransactionInterface {
  return {
    id: transaction.id,
    paymentId: transaction.paymentId,
    userId: transaction.userId,
    userTelegramId: user?.telegramId?.toString() ?? null,
    userUsername: user?.username ?? null,
    userName: user?.name ?? null,
    userEmail: user?.email ?? null,
    subscriptionId: transaction.subscriptionId,
    status: transaction.status,
    purchaseType: transaction.purchaseType,
    channel: transaction.channel,
    gatewayType: transaction.gatewayType,
    currency: transaction.currency,
    amount: transaction.amount.toString(),
    paymentAsset: transaction.paymentAsset,
    gatewayId: transaction.gatewayId,
    planSnapshot: transaction.planSnapshot,
    createdAt: transaction.createdAt.toISOString(),
    updatedAt: transaction.updatedAt.toISOString(),
  };
}

/**
 * Every `payment_id` a searched reference can name: itself, and — unless it
 * already carries one — the same number under each importer's namespace, the
 * form the cabinet shows an imported payment in (IMPORTED_PAYMENT_ID_PREFIXES).
 * All equalities on the unique `payment_id` index.
 */
function paymentIdCandidates(reference: string): string[] {
  const namespaced = IMPORTED_PAYMENT_ID_PREFIXES.some((prefix) => reference.startsWith(`${prefix}:`));
  return namespaced
    ? [reference]
    : [reference, ...IMPORTED_PAYMENT_ID_PREFIXES.map((prefix) => `${prefix}:${reference}`)];
}

/** A purchase whose fulfilment creates its subscription, rather than acting on one. */
function createsSubscription(purchaseType: PurchaseType): boolean {
  return purchaseType === PurchaseType.NEW || purchaseType === PurchaseType.ADDITIONAL;
}

function buildTransactionDraftSnapshot(input: {
  readonly purchaseType: PurchaseType;
  readonly selectedPlan: {
    readonly id: string;
    readonly name: string;
    readonly availability: PlanAvailability;
    readonly tag: string | null;
    readonly type: string;
    readonly trafficLimit: number | null;
    readonly deviceLimit: number;
    readonly trafficLimitStrategy: string;
    readonly trialSettings?: TrialSettings;
  };
  readonly selectedDurationDays: number;
  readonly providerSubscription?: ProviderSubscriptionTerms | null;
  /** The UPGRADE converts the buyer's trial — see `isTrialConversionSnapshot`. */
  readonly convertsTrial?: boolean;
}): Record<string, unknown> {
  return {
    ...(input.providerSubscription
      ? { [PROVIDER_SUBSCRIPTION_SNAPSHOT_KEY]: input.providerSubscription }
      : {}),
    ...(input.convertsTrial === true ? { [TRIAL_CONVERSION_SNAPSHOT_KEY]: true } : {}),
    id: input.selectedPlan.id,
    name: input.selectedPlan.name,
    availability: input.selectedPlan.availability,
    tag: input.selectedPlan.tag,
    type: input.selectedPlan.type,
    trafficLimit: input.selectedPlan.trafficLimit,
    deviceLimit: input.selectedPlan.deviceLimit,
    trafficLimitStrategy: input.selectedPlan.trafficLimitStrategy,
    ...(input.selectedPlan.availability === PlanAvailability.TRIAL
      ? { trialSettings: input.selectedPlan.trialSettings ?? readTrialSettings(null) }
      : {}),
    selectedDurationDays: input.selectedDurationDays,
    purchaseType: input.purchaseType,
    snapshotSource: 'ADMIN_TRANSACTION_DRAFT',
  };
}

function readSnapshotRecord(value: Prisma.JsonValue): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readSnapshotAvailability(value: Prisma.JsonValue): PlanAvailability | null {
  const availability = readSnapshotRecord(value)?.['availability'];
  return Object.values(PlanAvailability).includes(availability as PlanAvailability)
    ? (availability as PlanAvailability)
    : null;
}

function readSnapshotPlanId(value: Prisma.JsonValue): string | null {
  const id = readSnapshotRecord(value)?.['id'];
  return typeof id === 'string' && id.length > 0 ? id : null;
}

function trialDraftRequiresCheckout(): BadRequestException {
  return new BadRequestException({
    code: 'TRIAL_DRAFT_REQUIRES_CHECKOUT',
    message: 'Paid trial drafts must be created by a checkout that reserves trial capacity.',
  });
}

function trialClaimLimitReached(): BadRequestException {
  return new BadRequestException({
    code: 'TRIAL_ALREADY_USED',
    message: 'User has reached the trial claim limit',
  });
}

/**
 * The quota is full only because of the buyer's OWN unfinished attempt.
 *
 * Reported apart from `TRIAL_ALREADY_USED` because the two demand opposite
 * things of the buyer: one says the trial is spent and there is nothing to do,
 * the other says an attempt is still open and can be finished or abandoned.
 * Telling someone their trial is used up while it is sitting in their own
 * unpaid draft is how the original report started.
 */
function trialPendingCheckoutBlocks(): BadRequestException {
  return new BadRequestException({
    code: 'TRIAL_PENDING_CHECKOUT_STALE',
    message:
      'A paid-trial checkout is still pending for this user; finish or abandon it before starting another.',
  });
}

function matchesPendingDraft(
  transaction: Transaction,
  input: {
    readonly amount: string;
    readonly planSnapshot: Record<string, unknown>;
  },
): boolean {
  return (
    transaction.amount.toString() === input.amount &&
    stableJsonStringify(transaction.planSnapshot) === stableJsonStringify(input.planSnapshot)
  );
}

function stableJsonStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJsonStringify(entry)).join(',')}]`;
  }
  const objectValue = value as Record<string, unknown>;
  const sortedKeys = Object.keys(objectValue).sort((left, right) => left.localeCompare(right));
  return `{${sortedKeys
    .map((key) => `${JSON.stringify(key)}:${stableJsonStringify(objectValue[key])}`)
    .join(',')}}`;
}
