import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { firstValueFrom } from 'rxjs';

import { PrismaService } from '../../common/prisma/prisma.service';
import { shouldRunSchedules } from '../../common/runtime/process-role.util';

/**
 * Exchange rates for reporting.
 *
 * Money arrives in 14 currencies (8 of them crypto), and reports used to add the
 * raw minor units together and label the sum with whatever currency happened to
 * be first — so 8×499 ₽ + 2×4.99 USD printed as "4 001.98 RUB", and any crypto
 * amount collapsed to 0 because minor units were always `round(amount × 100)`
 * and BTC carries 8 decimals.
 *
 * Rates are quoted as "1 unit of `quote` = `rate` units of the base currency".
 * They are cached in `fx_rates` and refreshed hourly; a stale row keeps serving
 * for a day so a provider outage degrades into slightly old numbers instead of
 * zeroes. `MANUAL` rows are operator-owned and never overwritten by a fetch —
 * that is the only way to price Telegram Stars, which no exchange lists.
 */
@Injectable()
export class FxRateService {
  private readonly logger = new Logger(FxRateService.name);

  /** In-process memo so a metrics page render does not hit the DB per row. */
  private readonly memo = new Map<string, { rate: number; at: number }>();

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly httpService: HttpService,
  ) {}

  /** Currency every report is expressed in. */
  public getBaseCurrency(): string {
    const configured = (process.env['REPORTING_BASE_CURRENCY'] ?? '').trim().toUpperCase();
    return configured.length > 0 ? configured : DEFAULT_BASE_CURRENCY;
  }

  /**
   * Converts a major-unit amount into integer minor units of the base currency.
   *
   * Returns `null` when no rate is known: reports then count the row as
   * unconverted instead of silently adding a wrong (or zero) number.
   */
  public async toBaseMinor(
    amount: Prisma.Decimal | number | string,
    currency: string,
  ): Promise<{ readonly amountBaseMinor: number; readonly rate: number } | null> {
    const major = typeof amount === 'number' ? amount : Number(amount);
    if (!Number.isFinite(major)) {
      return null;
    }
    const base = this.getBaseCurrency();
    const quote = currency.trim().toUpperCase();
    if (quote === base) {
      return { amountBaseMinor: Math.round(major * 100), rate: 1 };
    }
    const rate = await this.getRate(quote);
    if (rate === null) {
      return null;
    }
    // Round only at the very end: crypto amounts are small and multiplying a
    // pre-rounded value would throw away most of the amount.
    return { amountBaseMinor: Math.round(major * rate * 100), rate };
  }

  /** 1 `quote` = ? base currency. Memo → DB → provider. */
  public async getRate(quote: string): Promise<number | null> {
    const base = this.getBaseCurrency();
    const upper = quote.trim().toUpperCase();
    if (upper === base) {
      return 1;
    }
    const key = `${base}:${upper}`;
    const memoized = this.memo.get(key);
    if (memoized !== undefined && Date.now() - memoized.at < MEMO_TTL_MS) {
      return memoized.rate;
    }

    const stored = await this.prismaService.fxRate.findUnique({
      where: { base_quote: { base, quote: upper } },
    });
    if (stored !== null) {
      const ageMs = Date.now() - stored.fetchedAt.getTime();
      // An operator-set rate has no expiry — it is a decision, not an observation.
      if (stored.source === 'MANUAL' || ageMs < STALE_MAX_MS) {
        const rate = Number(stored.rate);
        this.memo.set(key, { rate, at: Date.now() });
        return rate;
      }
    }

    const fetched = await this.fetchRate(base, upper);
    if (fetched === null) {
      // Expired beats missing: an outage should not zero out revenue.
      if (stored !== null) {
        const rate = Number(stored.rate);
        this.logger.warn(`fx: serving stale ${base}/${upper} rate (${rate})`);
        return rate;
      }
      this.logger.warn(`fx: no rate available for ${base}/${upper}`);
      return null;
    }
    await this.persist(base, upper, fetched.rate, fetched.source);
    this.memo.set(key, { rate: fetched.rate, at: Date.now() });
    return fetched.rate;
  }

  /** Operator-owned rate for anything no exchange quotes (e.g. Telegram Stars). */
  public async setManualRate(quote: string, rate: number): Promise<void> {
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new Error('A manual rate must be a positive number');
    }
    await this.persist(this.getBaseCurrency(), quote.trim().toUpperCase(), rate, 'MANUAL');
    this.memo.delete(`${this.getBaseCurrency()}:${quote.trim().toUpperCase()}`);
  }

  @Cron(CronExpression.EVERY_HOUR, { name: 'fx-rate-refresh' })
  public async refreshAll(): Promise<void> {
    if (!shouldRunSchedules()) return;
    const base = this.getBaseCurrency();
    const rows = await this.prismaService.fxRate.findMany({
      where: { base, source: { not: 'MANUAL' } },
      select: { quote: true },
    });
    // Refresh what is already in use, and seed the currencies the platform can
    // actually receive so the first conversion of the day is never unconverted.
    const quotes = new Set([...rows.map((r) => r.quote), ...SEED_QUOTES]);
    for (const quote of quotes) {
      if (quote === base) continue;
      const fetched = await this.fetchRate(base, quote);
      if (fetched !== null) {
        await this.persist(base, quote, fetched.rate, fetched.source);
        this.memo.delete(`${base}:${quote}`);
      }
    }
  }

  private async persist(
    base: string,
    quote: string,
    rate: number,
    source: string,
  ): Promise<void> {
    const data = { rate: new Prisma.Decimal(rate.toFixed(12)), source, fetchedAt: new Date() };
    await this.prismaService.fxRate.upsert({
      where: { base_quote: { base, quote } },
      create: { base, quote, ...data },
      update: data,
    });
  }

  private async fetchRate(
    base: string,
    quote: string,
  ): Promise<{ readonly rate: number; readonly source: string } | null> {
    try {
      if (FIAT_CURRENCIES.has(quote)) {
        const rate = await this.fiatRate(base, quote);
        return rate === null ? null : { rate, source: 'CBR' };
      }
      // Crypto is quoted against USD on the exchange, then carried into the base
      // currency with the fiat rate — no exchange lists RUB pairs for most coins.
      const usdPrice = await this.cryptoUsdPrice(quote);
      if (usdPrice === null) {
        return null;
      }
      if (base === 'USD') {
        return { rate: usdPrice, source: 'BINANCE' };
      }
      const usdInBase = await this.fiatRate(base, 'USD');
      if (usdInBase === null) {
        return null;
      }
      return { rate: usdPrice * usdInBase, source: 'BINANCE+CBR' };
    } catch (error: unknown) {
      this.logger.warn(
        `fx: fetch failed for ${base}/${quote}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  /** Fiat cross rate via the Bank of Russia daily feed (RUB-denominated). */
  private async fiatRate(base: string, quote: string): Promise<number | null> {
    const table = await this.loadCbrTable();
    if (table === null) {
      return null;
    }
    const quoteInRub = quote === 'RUB' ? 1 : table.get(quote);
    const baseInRub = base === 'RUB' ? 1 : table.get(base);
    if (quoteInRub === undefined || baseInRub === undefined || baseInRub === 0) {
      return null;
    }
    return quoteInRub / baseInRub;
  }

  private cbrCache: { table: Map<string, number>; at: number } | null = null;

  private async loadCbrTable(): Promise<Map<string, number> | null> {
    if (this.cbrCache !== null && Date.now() - this.cbrCache.at < CBR_TTL_MS) {
      return this.cbrCache.table;
    }
    const url = process.env['FX_FIAT_URL'] ?? DEFAULT_CBR_URL;
    const response = await firstValueFrom(
      this.httpService.get<unknown>(url, { timeout: FETCH_TIMEOUT_MS }),
    );
    const valutes = (response.data as { Valute?: Record<string, unknown> } | null)?.Valute;
    if (valutes === undefined || valutes === null || typeof valutes !== 'object') {
      return null;
    }
    const table = new Map<string, number>();
    for (const entry of Object.values(valutes)) {
      const row = entry as { CharCode?: unknown; Value?: unknown; Nominal?: unknown };
      const code = typeof row.CharCode === 'string' ? row.CharCode.toUpperCase() : null;
      const value = typeof row.Value === 'number' ? row.Value : Number(row.Value);
      const nominal = typeof row.Nominal === 'number' ? row.Nominal : Number(row.Nominal);
      if (code === null || !Number.isFinite(value) || !Number.isFinite(nominal) || nominal === 0) {
        continue;
      }
      // The feed quotes per `Nominal` units (e.g. 100 JPY) — normalise to one.
      table.set(code, value / nominal);
    }
    if (table.size === 0) {
      return null;
    }
    this.cbrCache = { table, at: Date.now() };
    return table;
  }

  /** Spot price of one coin in USD from a public exchange ticker. */
  private async cryptoUsdPrice(quote: string): Promise<number | null> {
    if (STABLE_USD_COINS.has(quote)) {
      return 1;
    }
    const symbol = `${quote}USDT`;
    const url = `${process.env['FX_CRYPTO_URL'] ?? DEFAULT_BINANCE_URL}?symbol=${encodeURIComponent(symbol)}`;
    const response = await firstValueFrom(
      this.httpService.get<unknown>(url, { timeout: FETCH_TIMEOUT_MS }),
    );
    const price = Number((response.data as { price?: unknown } | null)?.price);
    return Number.isFinite(price) && price > 0 ? price : null;
  }
}

const DEFAULT_BASE_CURRENCY = 'RUB';
const MEMO_TTL_MS = 5 * 60 * 1000;
const STALE_MAX_MS = 24 * 60 * 60 * 1000;
const CBR_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;
const DEFAULT_CBR_URL = 'https://www.cbr-xml-daily.ru/daily_json.js';
const DEFAULT_BINANCE_URL = 'https://api.binance.com/api/v3/ticker/price';

/** Currencies the Bank of Russia feed can price directly. */
const FIAT_CURRENCIES = new Set(['RUB', 'USD', 'EUR', 'KZT', 'UAH', 'BYN', 'TRY', 'CNY', 'GBP']);

/** Dollar-pegged coins — a ticker lookup would add a request for a rate of ~1. */
const STABLE_USD_COINS = new Set(['USDT', 'USDC']);

/**
 * Currencies the platform can actually receive (the `Currency` enum), minus
 * `XTR` (Telegram Stars): no exchange lists it, so it needs a MANUAL rate.
 */
const SEED_QUOTES = [
  'USD',
  'USDT',
  'USDC',
  'TON',
  'BTC',
  'ETH',
  'LTC',
  'BNB',
  'DASH',
  'SOL',
  'XMR',
  'TRX',
];
