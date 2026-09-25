import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Prisma } from '@prisma/client';

import { EVENT_TYPES } from '../src/common/services/system-events.service';
import { resolveAddOnRolloutFlags } from '../src/modules/add-on-entitlements/add-on-rollout.config';
import {
  ADD_ON_NOT_APPLIED_NOTICE_TYPE,
  DEFAULT_NOTIFICATION_TEMPLATES,
} from '../src/modules/notifications/catalog/default-templates.catalog';
import { isSubscriberNotificationEnabled } from '../src/modules/notifications/utils/notification-toggle.util';
import { PaymentSubscriptionMutationService } from '../src/modules/payments/services/payment-subscription-mutation.service';

/**
 * A PAID ADD-ON THAT COULD NOT BE APPLIED IS TOLD TO THE CUSTOMER (review R3a-07).
 *
 * A «до сброса» add-on paid for a subscription that was no longer active when
 * the money came in is recorded as fulfilled with no limit change, and the
 * operator gets «Докупка оплачена, но не применена». The customer, whose return
 * page shows a completed payment, used to hear nothing. Now they get ONE notice
 * from the templates catalogue — `addon_not_applied`, which the operator sees
 * and edits in «Карта бота» — and nothing is refunded by itself: the operator
 * decides, from the card.
 *
 * Only for that reason, because the notice says «подписка сейчас не активна»:
 * the rarer reasons are the operator's card alone. Only when money was taken:
 * «Оплата … получена» is not true of a free add-on. And a notice that cannot be
 * sent never undoes a recorded payment.
 *
 * Driven through the REAL `applyCompletedTransaction` over a transaction double
 * that stages exactly what the not-applied branches read and write.
 */

const PLAN_SNAPSHOT = { id: 'plan-1', name: 'Pro', trafficLimit: 100, deviceLimit: 3, trafficLimitStrategy: 'MONTH' };

interface Emitted {
  readonly severity: string;
  readonly type: string;
  readonly message: string;
  readonly metadata: Record<string, unknown>;
}

interface Notice {
  readonly userId: string;
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

function harness(input: {
  /** The subscription's status when the money comes in. */
  readonly status: 'ACTIVE' | 'EXPIRED' | 'DISABLED';
  readonly amount: string;
  /** −5 is an add-on the catalogue value makes incoherent: another reason it is not applied. */
  readonly addOnValue?: number;
  /** How the notice goes: sent, refused by the notifications service, or no service at all. */
  readonly notices?: 'sent' | 'refused' | 'no service';
}) {
  const fulfilment: Array<Record<string, unknown>> = [];
  const limitWrites: Array<Record<string, unknown>> = [];
  const tx = {
    subscription: {
      findUnique: async () => ({
        id: 'sub-1',
        userId: 'user-1',
        status: input.status,
        remnawaveId: 'rw-1',
        planSnapshot: PLAN_SNAPSHOT,
        trafficLimit: 100,
        deviceLimit: 3,
        expiresAt: new Date(Date.now() - 86_400_000),
      }),
      update: async ({ data }: { data: Record<string, unknown> }) => {
        limitWrites.push(data);
        return {};
      },
    },
    profileSyncJob: { create: async ({ data }: { data: object }) => ({ id: 'job-1', ...data }) },
    transaction: {
      update: async ({ data }: { data: Record<string, unknown> }) => {
        fulfilment.push(data);
        return {};
      },
    },
  };
  const prismaService = {
    transactionItem: { findMany: async () => [] },
    $transaction: async (work: (client: unknown) => Promise<unknown>) => work(tx),
  };

  const emitted: Emitted[] = [];
  const record =
    (severity: string) =>
    (type: string, _category: string, message: string, metadata: Record<string, unknown> = {}) => {
      emitted.push({ severity, type, message, metadata });
    };
  const notices: Notice[] = [];
  const userNotifications =
    input.notices === 'no service'
      ? undefined
      : {
          create: async (notice: Notice) => {
            notices.push(notice);
            if (input.notices === 'refused') throw new Error('the notifications table is unreachable');
            return 'event-1';
          },
        };
  // Stage 4 on, as it is when a «до сброса» quote is sold.
  const switches = {
    flags: async () => resolveAddOnRolloutFlags({ durableAccounting: true, trafficResetExpiry: true }, {}),
  };

  const service = new PaymentSubscriptionMutationService(
    prismaService as never,
    { info: record('INFO'), warn: record('WARNING'), error: record('ERROR') } as never,
    {} as never,
    {} as never,
    {} as never,
    // `TrafficResetService`: nothing here buys a reset.
    {} as never,
    {} as never,
    switches as never,
    userNotifications as never,
  );
  const warnings: string[] = [];
  (service as unknown as { logger: object }).logger = {
    log: () => undefined,
    warn: (message: string) => warnings.push(message),
    error: (message: string) => warnings.push(message),
  };

  const transaction = {
    id: 'tx-1',
    paymentId: 'pay-1',
    userId: 'user-1',
    subscriptionId: null,
    status: 'COMPLETED',
    purchaseType: 'ADDITIONAL',
    channel: 'WEB',
    gatewayType: 'YOOKASSA',
    currency: 'RUB',
    amount: new Prisma.Decimal(input.amount),
    createdAt: new Date(),
    planSnapshot: {
      snapshotSource: 'ADDON_PURCHASE',
      targetSubscriptionId: 'sub-1',
      addOnId: 'addon-1',
      addOnType: 'EXTRA_TRAFFIC',
      addOnValue: input.addOnValue ?? 50,
      name: 'Extra 50 GB',
      sourceLineKey: 'addon-1',
      lifetime: 'UNTIL_NEXT_RESET',
    },
  };

  const completion = (): Emitted => {
    const cards = emitted.filter((event) => event.type === EVENT_TYPES.PAYMENT_COMPLETED);
    assert.equal(cards.length, 1, 'exactly one completion card');
    return cards[0]!;
  };

  return { service, transaction, fulfilment, limitWrites, notices, warnings, completion };
}

describe('a paid add-on that could not be applied is told to the customer', () => {
  it('the subscription is no longer active: ONE notice, from the catalogue, naming the add-on', async () => {
    const env = harness({ status: 'EXPIRED', amount: '99' });

    await env.service.applyCompletedTransaction(env.transaction as never);

    assert.deepEqual(env.notices, [
      {
        userId: 'user-1',
        type: 'addon_not_applied',
        payload: { addon: 'Extra 50 GB', subscriptionId: 'sub-1', paymentId: 'pay-1' },
      },
    ]);
    // …beside what was already there: the payment settled with no limit moved,
    // and the operator's card asking them to decide about the money.
    assert.equal(env.limitWrites.length, 0, 'no limit moves');
    assert.equal(env.fulfilment.length, 1);
    assert.ok(env.fulfilment[0]!['fulfilledAt'] instanceof Date, 'settled, so it is not retried');
    const card = env.completion();
    assert.equal(card.message, 'Докупка оплачена, но не применена');
    assert.equal(card.metadata['needsManualReview'], true);
  });

  it('any status that is not ACTIVE or LIMITED is «не активна»: a disabled subscription is told too', async () => {
    const env = harness({ status: 'DISABLED', amount: '99' });

    await env.service.applyCompletedTransaction(env.transaction as never);

    assert.equal(env.notices.length, 1);
    assert.equal(env.notices[0]!.type, ADD_ON_NOT_APPLIED_NOTICE_TYPE);
  });

  it('nothing was charged: no notice — «Оплата … получена» would not be true', async () => {
    const env = harness({ status: 'EXPIRED', amount: '0' });

    await env.service.applyCompletedTransaction(env.transaction as never);

    assert.deepEqual(env.notices, []);
    // The operator's card still says it was not applied, and that there is nothing to refund.
    const card = env.completion();
    assert.equal(card.message, 'Докупка оплачена, но не применена');
    assert.match(String(card.metadata['note']), /Денег по ней не списано/);
  });

  it('not applied for another reason (a catalogue value that adds nothing): the card only, no notice', async () => {
    const env = harness({ status: 'ACTIVE', amount: '99', addOnValue: -5 });

    await env.service.applyCompletedTransaction(env.transaction as never);

    const card = env.completion();
    assert.equal(card.message, 'Докупка оплачена, но не применена', 'fixture: not applied, and why');
    assert.match(String(card.metadata['note']), /неверное значение/);
    assert.deepEqual(env.notices, [], '«подписка сейчас не активна» would not be true of an active one');
  });

  it('the notice cannot be written: the payment stays settled, the card goes out, and the failure is logged', async () => {
    const env = harness({ status: 'EXPIRED', amount: '99', notices: 'refused' });

    await env.service.applyCompletedTransaction(env.transaction as never);

    assert.equal(env.notices.length, 1, 'it was tried');
    assert.equal(env.fulfilment.length, 1);
    assert.ok(env.fulfilment[0]!['fulfilledAt'] instanceof Date);
    assert.equal(env.completion().message, 'Докупка оплачена, но не применена');
    assert.ok(
      env.warnings.some((line) => line.includes('pay-1') && line.includes('the notifications table is unreachable')),
      `logged with the payment: ${env.warnings.join(' | ')}`,
    );
  });

  it('without a notifications service (a hand-built fulfilment): settled as before', async () => {
    const env = harness({ status: 'EXPIRED', amount: '99', notices: 'no service' });

    await env.service.applyCompletedTransaction(env.transaction as never);

    assert.equal(env.fulfilment.length, 1);
    assert.equal(env.completion().message, 'Докупка оплачена, но не применена');
  });
});

describe('the notice is in the templates catalogue, so «Карта бота» shows it', () => {
  function notAppliedTemplate() {
    const template = DEFAULT_NOTIFICATION_TEMPLATES.find((entry) => entry.type === ADD_ON_NOT_APPLIED_NOTICE_TYPE);
    assert.ok(template, 'addon_not_applied ships a template');
    return template;
  }

  it('says what the owner asked, with the add-on named', () => {
    const template = notAppliedTemplate();
    assert.equal(
      template.body.replace('{{addon}}', 'Extra 50 GB'),
      'Оплата докупки «Extra 50 GB» получена, но применить её не удалось — подписка сейчас не активна. ' +
        'Мы разберёмся и свяжемся с вами.',
    );
    assert.ok(template.title.trim().length > 0);
  });

  it('has an English version, with the add-on named', () => {
    const template = notAppliedTemplate();
    assert.ok((template.titleEn ?? '').trim().length > 0);
    const bodyEn = template.bodyEn ?? '';
    assert.ok(bodyEn.includes('{{addon}}'));
    assert.match(bodyEn, /not active/);
  });

  it('is not a switch the customer can turn off: it is about their money', () => {
    const muted = { [ADD_ON_NOT_APPLIED_NOTICE_TYPE]: false };
    assert.equal(isSubscriberNotificationEnabled(muted, ADD_ON_NOT_APPLIED_NOTICE_TYPE), true);
  });
});
