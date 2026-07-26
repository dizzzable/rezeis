import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Currency, PaymentGatewayType, PurchaseChannel, PurchaseType, TransactionStatus } from '@prisma/client';

import { AdminJwtAuthGuard } from '../src/modules/auth/guards/admin-jwt-auth.guard';
import { AdminPaymentTransactionsController } from '../src/modules/payments/controllers/admin-payment-transactions.controller';
import { PaymentRefundService } from '../src/modules/payments/services/payment-refund.service';
import { PaymentsTransactionsService } from '../src/modules/payments/services/payments-transactions.service';
import { REQUIRE_PERMISSION_KEY } from '../src/modules/rbac/decorators/require-permission.decorator';
import { RbacGuard } from '../src/modules/rbac/guards/rbac.guard';

describe('AdminPaymentTransactionsController', () => {
  it('exposes transaction admin routes behind explicit payment RBAC', () => {
    assert.equal(
      Reflect.getMetadata(PATH_METADATA, AdminPaymentTransactionsController),
      'admin/payments/transactions',
    );
    assert.deepStrictEqual(
      Reflect.getMetadata(GUARDS_METADATA, AdminPaymentTransactionsController),
      [AdminJwtAuthGuard, RbacGuard],
    );
    assertRoute(AdminPaymentTransactionsController.prototype.listTransactions, '/', RequestMethod.GET, 'view');
    assertRoute(AdminPaymentTransactionsController.prototype.createDraft, 'draft', RequestMethod.POST, 'create');
    assertRoute(
      AdminPaymentTransactionsController.prototype.getRefundEligibility,
      ':transactionId/refund-eligibility',
      RequestMethod.GET,
      'view',
    );
    // Issuing money back is gated on its own permission, NOT on `edit` — a role
    // that may correct transaction metadata must not inherit the ability to
    // refund.
    assertRoute(
      AdminPaymentTransactionsController.prototype.refundTransaction,
      ':transactionId/refund',
      RequestMethod.POST,
      'refund',
    );
  });

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
    const refundService = {
      getEligibility: async (transactionId: string) => {
        calls.push(['refundEligibility', transactionId]);
        return {
          refundable: true,
          reason: null,
          refundableAmount: '8.00',
          currency: 'USD',
          refundedAmount: '0.00',
        };
      },
      refundTransaction: async (input: { transactionId: string; amount: string | null }) => {
        calls.push(['refund', input.transactionId, input.amount]);
        return {
          transactionId: input.transactionId,
          refundId: 'refund-1',
          amount: '8.00',
          currency: 'USD',
          providerStatus: 'succeeded',
        };
      },
    } as unknown as PaymentRefundService;
    const controller = new AdminPaymentTransactionsController(transactionsService, refundService);
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
    assert.equal((await controller.getRefundEligibility('transaction-1')).refundable, true);
    assert.equal(
      (
        await controller.refundTransaction(
          'transaction-1',
          { amount: '5.00', reason: 'duplicate charge' },
          { id: 'admin-1' } as never,
          { headers: {}, ip: '203.0.113.5', socket: { remoteAddress: '203.0.113.5' } } as never,
        )
      ).refundId,
      'refund-1',
    );

    assert.deepStrictEqual(calls, [
      ['list', query],
      ['createDraft', draft],
      ['refundEligibility', 'transaction-1'],
      ['refund', 'transaction-1', '5.00'],
    ]);
  });
});

function assertRoute(method: unknown, path: string | undefined, requestMethod: RequestMethod, action: string): void {
  assert.equal(Reflect.getMetadata(PATH_METADATA, method), path);
  assert.equal(Reflect.getMetadata(METHOD_METADATA, method), requestMethod);
  assert.deepStrictEqual(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, method), [
    { resource: 'payments', action },
  ]);
}
