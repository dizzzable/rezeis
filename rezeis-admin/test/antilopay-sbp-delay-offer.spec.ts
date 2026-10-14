import 'reflect-metadata';

import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  Currency,
  PaymentGatewayType,
  Prisma,
  ProviderSubscriptionStatus,
  PurchaseChannel,
  PurchaseType,
} from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { of } from 'rxjs';

import { SAFE_REFUSAL_REASONS } from '../src/common/filters/admin-safe-exception.filter';
import { InternalPaymentsController } from '../src/modules/payments/controllers/internal-payments.controller';
import { InternalPaymentCheckoutDto } from '../src/modules/payments/dto/internal-payment-checkout.dto';
import { InternalRenewalCheckoutDto } from '../src/modules/payments/dto/internal-renewal-checkout.dto';
import { PaymentProviderExecutionService } from '../src/modules/payments/services/payment-provider-execution.service';
import { PaymentWebhookPayloadRedactionService } from '../src/modules/payments/services/payment-webhook-payload-redaction.service';
import { ProviderSubscriptionService } from '../src/modules/payments/services/provider-subscription.service';
import {
  decideAntilopayDelay,
  readShownDelay,
  settleDelayWithConsent,
} from '../src/modules/payments/utils/antilopay-delay-policy.util';
import { makeAntilopayDelay } from '../src/modules/payments/utils/antilopay-recurrent.util';
import {
  AUTOPAY_NOT_AVAILABLE_CODE,
  autopayNotAvailable,
  PROVIDER_SUBSCRIPTION_REFUSALS,
  PROVIDER_SUBSCRIPTION_SNAPSHOT_KEY,
  readProviderSubscriptionTerms,
  resolveProviderSubscriptionTerms,
} from '../src/modules/payments/utils/provider-subscription-terms.util';
import {
  CABINET_CAPABILITY,
  CABINET_CAPABILITY_REGISTRY,
  CabinetView,
} from '../src/modules/reiwa-peers/cabinet-capabilities';

const KEYS = { projectIdentificator: 'project-1', secretId: 'secret-id-1' };

/** The wire words, written out: a derived expectation would follow a typo in the code. */
const WIRE_UNITS = ['DAY', 'WEEK', 'MONTH', 'QUARTER', 'YEAR'] as const;
/** A count each unit allows (a year of years would pass the cap of a year). */
const COUNT_OF: Readonly<Record<(typeof WIRE_UNITS)[number], number>> = { DAY: 3, WEEK: 3, MONTH: 3, QUARTER: 1, YEAR: 1 };

const SBP_SETTINGS = {
  ...KEYS,
  autopayCardApproved: true,
  autopaySbpApproved: true,
  sbpDelayCount: 7,
  sbpDelayUnit: 'DAY',
};
const CAN_DELAY = CabinetView.of([CABINET_CAPABILITY.autopayFirstChargeDelay], 'a cabinet that shows the delay');
const SEVEN_DAYS = { count: 7, unit: 'DAY', days: 7 } as const;

// ── the decision: who is offered the delay, and what is sent ─────────────────

describe('who is offered the delay of the first SBP charge', () => {
  const decide = (overrides: Record<string, unknown> = {}) =>
    decideAntilopayDelay({
      settings: SBP_SETTINGS,
      method: 'SBP',
      audience: CAN_DELAY,
      alreadyUsed: false,
      ...overrides,
    } as never);

  it('offers the operator\'s delay to an SBP payer of a cabinet that shows it, once', () => {
    assert.deepEqual(decide(), SEVEN_DAYS);
  });

  it('offers a card none: its first payment is charged on the form', () => {
    assert.equal(decide({ method: 'CARD' }), null);
    assert.equal(decide({ method: undefined }), null);
  });

  it('offers nothing to a cabinet that cannot show it: an older one keeps charging at once', () => {
    assert.equal(decide({ audience: CabinetView.floor() }), null);
    assert.equal(decide({ audience: CabinetView.of([], 'declares nothing') }), null);
    assert.equal(decide({ audience: undefined }), null, 'a caller that is not a cabinet');
    assert.deepEqual(decide({ audience: CabinetView.all() }), SEVEN_DAYS);
  });

  it('offers nothing to a customer who has used it', () => {
    assert.equal(decide({ alreadyUsed: true }), null);
  });

  it('offers nothing without the operator\'s approval of SBP or a delay set', () => {
    assert.equal(decide({ settings: { ...SBP_SETTINGS, autopaySbpApproved: false } }), null);
    assert.equal(decide({ settings: { ...SBP_SETTINGS, autopayCardApproved: true, autopaySbpApproved: undefined } }), null);
    assert.equal(decide({ settings: { ...SBP_SETTINGS, sbpDelayCount: 0 } }), null);
    assert.equal(decide({ settings: { ...SBP_SETTINGS, sbpDelayCount: undefined } }), null);
    assert.equal(decide({ settings: { ...SBP_SETTINGS, sbpDelayUnit: 'day' } }), null, 'a unit in the wrong case is no delay');
  });
});

describe('the delay the payer was shown', () => {
  it('reads both fields, or neither, and nothing half-said', () => {
    assert.deepEqual(readShownDelay({}), { kind: 'NONE' });
    assert.deepEqual(readShownDelay({ autopayDelayCount: null, autopayDelayUnit: undefined }), { kind: 'NONE' });
    assert.deepEqual(readShownDelay({ autopayDelayCount: 7, autopayDelayUnit: 'DAY' }), { kind: 'SHOWN', delay: SEVEN_DAYS });
    assert.deepEqual(readShownDelay({ autopayDelayCount: 7 }), { kind: 'MALFORMED' });
    assert.deepEqual(readShownDelay({ autopayDelayUnit: 'DAY' }), { kind: 'MALFORMED' });
    assert.deepEqual(readShownDelay({ autopayDelayCount: 7, autopayDelayUnit: 'day' }), { kind: 'MALFORMED' });
    assert.deepEqual(readShownDelay({ autopayDelayCount: 0, autopayDelayUnit: 'DAY' }), { kind: 'MALFORMED' });
    assert.deepEqual(readShownDelay({ autopayDelayCount: 5000, autopayDelayUnit: 'DAY' }), { kind: 'MALFORMED' });
  });

  it('is what the checkout is made with, or it is refused: never charged now after "nothing now", never another delay', () => {
    const shown = readShownDelay({ autopayDelayCount: 7, autopayDelayUnit: 'DAY' });
    assert.deepEqual(settleDelayWithConsent(shown, SEVEN_DAYS), { kind: 'APPLY', delay: SEVEN_DAYS });
    // The operator changed it, removed it, or the customer used it elsewhere since.
    assert.deepEqual(settleDelayWithConsent(shown, { count: 1, unit: 'WEEK', days: 7 }), { kind: 'REFUSE' });
    assert.deepEqual(settleDelayWithConsent(shown, { count: 8, unit: 'DAY', days: 8 }), { kind: 'REFUSE' });
    assert.deepEqual(settleDelayWithConsent(shown, null), { kind: 'REFUSE' });
    assert.deepEqual(settleDelayWithConsent({ kind: 'MALFORMED' }, SEVEN_DAYS), { kind: 'REFUSE' });
  });

  it('is no delay when none was shown, whatever the panel would offer: the payer was told it is charged now', () => {
    assert.deepEqual(settleDelayWithConsent({ kind: 'NONE' }, SEVEN_DAYS), { kind: 'APPLY', delay: null });
    assert.deepEqual(settleDelayWithConsent({ kind: 'NONE' }, null), { kind: 'APPLY', delay: null });
  });
});

describe('the capability that gates the delay', () => {
  it('is registered as a gate, checked in the policy file, with words for the operator', () => {
    const row = CABINET_CAPABILITY_REGISTRY.find((candidate) => candidate.id === 'web.autopay-first-charge-delay');
    assert.ok(row);
    assert.equal(row.kind, 'gate');
    assert.deepEqual(row.gatedIn, ['src/modules/payments/utils/antilopay-delay-policy.util.ts']);
    assert.equal(CABINET_CAPABILITY.autopayFirstChargeDelay, 'web.autopay-first-charge-delay');
    // No version implies it: only a cabinet that declares it has it.
    assert.equal(CabinetView.floor().can(CABINET_CAPABILITY.autopayFirstChargeDelay), false);
  });
});

// ── the terms a draft carries, and the wire ──────────────────────────────────

const SBP_BASE = {
  gatewayType: PaymentGatewayType.ANTILOPAY as PaymentGatewayType,
  currency: 'RUB',
  amount: new Prisma.Decimal('299.00000000'),
  durationDays: 30,
  discountSource: 'NONE' as const,
  planId: 'plan-1',
  subscriptionId: null,
};

describe('the terms of a sign-up with a delay', () => {
  it('carry the delay of an SBP sign-up out of the draft\'s snapshot and back', () => {
    const resolved = resolveProviderSubscriptionTerms({ ...SBP_BASE, method: 'SBP', delay: SEVEN_DAYS });
    assert.ok('terms' in resolved);
    assert.deepEqual(resolved.terms.delay, SEVEN_DAYS);
    const snapshot = JSON.parse(JSON.stringify({ id: 'plan-1', [PROVIDER_SUBSCRIPTION_SNAPSHOT_KEY]: resolved.terms }));
    assert.deepEqual(readProviderSubscriptionTerms(snapshot), resolved.terms);
  });

  it('carry none for a card, however the delay got there, and none when there is none', () => {
    const card = resolveProviderSubscriptionTerms({ ...SBP_BASE, method: 'CARD', delay: SEVEN_DAYS });
    assert.ok('terms' in card);
    assert.equal('delay' in card.terms, false);
    const plain = resolveProviderSubscriptionTerms({ ...SBP_BASE, method: 'SBP' });
    assert.ok('terms' in plain);
    assert.equal('delay' in plain.terms, false);
    const nulled = resolveProviderSubscriptionTerms({ ...SBP_BASE, method: 'SBP', delay: null });
    assert.ok('terms' in nulled);
    assert.equal('delay' in nulled.terms, false);
  });

  it('read a delay that is not one as none', () => {
    const snapshot = (delay: unknown) => ({
      [PROVIDER_SUBSCRIPTION_SNAPSHOT_KEY]: {
        unit: 'month',
        count: 1,
        amount: 299,
        durationDays: 30,
        planId: 'plan-1',
        subscriptionId: null,
        method: 'SBP',
        delay,
      },
    });
    for (const delay of [
      { count: 7, unit: 'day', days: 7 },
      { count: 7, unit: 'DAY', days: 8 },
      { count: 0, unit: 'DAY', days: 0 },
      { count: 7, unit: 'DAY' },
      'DAY',
      [],
      null,
    ]) {
      assert.equal(readProviderSubscriptionTerms(snapshot(delay))?.delay, undefined, JSON.stringify(delay));
    }
    assert.deepEqual(readProviderSubscriptionTerms(snapshot(SEVEN_DAYS))?.delay, SEVEN_DAYS);
  });

  it('are refused as DELAY_CHANGED when the delay the payer saw is gone, a reason the cabinet is let through with', () => {
    assert.ok((PROVIDER_SUBSCRIPTION_REFUSALS as readonly string[]).includes('DELAY_CHANGED'));
    assert.ok(SAFE_REFUSAL_REASONS.has('DELAY_CHANGED'));
    assert.equal(autopayNotAvailable('DELAY_CHANGED').getStatus(), 400);
    const body = autopayNotAvailable('DELAY_CHANGED').getResponse() as { code: string; reason: string };
    assert.equal(body.code, AUTOPAY_NOT_AVAILABLE_CODE);
    assert.equal(body.reason, 'DELAY_CHANGED');
  });
});

describe('the checkout the panel sends Antilopay for a sign-up with a delay', () => {
  const keyPair = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const settings = { ...SBP_SETTINGS, privateKey: keyPair.privateKey, publicKey: 'MFwwDQYJKoZI' };

  function terms(method: 'CARD' | 'SBP', extra: Record<string, unknown> = {}) {
    return { unit: 'month', count: 1, amount: 299, durationDays: 30, planId: 'plan-1', subscriptionId: null, method, ...extra };
  }

  async function send(snapshot: Record<string, unknown>, gatewaySettings: Record<string, unknown> = settings) {
    const calls: Array<{ url: string; body: string }> = [];
    const service = new PaymentProviderExecutionService(
      {
        post: (url: string, body: string) => {
          calls.push({ url, body });
          return of({ data: { code: 0, payment_id: 'APAY-1', payment_url: 'https://gate.antilopay.com/payment/APAY-1' } });
        },
      } as never,
      { domain: 'https://user.example', botToken: 'bot-token-1' } as never,
      new PaymentWebhookPayloadRedactionService(),
    );
    await service.createCheckout({
      gateway: {
        id: 'gw-1',
        type: PaymentGatewayType.ANTILOPAY,
        currency: Currency.RUB,
        isActive: true,
        orderIndex: 0,
        settings: gatewaySettings,
      } as never,
      transaction: {
        id: 'tx-1',
        paymentId: 'payment-1',
        userId: 'user-1',
        gatewayType: PaymentGatewayType.ANTILOPAY,
        amount: new Prisma.Decimal('299'),
        currency: Currency.RUB,
        planSnapshot: snapshot,
        purchaseType: PurchaseType.NEW,
        channel: PurchaseChannel.WEB,
      } as never,
      description: 'Plan purchase',
      customerEmail: 'buyer@example.com',
    } as never);
    return calls;
  }

  for (const unit of WIRE_UNITS) {
    it(`signs delay and delay_type ${unit} exactly as written, upper-case, in the string that is sent`, async () => {
      const delay = makeAntilopayDelay(COUNT_OF[unit], unit);
      const calls = await send({ [PROVIDER_SUBSCRIPTION_SNAPSHOT_KEY]: terms('SBP', { delay }) });
      assert.equal(calls.length, 1);
      const raw = calls[0]?.body ?? '';
      assert.ok(raw.includes(`"delay":${COUNT_OF[unit]},"delay_type":"${unit}"`), raw);
      assert.ok(raw.includes('"category":"SUBSCRIPTION"'), raw);
      assert.ok(raw.includes('"currency":"RUB"'), raw);
      const body = JSON.parse(raw) as Record<string, unknown>;
      assert.deepEqual(body['recurrent'], {
        type: 'MONTH',
        category: 'SUBSCRIPTION',
        delay: COUNT_OF[unit],
        delay_type: unit,
      });
      assert.deepEqual(body['prefer_methods'], ['SBP']);
      assert.equal(body['amount'], 299, 'the sum of every charge is still the plan\'s price');
    });
  }

  it('keeps delay 0 in the period\'s word when the sign-up has none', async () => {
    const calls = await send({ [PROVIDER_SUBSCRIPTION_SNAPSHOT_KEY]: terms('SBP') });
    const body = JSON.parse(calls[0]?.body ?? '{}') as Record<string, unknown>;
    assert.deepEqual(body['recurrent'], { type: 'MONTH', category: 'SUBSCRIPTION', delay: 0, delay_type: 'MONTH' });
  });

  it('sends a card no delay even from terms that carry one', async () => {
    const calls = await send({ [PROVIDER_SUBSCRIPTION_SNAPSHOT_KEY]: terms('CARD', { delay: SEVEN_DAYS }) });
    const body = JSON.parse(calls[0]?.body ?? '{}') as Record<string, unknown>;
    assert.deepEqual(body['recurrent'], { type: 'MONTH', category: 'PAYMENT_TEMPLATE' });
  });

  it('sends what the payer agreed to, not what the setting says now', async () => {
    const calls = await send(
      { [PROVIDER_SUBSCRIPTION_SNAPSHOT_KEY]: terms('SBP', { delay: SEVEN_DAYS }) },
      { ...settings, sbpDelayCount: 30, sbpDelayUnit: 'DAY' },
    );
    const body = JSON.parse(calls[0]?.body ?? '{}') as Record<string, unknown>;
    assert.deepEqual(body['recurrent'], { type: 'MONTH', category: 'SUBSCRIPTION', delay: 7, delay_type: 'DAY' });
  });
});

// ── once per customer, and the gate in the service ───────────────────────────

type DelayRow = {
  readonly userId: string | null;
  readonly gatewayType: PaymentGatewayType;
  readonly delayDays: number | null;
  readonly delayGrantedAt: Date | null;
  readonly status: ProviderSubscriptionStatus;
};

/** Evaluates the one `where` `hasUsedDelay` asks, over rows, so what it asks is what is tested. */
function delayService(rows: readonly DelayRow[]) {
  const asked: unknown[] = [];
  const prisma = {
    providerSubscription: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        asked.push(where);
        const or = where['OR'] as Array<Record<string, unknown>>;
        const gt = (where['delayDays'] as { gt: number }).gt;
        return (
          rows.find((row) => {
            if (row.userId !== where['userId'] || row.gatewayType !== where['gatewayType']) return false;
            if (row.delayDays === null || !(row.delayDays > gt)) return false;
            return or.some((clause) => {
              const granted = clause['delayGrantedAt'] as { not: null } | undefined;
              if (granted !== undefined) return row.delayGrantedAt !== null;
              const status = clause['status'] as { in: ProviderSubscriptionStatus[] } | undefined;
              return status !== undefined && status.in.includes(row.status);
            });
          }) ?? null
        );
      },
    },
  };
  const service = new ProviderSubscriptionService(prisma as never, {} as never, {} as never, {} as never);
  return { service, asked };
}

const row = (overrides: Partial<DelayRow> = {}): DelayRow => ({
  userId: 'user-1',
  gatewayType: PaymentGatewayType.ANTILOPAY,
  delayDays: 7,
  delayGrantedAt: new Date('2026-10-01T10:00:00Z'),
  status: ProviderSubscriptionStatus.ACTIVE,
  ...overrides,
});

describe('the delay is given once per customer', () => {
  it('counts a customer who was granted it, whatever became of the subscription', async () => {
    for (const status of Object.values(ProviderSubscriptionStatus)) {
      const { service } = delayService([row({ status })]);
      assert.equal(await service.hasUsedDelay('user-1'), true, `a ${status} subscription`);
    }
  });

  it('counts a delayed subscription that is live and about to be granted, but not one still waiting for its payer', async () => {
    const live = delayService([row({ delayGrantedAt: null, status: ProviderSubscriptionStatus.ACTIVE })]);
    assert.equal(await live.service.hasUsedDelay('user-1'), true);
    const pastDue = delayService([row({ delayGrantedAt: null, status: ProviderSubscriptionStatus.PAST_DUE })]);
    assert.equal(await pastDue.service.hasUsedDelay('user-1'), true);
    const waiting = delayService([row({ delayGrantedAt: null, status: ProviderSubscriptionStatus.PENDING })]);
    assert.equal(await waiting.service.hasUsedDelay('user-1'), false, 'a link nobody paid gave nothing');
    const abandoned = delayService([row({ delayGrantedAt: null, status: ProviderSubscriptionStatus.CANCELLED })]);
    assert.equal(await abandoned.service.hasUsedDelay('user-1'), false, 'cancelled before it was ever granted');
  });

  it('does not count another customer, a subscription without a delay, or another gateway', async () => {
    const { service } = delayService([
      row({ userId: 'user-2' }),
      row({ delayDays: null }),
      row({ delayDays: 0 }),
      row({ gatewayType: PaymentGatewayType.PLATEGA }),
    ]);
    assert.equal(await service.hasUsedDelay('user-1'), false);
  });
});

describe('settling the delay at checkout', () => {
  type Refusal = { readonly refused?: { readonly code?: string; readonly reason?: string } };
  const settle = async (input: {
    readonly rows?: readonly DelayRow[];
    readonly shown: ReturnType<typeof readShownDelay>;
    readonly audience?: CabinetView;
    readonly settings?: Record<string, unknown>;
    readonly method?: 'CARD' | 'SBP';
  }) => {
    const { service, asked } = delayService(input.rows ?? []);
    const outcome: { readonly delay: unknown } | Refusal = await service
      .settleAntilopayDelay({
        userId: 'user-1',
        settings: input.settings ?? SBP_SETTINGS,
        method: input.method ?? 'SBP',
        audience: 'audience' in input ? input.audience : CAN_DELAY,
        shown: input.shown,
      })
      .then(
        (delay) => ({ delay }),
        (error: { getResponse?: () => { code?: string; reason?: string } }) => ({ refused: error.getResponse?.() }),
      );
    return { outcome, asked };
  };
  const shown7 = readShownDelay({ autopayDelayCount: 7, autopayDelayUnit: 'DAY' });
  const reasonOf = (outcome: { readonly delay: unknown } | Refusal): string | undefined =>
    'refused' in outcome ? outcome.refused?.reason : undefined;

  it('gives the delay the payer was shown when the panel gives it too', async () => {
    const { outcome } = await settle({ shown: shown7 });
    assert.deepEqual(outcome, { delay: SEVEN_DAYS });
  });

  it('asks nothing and gives nothing when no delay was shown', async () => {
    const { outcome, asked } = await settle({ shown: { kind: 'NONE' } });
    assert.deepEqual(outcome, { delay: null });
    assert.equal(asked.length, 0, 'the common checkout costs no query');
  });

  it('refuses a delay shown by a cabinet that, to the panel, cannot show it', async () => {
    const { outcome } = await settle({ shown: shown7, audience: CabinetView.floor() });
    assert.equal(reasonOf(outcome), 'DELAY_CHANGED');
    assert.equal((outcome as Refusal).refused?.code, AUTOPAY_NOT_AVAILABLE_CODE);
  });

  it('refuses a delay shown to a customer who has used it since, to a card, and to a changed setting', async () => {
    assert.equal(reasonOf((await settle({ shown: shown7, rows: [row()] })).outcome), 'DELAY_CHANGED');
    assert.equal(reasonOf((await settle({ shown: shown7, method: 'CARD' })).outcome), 'DELAY_CHANGED');
    assert.equal(reasonOf((await settle({ shown: shown7, settings: { ...SBP_SETTINGS, sbpDelayCount: 14 } })).outcome), 'DELAY_CHANGED');
    assert.equal(reasonOf((await settle({ shown: shown7, settings: { ...SBP_SETTINGS, sbpDelayCount: 0 } })).outcome), 'DELAY_CHANGED');
  });

  it('refuses a delay it cannot read', async () => {
    const { outcome } = await settle({ shown: readShownDelay({ autopayDelayCount: 7 }) });
    assert.equal(reasonOf(outcome), 'DELAY_CHANGED');
  });
});

describe('the checkout request carries the delay the payer was shown', () => {
  const properties = async (Dto: new () => object, extra: Record<string, unknown>) =>
    validate(
      plainToInstance(Dto, {
        purchaseType: 'NEW',
        planId: 'plan-1',
        durationDays: 30,
        gatewayType: 'ANTILOPAY',
        subscriptionIds: ['sub-1'],
        userId: 'user-1',
        ...extra,
      }),
      { whitelist: true, forbidNonWhitelisted: true },
    ).then((errors) => errors.map((error) => error.property));

  for (const [name, Dto] of [
    ['InternalPaymentCheckoutDto', InternalPaymentCheckoutDto],
    ['InternalRenewalCheckoutDto', InternalRenewalCheckoutDto],
  ] as const) {
    it(`${name} takes a count and one of the five words`, async () => {
      for (const unit of WIRE_UNITS) {
        const invalid = await properties(Dto, { autopayDelayCount: 1, autopayDelayUnit: unit });
        assert.equal(invalid.includes('autopayDelayCount') || invalid.includes('autopayDelayUnit'), false, unit);
      }
    });

    it(`${name} refuses a lower-case word, an unknown one and a count that is not 1 to 366`, async () => {
      assert.ok((await properties(Dto, { autopayDelayCount: 7, autopayDelayUnit: 'day' })).includes('autopayDelayUnit'));
      assert.ok((await properties(Dto, { autopayDelayCount: 7, autopayDelayUnit: 'HOUR' })).includes('autopayDelayUnit'));
      for (const count of [0, -1, 367, 1.5, '7']) {
        assert.ok(
          (await properties(Dto, { autopayDelayCount: count, autopayDelayUnit: 'DAY' })).includes('autopayDelayCount'),
          String(count),
        );
      }
    });
  }
});

describe('the list of gateways a customer sees', () => {
  const gateways = [
    { id: 'apay', type: PaymentGatewayType.ANTILOPAY, currency: Currency.RUB, isActive: true, isConfigured: true, orderIndex: 1, settings: SBP_SETTINGS },
    { id: 'rub', type: PaymentGatewayType.YOOKASSA, currency: Currency.RUB, isActive: true, isConfigured: true, orderIndex: 2, settings: {} },
  ];

  function controller(input: { readonly audience: CabinetView | undefined; readonly used: boolean; readonly settings?: Record<string, unknown> }) {
    const asked: string[] = [];
    const list = new InternalPaymentsController(
      {} as never,
      {} as never,
      {
        listGateways: async () =>
          gateways.map((gateway) => (gateway.id === 'apay' ? { ...gateway, settings: input.settings ?? SBP_SETTINGS } : gateway)),
      } as never,
      {} as never,
      { getInternalPlatformPolicy: async () => ({ defaultCurrency: Currency.RUB }) } as never,
      {} as never,
      { viewOfRequest: async () => input.audience } as never,
      {
        hasUsedDelay: async (userId: string) => {
          asked.push(userId);
          return input.used;
        },
      } as never,
    );
    return { list, asked };
  }
  const antilopay = (result: readonly { type: string }[]) => result.find((gateway) => gateway.type === 'ANTILOPAY') as unknown as Record<string, unknown>;

  it('names the delay on the Antilopay entry of a customer who may still use it', async () => {
    const { list, asked } = controller({ audience: CAN_DELAY, used: false });
    const entry = antilopay(await list.listEnabledGateways('WEB', 'user-1', {}));
    assert.deepEqual(entry['autopayDelay'], SEVEN_DAYS);
    assert.deepEqual(entry['autopayMethods'], ['CARD', 'SBP']);
    assert.equal(entry['autopay'], false);
    assert.deepEqual(asked, ['user-1']);
  });

  it('names none to a customer who used it, to a cabinet that cannot show it, and to a caller with no customer', async () => {
    const cases: ReadonlyArray<readonly [string, () => Promise<readonly { type: string }[]>]> = [
      ['used', () => controller({ audience: CAN_DELAY, used: true }).list.listEnabledGateways('WEB', 'user-1', {})],
      ['old cabinet', () => controller({ audience: CabinetView.floor(), used: false }).list.listEnabledGateways('WEB', 'user-1', {})],
      ['no customer', () => controller({ audience: CAN_DELAY, used: false }).list.listEnabledGateways('WEB', undefined, {})],
      ['empty customer', () => controller({ audience: CAN_DELAY, used: false }).list.listEnabledGateways('WEB', '', {})],
      [
        'no delay set',
        () => controller({ audience: CAN_DELAY, used: false, settings: { ...SBP_SETTINGS, sbpDelayCount: 0 } }).list.listEnabledGateways('WEB', 'user-1', {}),
      ],
    ];
    for (const [name, run] of cases) {
      const entry = antilopay(await run());
      assert.equal('autopayDelay' in entry, false, name);
      assert.deepEqual(entry['autopayMethods'], ['CARD', 'SBP'], name);
    }
  });

  it('asks the database nothing when no delay is on offer, and leaves the other gateways as they were', async () => {
    const old = controller({ audience: CabinetView.floor(), used: false });
    const result = await old.list.listEnabledGateways('WEB', 'user-1', {});
    assert.deepEqual(old.asked, []);
    assert.deepEqual(result.find((gateway) => gateway.type === 'YOOKASSA'), {
      id: 'rub',
      type: PaymentGatewayType.YOOKASSA,
      currency: Currency.RUB,
      orderIndex: 2,
      autopay: false,
    });
  });
});
