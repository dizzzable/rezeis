import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';

import { Currency, PaymentGatewayType, PurchaseChannel, PurchaseType, TransactionStatus } from '@prisma/client';
import { of } from 'rxjs';

import { paymentsConfig } from '../src/common/config/payments.config';
import { normalizePanelBaseUrl } from '../src/common/config/public-site-url.util';
import { AntiFraudService } from '../src/modules/anti-fraud/services/anti-fraud.service';
import {
  buildResultUrl,
  buildWebhookUrl,
} from '../src/modules/payments/services/payment-provider-execution.helpers';
import { PaymentProviderExecutionService } from '../src/modules/payments/services/payment-provider-execution.service';
import { PaymentWebhookPayloadRedactionService } from '../src/modules/payments/services/payment-webhook-payload-redaction.service';

/**
 * `docs/environment.md` lets an operator write `REZEIS_DOMAIN=panel.example.com`
 * with no scheme. The panel then handed AuraPay
 * `callback_url=panel.example.com/api/v1/payments/webhooks/AURAPAY`, and six
 * more gateways the same shape. The base is made absolute in one place.
 */

const savedEnvironment = {
  web: process.env.REIWA_WEB_BASE_URL,
  miniApp: process.env.MINIAPP_CUSTOM_URL,
  domain: process.env.REZEIS_DOMAIN,
};
before(() => {
  // No cabinet address, so the return page falls back to the panel's domain.
  delete process.env.REIWA_WEB_BASE_URL;
  delete process.env.MINIAPP_CUSTOM_URL;
});
afterEach(() => {
  restore('REZEIS_DOMAIN', savedEnvironment.domain);
});
after(() => {
  restore('REIWA_WEB_BASE_URL', savedEnvironment.web);
  restore('MINIAPP_CUSTOM_URL', savedEnvironment.miniApp);
  restore('REZEIS_DOMAIN', savedEnvironment.domain);
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe('normalizePanelBaseUrl', () => {
  const cases: ReadonlyArray<readonly [string, string | null | undefined, string | null]> = [
    ['a bare host gets https', 'panel.example.com', 'https://panel.example.com'],
    ['a bare host with a port gets https', 'panel.example.com:8443', 'https://panel.example.com:8443'],
    ['an https host is kept', 'https://panel.example.com', 'https://panel.example.com'],
    ['an http host keeps its http', 'http://panel.internal', 'http://panel.internal'],
    ['the scheme is matched case-insensitively', 'HTTPS://Panel.Example.com', 'HTTPS://Panel.Example.com'],
    ['one trailing slash goes', 'https://panel.example.com/', 'https://panel.example.com'],
    ['several trailing slashes go', 'panel.example.com///', 'https://panel.example.com'],
    ['a path stays, its trailing slash goes', 'https://panel.example.com/admin/', 'https://panel.example.com/admin'],
    ['surrounding whitespace goes', '  panel.example.com  ', 'https://panel.example.com'],
    ['a scheme-relative host gets https', '//panel.example.com', 'https://panel.example.com'],
    ['an empty value is no address', '', null],
    ['whitespace is no address', '   ', null],
    ['null is no address', null, null],
    ['undefined is no address', undefined, null],
    ['a lone slash is no address', '/', null],
    ['a lone scheme is no address', 'https://', null],
  ];

  for (const [title, input, expected] of cases) {
    it(title, () => {
      assert.equal(normalizePanelBaseUrl(input), expected);
    });
  }

  it('is idempotent', () => {
    for (const [, input] of cases) {
      const once = normalizePanelBaseUrl(input);
      assert.equal(normalizePanelBaseUrl(once), once);
    }
  });

  it('puts the scheme the caller names on a bare host and leaves a written one alone', () => {
    assert.equal(normalizePanelBaseUrl('rezeis', 'http'), 'http://rezeis');
    assert.equal(normalizePanelBaseUrl('https://panel.example.com', 'http'), 'https://panel.example.com');
  });
});

describe('paymentsConfig.domain', () => {
  it('is an absolute URL when REZEIS_DOMAIN is a bare host', () => {
    process.env.REZEIS_DOMAIN = 'panel.example.com';
    assert.equal(paymentsConfig().domain, 'https://panel.example.com');
  });

  it('keeps https, http and a path, and drops the trailing slash', () => {
    for (const [raw, expected] of [
      ['https://panel.example.com', 'https://panel.example.com'],
      ['http://panel.example.com', 'http://panel.example.com'],
      ['https://panel.example.com/', 'https://panel.example.com'],
      ['https://panel.example.com/panel/', 'https://panel.example.com/panel'],
    ] as const) {
      process.env.REZEIS_DOMAIN = raw;
      assert.equal(paymentsConfig().domain, expected, raw);
    }
  });

  it('is null when REZEIS_DOMAIN is unset or blank', () => {
    delete process.env.REZEIS_DOMAIN;
    assert.equal(paymentsConfig().domain, null);
    process.env.REZEIS_DOMAIN = '   ';
    assert.equal(paymentsConfig().domain, null);
  });
});

describe('webhook and return addresses built on a REZEIS_DOMAIN without a scheme', () => {
  const GATEWAYS_THAT_CALL_BACK = [
    PaymentGatewayType.AURAPAY,
    PaymentGatewayType.CRYPTOMUS,
    PaymentGatewayType.HELEKET,
    PaymentGatewayType.OVERPAY,
    PaymentGatewayType.PAYPALYCH,
    PaymentGatewayType.RIOPAY,
    PaymentGatewayType.VALUTIX,
  ] as const;

  it('gives every gateway that sends a callback an absolute one, whatever the operator wrote', () => {
    for (const written of [
      'panel.example.com',
      'https://panel.example.com',
      'https://panel.example.com/',
      '  panel.example.com/  ',
    ]) {
      for (const gateway of GATEWAYS_THAT_CALL_BACK) {
        assert.equal(
          buildWebhookUrl(written, gateway),
          `https://panel.example.com/api/v1/payments/webhooks/${gateway}`,
          `${gateway} with ${JSON.stringify(written)}`,
        );
      }
    }
  });

  it('keeps an http domain as the operator wrote it', () => {
    assert.equal(
      buildWebhookUrl('http://panel.internal:3000/', PaymentGatewayType.AURAPAY),
      'http://panel.internal:3000/api/v1/payments/webhooks/AURAPAY',
    );
  });

  it('still refuses when there is no domain at all', () => {
    assert.throws(() => buildWebhookUrl(null, PaymentGatewayType.AURAPAY), /not configured/);
    assert.throws(() => buildWebhookUrl('   ', PaymentGatewayType.AURAPAY), /not configured/);
  });

  it('builds the fallback return page on an absolute panel address', () => {
    assert.equal(
      buildResultUrl({ kind: 'PANEL', domain: 'panel.example.com' }, 'payment 1'),
      'https://panel.example.com/payments/result?paymentId=payment%201',
    );
    assert.equal(
      buildResultUrl({ kind: 'PANEL', domain: 'http://panel.example.com/' }, 'p1'),
      'http://panel.example.com/payments/result?paymentId=p1',
    );
  });

  it('sends AuraPay a callback_url with a scheme, from the environment through the config', async () => {
    process.env.REZEIS_DOMAIN = 'panel.example.com';
    const payload = await createAurapayCheckout(paymentsConfig().domain);

    assert.equal(payload.callback_url, 'https://panel.example.com/api/v1/payments/webhooks/AURAPAY');
    // The return pages fall back to the panel's domain when the cabinet's address is unknown.
    assert.equal(payload.success_url, 'https://panel.example.com/payments/result?paymentId=payment-aura-1');
    assert.equal(payload.fail_url, 'https://panel.example.com/payments/result?paymentId=payment-aura-1');
  });

  it('sends AuraPay the same callback_url even when the service is handed the raw bare host', async () => {
    const payload = await createAurapayCheckout('panel.example.com');

    assert.equal(payload.callback_url, 'https://panel.example.com/api/v1/payments/webhooks/AURAPAY');
  });

  it('does not double the slash when the domain has a trailing one', async () => {
    const payload = await createAurapayCheckout('https://panel.example.com/');

    assert.equal(payload.callback_url, 'https://panel.example.com/api/v1/payments/webhooks/AURAPAY');
  });
});

describe('the anti-fraud profile link built on REZEIS_DOMAIN', () => {
  it('has exactly one scheme whether or not the operator wrote one', async () => {
    for (const [written, expected] of [
      ['panel.example.com', 'https://panel.example.com/users/12345'],
      ['https://panel.example.com', 'https://panel.example.com/users/12345'],
      ['https://panel.example.com/', 'https://panel.example.com/users/12345'],
      ['http://panel.example.com', 'http://panel.example.com/users/12345'],
      ['rezeis-admin:3000', 'http://rezeis-admin:3000/users/12345'],
    ] as const) {
      process.env.REZEIS_DOMAIN = written;
      const payload = await fraudPayload();
      assert.equal(payload.fraudProfileUrl, expected, written);
      assert.equal(String(payload.fraudProfileUrl).split('://').length, 2, `one scheme in ${written}`);
    }
  });

  it('gives no link for localhost, in either spelling, or without a domain', async () => {
    for (const written of ['localhost', 'http://localhost', 'http://localhost:3000/', undefined]) {
      if (written === undefined) delete process.env.REZEIS_DOMAIN;
      else process.env.REZEIS_DOMAIN = written;
      const payload = await fraudPayload();
      assert.equal('fraudProfileUrl' in payload, false, String(written));
    }
  });
});

async function fraudPayload(): Promise<Record<string, unknown>> {
  const prismaService = {
    user: {
      findUnique: async () => ({
        id: 'user-1',
        telegramId: 12345n,
        username: 'someone',
        name: 'Some One',
        email: null,
        role: 'USER',
        isBlocked: false,
        webAccount: null,
        _count: { subscriptions: 1 },
      }),
    },
  };
  const service = new AntiFraudService(
    prismaService as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  ) as unknown as {
    buildFraudNotifyPayload(signal: unknown, candidate: unknown): Promise<Record<string, unknown>>;
  };
  return service.buildFraudNotifyPayload(
    { id: 'signal-1', code: 'IP_SHARING', score: 50, confidence: 0.5 },
    { metadata: { kind: 'ip_sharing' }, affectedUserIds: ['user-1'] },
  );
}

async function createAurapayCheckout(domain: string | null): Promise<Record<string, unknown>> {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const service = new PaymentProviderExecutionService(
    {
      post: (url: string, body: Record<string, unknown>) => {
        calls.push({ url, body });
        return of({
          data: { id: 'aura-1', status: 'PENDING', payment_data: { url: 'https://pay.aurapay.tech/1' } },
        });
      },
    } as never,
    { domain, botToken: 'bot-token-1' } as never,
    new PaymentWebhookPayloadRedactionService(),
  );

  await service.createCheckout({
    gateway: {
      id: 'gateway-1',
      type: PaymentGatewayType.AURAPAY,
      orderIndex: 1,
      currency: Currency.RUB,
      isActive: true,
      settings: { apiKey: 'api-key-1', shopId: 'shop-1' },
      createdAt: new Date('2026-04-19T12:00:00.000Z'),
      updatedAt: new Date('2026-04-19T12:00:00.000Z'),
    } as never,
    transaction: {
      id: 'transaction-1',
      paymentId: 'payment-aura-1',
      userId: 'user-1',
      subscriptionId: null,
      status: TransactionStatus.PENDING,
      purchaseType: PurchaseType.NEW,
      channel: PurchaseChannel.WEB,
      gatewayType: PaymentGatewayType.AURAPAY,
      gatewayId: null,
      gatewayData: null,
      currency: Currency.RUB,
      paymentAsset: null,
      amount: { toString: () => '199' },
      planSnapshot: {},
      deviceTypes: [],
      createdAt: new Date('2026-04-19T12:00:00.000Z'),
      updatedAt: new Date('2026-04-19T12:00:00.000Z'),
    } as never,
    description: 'Plan purchase',
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://app.aurapay.tech/invoice/create');
  return calls[0].body;
}
