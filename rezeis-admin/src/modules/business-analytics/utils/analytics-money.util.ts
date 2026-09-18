/**
 * Money in the analytics reports: never one number across currencies.
 *
 * WHAT WAS WRONG. The page summed `amount` over every completed payment, so
 * 1 000 RUB and 10 USDT were reported as «1 010» — in no currency at all — and
 * the ARPPU, the daily bars, the providers' revenue, the LTV histogram and the
 * top payers were all built on that sum. An install that takes crypto next to
 * roubles read its crypto as a rounding error.
 *
 * WHAT A REPORT DOES NOW. Every sum is taken per currency in SQL. Then the
 * report picks ONE currency to state its figures in (its "view"):
 *
 *   - money in one currency only — that currency, natively. Nothing is
 *     converted, whatever `REPORTING_BASE_CURRENCY` says: an install that takes
 *     only USDT reads USDT, not an approximation of it in roubles;
 *   - money in several — the panel's reporting base currency, with every other
 *     currency converted at the rate the panel keeps in `fx_rates` (the table
 *     `FxRateService` refreshes hourly and the advertising reports already
 *     use). A currency with no rate there — Telegram Stars until an operator
 *     sets one — is left out of every converted figure and named in
 *     `unconverted`, so the page can say so instead of adding it at 1:1.
 *
 * The rates are READ from the table, never fetched: a report must not wait on
 * an exchange's API inside the panel's 30-second request limit. A stale row is
 * used as it is, and its `fetchedAt` goes to the page, which prints the date.
 */
import type { PrismaService } from '../../../common/prisma/prisma.service';
import type {
  CurrencyAmountInterface,
  CurrencySliceInterface,
  FxRateUsedInterface,
  MoneyFigureInterface,
  MoneyViewInterface,
} from '../interfaces/business-analytics.types';

export interface FxRateRecord {
  readonly rate: number;
  readonly source: string;
  readonly fetchedAt: Date;
}

/** The panel's rates into `base`, as the table holds them at the moment of the report. */
export interface FxSnapshot {
  readonly base: string;
  readonly rates: ReadonlyMap<string, FxRateRecord>;
}

export async function readFxSnapshot(prisma: Pick<PrismaService, 'fxRate'>, base: string): Promise<FxSnapshot> {
  const rows = await prisma.fxRate.findMany({
    where: { base },
    select: { quote: true, rate: true, source: true, fetchedAt: true },
  });
  const rates = new Map<string, FxRateRecord>();
  for (const row of rows) {
    const rate = Number(row.rate);
    // A rate that is not a positive number converts nothing; the currency then
    // counts as unconverted rather than as worthless.
    if (!Number.isFinite(rate) || rate <= 0) continue;
    rates.set(row.quote.toUpperCase(), { rate, source: row.source, fetchedAt: row.fetchedAt });
  }
  return { base: base.toUpperCase(), rates };
}

/**
 * The view for money in `currencies` — pass only the currencies that carry a
 * non-zero amount somewhere in the report, current and previous windows alike,
 * so every figure of one report is in the same currency.
 */
export function chooseMoneyView(currencies: Iterable<string>, fx: FxSnapshot): MoneyViewInterface {
  const present = [...new Set([...currencies].map((currency) => currency.toUpperCase()))].sort();
  if (present.length <= 1) {
    return { currency: present[0] ?? fx.base, converted: false, rates: [], unconverted: [] };
  }
  const rates: FxRateUsedInterface[] = [];
  const unconverted: string[] = [];
  for (const currency of present) {
    if (currency === fx.base) continue;
    const known = fx.rates.get(currency);
    if (known === undefined) {
      unconverted.push(currency);
      continue;
    }
    rates.push({
      currency,
      rate: known.rate,
      source: known.source,
      fetchedAt: known.fetchedAt.toISOString(),
    });
  }
  return { currency: fx.base, converted: rates.length > 0, rates, unconverted };
}

/** `amount` of `currency` in the view currency, or `null` when there is no rate for it. */
export function convertAmount(view: MoneyViewInterface, currency: string, amount: number): number | null {
  const code = currency.toUpperCase();
  if (code === view.currency) return amount;
  const used = view.rates.find((rate) => rate.currency === code);
  return used === undefined ? null : amount * used.rate;
}

/** `{ currency: rate into the view }` for every currency the view can express — the view's own at 1. */
export function viewRates(view: MoneyViewInterface): Record<string, number> {
  const rates: Record<string, number> = { [view.currency]: 1 };
  for (const used of view.rates) rates[used.currency] = used.rate;
  return rates;
}

type Sums = ReadonlyMap<string, number> | Iterable<CurrencyAmountInterface>;

function sumsByCurrency(sums: Sums): Map<string, number> {
  const out = new Map<string, number>();
  const entries: Iterable<readonly [string, number]> =
    sums instanceof Map
      ? (sums as ReadonlyMap<string, number>).entries()
      : [...(sums as Iterable<CurrencyAmountInterface>)].map((row) => [row.currency, row.amount] as const);
  for (const [currency, amount] of entries) {
    if (!Number.isFinite(amount) || amount === 0) continue;
    const code = currency.toUpperCase();
    out.set(code, (out.get(code) ?? 0) + amount);
  }
  return out;
}

/** Largest converted first; currencies without a rate after them, largest amount first. */
function bySize(a: CurrencySliceInterface, b: CurrencySliceInterface): number {
  if (a.value !== null && b.value !== null) return b.value - a.value || a.currency.localeCompare(b.currency);
  if (a.value !== null) return -1;
  if (b.value !== null) return 1;
  return b.amount - a.amount || a.currency.localeCompare(b.currency);
}

/** Every currency of `sums` with its amount, and that amount in the view currency when it has a rate. */
export function currencySlices(view: MoneyViewInterface, sums: Sums): CurrencySliceInterface[] {
  return [...sumsByCurrency(sums).entries()]
    .map(([currency, amount]) => ({ currency, amount, value: convertAmount(view, currency, amount) }))
    .sort(bySize);
}

/** A figure: the view-currency value of everything that can be converted, and the exact sums. */
export function moneyFigure(view: MoneyViewInterface, sums: Sums): MoneyFigureInterface {
  const slices = currencySlices(view, sums);
  return {
    value: slices.reduce((total, slice) => total + (slice.value ?? 0), 0),
    byCurrency: slices.map(({ currency, amount }) => ({ currency, amount })),
  };
}

/** True when some of the figure's money could not be converted and is not in its `value`. */
export function hasUnconverted(view: MoneyViewInterface, figure: MoneyFigureInterface): boolean {
  return figure.byCurrency.some((slice) => convertAmount(view, slice.currency, slice.amount) === null);
}
