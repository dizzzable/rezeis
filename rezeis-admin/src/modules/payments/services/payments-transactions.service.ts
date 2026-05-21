import { BadRequestException, Injectable } from '@nestjs/common';
import {
  Prisma,
  PurchaseChannel,
  PurchaseType,
  Transaction,
  TransactionStatus,
} from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { SubscriptionQuoteService } from '../../subscriptions/services/subscription-quote.service';
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
    if ((input.purchaseType as unknown as string) === 'TRIAL') {
      throw new BadRequestException({
        code: 'PAYMENT_DRAFT_TRIAL_UNSUPPORTED',
        message: 'Trial purchases cannot be converted to transaction drafts.',
      });
    }
    const channel = input.channel ?? PurchaseChannel.WEB;
    const quote = await this.subscriptionQuoteService.getQuote({
      userId: input.userId,
      purchaseType: input.purchaseType,
      subscriptionId: input.sourceSubscriptionId,
      planId: input.planId,
      durationDays: input.durationDays,
      channel,
      gatewayType: input.gatewayType,
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
    const draftPlanSnapshot = buildTransactionDraftSnapshot({
      purchaseType: input.purchaseType,
      selectedPlan: quote.selectedPlan,
      selectedDurationDays: quote.selectedDuration.days,
    });
    const existingPendingDraft = await this.findExistingPendingDraft({
      userId: input.userId,
      subscriptionId: input.sourceSubscriptionId ?? quote.selectedSubscriptionId ?? null,
      purchaseType: input.purchaseType,
      channel,
      gatewayType: input.gatewayType,
      currency: quote.price.currency,
      amount: quote.price.price,
      planSnapshot: draftPlanSnapshot,
    });
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
        deviceTypes: [],
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
  }): Promise<Transaction | null> {
    const pendingTransactions = await this.prismaService.transaction.findMany({
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
    const expectedPlanSnapshot = stableJsonStringify(input.planSnapshot);
    return (
      pendingTransactions.find(
        (transaction) =>
          transaction.amount.toString() === input.amount &&
          stableJsonStringify(transaction.planSnapshot) === expectedPlanSnapshot,
      ) ?? null
    );
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
    readonly tag: string | null;
    readonly type: string;
    readonly trafficLimit: number | null;
    readonly deviceLimit: number;
    readonly trafficLimitStrategy: string;
  };
  readonly selectedDurationDays: number;
}): Record<string, unknown> {
  return {
    id: input.selectedPlan.id,
    name: input.selectedPlan.name,
    tag: input.selectedPlan.tag,
    type: input.selectedPlan.type,
    trafficLimit: input.selectedPlan.trafficLimit,
    deviceLimit: input.selectedPlan.deviceLimit,
    trafficLimitStrategy: input.selectedPlan.trafficLimitStrategy,
    selectedDurationDays: input.selectedDurationDays,
    purchaseType: input.purchaseType,
    snapshotSource: 'ADMIN_TRANSACTION_DRAFT',
  };
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
