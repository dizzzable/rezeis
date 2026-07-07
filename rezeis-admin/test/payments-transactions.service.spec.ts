import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BadRequestException } from '@nestjs/common';
import {
  Currency,
  PaymentGatewayType,
  PurchaseChannel,
  PurchaseType,
  TransactionStatus,
} from '@prisma/client';

import { CreateTransactionDraftDto } from '../src/modules/payments/dto/create-transaction-draft.dto';
import { PaymentsTransactionsService } from '../src/modules/payments/services/payments-transactions.service';

describe('PaymentsTransactionsService', () => {
  it('lists transactions with user search, filters, and mapped user fields', async () => {
    const { service, state } = createService({
      matchingUsers: [{ id: 'user-1' }, { id: 'user-2' }],
      listTransactions: [
        createStoredTransaction({
          id: 'transaction-1',
          paymentId: 'payment-1',
          userId: 'user-1',
          amount: '12.50',
          user: {
            id: 'user-1',
            telegramId: 12345n,
            username: 'alice',
            name: 'Alice',
            email: 'alice@example.test',
          },
        }),
      ],
      listTotal: 1,
    });

    const result = await service.listTransactions({
      userSearch: 'alice',
      status: TransactionStatus.PENDING,
      gatewayType: PaymentGatewayType.YOOKASSA,
      purchaseType: PurchaseType.NEW,
      dateFrom: '2026-04-01T00:00:00.000Z',
      dateTo: '2026-04-30T23:59:59.999Z',
      limit: 25,
      offset: 5,
    });

    assert.equal(result.total, 1);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0]?.id, 'transaction-1');
    assert.equal(result.items[0]?.userTelegramId, '12345');
    assert.equal(result.items[0]?.userUsername, 'alice');
    assert.equal(result.items[0]?.amount, '12.50');
    assert.deepStrictEqual(state.userFindManyCalls[0], {
      where: {
        OR: [
          { id: 'alice' },
          { email: { equals: 'alice', mode: 'insensitive' } },
          { username: { equals: 'alice', mode: 'insensitive' } },
        ],
      },
      select: { id: true },
      take: 50,
    });
    assert.deepStrictEqual(state.transactionCountCalls[0], {
      where: {
        userId: { in: ['user-1', 'user-2'] },
        status: TransactionStatus.PENDING,
        gatewayType: PaymentGatewayType.YOOKASSA,
        purchaseType: PurchaseType.NEW,
        createdAt: {
          gte: new Date('2026-04-01T00:00:00.000Z'),
          lte: new Date('2026-04-30T23:59:59.999Z'),
        },
      },
    });
    assert.equal(state.transactionListCalls[0]?.take, 25);
    assert.equal(state.transactionListCalls[0]?.skip, 5);
  });

  it('returns an empty list without querying transactions when user search has no match', async () => {
    const { service, state } = createService({ matchingUsers: [] });

    const result = await service.listTransactions({ userSearch: 'missing-user' });

    assert.deepStrictEqual(result, { items: [], total: 0 });
    assert.equal(state.transactionListCalls.length, 0);
    assert.equal(state.transactionCountCalls.length, 0);
  });

  it('creates pending transaction draft from eligible quote', async () => {
    const { service, state } = createService({
      quoteResult: createEligibleQuote(),
    });

    const transaction = await service.createDraft({
      userId: 'user-1',
      purchaseType: PurchaseType.NEW,
      planId: 'plan-1',
      durationDays: 30,
      gatewayType: PaymentGatewayType.YOOKASSA,
      channel: PurchaseChannel.WEB,
      deviceType: 'ANDROID',
    });

    assert.equal(transaction.status, TransactionStatus.PENDING);
    assert.equal(transaction.purchaseType, PurchaseType.NEW);
    assert.equal(transaction.gatewayType, PaymentGatewayType.YOOKASSA);
    assert.equal(transaction.currency, Currency.USD);
    assert.equal(transaction.amount, '8');
    assert.equal(state.transactionCreateCalls.length, 1);
    assert.deepStrictEqual(state.transactionCreateCalls[0], {
      userId: 'user-1',
      subscriptionId: null,
      status: TransactionStatus.PENDING,
      purchaseType: PurchaseType.NEW,
      channel: PurchaseChannel.WEB,
      gatewayType: PaymentGatewayType.YOOKASSA,
      currency: Currency.USD,
      amount: '8',
      planSnapshot: createDraftSnapshot(PurchaseType.NEW),
      deviceTypes: ['ANDROID'],
    });
  });

  it('rejects ineligible quotes and does not create transaction', async () => {
    const { service, state } = createService({
      quoteResult: {
        ...createEligibleQuote(),
        isEligible: false,
        warnings: [{ code: 'GATEWAY_NOT_AVAILABLE', message: 'Gateway not available' }],
      },
    });

    await assert.rejects(async () => {
      await service.createDraft({
        userId: 'user-1',
        purchaseType: PurchaseType.NEW,
        planId: 'plan-1',
        durationDays: 30,
        gatewayType: PaymentGatewayType.YOOKASSA,
        channel: PurchaseChannel.WEB,
      });
    }, (error: unknown) => {
      assert.ok(error instanceof BadRequestException);
      assert.deepStrictEqual(error.getResponse(), {
        code: 'PAYMENT_DRAFT_QUOTE_NOT_ELIGIBLE',
        message: 'Quote is not eligible for transaction draft creation.',
        warnings: [{ code: 'GATEWAY_NOT_AVAILABLE', message: 'Gateway not available' }],
      });
      return true;
    });

    assert.equal(state.transactionCreateCalls.length, 0);
  });

  it('rejects TRIAL transaction draft payloads before quoting', async () => {
    const { service, state } = createService({
      quoteResult: createEligibleQuote(),
    });
    const input = new CreateTransactionDraftDto();
    input.userId = 'user-1';
    input.purchaseType = PurchaseType.NEW;
    input.planId = 'plan-1';
    input.durationDays = 30;
    input.gatewayType = PaymentGatewayType.YOOKASSA;
    input.channel = PurchaseChannel.WEB;
    Reflect.set(input, 'purchaseType', 'TRIAL');

    await assert.rejects(async () => {
      await service.createDraft(input);
    }, (error: unknown) => {
      assert.ok(error instanceof BadRequestException);
      assert.deepStrictEqual(error.getResponse(), {
        code: 'PAYMENT_DRAFT_TRIAL_UNSUPPORTED',
        message: 'Trial purchases cannot be converted to transaction drafts.',
      });
      return true;
    });
    assert.equal(state.quoteCalls, 0);
  });

  it('rejects a NEW draft when the subscription cap is reached', async () => {
    const { service, state } = createService({
      quoteResult: createEligibleQuote(),
      capacityAvailable: false,
    });

    await assert.rejects(async () => {
      await service.createDraft({
        userId: 'user-1',
        purchaseType: PurchaseType.NEW,
        planId: 'plan-1',
        durationDays: 30,
        gatewayType: PaymentGatewayType.YOOKASSA,
        channel: PurchaseChannel.WEB,
      });
    }, (error: unknown) => {
      assert.ok(error instanceof BadRequestException);
      assert.deepStrictEqual(error.getResponse(), {
        code: 'SUBSCRIPTION_LIMIT_REACHED',
        message: 'The user has reached the maximum number of active subscriptions.',
      });
      return true;
    });

    // The cap guard must short-circuit BEFORE quoting or writing anything.
    assert.equal(state.quoteCalls, 0);
    assert.equal(state.transactionCreateCalls.length, 0);
  });

  it('allows an ADDITIONAL draft when capacity remains', async () => {
    const { service, state } = createService({
      quoteResult: createEligibleQuote(),
      capacityAvailable: true,
    });

    const transaction = await service.createDraft({
      userId: 'user-1',
      purchaseType: PurchaseType.ADDITIONAL,
      planId: 'plan-1',
      durationDays: 30,
      gatewayType: PaymentGatewayType.YOOKASSA,
      channel: PurchaseChannel.WEB,
    });

    assert.equal(transaction.id, 'transaction-1');
    assert.equal(state.transactionCreateCalls.length, 1);
  });

  it('reuses an existing pending draft for the same quote context', async () => {
    const { service, state } = createService({
      quoteResult: createEligibleQuote(),
      existingDrafts: [
        createStoredTransaction({
          id: 'transaction-existing',
          paymentId: 'payment-existing',
          planSnapshot: {
            snapshotSource: 'ADMIN_TRANSACTION_DRAFT',
            purchaseType: PurchaseType.NEW,
            selectedDurationDays: 30,
            trafficLimitStrategy: 'NO_RESET',
            deviceLimit: 1,
            trafficLimit: 1024,
            type: 'BOTH',
            tag: null,
            name: 'Starter',
            id: 'plan-1',
          },
        }),
      ],
    });

    const transaction = await service.createDraft({
      userId: 'user-1',
      purchaseType: PurchaseType.NEW,
      planId: 'plan-1',
      durationDays: 30,
      gatewayType: PaymentGatewayType.YOOKASSA,
      channel: PurchaseChannel.WEB,
    });

    assert.equal(transaction.id, 'transaction-existing');
    assert.equal(transaction.paymentId, 'payment-existing');
    assert.equal(state.transactionCreateCalls.length, 0);
  });
});

function createService(input: {
  readonly quoteResult?: QuoteResult;
  readonly existingDrafts?: readonly StoredTransaction[];
  readonly listTransactions?: readonly StoredTransaction[];
  readonly listTotal?: number;
  readonly matchingUsers?: readonly { readonly id: string }[];
  /** Subscription-cap mock: capacityAvailable defaults to true. */
  readonly capacityAvailable?: boolean;
  readonly capacityMax?: number;
}): {
  readonly service: PaymentsTransactionsService;
  readonly state: {
    readonly quoteCalls: number;
    readonly userFindManyCalls: unknown[];
    readonly transactionListCalls: Array<Record<string, unknown>>;
    readonly transactionCountCalls: unknown[];
    readonly transactionCreateCalls: Record<string, unknown>[];
  };
} {
  const transactionCreateCalls: Record<string, unknown>[] = [];
  const transactionListCalls: Array<Record<string, unknown>> = [];
  const transactionCountCalls: unknown[] = [];
  const userFindManyCalls: unknown[] = [];
  let quoteCalls = 0;
  const existingDrafts = [...(input.existingDrafts ?? [])];
  const listTransactions = [...(input.listTransactions ?? [])];
  const state = {
    get quoteCalls(): number {
      return quoteCalls;
    },
    userFindManyCalls,
    transactionListCalls,
    transactionCountCalls,
    transactionCreateCalls,
  };
  const prismaService = {
    transaction: {
      findMany: async (args: Record<string, unknown>) => {
        if (args.include) {
          transactionListCalls.push(args);
          return listTransactions;
        }
        return existingDrafts;
      },
      count: async (args: unknown) => {
        transactionCountCalls.push(args);
        return input.listTotal ?? listTransactions.length;
      },
      create: async (args: { readonly data: Record<string, unknown> }) => {
        transactionCreateCalls.push(args.data);
        return createStoredTransaction({
          id: 'transaction-1',
          paymentId: 'payment-1',
          userId: String(args.data.userId),
          subscriptionId: (args.data.subscriptionId as string | null) ?? null,
          status: args.data.status as TransactionStatus,
          purchaseType: args.data.purchaseType as PurchaseType,
          channel: args.data.channel as PurchaseChannel,
          gatewayType: args.data.gatewayType as PaymentGatewayType,
          currency: args.data.currency as Currency,
          amount: String(args.data.amount),
          planSnapshot: args.data.planSnapshot as Record<string, unknown>,
          deviceTypes: args.data.deviceTypes as string[],
        });
      },
    },
    user: {
      findMany: async (args: unknown) => {
        userFindManyCalls.push(args);
        return input.matchingUsers ?? [];
      },
    },
  };
  const quoteService = {
    getQuote: async () => {
      quoteCalls += 1;
      if (!input.quoteResult) {
        throw new Error('Unexpected quote request');
      }
      return input.quoteResult;
    },
    getSubscriptionCapacity: async () => ({
      activeSubscriptionCount: 0,
      effectiveMaxSubscriptions: input.capacityMax ?? 1,
      capacityAvailable: input.capacityAvailable ?? true,
    }),
  };
  return {
    service: new PaymentsTransactionsService(prismaService as never, quoteService as never),
    state,
  };
}

function createEligibleQuote(): QuoteResult {
  return {
    userId: 'user-1',
    purchaseType: PurchaseType.NEW,
    channel: PurchaseChannel.WEB,
    isEligible: true,
    selectedSubscriptionId: null,
    selectedPlan: {
      id: 'plan-1',
      name: 'Starter',
      tag: null,
      type: 'BOTH',
      trafficLimit: 1024,
      deviceLimit: 1,
      trafficLimitStrategy: 'NO_RESET',
      durations: [],
    },
    selectedDuration: {
      id: 'duration-1',
      days: 30,
    },
    availablePlans: [],
    price: {
      gatewayType: PaymentGatewayType.YOOKASSA,
      currency: Currency.USD,
      originalPrice: '10',
      price: '8',
      discountPercent: 20,
      discountSource: 'PURCHASE',
    },
    warnings: [],
  };
}

function createDraftSnapshot(purchaseType: PurchaseType): Record<string, unknown> {
  return {
    id: 'plan-1',
    name: 'Starter',
    tag: null,
    type: 'BOTH',
    trafficLimit: 1024,
    deviceLimit: 1,
    trafficLimitStrategy: 'NO_RESET',
    selectedDurationDays: 30,
    purchaseType,
    snapshotSource: 'ADMIN_TRANSACTION_DRAFT',
  };
}

interface QuoteResult {
  userId: string;
  purchaseType: PurchaseType;
  channel: PurchaseChannel;
  isEligible: boolean;
  selectedSubscriptionId: string | null;
  selectedPlan: {
    id: string;
    name: string;
    tag: string | null;
    type: string;
    trafficLimit: number | null;
    deviceLimit: number;
    trafficLimitStrategy: string;
    durations: readonly unknown[];
  } | null;
  selectedDuration: {
    id: string;
    days: number;
  } | null;
  availablePlans: readonly unknown[];
  price: {
    gatewayType: PaymentGatewayType;
    currency: Currency;
    originalPrice: string;
    price: string;
    discountPercent: number;
    discountSource: string;
  } | null;
  warnings: { code: string; message: string }[];
}

type StoredTransaction = ReturnType<typeof createStoredTransaction>;

function createStoredTransaction(input: {
  readonly id: string;
  readonly paymentId: string;
  readonly userId?: string;
  readonly subscriptionId?: string | null;
  readonly status?: TransactionStatus;
  readonly purchaseType?: PurchaseType;
  readonly channel?: PurchaseChannel;
  readonly gatewayType?: PaymentGatewayType;
  readonly currency?: Currency;
  readonly amount?: string;
  readonly planSnapshot?: Record<string, unknown>;
  readonly deviceTypes?: readonly string[];
  readonly user?: {
    readonly id: string;
    readonly telegramId: bigint | null;
    readonly username: string | null;
    readonly name: string;
    readonly email: string | null;
  } | null;
}) {
  return {
    id: input.id,
    paymentId: input.paymentId,
    userId: input.userId ?? 'user-1',
    subscriptionId: input.subscriptionId ?? null,
    status: input.status ?? TransactionStatus.PENDING,
    purchaseType: input.purchaseType ?? PurchaseType.NEW,
    channel: input.channel ?? PurchaseChannel.WEB,
    gatewayType: input.gatewayType ?? PaymentGatewayType.YOOKASSA,
    currency: input.currency ?? Currency.USD,
    amount: { toString: (): string => input.amount ?? '8' },
    paymentAsset: null,
    gatewayId: null,
    planSnapshot: input.planSnapshot ?? createDraftSnapshot(input.purchaseType ?? PurchaseType.NEW),
    deviceTypes: [...(input.deviceTypes ?? [])],
    createdAt: new Date('2026-04-19T12:00:00.000Z'),
    updatedAt: new Date('2026-04-19T12:00:00.000Z'),
    user: input.user,
  };
}
