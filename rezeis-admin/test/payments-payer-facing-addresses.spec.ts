import 'reflect-metadata';

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { Logger, ServiceUnavailableException } from '@nestjs/common';
import {
  Currency,
  PaymentGatewayType,
  PurchaseChannel,
  PurchaseType,
  TransactionStatus,
} from '@prisma/client';
import { of } from 'rxjs';

import { advertisingConfig } from '../src/common/config/advertising.config';
import { ReiwaPublicLinksModule } from '../src/modules/advertising/reiwa-public-links.module';
import { ReiwaAdvertisingLinkConfigService } from '../src/modules/advertising/services/reiwa-advertising-link-config.service';
import { PaymentsModule } from '../src/modules/payments/payments.module';
import { PaymentProviderExecutionService } from '../src/modules/payments/services/payment-provider-execution.service';
import { PaymentWebhookPayloadRedactionService } from '../src/modules/payments/services/payment-webhook-payload-redaction.service';

/**
 * What a PAYER sees of a checkout names the operator's cabinet when its
 * address is known, and — only when it is not — the panel, exactly as before.
 *
 * Two addresses the caller may leave to the panel are payer-facing:
 *  - the page the provider sends the payer back to when the cabinet names
 *    none, and
 *  - the per-payment buyer address Antilopay, SeverPay and Lava demand on the
 *    invoice, which the provider may show or mail.
 * They were built on the panel's own domain (`REZEIS_DOMAIN`). They now ask the
 * one resolver of the cabinet's address (`ReiwaPublicLinksModule`: what the
 * cabinet publishes, then `REIWA_WEB_BASE_URL`, then `MINIAPP_CUSTOM_URL`), and
 * with no answer fall back to the panel as before, saying so once. A payment
 * is never refused over a missing optional address. The provider's CALLBACK is
 * not the payer's: it stays the panel.
 */

const PANEL_DOMAIN = 'https://admin.example';
const FALLBACK_WARNING = /REIWA_WEB_BASE_URL/;

const savedEnvironment = {
  web: process.env.REIWA_WEB_BASE_URL,
  miniApp: process.env.MINIAPP_CUSTOM_URL,
};

beforeEach(() => {
  delete process.env.REIWA_WEB_BASE_URL;
  delete process.env.MINIAPP_CUSTOM_URL;
});

afterEach(() => {
  mock.restoreAll();
  for (const [name, value] of [
    ['REIWA_WEB_BASE_URL', savedEnvironment.web],
    ['MINIAPP_CUSTOM_URL', savedEnvironment.miniApp],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

interface PostedRequest {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

type CabinetLinks = Pick<ReiwaAdvertisingLinkConfigService, 'resolveCabinetWebBaseUrl'>;

/**
 * The cabinet-address resolver itself (`ReiwaAdvertisingLinkConfigService`),
 * on the configuration the environment gives it, with the cabinet unreachable
 * (`reiwaApiBaseUrl: null`), so what it answers is the `.env` tail of its
 * chain; `overrides` changes one field.
 */
function realResolver(overrides: Record<string, unknown> = {}): ReiwaAdvertisingLinkConfigService {
  return new ReiwaAdvertisingLinkConfigService({
    ...advertisingConfig(),
    reiwaApiBaseUrl: null,
    ...overrides,
  } as never);
}

/** A resolver that knows no address. */
function knowsNothing(): ReiwaAdvertisingLinkConfigService {
  return realResolver({ webBaseUrl: null });
}

const RESPONSES: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
  ['api.yookassa.ru', { id: 'yk-1', status: 'pending', confirmation: { confirmation_url: 'https://checkout.example/yk' } }],
  ['app.platega.io', { transactionId: 'platega-1', redirect: 'https://checkout.example/platega', status: 'PENDING' }],
  ['gate.lava.top', { id: 'lava-1', status: 'in-progress', paymentUrl: 'https://app.lava.top/pay/1' }],
  ['severpay.io', { status: true, data: { uid: 'sp-1', url: 'https://severpay.io/pay/1' } }],
  ['api.heleket.com', { result: { uuid: 'heleket-1', status: 'new', url: 'https://checkout.example/heleket' } }],
];

function createService(
  calls: PostedRequest[],
  cabinetLinks: CabinetLinks | undefined,
  domain: string | null = PANEL_DOMAIN,
): PaymentProviderExecutionService {
  return new PaymentProviderExecutionService(
    {
      post: (url: string, body: Record<string, unknown>) => {
        calls.push({ url, body });
        const response = RESPONSES.find(([host]) => url.includes(host))?.[1] ?? {};
        return of({ data: response });
      },
    } as never,
    { domain, botToken: 'bot-token-1' } as never,
    new PaymentWebhookPayloadRedactionService(),
    undefined,
    undefined,
    cabinetLinks as never,
  );
}

function gateway(type: PaymentGatewayType, settings: Record<string, unknown>) {
  return {
    id: 'gateway-1',
    type,
    orderIndex: 1,
    currency: Currency.RUB,
    isActive: true,
    settings,
    createdAt: new Date('2026-09-01T12:00:00.000Z'),
    updatedAt: new Date('2026-09-01T12:00:00.000Z'),
  } as never;
}

function transaction(paymentId: string, gatewayType: PaymentGatewayType) {
  return {
    id: 'transaction-1',
    paymentId,
    userId: 'user-1',
    subscriptionId: null,
    status: TransactionStatus.PENDING,
    purchaseType: PurchaseType.NEW,
    channel: PurchaseChannel.WEB,
    gatewayType,
    gatewayId: null,
    gatewayData: null,
    currency: Currency.RUB,
    paymentAsset: null,
    amount: { toString: () => '299' },
    planSnapshot: {},
    deviceTypes: [],
    createdAt: new Date('2026-09-01T12:00:00.000Z'),
    updatedAt: new Date('2026-09-01T12:00:00.000Z'),
  } as never;
}

const yookassa = (service: PaymentProviderExecutionService, successUrl?: string) =>
  service.createCheckout({
    gateway: gateway(PaymentGatewayType.YOOKASSA, { shopId: 'shop-1', apiKey: 'secret-1' }),
    transaction: transaction('payment-1', PaymentGatewayType.YOOKASSA),
    description: 'Plan purchase',
    ...(successUrl === undefined ? {} : { successUrl }),
  });

const platega = (service: PaymentProviderExecutionService) =>
  service.createCheckout({
    gateway: gateway(PaymentGatewayType.PLATEGA, { merchantId: 'merchant-1', secret: 'secret-1', paymentMethod: 2 }),
    transaction: transaction('payment-1', PaymentGatewayType.PLATEGA),
    description: 'Plan purchase',
  });

const lava = (service: PaymentProviderExecutionService, successUrl?: string) =>
  service.createCheckout({
    gateway: gateway(PaymentGatewayType.LAVA, { apiKey: 'lava-key-1', offerId: 'offer-1' }),
    transaction: transaction('payment-lava-1', PaymentGatewayType.LAVA),
    description: 'Plan purchase',
    ...(successUrl === undefined ? {} : { successUrl }),
  });

const severpay = (service: PaymentProviderExecutionService) =>
  service.createCheckout({
    gateway: gateway(PaymentGatewayType.SEVERPAY, { mid: '4242', secretToken: 'severpay-secret-1' }),
    transaction: transaction('payment-sp-1', PaymentGatewayType.SEVERPAY),
    description: 'Plan purchase',
  });

function returnUrl(call: PostedRequest | undefined): unknown {
  return (call?.body.confirmation as Record<string, unknown> | undefined)?.return_url;
}

function assertNamesNoPanel(calls: readonly PostedRequest[]): void {
  for (const call of calls) {
    assert.equal(JSON.stringify(call.body).includes('admin.example'), false, JSON.stringify(call.body));
  }
}

function fallbackWarnings(warn: { mock: { calls: ReadonlyArray<{ arguments: readonly unknown[] }> } }): number {
  return warn.mock.calls.filter((call) => FALLBACK_WARNING.test(String(call.arguments[0]))).length;
}

describe('the page a payer returns to', () => {
  it("is the cabinet's /payment-return when the cabinet's address is known", async () => {
    process.env.REIWA_WEB_BASE_URL = 'https://app.example.com/';
    const calls: PostedRequest[] = [];

    await yookassa(createService(calls, realResolver()));

    assertNamesNoPanel(calls);
    assert.equal(returnUrl(calls[0]), 'https://app.example.com/payment-return?paymentId=payment-1');
  });

  it('takes MINIAPP_CUSTOM_URL when REIWA_WEB_BASE_URL is not set', async () => {
    process.env.MINIAPP_CUSTOM_URL = 'https://mini.example.com';
    const calls: PostedRequest[] = [];

    await yookassa(createService(calls, realResolver()));

    assert.equal(returnUrl(calls[0]), 'https://mini.example.com/payment-return?paymentId=payment-1');
  });

  it('takes the address the cabinet publishes before the environment', async () => {
    const fetched: string[] = [];
    mock.method(globalThis, 'fetch', async (url: string) => {
      fetched.push(String(url));
      return new Response(JSON.stringify({ webBaseUrl: 'https://published.example.com' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const calls: PostedRequest[] = [];

    await yookassa(
      createService(calls, realResolver({ reiwaApiBaseUrl: 'http://reiwa.internal:5000', webBaseUrl: 'https://env.example.com' })),
    );

    assert.deepEqual(fetched, ['http://reiwa.internal:5000/api/v1/public-config']);
    assert.equal(returnUrl(calls[0]), 'https://published.example.com/payment-return?paymentId=payment-1');
  });

  it('sends the failure page to the cabinet too', async () => {
    const calls: PostedRequest[] = [];

    await platega(createService(calls, realResolver({ webBaseUrl: 'https://app.example.com' })));

    assertNamesNoPanel(calls);
    assert.equal(calls[0]?.body.return, 'https://app.example.com/payment-return?paymentId=payment-1');
    assert.equal(calls[0]?.body.failedUrl, 'https://app.example.com/payment-return?paymentId=payment-1');
  });

  it('is the page the caller names, and then nothing is looked up', async () => {
    let asked = 0;
    const calls: PostedRequest[] = [];

    await yookassa(
      createService(calls, {
        resolveCabinetWebBaseUrl: async () => {
          asked += 1;
          return 'https://app.example.com';
        },
      }),
      'https://t.me/ExampleBot?start=payment_return',
    );

    assert.equal(returnUrl(calls[0]), 'https://t.me/ExampleBot?start=payment_return');
    assert.equal(asked, 0);
  });

  it("with no address known: the panel's /payments/result, as before, and the checkout goes ahead", async () => {
    mock.method(Logger.prototype, 'warn', () => undefined);
    const calls: PostedRequest[] = [];

    const result = await yookassa(createService(calls, knowsNothing()));

    assert.equal(calls.length, 1, 'the provider was not called');
    assert.equal(returnUrl(calls[0]), 'https://admin.example/payments/result?paymentId=payment-1');
    assert.equal(result.checkoutUrl, 'https://checkout.example/yk');
  });

  it('with no address known: the failure page falls back the same way', async () => {
    mock.method(Logger.prototype, 'warn', () => undefined);
    const calls: PostedRequest[] = [];

    await platega(createService(calls, knowsNothing()));

    assert.equal(calls[0]?.body.return, 'https://admin.example/payments/result?paymentId=payment-1');
    assert.equal(calls[0]?.body.failedUrl, 'https://admin.example/payments/result?paymentId=payment-1');
  });

  it('counts a resolver that fails, or none at all, as no address: the checkout goes ahead', async () => {
    mock.method(Logger.prototype, 'warn', () => undefined);
    const failing: PostedRequest[] = [];
    const without: PostedRequest[] = [];

    await yookassa(createService(failing, { resolveCabinetWebBaseUrl: async () => Promise.reject(new Error('boom')) }));
    await yookassa(createService(without, undefined));

    assert.equal(returnUrl(failing[0]), 'https://admin.example/payments/result?paymentId=payment-1');
    assert.equal(returnUrl(without[0]), 'https://admin.example/payments/result?paymentId=payment-1');
  });

  it('with neither the cabinet nor the panel known: the 503 it always was, before the provider is called', async () => {
    mock.method(Logger.prototype, 'warn', () => undefined);
    const calls: PostedRequest[] = [];

    await assert.rejects(
      yookassa(createService(calls, knowsNothing(), null)),
      (error: unknown) =>
        error instanceof ServiceUnavailableException && error.message === 'RUID public web URL is not configured',
    );
    assert.equal(calls.length, 0);
  });
});

describe('the buyer address on an invoice', () => {
  it("is a per-payment address under the cabinet's host when its address is known", async () => {
    const cabinet = { webBaseUrl: 'https://App.Example.com:8443/cabinet' };
    const lavaCalls: PostedRequest[] = [];
    const severpayCalls: PostedRequest[] = [];

    await lava(createService(lavaCalls, realResolver(cabinet)));
    await severpay(createService(severpayCalls, realResolver(cabinet)));

    assertNamesNoPanel([...lavaCalls, ...severpayCalls]);
    assert.equal(lavaCalls[0]?.body.email, 'payment-lava-1@app.example.com');
    assert.equal(severpayCalls[0]?.body.client_email, 'payment-sp-1@app.example.com');
  });

  it("is under the panel's host, as before, when it is not — and the checkout goes ahead", async () => {
    mock.method(Logger.prototype, 'warn', () => undefined);
    const lavaCalls: PostedRequest[] = [];
    const severpayCalls: PostedRequest[] = [];

    await lava(createService(lavaCalls, knowsNothing()), 'https://app.example.com/payment-return');
    await severpay(createService(severpayCalls, knowsNothing()));

    assert.equal(lavaCalls[0]?.body.email, 'payment-lava-1@admin.example');
    assert.equal(severpayCalls[0]?.body.client_email, 'payment-sp-1@admin.example');
  });
});

describe('the fallback to the panel', () => {
  it('is said once, at warn level, naming the variable, however many checkouts take it', async () => {
    const warn = mock.method(Logger.prototype, 'warn', () => undefined);
    const service = createService([], knowsNothing());

    await yookassa(service);
    await lava(service);
    await severpay(service);
    await platega(service);

    assert.equal(fallbackWarnings(warn), 1);
  });

  it('is not said when the cabinet is known, or when the caller named the page', async () => {
    const warn = mock.method(Logger.prototype, 'warn', () => undefined);

    await yookassa(createService([], realResolver({ webBaseUrl: 'https://app.example.com' })));
    await lava(createService([], realResolver({ webBaseUrl: 'https://app.example.com' })));
    await yookassa(createService([], knowsNothing()), 'https://app.example.com/payment-return');

    assert.equal(fallbackWarnings(warn), 0);
  });
});

describe("the provider's callback", () => {
  it('stays the panel, where the webhooks are received', async () => {
    const calls: PostedRequest[] = [];

    await createService(calls, realResolver({ webBaseUrl: 'https://app.example.com' })).createCheckout({
      gateway: gateway(PaymentGatewayType.HELEKET, { merchantId: 'merchant-1', apiKey: 'secret-1' }),
      transaction: transaction('payment-heleket-1', PaymentGatewayType.HELEKET),
      description: 'Crypto checkout',
    });

    assert.equal(calls[0]?.body.url_callback, 'https://admin.example/api/v1/payments/webhooks/HELEKET');
    assert.equal(calls[0]?.body.url_success, 'https://app.example.com/payment-return?paymentId=payment-heleket-1');
    assert.equal(calls[0]?.body.url_return, 'https://app.example.com/payment-return?paymentId=payment-heleket-1');
  });
});

describe('the wiring', () => {
  /** Every module reachable from `root` through `imports`, including itself. */
  function reachableImports(root: unknown): Set<unknown> {
    const seen = new Set<unknown>([root]);
    const queue: unknown[] = [root];
    while (queue.length > 0) {
      const current = queue.shift();
      for (const imported of (Reflect.getMetadata('imports', current as object) ?? []) as unknown[]) {
        const target =
          imported !== null && typeof imported === 'object' && 'module' in imported
            ? (imported as { module: unknown }).module
            : imported;
        if (target === undefined || target === null || seen.has(target)) continue;
        seen.add(target);
        queue.push(target);
      }
    }
    return seen;
  }

  it('asks the one resolver, which the payments module can inject', () => {
    const params = (Reflect.getMetadata('design:paramtypes', PaymentProviderExecutionService) ?? []) as unknown[];
    const index = params.indexOf(ReiwaAdvertisingLinkConfigService);
    assert.ok(index >= 0, 'the service does not take the resolver');
    // Required, not `@Optional()`: a lost import must stop the boot, not send
    // every payer to the panel with every spec still green.
    const optional = (Reflect.getMetadata('optional:paramtypes', PaymentProviderExecutionService) ?? []) as number[];
    assert.equal(optional.includes(index), false, 'the resolver is injected as optional');
    // Directly: `AdvertisingModule` imports the resolver's module without
    // exporting it, so reaching it through that module would not inject.
    assert.ok(
      ((Reflect.getMetadata('imports', PaymentsModule) ?? []) as unknown[]).includes(ReiwaPublicLinksModule),
      'PaymentsModule does not import ReiwaPublicLinksModule',
    );
    assert.ok(reachableImports(PaymentsModule).has(ReiwaPublicLinksModule));
    assert.ok(
      ((Reflect.getMetadata('exports', ReiwaPublicLinksModule) ?? []) as unknown[]).includes(ReiwaAdvertisingLinkConfigService),
    );
  });
});
