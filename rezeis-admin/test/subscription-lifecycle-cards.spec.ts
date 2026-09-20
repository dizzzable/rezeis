import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  Currency,
  PaymentGatewayType,
  PurchaseChannel,
  PurchaseType,
  SubscriptionStatus,
} from '@prisma/client';

import { EVENT_TYPES } from '../src/common/services/system-events.service';
import { PaymentSubscriptionMutationService } from '../src/modules/payments/services/payment-subscription-mutation.service';

/**
 * «🔄 Подписка продлена» and «⬆️ Подписка улучшена» — what happened TO THE
 * SUBSCRIPTION, as opposed to what happened to the money. Both types were
 * registered, titled and tick-boxed since long before this file and raised by
 * nobody; `payment.completed` was the only trace either left.
 */

interface Emitted {
  readonly type: string;
  readonly metadata: Record<string, unknown>;
}

const EXPIRES_AT = new Date('2026-10-20T12:00:00.000Z');

async function complete(purchaseType: PurchaseType): Promise<Emitted[]> {
  const emitted: Emitted[] = [];
  const record = (type: string, _category: string, _message: string, metadata: Record<string, unknown>) => {
    emitted.push({ type, metadata });
  };
  const events = { info: record, warn: record, error: record };

  const prisma = {
    transactionItem: { findMany: async () => [] },
    plan: {
      findUnique: async () => ({
        id: 'plan-1',
        name: 'Премиум',
        type: 'BOTH',
        trafficLimit: 100,
        deviceLimit: 3,
        deletedAt: null,
      }),
    },
    user: {
      findUnique: async () => ({ isBlocked: false, purchaseDiscount: 0 }),
      // The one-time purchase discount is settled after the cards; stubbed so
      // this spec's output stays clean rather than carrying its warning.
      updateMany: async () => ({ count: 0 }),
    },
    userPendingDiscount: { findMany: async () => [] },
  };

  const service = new PaymentSubscriptionMutationService(
    prisma as never,
    events as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const fulfilled = {
    subscription: {
      id: 'sub-1',
      userId: 'user-1',
      remnawaveId: 'rw-1',
      status: SubscriptionStatus.ACTIVE,
      expiresAt: EXPIRES_AT,
    },
    syncJob: { id: 'job-1' },
  };
  const stub = service as unknown as Record<string, () => Promise<unknown>>;
  stub.createSubscriptionFromPayment = async () => fulfilled;
  stub.renewSubscriptionFromPayment = async () => fulfilled;
  stub.upgradeSubscriptionFromPayment = async () => fulfilled;

  await service.applyCompletedTransaction({
    id: 'tx-1',
    userId: 'user-1',
    paymentId: 'pay-1',
    purchaseType,
    amount: { toString: () => '499' },
    currency: Currency.RUB,
    gatewayType: PaymentGatewayType.YOOKASSA,
    channel: PurchaseChannel.WEB,
    planSnapshot: { id: 'plan-1', selectedDurationDays: 30 },
  } as never);

  return emitted;
}

describe('жизненный цикл подписки на карточках оператора', () => {
  it('announces a renewal as its own card, with the plan and the new deadline', async () => {
    const emitted = await complete(PurchaseType.RENEW);

    const renewed = emitted.filter((event) => event.type === EVENT_TYPES.SUBSCRIPTION_RENEWED);
    assert.equal(renewed.length, 1);
    assert.equal(renewed[0].metadata['subscriptionId'], 'sub-1');
    assert.equal(renewed[0].metadata['planName'], 'Премиум');
    assert.equal(renewed[0].metadata['durationDays'], 30);
    assert.equal(renewed[0].metadata['expireAt'], EXPIRES_AT.toISOString());
    assert.equal(renewed[0].metadata['paymentId'], 'pay-1');
    // Beside the payment card, not instead of it: the two answer different
    // questions and an operator can untick either one.
    assert.equal(
      emitted.filter((event) => event.type === EVENT_TYPES.PAYMENT_COMPLETED).length,
      1,
    );
  });

  it('announces an upgrade under its own type', async () => {
    const emitted = await complete(PurchaseType.UPGRADE);

    assert.deepStrictEqual(
      emitted.map((event) => event.type).filter((type) => type.startsWith('subscription.')),
      [EVENT_TYPES.SUBSCRIPTION_UPGRADED],
    );
  });

  it('stays quiet for a NEW purchase — `subscription.created` belongs to provisioning', async () => {
    // The subscription starts being real when its panel profile exists, and
    // that step raises the card. A second one here would announce a
    // subscription that cannot be used yet.
    const emitted = await complete(PurchaseType.NEW);

    assert.deepStrictEqual(
      emitted.map((event) => event.type).filter((type) => type.startsWith('subscription.')),
      [],
    );
  });
});
