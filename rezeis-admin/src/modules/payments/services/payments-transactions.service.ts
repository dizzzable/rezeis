import { BadRequestException, Injectable } from '@nestjs/common';
import {
  PlanAvailability,
  Prisma,
  PurchaseChannel,
  PurchaseType,
  Transaction,
  TransactionStatus,
  TrialClaimStatus,
} from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { readTrialSettings, TrialSettings } from '../../plans/utils/trial-settings.util';
import { SubscriptionQuoteService } from '../../subscriptions/services/subscription-quote.service';
import {
  countCommittedTrialClaimUnits,
  lockTrialClaimUser,
  findResumablePaidTrialClaim,
  reservePaidTrialClaim,
} from '../../subscriptions/services/trial-claim-ledger.util';
import { CreateTransactionDraftDto } from '../dto/create-transaction-draft.dto';
import { ListTransactionsQueryDto } from '../dto/list-transactions-query.dto';
import { AdminPaymentTransactionInterface } from '../interfaces/admin-payment-transaction.interface';

@Injectable()
export class PaymentsTransactionsService {
  public constructor(
    private readonly prismaService: PrismaService,
    private readonly subscriptionQuoteService: SubscriptionQuoteService,
  ) {}

  public async listTransactions(
    query: ListTransactionsQueryDto,
  ): Promise<{ readonly items: readonly AdminPaymentTransactionInterface[]; readonly total: number }> {
    const where: Prisma.TransactionWhereInput = {};

    if (query.userId) {
      where.userId = query.userId;
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
        if (matchingUsers.length > 0) {
          where.userId = { in: matchingUsers.map((u) => u.id) };
        } else {
          // No matching users — return empty result immediately
          return { items: [], total: 0 };
        }
      }
    }

    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;

    const [transactions, total] = await Promise.all([
      this.prismaService.transaction.findMany({
        where,
        include: {
          user: { select: { id: true, telegramId: true, username: true, name: true, email: true } },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
        skip: offset,
      }),
      this.prismaService.transaction.count({ where }),
    ]);

    return {
      items: transactions.map((tx) => mapAdminPaymentTransaction(tx, tx.user)),
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
  ): Promise<AdminPaymentTransactionInterface> {
    return this.createDraftInternal(input, true);
  }

  private async createDraftInternal(
    input: CreateTransactionDraftDto,
    allowPaidTrialReservation: boolean,
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
    if (
      input.purchaseType === PurchaseType.NEW ||
      input.purchaseType === PurchaseType.ADDITIONAL
    ) {
      const capacity = await this.subscriptionQuoteService.getSubscriptionCapacity(input.userId);
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
      ...(replayAvailability === PlanAvailability.TRIAL
        ? { excludeTrialTransactionId: replay!.id }
        : {}),
    });
    if (
      !quote.isEligible ||
      quote.price === null ||
      quote.selectedPlan === null ||
      quote.selectedDuration === null
    ) {
      throw new BadRequestException({
        code: 'PAYMENT_DRAFT_QUOTE_NOT_ELIGIBLE',
        message: 'Quote is not eligible for transaction draft creation.',
        warnings: quote.warnings,
      });
    }
    if (
      quote.selectedPlan.availability === PlanAvailability.TRIAL &&
      !allowPaidTrialReservation
    ) {
      throw trialDraftRequiresCheckout();
    }
    const draftPlanSnapshot = buildTransactionDraftSnapshot({
      purchaseType: input.purchaseType,
      selectedPlan: quote.selectedPlan,
      selectedDurationDays: quote.selectedDuration.days,
    });
    const draftMatch = {
      userId: input.userId,
      subscriptionId: input.sourceSubscriptionId ?? quote.selectedSubscriptionId ?? null,
      purchaseType: input.purchaseType,
      channel,
      gatewayType: input.gatewayType,
      currency: quote.price.currency,
      amount: quote.price.price,
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
      await this.ensureExistingTrialReservation(replay, quote.selectedPlan.trialSettings);
      return mapAdminPaymentTransaction(replay);
    }

    if (quote.selectedPlan.availability === PlanAvailability.TRIAL) {
      const transaction = await this.prismaService.$transaction(async (tx) => {
        await lockTrialClaimUser(tx, input.userId);
        const existingPendingDraft = await this.findExistingPendingDraft(draftMatch, tx);
        if (existingPendingDraft !== null) {
          const existingClaim = await tx.trialClaim.findUnique({
            where: { transactionId: existingPendingDraft.id },
          });
          if (existingClaim === null || existingClaim.status === 'RELEASED') {
            const usedUnits = await countCommittedTrialClaimUnits(tx, input.userId);
            if (usedUnits >= quote.selectedPlan.trialSettings.maxClaims) {
              throw trialClaimLimitReached();
            }
          }
          await reservePaidTrialClaim(tx, {
            userId: input.userId,
            planId: quote.selectedPlan.id,
            transactionId: existingPendingDraft.id,
          });
          return existingPendingDraft;
        }
        const usedUnits = await countCommittedTrialClaimUnits(tx, input.userId);
        if (usedUnits >= quote.selectedPlan.trialSettings.maxClaims) {
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
            subscriptionId: input.sourceSubscriptionId ?? quote.selectedSubscriptionId ?? null,
            status: TransactionStatus.PENDING,
            purchaseType: input.purchaseType,
            channel,
            gatewayType: input.gatewayType,
            currency: quote.price.currency,
            amount: quote.price.price,
            planSnapshot: draftPlanSnapshot as Prisma.InputJsonValue,
            deviceTypes: input.deviceType ? [input.deviceType] : [],
          },
        });
        await reservePaidTrialClaim(tx, {
          userId: input.userId,
          planId: quote.selectedPlan.id,
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
        subscriptionId: input.sourceSubscriptionId ?? quote.selectedSubscriptionId ?? null,
        status: TransactionStatus.PENDING,
        purchaseType: input.purchaseType,
        channel,
        gatewayType: input.gatewayType,
        currency: quote.price.currency,
        amount: quote.price.price,
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
}): Record<string, unknown> {
  return {
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
