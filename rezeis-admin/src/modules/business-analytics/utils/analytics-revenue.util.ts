/**
 * «Выручка»: where the money of the window came from — per bar and currency,
 * per kind of purchase, per plan and per payment system.
 *
 * Money is money received (`analytics-money-received.util.ts`): completed, for
 * more than nothing, not from a partner's balance, net of partial refunds. A
 * partner's balance spend is stated apart, on a line of its own.
 *
 * Every statement groups by currency as well as by what it breaks down, and
 * the assembly converts per currency, so a breakdown's rows add up to the
 * total in the same view currency (see `analytics-money.util.ts`).
 */
import { Prisma } from '@prisma/client';

import type {
  CurrencySliceInterface,
  PurchaseKind,
  RevenuePlanInterface,
  RevenueReportInterface,
} from '../interfaces/business-analytics.types';
import { moneyReceivedSql, netAmountSql, purchaseKindSql } from './analytics-money-received.util';
import { chooseMoneyView, currencySlices, type FxSnapshot, moneyFigure } from './analytics-money.util';
import { assemblePartnerBalance, type PartnerBalanceRow } from './analytics-overview.util';
import { type AnalyticsWindowInterface, bothWindowsSql, bucketIndexSql, describePeriod } from './analytics-window.util';

type SqlNumeric = Prisma.Decimal | string | number | bigint | null;
const num = (value: SqlNumeric | undefined): number => (value === null || value === undefined ? 0 : Number(value));

/**
 * `withheld` last: money received and applied to nothing, to be refunded
 * («Не применён (к возврату)»). The panel shows its row only while there is
 * some; the report always carries it, so the rows add up to the total.
 */
export const PURCHASE_KINDS: readonly PurchaseKind[] = ['new', 'renewal', 'change', 'addon', 'withheld'];

export interface RevenueSliceRow {
  readonly bucket: number;
  readonly currency: string;
  readonly kind: PurchaseKind;
  readonly amount: SqlNumeric;
  readonly payments: number;
}

export interface ViewCurrencyRow {
  readonly currency: string;
}

/**
 * THE CURRENCIES THE MONEY VIEW IS CHOSEN OVER: every currency with money
 * received in the window OR in the one it is compared with — the set «Обзор»
 * chooses over (its payment rows cover both windows). «Выручка» shows no
 * previous window, but it states the same days as «Обзор» and as the payments'
 * «Аналитика», and all three must state them in one currency: a week of only
 * 10 USDT after a week of 1 000 ₽ is «≈ 800 ₽» on each, never «10 USDT» here.
 */
export function moneyViewCurrenciesSql(window: AnalyticsWindowInterface): Prisma.Sql {
  const at = Prisma.sql`t."created_at"`;
  return Prisma.sql`
    SELECT DISTINCT t."currency"::text AS "currency"
      FROM "transactions" t
     WHERE ${moneyReceivedSql()} AND ${bothWindowsSql(at, window)} AND ${netAmountSql()} > 0`;
}

/** Money received in the window per bar, currency and kind of purchase — one statement feeds three charts. */
export function revenueSlicesSql(window: AnalyticsWindowInterface): Prisma.Sql {
  const at = Prisma.sql`t."created_at"`;
  return Prisma.sql`
    SELECT ${bucketIndexSql(at, window)} AS "bucket",
           t."currency"::text AS "currency",
           ${purchaseKindSql()} AS "kind",
           SUM(${netAmountSql()}) AS "amount",
           COUNT(*)::int AS "payments"
      FROM "transactions" t
     WHERE ${moneyReceivedSql()} AND t."created_at" >= ${window.start}
     GROUP BY 1, 2, 3`;
}

export interface RevenuePlanRow {
  readonly kind: 'plan' | 'addon' | 'none';
  readonly planId: string | null;
  readonly name: string | null;
  readonly currency: string;
  readonly amount: SqlNumeric;
  readonly payments: number;
}

/**
 * Revenue per plan. A payment names its plan in its snapshot — except a
 * combined renewal, whose plans are its `transaction_items`: its total is
 * shared among the items in proportion to their prices (add-ons bought with a
 * renewal ride with the plan they were bought for), so the rows still add up
 * to the window's total. A plan is keyed by its id and shown under the latest
 * name a payment recorded for it.
 */
export function revenueByPlanSql(window: AnalyticsWindowInterface): Prisma.Sql {
  return Prisma.sql`
    WITH "paid" AS (
      SELECT t."id", ${netAmountSql()} AS "amount", t."currency"::text AS "currency", t."purchase_type", t."plan_snapshot", t."created_at"
        FROM "transactions" t
       WHERE ${moneyReceivedSql()} AND t."created_at" >= ${window.start}
    ),
    "line" AS (
      SELECT p."id" AS "tx", 'plan' AS "kind", i."plan_id" AS "plan_id", i."plan_snapshot"->>'name' AS "name",
             p."currency", p."created_at",
             CASE WHEN SUM(i."amount") OVER "per_tx" > 0
                  THEN p."amount" * i."amount" / SUM(i."amount") OVER "per_tx"
                  ELSE p."amount" / COUNT(*) OVER "per_tx"
             END AS "amount"
        FROM "paid" p
        JOIN "transaction_items" i ON i."transaction_id" = p."id"
      WINDOW "per_tx" AS (PARTITION BY p."id")
      UNION ALL
      SELECT p."id",
             CASE WHEN p."purchase_type" = 'ADDITIONAL' AND p."plan_snapshot"->>'snapshotSource' = 'ADDON_PURCHASE' THEN 'addon'
                  WHEN NULLIF(p."plan_snapshot"->>'id', '') IS NULL THEN 'none'
                  ELSE 'plan' END,
             CASE WHEN p."purchase_type" = 'ADDITIONAL' AND p."plan_snapshot"->>'snapshotSource' = 'ADDON_PURCHASE' THEN NULL
                  ELSE NULLIF(p."plan_snapshot"->>'id', '') END,
             p."plan_snapshot"->>'name',
             p."currency", p."created_at", p."amount"
        FROM "paid" p
       WHERE NOT EXISTS (SELECT 1 FROM "transaction_items" i WHERE i."transaction_id" = p."id")
    )
    SELECT "kind", "plan_id" AS "planId", "currency",
           (ARRAY_AGG("name" ORDER BY "created_at" DESC) FILTER (WHERE NULLIF("name", '') IS NOT NULL))[1] AS "name",
           SUM("amount") AS "amount",
           COUNT(DISTINCT "tx")::int AS "payments"
      FROM "line"
     GROUP BY "kind", "plan_id", "currency"`;
}

export interface RevenueGatewayRow {
  readonly gateway: string;
  readonly currency: string;
  readonly amount: SqlNumeric;
  readonly payments: number;
}

export function revenueByGatewaySql(window: AnalyticsWindowInterface): Prisma.Sql {
  return Prisma.sql`
    SELECT t."gateway_type"::text AS "gateway", t."currency"::text AS "currency",
           SUM(${netAmountSql()}) AS "amount", COUNT(*)::int AS "payments"
      FROM "transactions" t
     WHERE ${moneyReceivedSql()} AND t."created_at" >= ${window.start}
     GROUP BY 1, 2`;
}

function add(map: Map<string, number>, key: string, amount: number): void {
  map.set(key, (map.get(key) ?? 0) + amount);
}

export function assembleRevenue(
  window: AnalyticsWindowInterface,
  rows: {
    readonly slices: readonly RevenueSliceRow[];
    readonly plans: readonly RevenuePlanRow[];
    readonly gateways: readonly RevenueGatewayRow[];
    readonly partnerBalance: readonly PartnerBalanceRow[];
    /** {@link moneyViewCurrenciesSql}: both windows, as «Обзор» chooses. */
    readonly viewCurrencies: readonly ViewCurrencyRow[];
  },
  fx: FxSnapshot,
): RevenueReportInterface {
  const view = chooseMoneyView(
    rows.viewCurrencies.map((row) => row.currency),
    fx,
  );

  const total = new Map<string, number>();
  const paymentsByCurrency = new Map<string, number>();
  const perBucket = Array.from({ length: window.bucketCount }, () => ({
    currencies: new Map<string, number>(),
    kinds: new Map<PurchaseKind, Map<string, number>>(),
  }));
  const perKind = new Map<PurchaseKind, { sums: Map<string, number>; payments: number }>();
  let payments = 0;
  for (const row of rows.slices) {
    const amount = num(row.amount);
    add(total, row.currency, amount);
    add(paymentsByCurrency, row.currency, row.payments);
    payments += row.payments;
    const kind = perKind.get(row.kind) ?? { sums: new Map<string, number>(), payments: 0 };
    add(kind.sums, row.currency, amount);
    kind.payments += row.payments;
    perKind.set(row.kind, kind);
    const bucket = perBucket[row.bucket];
    if (bucket === undefined) continue;
    add(bucket.currencies, row.currency, amount);
    const kindSums = bucket.kinds.get(row.kind) ?? new Map<string, number>();
    add(kindSums, row.currency, amount);
    bucket.kinds.set(row.kind, kindSums);
  }

  const series = perBucket.map((bucket) => {
    const byKind = Object.fromEntries(
      PURCHASE_KINDS.map((kind) => [kind, moneyFigure(view, bucket.kinds.get(kind) ?? new Map()).value]),
    ) as Record<PurchaseKind, number>;
    const byCurrency: CurrencySliceInterface[] = currencySlices(view, bucket.currencies);
    return {
      total: byCurrency.reduce((sum, slice) => sum + (slice.value ?? 0), 0),
      byCurrency,
      byKind,
    };
  });

  const planGroups = new Map<string, { row: RevenuePlanInterface; sums: Map<string, number>; payments: number }>();
  for (const row of rows.plans) {
    const key = row.kind === 'plan' ? `plan:${row.planId ?? ''}` : row.kind;
    const group = planGroups.get(key) ?? {
      row: {
        key,
        kind: row.kind,
        planId: row.kind === 'plan' ? row.planId : null,
        name: null,
        figure: { value: 0, byCurrency: [] },
        payments: 0,
      },
      sums: new Map<string, number>(),
      payments: 0,
    };
    add(group.sums, row.currency, num(row.amount));
    group.payments += row.payments;
    if (group.row.name === null && row.name !== null && row.name !== '') group.row = { ...group.row, name: row.name };
    planGroups.set(key, group);
  }
  const byPlan = [...planGroups.values()]
    .map(({ row, sums, payments: count }) => ({ ...row, figure: moneyFigure(view, sums), payments: count }))
    .sort((a, b) => b.figure.value - a.figure.value || b.payments - a.payments || a.key.localeCompare(b.key));

  const gatewayGroups = new Map<string, { sums: Map<string, number>; payments: number }>();
  for (const row of rows.gateways) {
    const group = gatewayGroups.get(row.gateway) ?? { sums: new Map<string, number>(), payments: 0 };
    add(group.sums, row.currency, num(row.amount));
    group.payments += row.payments;
    gatewayGroups.set(row.gateway, group);
  }
  const byGateway = [...gatewayGroups.entries()]
    .map(([gatewayType, group]) => ({ gatewayType, figure: moneyFigure(view, group.sums), payments: group.payments }))
    .sort((a, b) => b.figure.value - a.figure.value || b.payments - a.payments || a.gatewayType.localeCompare(b.gatewayType));

  return {
    windowDays: window.days,
    generatedAt: window.now.toISOString(),
    period: describePeriod(window),
    money: view,
    total: moneyFigure(view, total),
    payments,
    byCurrency: currencySlices(view, total).map((slice) => ({
      ...slice,
      payments: paymentsByCurrency.get(slice.currency) ?? 0,
    })),
    series,
    byKind: PURCHASE_KINDS.map((kind) => {
      const entry = perKind.get(kind);
      return { kind, figure: moneyFigure(view, entry?.sums ?? new Map()), payments: entry?.payments ?? 0 };
    }),
    byPlan,
    byGateway,
    partnerBalance: assemblePartnerBalance(view, rows.partnerBalance),
  };
}
