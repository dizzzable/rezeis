import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Prisma } from '@prisma/client';

import { EVENT_TYPES } from '../src/common/services/system-events.service';
import { resolveAddOnRolloutFlags } from '../src/modules/add-on-entitlements/add-on-rollout.config';
import {
  ADD_ON_NOT_APPLIED_NOTICE_TYPE,
  ADD_ON_NOT_APPLIED_OTHER_NOTICE_TYPE,
  DEFAULT_NOTIFICATION_TEMPLATES,
} from '../src/modules/notifications/catalog/default-templates.catalog';
import {
  isSubscriberMailableType,
  isSubscriberNotificationEnabled,
  MAILABLE_WITHOUT_SWITCH_TYPES,
  SUBSCRIBER_MUTABLE_NOTIFICATION_TYPES,
} from '../src/modules/notifications/utils/notification-toggle.util';
import { PaymentSubscriptionMutationService } from '../src/modules/payments/services/payment-subscription-mutation.service';
import { executeGatewayDataWrites } from './helpers/gateway-data-write-double';

/**
 * A PAID ADD-ON THAT COULD NOT BE APPLIED (review R3a-07, FX5 items 4 and 5).
 *
 * An add-on paid for and not applied — the subscription no longer active when
 * the money came in, no term, paid after the quoted end, a catalogue value
 * that adds nothing — is recorded as fulfilled with no limit change, and the
 * operator gets «Докупка оплачена, но не применена».
 *
 *  - It is NOT a sale: the card is `payment.withheld`, operator-only, and
 *    `payment.completed` — what automations, pop-ups, outbound webhooks, the
 *    «Платёж получен» letter and the payer's open cabinet read as an order
 *    fulfilled — is not emitted.
 *  - The customer, whose return page shows a completed payment, gets ONE
 *    notice from the templates catalogue, which the operator sees and edits in
 *    «Карта бота»: `addon_not_applied` with the owner's words «…— подписка
 *    сейчас не активна», or, for any other reason, `addon_not_applied_other`,
 *    the same sentence without that clause. Only when money was taken:
 *    «Оплата … получена» is not true of a free add-on.
 *  - The payment is stamped `addOnNotApplied` in the capture's own
 *    transaction, with the atomic `gatewayData` merge: its refund takes no
 *    limit back. So is a payment that added nothing because the subscription
 *    is unlimited in what it adds — that one is still a sale, and no notice.
 *  - A notice that cannot be sent never undoes a recorded payment.
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
  /** Sold «до сброса» (the default) or «до конца подписки», which goes the legacy way when it cannot be ledgered. */
  readonly lifetime?: 'UNTIL_NEXT_RESET' | 'UNTIL_SUBSCRIPTION_END';
  /** The subscription's traffic column; `null` is unlimited. */
  readonly trafficLimit?: number | null;
  /** How the notice goes: sent, refused by the notifications service, or no service at all. */
  readonly notices?: 'sent' | 'refused' | 'no service';
}) {
  const fulfilment: Array<Record<string, unknown>> = [];
  const limitWrites: Array<Record<string, unknown>> = [];
  /** `gatewayData` as each atomic merge left it, in order. */
  const stamps: Array<Record<string, unknown>> = [];
  const tx = {
    subscription: {
      findUnique: async () => ({
        id: 'sub-1',
        userId: 'user-1',
        status: input.status,
        remnawaveId: 'rw-1',
        planSnapshot: PLAN_SNAPSHOT,
        trafficLimit: input.trafficLimit === undefined ? 100 : input.trafficLimit,
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
    $executeRaw: executeGatewayDataWrites({
      currentGatewayData: () => ({}),
      update: async (args) => {
        stamps.push(args.data.gatewayData);
        return {};
      },
    }),
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
      lifetime: input.lifetime ?? 'UNTIL_NEXT_RESET',
    },
  };

  /** The one card of a payment that was not applied: `payment.withheld`, and no `payment.completed`. */
  const withheld = (): Emitted => {
    assert.deepEqual(
      emitted.filter((event) => event.type === EVENT_TYPES.PAYMENT_COMPLETED).map((event) => event.message),
      [],
      'announced as a sale',
    );
    const cards = emitted.filter((event) => event.type === EVENT_TYPES.PAYMENT_WITHHELD);
    assert.equal(cards.length, 1, 'exactly one withheld card');
    return cards[0]!;
  };
  /** The reason the capture stamped, or `undefined`; only ever one stamp. */
  const stampedReason = (): unknown => {
    assert.ok(stamps.length <= 1, `stamped ${stamps.length} times`);
    const stamp = stamps[0]?.['addOnNotApplied'] as Record<string, unknown> | undefined;
    if (stamp !== undefined) assert.equal(typeof stamp['at'], 'string');
    return stamp?.['reason'];
  };

  return { service, transaction, fulfilment, limitWrites, notices, warnings, emitted, withheld, stampedReason };
}

describe('a paid add-on that could not be applied is told to the customer, and is not a sale', () => {
  it('the subscription is no longer active: ONE notice, from the catalogue, naming the add-on', async () => {
    const env = harness({ status: 'EXPIRED', amount: '99' });

    await env.service.applyCompletedTransaction(env.transaction as never);

    assert.deepEqual(env.notices, [
      {
        userId: 'user-1',
        type: 'addon_not_applied',
        payload: { addon: 'Extra 50 GB', subscriptionId: 'sub-1', paymentId: 'pay-1', reason: 'SUBSCRIPTION_NOT_ACTIVE' },
      },
    ]);
    // …beside what was already there: the payment settled with no limit moved,
    // and the operator's card asking them to decide about the money.
    assert.equal(env.limitWrites.length, 0, 'no limit moves');
    assert.equal(env.fulfilment.length, 1);
    assert.ok(env.fulfilment[0]!['fulfilledAt'] instanceof Date, 'settled, so it is not retried');
    const card = env.withheld();
    assert.equal(card.severity, 'WARNING');
    assert.equal(card.message, 'Докупка оплачена, но не применена');
    assert.equal(card.metadata['needsManualReview'], true);
    assert.equal(card.metadata['userId'], 'user-1', 'the card names the customer');
    assert.equal(card.metadata['withheldReason'], 'ADD_ON_NOT_APPLIED');
    assert.equal(card.metadata['addOnNotAppliedReason'], 'SUBSCRIPTION_NOT_ACTIVE');
    assert.equal(env.stampedReason(), 'SUBSCRIPTION_NOT_ACTIVE', 'a refund of it must take nothing back');
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
    const card = env.withheld();
    assert.equal(card.message, 'Докупка оплачена, но не применена');
    assert.match(String(card.metadata['note']), /Денег по ней не списано/);
    assert.equal(env.stampedReason(), 'SUBSCRIPTION_NOT_ACTIVE');
  });

  it('not applied for another reason (a catalogue value that adds nothing): the other notice, without «не активна»', async () => {
    const env = harness({ status: 'ACTIVE', amount: '99', addOnValue: -5 });

    await env.service.applyCompletedTransaction(env.transaction as never);

    const card = env.withheld();
    assert.equal(card.message, 'Докупка оплачена, но не применена', 'fixture: not applied, and why');
    assert.match(String(card.metadata['note']), /неверное значение/);
    assert.equal(card.metadata['addOnNotAppliedReason'], 'INCOHERENT_VALUE');
    assert.deepEqual(env.notices, [
      {
        userId: 'user-1',
        type: ADD_ON_NOT_APPLIED_OTHER_NOTICE_TYPE,
        payload: { addon: 'Extra 50 GB', subscriptionId: 'sub-1', paymentId: 'pay-1', reason: 'INCOHERENT_VALUE' },
      },
    ]);
    assert.equal(env.stampedReason(), 'INCOHERENT_VALUE');
    assert.equal(env.limitWrites.length, 0);
  });

  it('«до конца подписки» with a value that adds nothing goes the legacy way: not applied there too, and told', async () => {
    const env = harness({ status: 'ACTIVE', amount: '99', addOnValue: -5, lifetime: 'UNTIL_SUBSCRIPTION_END' });

    await env.service.applyCompletedTransaction(env.transaction as never);

    assert.equal(env.limitWrites.length, 0, 'the column is left untouched');
    assert.equal(env.fulfilment.length, 1);
    const card = env.withheld();
    assert.equal(card.message, 'Докупка оплачена, но не применена');
    assert.match(String(card.metadata['note']), /^Докупка «Extra 50 GB» оплачена, но у докупки в каталоге неверное значение\./);
    assert.equal(card.metadata['needsManualReview'], true);
    assert.deepEqual(
      env.notices.map((notice) => [notice.type, notice.payload['reason']]),
      [[ADD_ON_NOT_APPLIED_OTHER_NOTICE_TYPE, 'INCOHERENT_VALUE']],
    );
    assert.equal(env.stampedReason(), 'INCOHERENT_VALUE');
  });

  it('a subscription unlimited in what the add-on adds: still a sale, no notice — and stamped, so a refund takes nothing', async () => {
    const env = harness({ status: 'EXPIRED', amount: '99', lifetime: 'UNTIL_SUBSCRIPTION_END', trafficLimit: null });

    await env.service.applyCompletedTransaction(env.transaction as never);

    assert.equal(env.limitWrites.length, 0);
    assert.deepEqual(
      env.emitted.map((event) => [event.type, event.severity]),
      [[EVENT_TYPES.PAYMENT_COMPLETED, 'INFO']],
      'the customer has what they paid for: unlimited',
    );
    assert.deepEqual(env.notices, []);
    assert.equal(env.stampedReason(), 'UNLIMITED_BASELINE');
  });

  it('an add-on that was applied is a sale: `payment.completed`, no notice, no stamp', async () => {
    const env = harness({ status: 'EXPIRED', amount: '99', lifetime: 'UNTIL_SUBSCRIPTION_END' });

    await env.service.applyCompletedTransaction(env.transaction as never);

    assert.deepEqual(env.limitWrites, [{ trafficLimit: { increment: 50 } }], 'fixture: the legacy increment');
    assert.deepEqual(
      env.emitted.map((event) => event.type),
      [EVENT_TYPES.PAYMENT_COMPLETED],
    );
    assert.deepEqual(env.notices, []);
    assert.equal(env.stampedReason(), undefined);
  });

  it('the notice cannot be written: the payment stays settled, the card goes out, and the failure is logged', async () => {
    const env = harness({ status: 'EXPIRED', amount: '99', notices: 'refused' });

    await env.service.applyCompletedTransaction(env.transaction as never);

    assert.equal(env.notices.length, 1, 'it was tried');
    assert.equal(env.fulfilment.length, 1);
    assert.ok(env.fulfilment[0]!['fulfilledAt'] instanceof Date);
    assert.equal(env.withheld().message, 'Докупка оплачена, но не применена');
    assert.ok(
      env.warnings.some((line) => line.includes('pay-1') && line.includes('the notifications table is unreachable')),
      `logged with the payment: ${env.warnings.join(' | ')}`,
    );
  });

  it('without a notifications service (a hand-built fulfilment): settled as before', async () => {
    const env = harness({ status: 'EXPIRED', amount: '99', notices: 'no service' });

    await env.service.applyCompletedTransaction(env.transaction as never);

    assert.equal(env.fulfilment.length, 1);
    assert.equal(env.withheld().message, 'Докупка оплачена, но не применена');
  });
});

describe('the notices are in the templates catalogue, so «Карта бота» shows them', () => {
  function templateOf(type: string) {
    const template = DEFAULT_NOTIFICATION_TEMPLATES.find((entry) => entry.type === type);
    assert.ok(template, `${type} ships a template`);
    return template;
  }

  it('says what the owner asked, with the add-on named', () => {
    const template = templateOf(ADD_ON_NOT_APPLIED_NOTICE_TYPE);
    assert.equal(
      template.body.replace('{{addon}}', 'Extra 50 GB'),
      'Оплата докупки «Extra 50 GB» получена, но применить её не удалось — подписка сейчас не активна. ' +
        'Мы разберёмся и свяжемся с вами.',
    );
    assert.ok(template.title.trim().length > 0);
  });

  it('any other reason: the same sentence without «— подписка сейчас не активна»', () => {
    const template = templateOf(ADD_ON_NOT_APPLIED_OTHER_NOTICE_TYPE);
    assert.equal(
      template.body.replace('{{addon}}', 'Extra 50 GB'),
      'Оплата докупки «Extra 50 GB» получена, но применить её не удалось. Мы разберёмся и свяжемся с вами.',
    );
    assert.equal(template.title, templateOf(ADD_ON_NOT_APPLIED_NOTICE_TYPE).title);
  });

  it('both have an English version, with the add-on named — and only the inactive one says «not active»', () => {
    for (const type of [ADD_ON_NOT_APPLIED_NOTICE_TYPE, ADD_ON_NOT_APPLIED_OTHER_NOTICE_TYPE]) {
      const template = templateOf(type);
      assert.ok((template.titleEn ?? '').trim().length > 0, type);
      assert.ok((template.bodyEn ?? '').includes('{{addon}}'), type);
    }
    assert.match(templateOf(ADD_ON_NOT_APPLIED_NOTICE_TYPE).bodyEn ?? '', /not active/);
    assert.doesNotMatch(templateOf(ADD_ON_NOT_APPLIED_OTHER_NOTICE_TYPE).bodyEn ?? '', /not active/);
  });

  it('both lead to support', () => {
    for (const type of [ADD_ON_NOT_APPLIED_NOTICE_TYPE, ADD_ON_NOT_APPLIED_OTHER_NOTICE_TYPE]) {
      const targets = (templateOf(type).buttons ?? []).map((button) => button.target);
      assert.ok(targets.includes('/support'), `${type}: ${JSON.stringify(targets)}`);
    }
  });

  it('neither is a switch the customer can turn off: they are about their money', () => {
    for (const type of [ADD_ON_NOT_APPLIED_NOTICE_TYPE, ADD_ON_NOT_APPLIED_OTHER_NOTICE_TYPE]) {
      assert.equal(isSubscriberNotificationEnabled({ [type]: false }, type), true, type);
    }
  });

  it('both are mailed all the same — a customer with no Telegram and no push is reached — and nothing else became mailable', () => {
    for (const type of [ADD_ON_NOT_APPLIED_NOTICE_TYPE, ADD_ON_NOT_APPLIED_OTHER_NOTICE_TYPE]) {
      assert.equal(isSubscriberMailableType(type), true, type);
      assert.equal((SUBSCRIBER_MUTABLE_NOTIFICATION_TYPES as readonly string[]).includes(type), false, `${type} became a switch`);
    }
    assert.deepEqual(
      [...MAILABLE_WITHOUT_SWITCH_TYPES].sort(),
      [ADD_ON_NOT_APPLIED_NOTICE_TYPE, ADD_ON_NOT_APPLIED_OTHER_NOTICE_TYPE].sort(),
    );
  });
});
