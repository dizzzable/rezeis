/**
 * Report bodies for the analytics page's tests, shaped exactly as the backend
 * sends them (`analytics-reports-wire-contract.test.ts` holds the types to the
 * server's). Only tests import this module.
 */
import type {
  AdvancedAnalyticsReport,
  AnalyticsPeriod,
  CohortRow,
  ExpiringReport,
  LtvReport,
  MoneyView,
  RevenueReport,
  SubscriptionByPlanItem,
  TopPayersReport,
  TrialConversionReport,
  UsageSurfaceReport,
} from './analytics-api'

export const ROUBLES: MoneyView = { currency: 'RUB', converted: false, rates: [], unconverted: [] }

export const ROUBLES_AND_USDT: MoneyView = {
  currency: 'RUB',
  converted: true,
  rates: [{ currency: 'USDT', rate: 80, source: 'BINANCE+CBR', fetchedAt: '2026-09-18T09:00:00.000Z' }],
  unconverted: [],
}

/** Nothing paid from a partner's balance. */
export const NO_PARTNER_BALANCE = { figure: { value: 0, byCurrency: [] }, payments: 0 } as const

/** A 7-day window ending 18 September 2026, a bar per day. */
export function weekPeriod(): AnalyticsPeriod {
  const days = ['12', '13', '14', '15', '16', '17', '18'].map((day) => `2026-09-${day}`)
  const previous = ['05', '06', '07', '08', '09', '10', '11'].map((day) => `2026-09-${day}`)
  return {
    start: '2026-09-12T00:00:00.000Z',
    end: '2026-09-18T12:00:00.000Z',
    previousStart: '2026-09-05T00:00:00.000Z',
    previousEnd: '2026-09-11T12:00:00.000Z',
    timeZone: 'UTC',
    timeZoneFallback: false,
    granularity: 'day',
    buckets: days.map((day) => ({ from: day, to: day })),
    previousBuckets: previous.map((day) => ({ from: day, to: day })),
  }
}

export function overviewReport(overrides: Partial<AdvancedAnalyticsReport> = {}, windowDays = 7): AdvancedAnalyticsReport {
  const period = weekPeriod()
  const revenue = [0, 1200, 0, 3500, 2000, 0, 3000]
  const previousRevenue = [1000, 0, 2000, 1000, 2000, 1000, 1818]
  return {
    kpis: {
      windowDays,
      totalRevenue: 9700,
      paidCount: 23,
      payingUsers: 20,
      arpu: 97,
      arppu: 485,
      activeSubscriptions: 140,
      trialSubscriptions: 12,
      totalUsers: 100,
      newUsersInWindow: 30,
    },
    churn: { windowDays, prevActive: 120, stillActive: 108, churned: 12, churnRate: 0.1, retentionRate: 0.9 },
    funnel: [
      { key: 'registered', label: 'Registered', count: 30, pctOfStart: 1, pctOfPrev: 1 },
      { key: 'activated', label: 'Started using', count: 21, pctOfStart: 0.7, pctOfPrev: 0.7 },
      { key: 'paid', label: 'Paid', count: 9, pctOfStart: 0.3, pctOfPrev: 9 / 21 },
      { key: 'repeat', label: 'Paid again', count: 3, pctOfStart: 0.1, pctOfPrev: 1 / 3 },
    ],
    providers: [
      {
        gatewayType: 'YOOKASSA',
        total: 30,
        paid: 23,
        completed: 21,
        refunded: 2,
        failed: 2,
        canceled: 4,
        pending: 1,
        successRate: 23 / 29,
        revenue: 9700,
        revenueFigure: { value: 9700, byCurrency: [{ currency: 'RUB', amount: 9700 }] },
      },
    ],
    daily: [],
    windowDays,
    generatedAt: '2026-09-18T12:00:00.000Z',
    period,
    money: ROUBLES,
    metrics: {
      revenue: {
        current: { value: 9700, byCurrency: [{ currency: 'RUB', amount: 9700 }] },
        previous: { value: 8818, byCurrency: [{ currency: 'RUB', amount: 8818 }] },
      },
      payments: { current: 23, previous: 20 },
      payingCustomers: { current: 20, previous: 20 },
      arppu: { current: 485, previous: 440.9 },
      newUsers: { current: 30, previous: 40 },
      newSubscriptions: { current: 9, previous: 6 },
      activeSubscriptions: { current: 140, previous: 130 },
      trialSubscriptions: 12,
      churn: { current: { base: 120, churned: 12, rate: 0.1 }, previous: { base: 110, churned: 8, rate: 8 / 110 } },
    },
    partnerBalance: NO_PARTNER_BALANCE,
    series: {
      revenue,
      payingCustomers: [0, 2, 0, 7, 5, 0, 6],
      arppu: [null, 600, null, 500, 400, null, 500],
      newUsers: [4, 5, 3, 6, 4, 5, 3],
      newSubscriptions: [1, 2, 0, 3, 1, 0, 2],
      activeSubscriptions: [132, 133, 134, 136, 137, 139, 140],
    },
    previousSeries: {
      revenue: previousRevenue,
      payingCustomers: [2, 0, 4, 2, 4, 2, 6],
      arppu: [500, null, 500, 500, 500, 500, 303],
      newUsers: [6, 6, 5, 6, 6, 5, 6],
      newSubscriptions: [1, 0, 1, 1, 1, 1, 1],
    },
    ...overrides,
  }
}

/** The overview of a window in which nothing at all happened. */
export function emptyOverviewReport(windowDays = 30): AdvancedAnalyticsReport {
  const base = overviewReport({}, windowDays)
  const zeroes = base.period.buckets.map(() => 0)
  const nulls = base.period.buckets.map(() => null)
  return {
    ...base,
    kpis: { ...base.kpis, totalRevenue: 0, paidCount: 0, payingUsers: 0, arpu: 0, arppu: 0 },
    funnel: base.funnel.map((step) => ({ ...step, count: 0, pctOfStart: 0, pctOfPrev: 0 })),
    providers: [],
    metrics: {
      ...base.metrics,
      revenue: { current: { value: 0, byCurrency: [] }, previous: { value: 0, byCurrency: [] } },
      payments: { current: 0, previous: 0 },
      payingCustomers: { current: 0, previous: 0 },
      arppu: { current: null, previous: null },
      newSubscriptions: { current: 0, previous: 0 },
    },
    series: { ...base.series, revenue: zeroes, payingCustomers: zeroes, arppu: nulls, newSubscriptions: zeroes },
    previousSeries: { ...base.previousSeries, revenue: zeroes, payingCustomers: zeroes, arppu: nulls, newSubscriptions: zeroes },
  }
}

const NO_KINDS = { new: 0, renewal: 0, change: 0, addon: 0 } as const

export function revenueReport(money: MoneyView = ROUBLES): RevenueReport {
  const multi = money.converted
  const byCurrency = multi
    ? [
        { currency: 'RUB', amount: 9700, value: 9700, payments: 22 },
        { currency: 'USDT', amount: 10, value: 800, payments: 1 },
      ]
    : [{ currency: 'RUB', amount: 9700, value: 9700, payments: 23 }]
  const total = multi ? 10500 : 9700
  const period = weekPeriod()
  return {
    windowDays: 7,
    generatedAt: '2026-09-18T12:00:00.000Z',
    period,
    money,
    total: { value: total, byCurrency: byCurrency.map(({ currency, amount }) => ({ currency, amount })) },
    payments: 23,
    byCurrency,
    series: period.buckets.map((_, index) =>
      index === 3
        ? {
            total: multi ? 4300 : 3500,
            byCurrency: [
              { currency: 'RUB', amount: 3500, value: 3500 },
              ...(multi ? [{ currency: 'USDT', amount: 10, value: 800 }] : []),
            ],
            byKind: { new: multi ? 2300 : 1500, renewal: 2000, change: 0, addon: 0 },
          }
        : { total: 0, byCurrency: [], byKind: NO_KINDS },
    ),
    byKind: [
      { kind: 'new', figure: { value: 4700, byCurrency: [{ currency: 'RUB', amount: 4700 }] }, payments: 10 },
      { kind: 'renewal', figure: { value: 4000, byCurrency: [{ currency: 'RUB', amount: 4000 }] }, payments: 11 },
      { kind: 'change', figure: { value: 600, byCurrency: [{ currency: 'RUB', amount: 600 }] }, payments: 1 },
      { kind: 'addon', figure: { value: 400, byCurrency: [{ currency: 'RUB', amount: 400 }] }, payments: 1 },
    ],
    byPlan: [
      { key: 'plan:p1', kind: 'plan', planId: 'p1', name: 'Pro', figure: { value: 6000, byCurrency: [{ currency: 'RUB', amount: 6000 }] }, payments: 12 },
      { key: 'plan:p2', kind: 'plan', planId: 'p2', name: 'Basic', figure: { value: 3300, byCurrency: [{ currency: 'RUB', amount: 3300 }] }, payments: 10 },
      { key: 'addon', kind: 'addon', planId: null, name: '+50 GB', figure: { value: 400, byCurrency: [{ currency: 'RUB', amount: 400 }] }, payments: 1 },
    ],
    byGateway: [
      { gatewayType: 'YOOKASSA', figure: { value: 9700, byCurrency: [{ currency: 'RUB', amount: 9700 }] }, payments: 23 },
    ],
    partnerBalance: NO_PARTNER_BALANCE,
  }
}

export function emptyRevenueReport(): RevenueReport {
  const base = revenueReport()
  return {
    ...base,
    total: { value: 0, byCurrency: [] },
    payments: 0,
    byCurrency: [],
    series: base.period.buckets.map(() => ({ total: 0, byCurrency: [], byKind: NO_KINDS })),
    byKind: base.byKind.map((kind) => ({ ...kind, figure: { value: 0, byCurrency: [] }, payments: 0 })),
    byPlan: [],
    byGateway: [],
  }
}

export const SUBSCRIPTIONS_BY_PLAN: readonly SubscriptionByPlanItem[] = [
  { plan: 'Pro', planId: 'p1', active: 10, limited: 2, trial: 0, total: 12, percentage: 0.6 },
  { plan: 'Basic', planId: 'p2', active: 8, limited: 0, trial: 0, total: 8, percentage: 0.4 },
]

export function conversionReport(): TrialConversionReport {
  return {
    windowDays: 7,
    timeZone: 'UTC',
    timeZoneFallback: false,
    totalTrialUsers: 40,
    convertedUsers: 10,
    conversionRate: 0.25,
    avgDaysToConvert: 5.2,
    medianDaysToConvert: 4.5,
    revenueFromConverted: 4990,
    revenueFromConvertedByCurrency: [{ currency: 'RUB', amount: 4990 }],
    money: ROUBLES,
    daysToConvert: [
      { key: 'd0', users: 3 },
      { key: 'd1_3', users: 2 },
      { key: 'd4_7', users: 3 },
      { key: 'd8_14', users: 1 },
      { key: 'd15_30', users: 1 },
      { key: 'd31_plus', users: 0 },
    ],
    topConvertedPlans: [
      { plan: 'Pro', planId: 'p1', kind: 'plan', count: 7, percentage: 0.7 },
      { plan: 'Basic', planId: 'p2', kind: 'plan', count: 3, percentage: 0.3 },
    ],
    firstPayment: {
      payers: 12,
      medianDays: 2,
      buckets: [
        { key: 'd0', users: 5 },
        { key: 'd1_3', users: 3 },
        { key: 'd4_7', users: 2 },
        { key: 'd8_14', users: 1 },
        { key: 'd15_30', users: 0 },
        { key: 'd31_plus', users: 1 },
      ],
    },
  }
}

export function expiringReport(): ExpiringReport {
  const days = Array.from({ length: 30 }, (_, index) => {
    const date = new Date(Date.UTC(2026, 8, 18 + index)).toISOString().slice(0, 10)
    return { date, autopay: index === 3 ? 2 : 0, manual: index === 3 ? 5 : index === 10 ? 1 : 0, trial: index === 5 ? 4 : 0 }
  })
  return { generatedAt: '2026-09-18T12:00:00.000Z', timeZone: 'UTC', timeZoneFallback: false, horizonDays: 30, days, totals: { autopay: 2, manual: 6, trial: 4 } }
}

export const COHORTS: readonly CohortRow[] = [
  { cohort: '2026-07', cohortSize: 50, retentionByMonth: [0.4, 0.2, 0.1] },
  { cohort: '2026-08', cohortSize: 80, retentionByMonth: [0.5, 0.25] },
  { cohort: '2026-09', cohortSize: 30, retentionByMonth: [0.3] },
]

export function ltvReport(): LtvReport {
  return {
    buckets: [
      { bound: 0, from: 0, to: 500, users: 40 },
      { bound: 500, from: 500, to: 1000, users: 25 },
      { bound: 1000, from: 1000, to: 1500, users: 10 },
      { bound: 1500, from: 1500, to: null, users: 5 },
    ],
    money: ROUBLES,
    stats: { payers: 80, mean: 720, median: 499, p90: 1490 },
  }
}

export function topPayersReport(): TopPayersReport {
  return {
    money: ROUBLES,
    payers: [
      { userId: 'u1', telegramId: '1001', username: 'whale', name: 'Кит', totalSpent: 12000, spentByCurrency: [{ currency: 'RUB', amount: 12000 }], transactionCount: 9, lastPaymentAt: '2026-09-10T10:00:00.000Z' },
      { userId: 'u2', telegramId: null, username: null, name: '', totalSpent: 3000, spentByCurrency: [{ currency: 'RUB', amount: 3000 }], transactionCount: 3, lastPaymentAt: null },
    ],
  }
}

export const SURFACES: UsageSurfaceReport = {
  surfaces: [
    { key: 'tma', count: 12 },
    { key: 'browser', count: 5 },
  ],
  formFactors: [],
  operatingSystems: [],
  pwaInstalls: 0,
  pwaInstallsByOs: [],
  activeLast30d: 0,
  totalTracked: 17,
  generatedAt: '2026-09-18T00:00:00.000Z',
}
