import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  Currency,
  PaymentGatewayType,
  PurchaseChannel,
  PurchaseType,
  TransactionStatus,
} from '@prisma/client';
import { of } from 'rxjs';

import { InternalPaymentsController } from '../src/modules/payments/controllers/internal-payments.controller';
import { PAYMENT_GATEWAY_DEFAULTS } from '../src/modules/payments/services/payment-gateway-registry.service';
import { PaymentProviderExecutionService } from '../src/modules/payments/services/payment-provider-execution.service';
import { PaymentWebhookPayloadRedactionService } from '../src/modules/payments/services/payment-webhook-payload-redaction.service';
import {
  GATEWAY_SUPPORTED_CURRENCIES,
  isCurrencySupportedByGateway,
} from '../src/modules/payments/utils/gateway-supported-currencies.util';

/**
 * Two ways a payment method can be offered to a buyer that it cannot honour.
 *
 * 1. **Wrong currency, silently.** A gateway whose request body pins a currency
 *    literal can only ever charge in that one currency. If the catalog claims
 *    it supports more, an operator can leave the row on the other one: we book
 *    `amount = 5.00, currency = USD`, post `{currency: 'rub', amount: '5'}`, and
 *    the buyer is charged 5 ₽ for a $5 subscription while the row records USD.
 *    That is a ~100× under-charge nobody is told about — strictly worse than
 *    the loud rejection the provider used to give us.
 *
 * 2. **A dark gateway.** Readiness is only checked when a gateway is switched
 *    ON. Growing the credential list `isGatewayConfigured` demands therefore
 *    leaves rows that are still `isActive: true` while every checkout path now
 *    answers `PAYMENT_GATEWAY_NOT_CONFIGURED` (400). Listing them puts the
 *    buyer one click from an error they cannot act on.
 *
 * 3. **Born outside its own catalog.** The seed list and the currency catalog
 *    hold the same fact in two places, and they drifted: MulenPay was seeded in
 *    USD after its list was narrowed to roubles alone, and Telegram Stars was
 *    seeded in USD although XTR is the only value it has ever accepted. A row
 *    born outside its catalog is rejected on the operator's first save — or,
 *    for a gateway that pins its currency in the request body, charges the
 *    wrong one until they notice.
 */

const EXECUTION_SERVICE = readFileSync(
  join(__dirname, '..', 'src', 'modules', 'payments', 'services', 'payment-provider-execution.service.ts'),
  'utf8',
);

// ═══════════════════════════════════════════════════════════════════════════
//  1. Currency: the catalog must not promise what the request body pins
// ═══════════════════════════════════════════════════════════════════════════

/** Fields the per-gateway bodies use to name the charge currency. */
const CURRENCY_FIELD = /\b(currency|currency_in|payment_currency|asset)\s*:\s*(.+)/;

/** Comments quote request bodies verbatim; scan the code, not the prose. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** `createCheckout`'s switch is the authoritative gateway → method mapping. */
function checkoutMethodNameByGateway(): ReadonlyMap<PaymentGatewayType, string> {
  const mapping = new Map<PaymentGatewayType, string>();
  const pattern = /case PaymentGatewayType\.(\w+):\s*\n\s*return await this\.(create\w+Checkout)\(/g;
  for (const match of EXECUTION_SERVICE.matchAll(pattern)) {
    mapping.set(match[1] as PaymentGatewayType, match[2]);
  }
  assert.ok(mapping.size > 0, 'could not read the gateway switch in createCheckout');
  return mapping;
}

/** Body of a `createXxxCheckout`, up to the next method declaration. */
function checkoutMethodBody(methodName: string): string {
  const start = EXECUTION_SERVICE.indexOf(`private async ${methodName}`);
  assert.notEqual(start, -1, `no ${methodName} in the execution service`);
  const next = EXECUTION_SERVICE.indexOf('\n  private async ', start + 1);
  return stripComments(EXECUTION_SERVICE.slice(start, next === -1 ? undefined : next));
}

/**
 * `'rub'` → pinned to one currency. `input.transaction.currency` (bare or
 * behind a ternary) → derived from what the buyer was actually quoted.
 */
function currencySource(methodName: string): 'hardcoded' | 'derived' | 'absent' {
  const assignment = CURRENCY_FIELD.exec(checkoutMethodBody(methodName));
  if (assignment === null) return 'absent';
  const value = assignment[2];
  if (/^['"`]/.test(value.trim())) return 'hardcoded';
  return value.includes('input.transaction.currency') ? 'derived' : 'absent';
}

describe('gateway charge currency', () => {
  it('never lets a hardcoded-currency gateway advertise a second currency', () => {
    // The whole defect in one assertion: a body that can only send one currency
    // must not be selectable in another. Either derive the value from the
    // transaction, or narrow the catalog — silently charging the wrong one is
    // not a third option.
    const offenders: string[] = [];
    for (const [gatewayType, methodName] of checkoutMethodNameByGateway()) {
      if (currencySource(methodName) !== 'hardcoded') continue;
      const supported = GATEWAY_SUPPORTED_CURRENCIES[gatewayType] ?? [];
      if (supported.length !== 1) {
        offenders.push(`${gatewayType} pins one currency but lists ${supported.join('/')}`);
      }
    }
    assert.deepStrictEqual(offenders, []);
  });

  it('offers MulenPay in roubles only', () => {
    // MulenPay's `currency` is an enum of exactly `['rub']`, and the value is
    // signed over, so there is nothing to derive. USD in this list is what let
    // a $5 plan be posted as 5 ₽.
    assert.deepStrictEqual(GATEWAY_SUPPORTED_CURRENCIES.MULENPAY, [Currency.RUB]);
    assert.equal(isCurrencySupportedByGateway(PaymentGatewayType.MULENPAY, Currency.USD), false);
    assert.equal(isCurrencySupportedByGateway(PaymentGatewayType.MULENPAY, Currency.RUB), true);
    assert.equal(currencySource('createMulenpayCheckout'), 'hardcoded');
  });

  it('derives the currency for the multi-currency gateways', () => {
    // The other side of the invariant: these accept more than one currency, so
    // the body must read the transaction rather than pin a literal.
    for (const methodName of [
      'createYookassaCheckout',
      'createPlategaCheckout',
      'createWataCheckout',
      'createSeverpayCheckout',
      'createLavaCheckout',
    ]) {
      assert.equal(currencySource(methodName), 'derived', `${methodName} must derive its currency`);
    }
  });

  it('refuses a MulenPay checkout booked in anything but roubles', async () => {
    // The catalog stops new selections; it does not rewrite a row seeded before
    // it was narrowed, and nothing re-validates currency at checkout time. So
    // the request must fail loudly rather than quietly bill 5 ₽ for $5.
    const calls: unknown[] = [];
    const service = createService({
      post: (url: string, body: unknown) => {
        calls.push({ url, body });
        return of({ data: { uuid: 'mulen-1', paymentUrl: 'https://mulenpay.example/pay' } });
      },
    });

    await assert.rejects(
      service.createCheckout({
        gateway: createGateway({
          type: PaymentGatewayType.MULENPAY,
          settings: { apiKey: 'api-1', shopId: 'shop-1', secretKey: 'secret-1' },
        }),
        transaction: createTransaction({
          gatewayType: PaymentGatewayType.MULENPAY,
          amount: '5.00',
          currency: Currency.USD,
        }),
        description: 'Five dollar plan',
      }),
      /PAYMENT_GATEWAY_CURRENCY_UNSUPPORTED/,
    );
    assert.deepStrictEqual(calls, [], 'nothing may reach MulenPay for a non-RUB transaction');
  });

  it('still creates a rouble MulenPay checkout, signed over the sent currency', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const service = createService({
      post: (url: string, body: unknown) => {
        calls.push({ url, body: body as Record<string, unknown> });
        return of({ data: { uuid: 'mulen-2', paymentUrl: 'https://mulenpay.example/pay' } });
      },
    });

    const result = await service.createCheckout({
      gateway: createGateway({
        type: PaymentGatewayType.MULENPAY,
        settings: { apiKey: 'api-1', shopId: 'shop-1', secretKey: 'secret-1' },
      }),
      transaction: createTransaction({
        paymentId: 'payment-rub',
        gatewayType: PaymentGatewayType.MULENPAY,
        amount: '450.00',
        currency: Currency.RUB,
      }),
      description: 'Rouble plan',
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://mulenpay.ru/api/v2/payments');
    assert.equal(calls[0].body['currency'], 'rub');
    assert.equal(calls[0].body['amount'], '450.00');
    assert.equal(
      calls[0].body['sign'],
      createHash('sha1').update('rub450.00shop-1secret-1').digest('hex'),
    );
    assert.equal(result.checkoutUrl, 'https://mulenpay.example/pay');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  2. Availability: never offer a method that cannot produce a checkout
// ═══════════════════════════════════════════════════════════════════════════

describe('buyer-facing gateway list', () => {
  it('hides a gateway that is enabled but no longer configured', async () => {
    // The exact shape of the regression: the operator enabled OVERPAY before
    // its callback `publicKey` became mandatory, so the row is still active
    // while `PaymentsCheckoutService` now answers 400 for it.
    const controller = createController([
      gatewayRow({ id: 'ready', type: PaymentGatewayType.YOOKASSA, isActive: true, isConfigured: true }),
      gatewayRow({ id: 'dark', type: PaymentGatewayType.OVERPAY, isActive: true, isConfigured: false }),
    ]);

    assert.deepStrictEqual(
      (await controller.listEnabledGateways('web')).map((gateway) => gateway.id),
      ['ready'],
    );
  });

  it('still offers a gateway that is both enabled and configured', async () => {
    // Guard against over-correcting: hiding everything is not a fix either.
    const controller = createController([
      gatewayRow({ id: 'ready', type: PaymentGatewayType.YOOKASSA, isActive: true, isConfigured: true }),
    ]);

    assert.deepStrictEqual(await controller.listEnabledGateways('web'), [
      {
        id: 'ready',
        type: PaymentGatewayType.YOOKASSA,
        currency: Currency.RUB,
        orderIndex: 1,
      },
    ]);
  });

  it('keeps hiding a disabled gateway even when its credentials are complete', async () => {
    const controller = createController([
      gatewayRow({ id: 'off', type: PaymentGatewayType.YOOKASSA, isActive: false, isConfigured: true }),
    ]);

    assert.deepStrictEqual(await controller.listEnabledGateways('web'), []);
  });
});

// ── Harness ────────────────────────────────────────────────────────────────

function createService(httpService: {
  readonly post: (...args: never[]) => unknown;
}): PaymentProviderExecutionService {
  return new PaymentProviderExecutionService(
    httpService as never,
    { domain: 'https://user.example', botToken: 'bot-token-1' } as never,
    new PaymentWebhookPayloadRedactionService(),
  );
}

function createGateway(input: {
  readonly type: PaymentGatewayType;
  readonly settings: Record<string, unknown>;
}) {
  return {
    id: 'gateway-1',
    type: input.type,
    orderIndex: 1,
    currency: Currency.RUB,
    isActive: true,
    settings: input.settings,
    createdAt: new Date('2026-08-04T12:00:00.000Z'),
    updatedAt: new Date('2026-08-04T12:00:00.000Z'),
  } as never;
}

function createTransaction(input: {
  readonly paymentId?: string;
  readonly gatewayType: PaymentGatewayType;
  readonly amount?: string;
  readonly currency?: Currency;
}) {
  return {
    id: 'transaction-1',
    paymentId: input.paymentId ?? 'payment-1',
    userId: 'user-1',
    subscriptionId: null,
    status: TransactionStatus.PENDING,
    purchaseType: PurchaseType.NEW,
    channel: PurchaseChannel.WEB,
    gatewayType: input.gatewayType,
    gatewayId: null,
    gatewayData: null,
    currency: input.currency ?? Currency.RUB,
    paymentAsset: null,
    amount: { toString: () => input.amount ?? '9.99' },
    planSnapshot: {},
    deviceTypes: [],
    createdAt: new Date('2026-08-04T12:00:00.000Z'),
    updatedAt: new Date('2026-08-04T12:00:00.000Z'),
  } as never;
}

/** Only the fields `listEnabledGateways` reads off the admin payload. */
function gatewayRow(input: {
  readonly id: string;
  readonly type: PaymentGatewayType;
  readonly isActive: boolean;
  readonly isConfigured: boolean;
  readonly currency?: Currency;
  readonly orderIndex?: number;
}) {
  return {
    id: input.id,
    type: input.type,
    currency: input.currency ?? Currency.RUB,
    orderIndex: input.orderIndex ?? 1,
    isActive: input.isActive,
    isConfigured: input.isConfigured,
  };
}

function createController(gateways: readonly unknown[]): InternalPaymentsController {
  return new InternalPaymentsController(
    {} as never,
    {} as never,
    { listGateways: async () => gateways } as never,
    {} as never,
    { getInternalPlatformPolicy: async () => ({ defaultCurrency: Currency.RUB }) } as never,
  );
}

describe('a seeded gateway is born inside its own currency catalog', () => {
  it('seeds every gateway in a currency that gateway actually supports', () => {
    // The seed list and the catalog hold the same fact twice, so this is the
    // only thing keeping them honest. Both drifts it caught were real:
    // MulenPay seeded in USD after its list was narrowed to roubles alone, and
    // Telegram Stars seeded in USD though XTR is the only value it accepts.
    const offenders = PAYMENT_GATEWAY_DEFAULTS.filter(
      (seed) => !isCurrencySupportedByGateway(seed.type, seed.currency),
    ).map((seed) => `${seed.type}=${seed.currency}`);

    assert.deepEqual(offenders, []);
  });

  it('seeds Telegram Stars in XTR, the only currency Stars can be priced in', () => {
    const stars = PAYMENT_GATEWAY_DEFAULTS.find(
      (seed) => seed.type === PaymentGatewayType.TELEGRAM_STARS,
    );

    assert.equal(stars?.currency, Currency.XTR);
    assert.deepEqual(GATEWAY_SUPPORTED_CURRENCIES.TELEGRAM_STARS, [Currency.XTR]);
  });

  it('covers every gateway the catalog prices, so a new one cannot slip in unseeded', () => {
    // PARTNER_BALANCE is the deliberate exception: it prices in the partner's
    // own balance currency and is never persisted as a PaymentGateway row.
    const pricedTypes = Object.entries(GATEWAY_SUPPORTED_CURRENCIES)
      .filter(([, currencies]) => currencies.length > 0)
      .map(([type]) => type)
      .sort();
    const seededTypes = PAYMENT_GATEWAY_DEFAULTS.map((seed) => String(seed.type)).sort();

    assert.deepEqual(seededTypes, pricedTypes);
  });
});
