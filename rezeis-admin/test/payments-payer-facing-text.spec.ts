import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import 'reflect-metadata';

import { Currency, PaymentGatewayType, PurchaseChannel, PurchaseType, TransactionStatus } from '@prisma/client';
import { of } from 'rxjs';

import { AddOnPurchaseService } from '../src/modules/payments/services/addon-purchase.service';
import { PaymentProviderExecutionService } from '../src/modules/payments/services/payment-provider-execution.service';
import { PaymentWebhookPayloadRedactionService } from '../src/modules/payments/services/payment-webhook-payload-redaction.service';
import { PaymentsRenewalCheckoutService } from '../src/modules/payments/services/payments-renewal-checkout.service';
import {
  cleanPayerText,
  describeAddOn,
  describePlanPurchase,
  describeRenewal,
  operatorDefaultPayerLocale,
  PAYER_DESCRIPTION_MAX_LENGTH,
  PAYER_TITLE_MAX_LENGTH,
  readPayerLocale,
  resolvePayerLocale,
} from '../src/modules/payments/utils/payer-facing-text.util';

/**
 * What a payer reads about a purchase on the provider's side — the payment
 * page, the bank statement, a fiscal receipt, the Telegram Stars invoice — is
 * a line in their language, «Премиум, 30 дней», not the checkout's internals
 * (`NEW Премиум 30d`, `RENEW x1`, `Add-on: …`), and it fits every gateway's
 * field in length and in characters.
 */

const savedDefaultLocale = process.env.REZEIS_DEFAULT_LOCALE;

beforeEach(() => {
  delete process.env.REZEIS_DEFAULT_LOCALE;
});

afterEach(() => {
  if (savedDefaultLocale === undefined) delete process.env.REZEIS_DEFAULT_LOCALE;
  else process.env.REZEIS_DEFAULT_LOCALE = savedDefaultLocale;
});

describe("the payer's line for a plan", () => {
  it('names the plan and the term in Russian, with the right form of «день»', () => {
    const line = (durationDays: number) =>
      describePlanPurchase({ purchaseType: PurchaseType.NEW, planName: 'Премиум', durationDays, locale: 'ru' }).description;

    assert.equal(line(30), 'Премиум, 30 дней');
    assert.deepEqual(
      [1, 2, 4, 5, 11, 12, 14, 21, 22, 25, 101, 111, 112, 365].map(line),
      [
        'Премиум, 1 день',
        'Премиум, 2 дня',
        'Премиум, 4 дня',
        'Премиум, 5 дней',
        'Премиум, 11 дней',
        'Премиум, 12 дней',
        'Премиум, 14 дней',
        'Премиум, 21 день',
        'Премиум, 22 дня',
        'Премиум, 25 дней',
        'Премиум, 101 день',
        'Премиум, 111 дней',
        'Премиум, 112 дней',
        'Премиум, 365 дней',
      ],
    );
  });

  it('says a term with no end in words, and leaves out a term it does not know', () => {
    const line = (durationDays: number | null, locale: 'ru' | 'en') =>
      describePlanPurchase({ purchaseType: PurchaseType.NEW, planName: 'Premium', durationDays, locale }).description;

    assert.equal(line(-1, 'ru'), 'Premium, бессрочно');
    assert.equal(line(-1, 'en'), 'Premium, no expiry');
    assert.equal(line(null, 'ru'), 'Premium');
    assert.equal(line(0, 'en'), 'Premium');
    assert.equal(line(30.5, 'en'), 'Premium');
  });

  it('is English for an English-speaking payer', () => {
    const line = (durationDays: number) =>
      describePlanPurchase({ purchaseType: PurchaseType.NEW, planName: 'Premium', durationDays, locale: 'en' }).description;

    assert.equal(line(1), 'Premium, 1 day');
    assert.equal(line(30), 'Premium, 30 days');
  });

  it('says a renewal is one, and keeps the title to the plan and the term', () => {
    assert.deepEqual(
      describePlanPurchase({ purchaseType: PurchaseType.RENEW, planName: 'Премиум', durationDays: 30, locale: 'ru' }),
      { description: 'Продление: Премиум, 30 дней', title: 'Премиум, 30 дней' },
    );
    assert.deepEqual(
      describePlanPurchase({ purchaseType: PurchaseType.RENEW, planName: 'Premium', durationDays: 30, locale: 'en' }),
      { description: 'Renewal: Premium, 30 days', title: 'Premium, 30 days' },
    );
    for (const purchaseType of [PurchaseType.NEW, PurchaseType.ADDITIONAL, PurchaseType.UPGRADE]) {
      assert.equal(
        describePlanPurchase({ purchaseType, planName: 'Премиум', durationDays: 30, locale: 'ru' }).description,
        'Премиум, 30 дней',
        purchaseType,
      );
    }
  });

  it('falls back to «Подписка» when nothing is left of the name', () => {
    assert.equal(
      describePlanPurchase({ purchaseType: PurchaseType.NEW, planName: '🔥🔥', durationDays: 30, locale: 'ru' }).description,
      'Подписка, 30 дней',
    );
    assert.equal(
      describePlanPurchase({ purchaseType: PurchaseType.NEW, planName: null, durationDays: 30, locale: 'en' }).description,
      'Subscription, 30 days',
    );
  });
});

describe("the payer's line for a renewal of several and for an add-on", () => {
  it('counts the subscriptions of a combined renewal, and names the plan of a single one', () => {
    const items = [
      { planName: 'Премиум', durationDays: 30 },
      { planName: 'Семейный', durationDays: 90 },
    ];

    assert.deepEqual(describeRenewal({ items, locale: 'ru' }), {
      description: 'Продление подписок: 2',
      title: 'Продление подписок: 2',
    });
    assert.equal(describeRenewal({ items, locale: 'en' }).description, 'Renewal of 2 subscriptions');
    assert.equal(
      describeRenewal({ items: items.slice(0, 1), locale: 'ru' }).description,
      'Продление: Премиум, 30 дней',
    );
  });

  it('names an add-on as the cabinet does', () => {
    assert.deepEqual(describeAddOn({ name: '+50 ГБ трафика', locale: 'ru' }), {
      description: 'Доп. опция: +50 ГБ трафика',
      title: '+50 ГБ трафика',
    });
    assert.equal(describeAddOn({ name: 'Extra 50GB', locale: 'en' }).description, 'Add-on: Extra 50GB');
    assert.equal(describeAddOn({ name: '🚀', locale: 'en' }).description, 'Add-on');
  });
});

describe('what the line may carry', () => {
  const ZWJ = String.fromCodePoint(0x200d);
  const VS16 = String.fromCodePoint(0xfe0f);
  const KEYCAP = String.fromCodePoint(0x20e3);
  const hostileNames = [
    '🔥 Премиум 🔥',
    // U+26A1: a pictograph inside the Basic Multilingual Plane.
    '⚡ Турбо ⚡',
    '🇷🇺 | Семейный',
    'Премиум — год',
    '«Семейный» … плюс',
    `Plan${ZWJ}${VS16}1${KEYCAP}`,
    'Tab\there\nnew line',
    '𝐏𝐑𝐎 Plan',
    'Очень длинное название тарифа для всей семьи, друзей и коллег по работе',
  ];
  const lines = hostileNames.flatMap((name) =>
    [PurchaseType.NEW, PurchaseType.RENEW].flatMap((purchaseType) =>
      [30, 365, -1].flatMap((durationDays) =>
        (['ru', 'en'] as const).map((locale) => describePlanPurchase({ purchaseType, planName: name, durationDays, locale })),
      ),
    ),
  );
  const addOnLines = hostileNames.map((name) => describeAddOn({ name, locale: 'ru' }));

  it("fits Platega's 64-character description and the Stars title's 32, keeping the term", () => {
    for (const text of [...lines, ...addOnLines]) {
      assert.ok(text.description.length <= PAYER_DESCRIPTION_MAX_LENGTH, text.description);
      assert.ok(text.title.length > 0 && text.title.length <= PAYER_TITLE_MAX_LENGTH, text.title);
    }
    const long = describePlanPurchase({
      purchaseType: PurchaseType.RENEW,
      planName: hostileNames[hostileNames.length - 1],
      durationDays: 365,
      locale: 'ru',
    });
    assert.ok(long.description.startsWith('Продление: Очень длинное'), long.description);
    assert.ok(long.description.endsWith('..., 365 дней'), long.description);
    assert.ok(long.title.endsWith('..., 365 дней'), long.title);
  });

  it('carries no emoji, astral, control, zero-width or typographic character', () => {
    for (const text of [...lines, ...addOnLines]) {
      for (const value of [text.description, text.title]) {
        assert.doesNotMatch(value, /[\u{10000}-\u{10FFFF}]/u, value);
        assert.doesNotMatch(value, /\p{Extended_Pictographic}/u, value);
        assert.doesNotMatch(value, /[\p{Cc}\p{Cf}\u{FE00}-\u{FE0F}\u{20E3}]/u, value);
        assert.doesNotMatch(value, /[\u{AB}\u{BB}\u{2013}\u{2014}\u{2026}]/u, value);
      }
    }
  });

  it('keeps what the operator wrote, in ASCII where it was typographic', () => {
    assert.equal(cleanPayerText('🔥 Премиум 🔥'), 'Премиум');
    assert.equal(cleanPayerText('⚡ Турбо ⚡'), 'Турбо');
    assert.equal(cleanPayerText('🇷🇺 | Семейный'), 'Семейный');
    assert.equal(cleanPayerText('Премиум — год'), 'Премиум - год');
    assert.equal(cleanPayerText('«Семейный» … плюс'), '"Семейный" ... плюс');
    assert.equal(cleanPayerText('Тариф №1'), 'Тариф №1');
    assert.equal(cleanPayerText('-50% Премиум'), '-50% Премиум');
  });
});

describe("the payer's language", () => {
  it('is Russian for RU and English for every other locale the bot recorded', () => {
    assert.equal(resolvePayerLocale({ language: 'RU', telegramId: 1n }), 'ru');
    assert.equal(resolvePayerLocale({ language: 'EN', telegramId: 1n }), 'en');
    assert.equal(resolvePayerLocale({ language: 'DE', telegramId: 1n }), 'en');
    assert.equal(resolvePayerLocale({ language: 'RU', telegramId: null }), 'ru');
  });

  it("is the operator's when the account says nothing: no row, or the column's EN default on a web-only account", () => {
    process.env.REZEIS_DEFAULT_LOCALE = 'ru';
    assert.equal(resolvePayerLocale(null), 'ru');
    assert.equal(resolvePayerLocale({ language: 'EN', telegramId: null }), 'ru');

    process.env.REZEIS_DEFAULT_LOCALE = 'en';
    assert.equal(resolvePayerLocale(null), 'en');
    assert.equal(resolvePayerLocale({ language: 'EN', telegramId: null }), 'en');
  });

  it("reads the operator's language as Russian unless it is set to another", () => {
    assert.equal(operatorDefaultPayerLocale(), 'ru');
    process.env.REZEIS_DEFAULT_LOCALE = 'EN';
    assert.equal(operatorDefaultPayerLocale(), 'en');
    process.env.REZEIS_DEFAULT_LOCALE = 'de';
    assert.equal(operatorDefaultPayerLocale(), 'en');
  });

  it("reads the payer's row, and never refuses a payment over it", async () => {
    const asked: unknown[] = [];
    const locale = await readPayerLocale(
      {
        user: {
          findUnique: async (args: unknown) => {
            asked.push(args);
            return { language: 'EN', telegramId: 42n };
          },
        },
      } as never,
      'user-1',
    );
    assert.equal(locale, 'en');
    assert.deepEqual(asked, [{ where: { id: 'user-1' }, select: { language: true, telegramId: true } }]);

    process.env.REZEIS_DEFAULT_LOCALE = 'ru';
    const failing = await readPayerLocale(
      { user: { findUnique: async () => Promise.reject(new Error('connection reset')) } } as never,
      'user-1',
    );
    assert.equal(failing, 'ru');
  });
});

// ── What reaches the provider ─────────────────────────────────────────────

interface ProviderCall {
  readonly description: string;
  readonly title?: string | null;
}

const RUSSIAN_PAYER = { id: 'user-1', language: 'RU', telegramId: 7n };
const ENGLISH_PAYER = { id: 'user-1', language: 'EN', telegramId: 7n };

function renewalWorld(payer: Record<string, unknown>) {
  const calls: ProviderCall[] = [];
  const draftRow = (data: Record<string, unknown>) => ({
    id: 'tx-1',
    paymentId: 'pay-1',
    userId: 'user-1',
    status: 'PENDING',
    purchaseType: 'RENEW',
    channel: 'WEB',
    gatewayType: 'YOOKASSA',
    gatewayId: null,
    currency: 'RUB',
    amount: { toString: () => '299.00' },
    planSnapshot: {},
    gatewayData: {},
    checkoutUrl: null,
    checkoutFingerprint: null,
    createdAt: new Date('2026-09-23T10:00:00.000Z'),
    ...data,
  });
  const created: Array<Record<string, unknown>> = [];
  const prisma = {
    paymentGateway: {
      findUnique: async () => ({
        type: 'YOOKASSA',
        isActive: true,
        currency: 'RUB',
        settings: { shopId: 'shop-1', apiKey: 'secret-1' },
      }),
    },
    user: { findUnique: async () => payer, findFirst: async () => null },
    transaction: {
      findFirst: async () => null,
      findMany: async () => [],
      findUnique: async () => null,
      updateMany: async () => ({ count: 1 }),
      update: async (args: { data: Record<string, unknown> }) =>
        draftRow({ ...created[0], ...args.data, checkoutUrl: 'https://yookassa.example/pay-1' }),
    },
    transactionItem: { createMany: async () => ({ count: 1 }) },
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        transaction: {
          create: async (args: { data: Record<string, unknown> }) => {
            created.push(args.data);
            return draftRow(args.data);
          },
        },
        transactionItem: { createMany: async () => ({ count: 1 }) },
      }),
  };
  const priced = {
    userId: 'user-1',
    currency: 'RUB',
    total: '299.00',
    items: [
      {
        subscriptionId: 'sub-1',
        planId: 'plan-a',
        planName: payer === ENGLISH_PAYER ? 'Premium' : 'Премиум',
        durationDays: 30,
        currency: 'RUB',
        amount: '299.00',
        discountPercent: 0,
        discountSource: 'NONE',
        planSnapshot: { id: 'plan-a', snapshotSource: 'RENEWAL_DRAFT' },
        addOnLines: [],
      },
    ],
  };
  const service = new PaymentsRenewalCheckoutService(
    prisma as never,
    { priceRenewalItems: async () => priced, assertRenewalPolicy: async () => undefined } as never,
    {
      createCheckout: async (input: ProviderCall) => {
        calls.push({ description: input.description, title: input.title });
        return {
          gatewayId: 'yk-1',
          checkoutUrl: 'https://yookassa.example/pay-1',
          providerMode: 'REDIRECT',
          providerStatus: 'pending',
          gatewayData: { checkoutUrl: 'https://yookassa.example/pay-1' },
        };
      },
    } as never,
    { applyCompletedTransaction: async () => ({ syncJobs: [] }) } as never,
    { enqueue: async () => undefined } as never,
    { getInternalPlatformPolicy: async () => ({ accessMode: 'PUBLIC' }) } as never,
    { evaluate: () => null } as never,
    { resolveActiveForCharge: async () => null } as never,
    { runPostFulfillmentHooksBestEffort: async () => undefined } as never,
    { assertNoLiveSubscriptionFor: async () => undefined, recordCheckout: async () => undefined } as never,
    { info: () => undefined } as never,
  );
  const renew = () =>
    service.renewalCheckout({
      userId: 'user-1',
      subscriptionIds: ['sub-1'],
      gatewayType: 'YOOKASSA' as never,
      expectedAmount: '299.00',
      expectedCurrency: 'RUB' as never,
    });
  return { renew, calls };
}

const LIVE_TERM_ENDS_AT = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);

function addOnWorld(payer: Record<string, unknown>) {
  const calls: ProviderCall[] = [];
  const txRecord = (data: Record<string, unknown> = {}) => ({
    id: 'tx-1',
    paymentId: 'pay-1',
    userId: 'user-1',
    subscriptionId: null,
    status: 'PENDING',
    purchaseType: 'ADDITIONAL',
    channel: 'WEB',
    gatewayType: 'YOOKASSA',
    currency: 'USD',
    amount: '2.50',
    checkoutUrl: null,
    checkoutFingerprint: null,
    idempotencyKey: null,
    fulfilledAt: null,
    createdAt: new Date('2026-09-23T10:00:00.000Z'),
    ...data,
  });
  const prisma = {
    user: { findFirst: async () => ({ id: 'user-1' }), findUnique: async () => payer },
    paymentGateway: {
      findUnique: async () => ({ type: 'YOOKASSA', isActive: true, currency: 'USD', settings: { shopId: 's', apiKey: 'k' } }),
    },
    subscription: {
      findUnique: async () => ({
        id: 'sub-1',
        userId: 'user-1',
        status: 'ACTIVE',
        trafficLimit: 100,
        deviceLimit: 3,
        planSnapshot: {
          id: 'plan-a',
          trafficLimitStrategy: 'NO_RESET',
          trafficLimit: 100,
          deviceLimit: 3,
          internalSquads: [],
          externalSquad: null,
        },
        createdAt: new Date('2026-09-01T00:00:00.000Z'),
        expiresAt: LIVE_TERM_ENDS_AT,
      }),
    },
    subscriptionTerm: {
      findFirst: async () => ({
        baseTrafficLimitBytes: 100n * 1024n * 1024n * 1024n,
        baseDeviceLimit: 3,
        endsAt: LIVE_TERM_ENDS_AT,
        trafficResetStrategy: 'NO_RESET',
        resetAnchorAt: null,
      }),
    },
    subscriptionEffectiveProjection: { findUnique: async () => null },
    addOn: {
      findUnique: async () => ({
        id: 'addon-1',
        isActive: true,
        revision: 3,
        type: 'EXTRA_TRAFFIC',
        value: 50,
        lifetime: 'UNTIL_SUBSCRIPTION_END',
        name: payer === ENGLISH_PAYER ? 'Extra 50GB' : '+50 ГБ трафика',
        applicablePlanIds: [],
        prices: [{ currency: 'USD', price: { toString: () => '2.50' } }],
      }),
    },
    transaction: {
      findFirst: async () => null,
      create: async (args: { data: Record<string, unknown> }) => txRecord({ ...args.data }),
      update: async (args: { data: Record<string, unknown> }) => txRecord({ ...args.data }),
      updateMany: async () => ({ count: 1 }),
      findUnique: async () => txRecord(),
      findUniqueOrThrow: async () => txRecord(),
    },
  };
  const service = new AddOnPurchaseService(
    prisma as never,
    { buildSnapshot: () => ({ price: '2.50' }) } as never,
    {
      createCheckout: async (input: ProviderCall) => {
        calls.push({ description: input.description, title: input.title });
        return { gatewayId: 'g1', gatewayData: {}, checkoutUrl: 'https://pay/1', providerMode: 'REDIRECT' };
      },
    } as never,
    { applyCompletedTransaction: async () => ({ syncJobs: [] }) } as never,
    { enqueue: async () => undefined } as never,
    { getInternalPlatformPolicy: async () => ({ accessMode: 'PUBLIC' }) } as never,
    { evaluate: () => null } as never,
    { info: () => undefined } as never,
  );
  const buy = () =>
    service.checkout({
      userId: 'user-1',
      addOnId: 'addon-1',
      subscriptionId: 'sub-1',
      gatewayType: 'YOOKASSA' as never,
      contractVersion: 2,
      idempotencyKey: 'idem-1',
    });
  return { buy, calls };
}

describe('what reaches the provider', () => {
  it("a renewal: the plan and its term, in the payer's language", async () => {
    const russian = renewalWorld(RUSSIAN_PAYER);
    await russian.renew();
    const english = renewalWorld(ENGLISH_PAYER);
    await english.renew();

    assert.deepEqual(russian.calls, [{ description: 'Продление: Премиум, 30 дней', title: 'Премиум, 30 дней' }]);
    assert.deepEqual(english.calls, [{ description: 'Renewal: Premium, 30 days', title: 'Premium, 30 days' }]);
  });

  it("an add-on: its name, in the payer's language", async () => {
    const russian = addOnWorld(RUSSIAN_PAYER);
    await russian.buy();
    const english = addOnWorld(ENGLISH_PAYER);
    await english.buy();

    assert.deepEqual(russian.calls, [{ description: 'Доп. опция: +50 ГБ трафика', title: '+50 ГБ трафика' }]);
    assert.deepEqual(english.calls, [{ description: 'Add-on: Extra 50GB', title: 'Extra 50GB' }]);
  });

  it('a Telegram Stars invoice: the title it was given, the whole line as its description', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const service = new PaymentProviderExecutionService(
      {
        post: (_url: string, body: Record<string, unknown>) => {
          bodies.push(body);
          return of({ data: { ok: true, result: 'https://t.me/$invoice-1' } });
        },
      } as never,
      { domain: 'https://admin.example', botToken: 'bot-token-1' } as never,
      new PaymentWebhookPayloadRedactionService(),
    );
    const text = describePlanPurchase({
      purchaseType: PurchaseType.RENEW,
      planName: 'Семейный Премиум Плюс',
      durationDays: 30,
      locale: 'ru',
    });
    const checkout = (title: string | undefined) =>
      service.createCheckout({
        gateway: {
          id: 'gateway-1',
          type: PaymentGatewayType.TELEGRAM_STARS,
          orderIndex: 1,
          currency: Currency.XTR,
          isActive: true,
          settings: {},
          createdAt: new Date('2026-09-01T00:00:00.000Z'),
          updatedAt: new Date('2026-09-01T00:00:00.000Z'),
        } as never,
        transaction: {
          id: 'transaction-1',
          paymentId: 'payment-stars-1',
          userId: 'user-1',
          subscriptionId: 'sub-1',
          status: TransactionStatus.PENDING,
          purchaseType: PurchaseType.RENEW,
          channel: PurchaseChannel.TELEGRAM,
          gatewayType: PaymentGatewayType.TELEGRAM_STARS,
          currency: Currency.XTR,
          amount: { toString: () => '150' },
          planSnapshot: {},
          createdAt: new Date('2026-09-23T10:00:00.000Z'),
          updatedAt: new Date('2026-09-23T10:00:00.000Z'),
        } as never,
        description: text.description,
        ...(title === undefined ? {} : { title }),
      });

    await checkout(text.title);
    await checkout(undefined);

    assert.equal(bodies[0].title, 'Семейный Премиум Плюс, 30 дней');
    assert.equal(bodies[0].description, 'Продление: Семейный Премиум Плюс, 30 дней');
    // A caller that sends no title still gets the line, cut to Telegram's 32.
    assert.equal(bodies[1].title, 'Продление: Семейный Премиум Плюс'.slice(0, 32));
  });
});
