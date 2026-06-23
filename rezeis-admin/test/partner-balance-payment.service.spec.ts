import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { PurchaseType, TransactionStatus } from '@prisma/client';

import { PartnerBalancePaymentService } from '../src/modules/payments/services/partner-balance-payment.service';

interface Overrides {
  readonly allowBalancePayment?: boolean;
  readonly partner?: { id: string; isActive: boolean; balance: number } | null;
  readonly draftAmount?: string;
  readonly accessRejection?: { code: string; status: 403 | 503; message: string } | null;
}

function build(overrides: Overrides = {}) {
  const calls: string[] = [];
  const partner = overrides.partner === undefined
    ? { id: 'partner-1', isActive: true, balance: 1000 }
    : overrides.partner;
  const draftAmount = overrides.draftAmount ?? '5.00';

  const prismaService = {
    user: {
      findUnique: async () => ({ id: 'user-1', partnerBalanceCurrencyOverride: null }),
      findFirst: async () => ({ id: 'user-1', partnerBalanceCurrencyOverride: null }),
    },
    partner: {
      findUnique: async () => partner,
      updateMany: async (args: { where: { balance: { gte: number } } }) => {
        calls.push(`debit:${args.where.balance.gte}`);
        return { count: partner && partner.balance >= args.where.balance.gte ? 1 : 0 };
      },
      update: async () => {
        calls.push('restore');
        return partner;
      },
    },
    transaction: {
      findUnique: async () => ({
        id: 'tx-1',
        paymentId: 'pay-1',
        status: TransactionStatus.COMPLETED,
        gatewayType: 'PARTNER_BALANCE',
        purchaseType: PurchaseType.NEW,
        amount: { toString: () => draftAmount },
        currency: 'RUB',
        createdAt: new Date('2026-06-24T00:00:00.000Z'),
      }),
      update: async () => {
        calls.push('complete');
        return {
          id: 'tx-1',
          paymentId: 'pay-1',
          status: TransactionStatus.COMPLETED,
          gatewayType: 'PARTNER_BALANCE',
          purchaseType: PurchaseType.NEW,
          amount: { toString: () => draftAmount },
          currency: 'RUB',
          createdAt: new Date('2026-06-24T00:00:00.000Z'),
        };
      },
    },
  };

  const settingsService = {
    getInternalPlatformPolicy: async () => ({ accessMode: 'PUBLIC', defaultCurrency: 'RUB' }),
    getPartnerSettings: async () => ({ allowBalancePayment: overrides.allowBalancePayment ?? true }),
  };
  const accessModeGuard = {
    evaluate: () => overrides.accessRejection ?? null,
  };
  const paymentsTransactionsService = {
    createDraft: async () => {
      calls.push('createDraft');
      return { id: 'tx-1', paymentId: 'pay-1', amount: draftAmount };
    },
  };
  const paymentSubscriptionMutationService = {
    applyCompletedTransaction: async () => {
      calls.push('fulfill');
      return { syncJobs: [{ id: 'job-1' }] };
    },
  };
  const profileSyncQueueService = { enqueue: async (id: string) => calls.push(`enqueue:${id}`) };
  const events = { info: () => undefined };

  const service = new PartnerBalancePaymentService(
    prismaService as never,
    settingsService as never,
    accessModeGuard as never,
    paymentsTransactionsService as never,
    paymentSubscriptionMutationService as never,
    profileSyncQueueService as never,
    events as never,
  );
  return { service, calls };
}

const baseInput = {
  userId: 'user-1',
  purchaseType: PurchaseType.NEW,
  planId: 'plan-1',
  durationDays: 30,
};

describe('PartnerBalancePaymentService', () => {
  it('rejects when the operator disabled balance payment', async () => {
    const { service } = build({ allowBalancePayment: false });
    await assert.rejects(service.pay(baseInput), ForbiddenException);
  });

  it('rejects when the user is not an active partner', async () => {
    const { service } = build({ partner: null });
    await assert.rejects(service.pay(baseInput), ForbiddenException);
  });

  it('rejects when the balance is insufficient', async () => {
    const { service } = build({ partner: { id: 'partner-1', isActive: true, balance: 100 } });
    await assert.rejects(service.pay(baseInput), BadRequestException);
  });

  it('debits the balance, fulfils the transaction and completes it', async () => {
    const { service, calls } = build();
    const result = await service.pay(baseInput);

    assert.equal(result.transactionStatus, TransactionStatus.COMPLETED);
    assert.equal(result.checkoutUrl, null);
    assert.equal(result.amount, '5.00');
    // Order: price → debit (500 minor) → fulfil → mark completed → enqueue sync.
    assert.deepStrictEqual(calls, [
      'createDraft',
      'debit:500',
      'fulfill',
      'complete',
      'enqueue:job-1',
    ]);
  });
});
