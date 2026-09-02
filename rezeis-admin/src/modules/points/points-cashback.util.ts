import { Currency, PointsCashbackMode, Prisma } from '@prisma/client';

/**
 * How points cashback is computed — the ONE function behind three surfaces.
 *
 * The catalogue shows "+13 points" on a plan before the purchase, the payment
 * status answers with what was credited after it, and the post-fulfilment
 * hook is what actually credits. All three call `computeCashback` with the
 * same inputs — the lines, the rules on the catalogue rows, the global
 * switch and the default currency — so the badge cannot promise what the
 * hook does not pay. That is the same discipline the discounts learned the
 * hard way: the catalogue price and the invoice used to be computed twice.
 *
 * ── Lines, not transactions ───────────────────────────────────────────────
 *
 * A payment is one of three shapes: one subscription (plan + duration), a
 * combined renewal (one item per subscription, each with its own add-on
 * lines) or a standalone add-on. "Percent of the transaction" fits only the
 * first, and a FIXED rule on a plan means nothing for the add-on bought in
 * the same payment. So the unit is a LINE, the result carries every line, and
 * the ledger row keeps them so the subscriber sees what each point was for.
 *
 * ── The base of a percent ─────────────────────────────────────────────────
 *
 * The final paid amount of the line, after every discount. When the line is
 * priced in another currency than the platform default, the line's OWN price
 * list is the exchange rate: amount × price(default) / price(line currency).
 * No external rate, nothing drifts, and a plan that has no price in the
 * default currency pays no percent cashback — the line says why.
 */

export interface CashbackRule {
  readonly mode: PointsCashbackMode;
  /** Own percent, read when `mode` is PERCENT. */
  readonly percent: number | null;
  /** Own points, read when `mode` is FIXED. A plan's come from the purchased duration. */
  readonly fixedPoints: number | null;
}

export interface CashbackPrice {
  readonly currency: Currency;
  readonly price: Prisma.Decimal | string | number;
}

export interface CashbackLineInput {
  readonly kind: 'PLAN' | 'ADD_ON';
  /** Plan id or add-on id. */
  readonly id: string;
  readonly name: string;
  /** Plans only: the purchased duration, for the ledger details. */
  readonly durationDays?: number;
  /** Final paid amount of THIS line, after discounts. */
  readonly amount: Prisma.Decimal | string | number;
  readonly currency: Currency;
  /** `null` when the catalogue row no longer exists. */
  readonly rule: CashbackRule | null;
  /** The line's own price list, used as the exchange rate to the default currency. */
  readonly prices: ReadonlyArray<CashbackPrice>;
}

export interface CashbackConfig {
  /** The master switch. Off means NO line pays, whatever its own rule says. */
  readonly enabled: boolean;
  /** The percent INHERIT lines follow. */
  readonly percent: number;
  readonly defaultCurrency: Currency;
}

export type CashbackSkipReason =
  /** The master switch is off. */
  | 'DISABLED'
  /** The row is in mode NONE — excluded on purpose. */
  | 'EXCLUDED'
  /** The rule resolves to zero percent / zero points. */
  | 'ZERO_RULE'
  /** Nothing was paid for the line. */
  | 'ZERO_AMOUNT'
  /** A percent rule on a line priced in another currency, with no price in the default one. */
  | 'NO_DEFAULT_PRICE'
  /** The plan or add-on is gone from the catalogue. */
  | 'MISSING_CATALOG';

export interface CashbackLineResult {
  readonly kind: 'PLAN' | 'ADD_ON';
  readonly id: string;
  readonly name: string;
  readonly durationDays: number | null;
  readonly amount: string;
  readonly currency: Currency;
  /** The mode configured on the row. */
  readonly mode: PointsCashbackMode | null;
  /** What the mode resolved to once the global rule was applied. */
  readonly effective: 'PERCENT' | 'FIXED' | 'NONE';
  /** The percent applied, for PERCENT. */
  readonly percent: number | null;
  /** The amount in the default currency the percent was taken of, for PERCENT. */
  readonly base: string | null;
  readonly points: number;
  readonly skipped: CashbackSkipReason | null;
}

export interface CashbackComputation {
  readonly points: number;
  readonly lines: readonly CashbackLineResult[];
}

/** PostgreSQL `integer`; a rule that computes past it is a misconfiguration, not a payout. */
export const INT4_MAX = 2_147_483_647;

function decimal(value: Prisma.Decimal | string | number): Prisma.Decimal {
  return value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value);
}

function wholePercent(value: number | null | undefined): number {
  if (value === null || value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

function wholePoints(value: number | null | undefined): number {
  if (value === null || value === undefined || !Number.isFinite(value)) return 0;
  return Math.min(INT4_MAX, Math.max(0, Math.trunc(value)));
}

function floorToInt(value: Prisma.Decimal): number {
  const floored = value.toDecimalPlaces(0, Prisma.Decimal.ROUND_FLOOR);
  if (floored.lte(0)) return 0;
  if (floored.gte(INT4_MAX)) return INT4_MAX;
  return floored.toNumber();
}

/**
 * The line's amount expressed in the default currency, or `null` when the
 * line's price list cannot say. The list is the rate: the same plan costs
 * `price(default)` in the default currency and `price(line)` in the paid one,
 * so `amount × price(default) / price(line)` is the amount at the plan's own
 * exchange rate.
 */
function baseInDefaultCurrency(
  amount: Prisma.Decimal,
  currency: Currency,
  prices: ReadonlyArray<CashbackPrice>,
  defaultCurrency: Currency,
): Prisma.Decimal | null {
  if (currency === defaultCurrency) return amount;
  const inDefault = prices.find((row) => row.currency === defaultCurrency);
  const inLine = prices.find((row) => row.currency === currency);
  if (inDefault === undefined || inLine === undefined) return null;
  const rate = decimal(inLine.price);
  if (rate.lte(0)) return null;
  return amount.mul(decimal(inDefault.price)).div(rate);
}

function skippedLine(
  line: CashbackLineInput,
  amount: Prisma.Decimal,
  effective: CashbackLineResult['effective'],
  skipped: CashbackSkipReason,
): CashbackLineResult {
  return {
    kind: line.kind,
    id: line.id,
    name: line.name,
    durationDays: line.durationDays ?? null,
    amount: amount.toString(),
    currency: line.currency,
    mode: line.rule?.mode ?? null,
    effective,
    percent: null,
    base: null,
    points: 0,
    skipped,
  };
}

export function computeCashbackLine(line: CashbackLineInput, config: CashbackConfig): CashbackLineResult {
  const amount = decimal(line.amount);
  if (line.rule === null) return skippedLine(line, amount, 'NONE', 'MISSING_CATALOG');
  if (!config.enabled) return skippedLine(line, amount, 'NONE', 'DISABLED');
  if (line.rule.mode === PointsCashbackMode.NONE) return skippedLine(line, amount, 'NONE', 'EXCLUDED');
  if (amount.lte(0)) return skippedLine(line, amount, 'NONE', 'ZERO_AMOUNT');

  if (line.rule.mode === PointsCashbackMode.FIXED) {
    const points = wholePoints(line.rule.fixedPoints);
    if (points === 0) return skippedLine(line, amount, 'FIXED', 'ZERO_RULE');
    return {
      kind: line.kind,
      id: line.id,
      name: line.name,
      durationDays: line.durationDays ?? null,
      amount: amount.toString(),
      currency: line.currency,
      mode: line.rule.mode,
      effective: 'FIXED',
      percent: null,
      base: null,
      points,
      skipped: null,
    };
  }

  const percent =
    line.rule.mode === PointsCashbackMode.INHERIT
      ? wholePercent(config.percent)
      : wholePercent(line.rule.percent);
  if (percent === 0) return skippedLine(line, amount, 'PERCENT', 'ZERO_RULE');

  const base = baseInDefaultCurrency(amount, line.currency, line.prices, config.defaultCurrency);
  if (base === null) return skippedLine(line, amount, 'PERCENT', 'NO_DEFAULT_PRICE');

  return {
    kind: line.kind,
    id: line.id,
    name: line.name,
    durationDays: line.durationDays ?? null,
    amount: amount.toString(),
    currency: line.currency,
    mode: line.rule.mode,
    effective: 'PERCENT',
    percent,
    base: base.toDecimalPlaces(8).toString(),
    points: floorToInt(base.mul(percent).div(100)),
    skipped: null,
  };
}

export function computeCashback(
  lines: ReadonlyArray<CashbackLineInput>,
  config: CashbackConfig,
): CashbackComputation {
  const results = lines.map((line) => computeCashbackLine(line, config));
  const total = results.reduce((sum, line) => sum + line.points, 0);
  return { points: Math.min(INT4_MAX, total), lines: results };
}

/**
 * `Settings.pointsSettings.cashback` as stored: `{ enabled?: boolean, percent?: number }`.
 * Anything absent or malformed reads as OFF — an update must not start
 * handing out points behind the operator's back.
 */
export function readCashbackSettings(pointsSettings: unknown): { readonly enabled: boolean; readonly percent: number } {
  const root =
    typeof pointsSettings === 'object' && pointsSettings !== null && !Array.isArray(pointsSettings)
      ? (pointsSettings as Record<string, unknown>)
      : {};
  const cashback =
    typeof root['cashback'] === 'object' && root['cashback'] !== null && !Array.isArray(root['cashback'])
      ? (root['cashback'] as Record<string, unknown>)
      : {};
  const percent = cashback['percent'];
  return {
    enabled: cashback['enabled'] === true,
    percent: typeof percent === 'number' ? wholePercent(percent) : 0,
  };
}
