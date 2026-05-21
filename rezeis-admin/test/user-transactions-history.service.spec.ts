import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Currency, PaymentGatewayType, PurchaseChannel, PurchaseType, TransactionStatus } from '@prisma/client';

import { UserTransactionsHistoryService } from '../src/modules/user-activity/services/user-transactions-history.service';

type UserTransactionsPrisma = ConstructorParameters<typeof UserTransactionsHistoryService>[0];
type TransactionCountArgs = Parameters<UserTransactionsPrisma['transaction']['count']>[0];
type TransactionFindManyArgs = Parameters<UserTransactionsPrisma['transaction']['findMany']>[0];
type TransactionRecord = {
  id: string;
  paymentId: string;
  userId: string;
  subscriptionId: string | null;
  status: TransactionStatus;
  purchaseType: PurchaseType;
  channel: PurchaseChannel;
  gatewayType: PaymentGatewayType;
  currency: Currency;
  amount: { toString: () => string };
  paymentAsset: string | null;
  gatewayId: string | null;
  planSnapshot: unknown;
  createdAt: Date;
  updatedAt: Date;
};
type UserTransactionsPrismaDouble = {
  transaction: {
    count: (args: TransactionCountArgs) => Promise<number>;
    findMany: (args: TransactionFindManyArgs) => Promise<TransactionRecord[]>;
  };
};

describe('UserTransactionsHistoryService', () => {
  it('returns paginated transactions ordered newest first', async () => {
    const state = { countArgs: [] as unknown[], findManyArgs: [] as unknown[] };
    const prismaDouble: UserTransactionsPrismaDouble = {
      transaction: {
        count: async (args: TransactionCountArgs) => {
          state.countArgs.push(args);
          return 2;
        },
        findMany: async (args: TransactionFindManyArgs) => {
          state.findManyArgs.push(args);
          return [
            createTransaction({ id: 'tx-2', paymentId: 'payment-2', amount: '12.50' }),
            createTransaction({ id: 'tx-1', paymentId: 'payment-1', amount: '8.00' }),
          ];
        },
      },
    };
    const service = new UserTransactionsHistoryService(prismaDouble as unknown as UserTransactionsPrisma);

    const result = await service.listTransactions({
      userId: 'user-1',
      page: 2,
      limit: 10,
      status: TransactionStatus.COMPLETED,
      gatewayType: PaymentGatewayType.YOOKASSA,
      purchaseType: PurchaseType.NEW,
    });

    assert.deepStrictEqual(result, {
      items: [
        {
          id: 'tx-2',
          paymentId: 'payment-2',
          userId: 'user-1',
          subscriptionId: null,
          status: TransactionStatus.COMPLETED,
          purchaseType: PurchaseType.NEW,
          channel: PurchaseChannel.WEB,
          gatewayType: PaymentGatewayType.YOOKASSA,
          currency: Currency.USD,
          amount: '12.50',
          paymentAsset: null,
          gatewayId: null,
          planSnapshot: { id: 'plan-1' },
          createdAt: '2026-04-20T00:00:00.000Z',
          updatedAt: '2026-04-20T00:00:00.000Z',
        },
        {
          id: 'tx-1',
          paymentId: 'payment-1',
          userId: 'user-1',
          subscriptionId: null,
          status: TransactionStatus.COMPLETED,
          purchaseType: PurchaseType.NEW,
          channel: PurchaseChannel.WEB,
          gatewayType: PaymentGatewayType.YOOKASSA,
          currency: Currency.USD,
          amount: '8.00',
          paymentAsset: null,
          gatewayId: null,
          planSnapshot: { id: 'plan-1' },
          createdAt: '2026-04-20T00:00:00.000Z',
          updatedAt: '2026-04-20T00:00:00.000Z',
        },
      ],
      total: 2,
      page: 2,
      limit: 10,
    });
    assert.deepStrictEqual(state.countArgs, [
      {
        where: {
          userId: 'user-1',
          status: TransactionStatus.COMPLETED,
          gatewayType: PaymentGatewayType.YOOKASSA,
          purchaseType: PurchaseType.NEW,
        },
      },
    ]);
    assert.deepStrictEqual(state.findManyArgs, [
      {
        where: {
          userId: 'user-1',
          status: TransactionStatus.COMPLETED,
          gatewayType: PaymentGatewayType.YOOKASSA,
          purchaseType: PurchaseType.NEW,
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: 10,
        take: 10,
      },
    ]);
  });
});

function createTransaction(input: {
  readonly id: string;
  readonly paymentId: string;
  readonly amount: string;
}) {
  return {
    id: input.id,
    paymentId: input.paymentId,
    userId: 'user-1',
    subscriptionId: null,
    status: TransactionStatus.COMPLETED,
    purchaseType: PurchaseType.NEW,
    channel: PurchaseChannel.WEB,
    gatewayType: PaymentGatewayType.YOOKASSA,
    currency: Currency.USD,
    amount: { toString: (): string => input.amount },
    paymentAsset: null,
    gatewayId: null,
    planSnapshot: { id: 'plan-1' },
    createdAt: new Date('2026-04-20T00:00:00.000Z'),
    updatedAt: new Date('2026-04-20T00:00:00.000Z'),
  };
}
