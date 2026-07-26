import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Prisma } from '@prisma/client';
import { of } from 'rxjs';

import { FxRateService } from '../src/modules/fx/fx-rate.service';
import type { PrismaService } from '../src/common/prisma/prisma.service';

const HOUR = 60 * 60 * 1000;

/** Bank-of-Russia style payload: value per `Nominal` units of the currency. */
const CBR_PAYLOAD = {
  Valute: {
    USD: { CharCode: 'USD', Value: 80, Nominal: 1 },
    EUR: { CharCode: 'EUR', Value: 90, Nominal: 1 },
    KZT: { CharCode: 'KZT', Value: 18, Nominal: 100 },
  },
};

function build(opts: {
  stored?: {
    quote: string;
    rate: number;
    source: string;
    ageMs: number;
  } | null;
  cbr?: unknown;
  cryptoPrice?: number | null;
  failFetch?: boolean;
} = {}) {
  const upserts: Array<Record<string, unknown>> = [];
  const requested: string[] = [];
  const prisma = {
    fxRate: {
      findUnique: async () =>
        opts.stored === undefined || opts.stored === null
          ? null
          : {
              base: 'RUB',
              quote: opts.stored.quote,
              rate: new Prisma.Decimal(opts.stored.rate),
              source: opts.stored.source,
              fetchedAt: new Date(Date.now() - opts.stored.ageMs),
            },
      findMany: async () => [],
      upsert: async (args: { create: Record<string, unknown> }) => {
        upserts.push(args.create);
        return args.create;
      },
    },
  } as unknown as PrismaService;

  const httpService = {
    get: (url: string) => {
      requested.push(url);
      if (opts.failFetch === true) {
        throw new Error('network down');
      }
      if (url.includes('daily')) {
        return of({ data: opts.cbr ?? CBR_PAYLOAD });
      }
      return of({ data: { price: String(opts.cryptoPrice ?? 60000) } });
    },
  } as never;

  return { service: new FxRateService(prisma, httpService), upserts, requested };
}

describe('FxRateService', () => {
  it('passes the base currency straight through without a lookup', async () => {
    const { service, requested } = build();
    const converted = await service.toBaseMinor('499.99', 'RUB');
    assert.deepEqual(converted, { amountBaseMinor: 49999, rate: 1 });
    assert.deepEqual(requested, [], 'no rate is needed for the base currency');
  });

  it('converts fiat through the daily feed and normalises the nominal', async () => {
    const { service } = build();
    // 4.99 USD at 80 = 399.20 RUB. Adding the raw minor units instead produced
    // "499 kopecks" and printed the total under the wrong currency.
    assert.deepEqual(await service.toBaseMinor('4.99', 'USD'), {
      amountBaseMinor: 39920,
      rate: 80,
    });
    // The feed quotes KZT per 100 units — a rate of 0.18, not 18.
    const kzt = await build().service.getRate('KZT');
    assert.equal(kzt, 0.18);
  });

  it('prices crypto via the exchange ticker and keeps small amounts intact', async () => {
    const { service } = build({ cryptoPrice: 60000 });
    // 0.004 BTC at $60 000 and 80 ₽/$ = 19 200 ₽. The old `round(amount * 100)`
    // turned this into 0 and the placement showed no revenue at all.
    const converted = await service.toBaseMinor('0.004', 'BTC');
    assert.deepEqual(converted, { amountBaseMinor: 1920000, rate: 4800000 });
  });

  it('treats dollar-pegged coins as one dollar without a ticker call', async () => {
    const { service, requested } = build();
    const converted = await service.toBaseMinor('10', 'USDT');
    assert.equal(converted?.amountBaseMinor, 80000);
    assert.equal(
      requested.some((url) => url.includes('ticker')),
      false,
    );
  });

  it('reuses a fresh stored rate instead of fetching', async () => {
    const { service, requested } = build({
      stored: { quote: 'USD', rate: 77, source: 'CBR', ageMs: 2 * HOUR },
    });
    assert.equal(await service.getRate('USD'), 77);
    assert.deepEqual(requested, []);
  });

  it('never expires an operator-set rate', async () => {
    // Telegram Stars have no market price, so a MANUAL rate is the only source —
    // ageing it out would silently drop that revenue from every report.
    const { service, requested } = build({
      stored: { quote: 'XTR', rate: 1.3, source: 'MANUAL', ageMs: 400 * 24 * HOUR },
    });
    assert.equal(await service.getRate('XTR'), 1.3);
    assert.deepEqual(requested, []);
  });

  it('serves a stale rate when the provider is down rather than reporting nothing', async () => {
    const { service } = build({
      stored: { quote: 'USD', rate: 70, source: 'CBR', ageMs: 40 * 24 * HOUR },
      failFetch: true,
    });
    assert.equal(await service.getRate('USD'), 70);
  });

  it('returns null when nothing can price the currency', async () => {
    const { service } = build({ failFetch: true });
    assert.equal(await service.getRate('XTR'), null);
    assert.equal(await service.toBaseMinor('500', 'XTR'), null);
  });

  it('stores a fetched rate with its source', async () => {
    const { service, upserts } = build();
    await service.getRate('EUR');
    assert.equal(upserts.length, 1);
    assert.equal(upserts[0]?.['quote'], 'EUR');
    assert.equal(upserts[0]?.['source'], 'CBR');
    assert.equal(Number(upserts[0]?.['rate']), 90);
  });

  it('rejects a non-positive manual rate', async () => {
    const { service } = build();
    await assert.rejects(() => service.setManualRate('XTR', 0));
    await assert.rejects(() => service.setManualRate('XTR', -1));
  });
});
