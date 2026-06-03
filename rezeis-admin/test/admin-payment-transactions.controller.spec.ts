import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Currency, PaymentGatewayType, PurchaseChannel, PurchaseType, TransactionStatus } from '@prisma/client';

import { AdminPaymentTransactionsController } from '../src/modules/payments/controllers/admin-payment-transactions.controller';
import { PaymentsTransactionsService } from '../src/modules/payments/services/payments-transactions.service';

describe('AdminPaymentTransactionsController', () => {
  it('delegates current transaction list and draft endpoints', async () => {
    const calls: unknown[] = [];
    const transactionsService = {
      listTransactions: async (query: unknown) => {
        calls.push(['list', query]);
        return { items: [], total: 0 };
      },
      createDraft: async (input: unknown) => {
        calls.push(['createDraft', input]);
        return {
          id: 'transaction-1',
          paymentId: 'payment-1',
          userId: 'user-1',
          userTelegramId: null,
          userUsername: null,
          userName: null,
          userEmail: null,
          subscriptionId: null,
          status: TransactionStatus.PENDING,
          purchaseType: PurchaseType.NEW,
          channel: PurchaseChannel.WEB,
          gatewayType: PaymentGatewayType.YOOKASSA,
          currency: Currency.USD,
          amount: '8',
          paymentAsset: null,
          gatewayId: null,
          planSnapshot: {},
          createdAt: '2026-04-19T12:00:00.000Z',
          updatedAt: '2026-04-19T12:00:00.000Z',
        };
      },
    } as unknown as PaymentsTransactionsService;
    const controller = new AdminPaymentTransactionsController(transactionsService);
    const query = {
      userSearch: 'alice',
      status: TransactionStatus.PENDING,
      gatewayType: PaymentGatewayType.YOOKASSA,
      purchaseType: PurchaseType.NEW,
      limit: 25,
      offset: 5,
    } as Parameters<AdminPaymentTransactionsController['listTransactions']>[0];
    const draft = {
      userId: 'user-1',
      purchaseType: PurchaseType.NEW,
      planId: 'plan-1',
      durationDays: 30,
      gatewayType: PaymentGatewayType.YOOKASSA,
      channel: PurchaseChannel.WEB,
    } as Parameters<AdminPaymentTransactionsController['createDraft']>[0];

    assert.deepStrictEqual(await controller.listTransactions(query), { items: [], total: 0 });
    assert.equal((await controller.createDraft(draft)).id, 'transaction-1');

    assert.deepStrictEqual(calls, [
      ['list', query],
      ['createDraft', draft],
    ]);
  });
});
