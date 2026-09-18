/**
 * THE ANALYTICS REPORTS, READ OFF BOTH SIDES.
 *
 * The page's tests answer with bodies built from the SPA's own types
 * (`analytics-test-fixtures.ts`), so they would stay green against a server
 * that renamed a field: the type and the fixture change together, and the
 * backend never hears of it. This file holds the two declarations to each
 * other instead — the backend's interfaces read with the TypeScript parser,
 * never imported (they sit in a module tree that imports Nest, which CI's
 * web-quality job does not install) — plus the routes that serve the bodies.
 *
 * The same approach as `surface-report-wire-contract.test.ts`, for every report
 * the rest of the page reads.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { AxiosResponse } from 'axios'
import ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'

import {
  getAnalyticsCohorts,
  getAnalyticsOverview,
  getExpiring,
  getLtvDistribution,
  getRevenueReport,
  getSubscriptionsByPlan,
  getTopPayers,
  getTrialConversion,
} from './analytics-api'
import {
  COHORTS,
  conversionReport,
  expiringReport,
  ltvReport,
  overviewReport,
  revenueReport,
  SUBSCRIPTIONS_BY_PLAN,
  topPayersReport,
} from './analytics-test-fixtures'

const HERE = dirname(fileURLToPath(import.meta.url))
const parse = (file: string): ts.SourceFile => ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)

const BACKEND = resolve(HERE, '../../../../src/modules/business-analytics')
const TYPES = parse(resolve(BACKEND, 'interfaces/business-analytics.types.ts'))
const CONTROLLER = readFileSync(resolve(BACKEND, 'controllers/admin-analytics.controller.ts'), 'utf8')
const SPA = parse(resolve(HERE, 'analytics-api.ts'))

const normalise = (text: string): string => text.replace(/\s+/g, ' ').replace(/(\w+)Interface\b/g, '$1').replace(/;\s*}/g, ' }').replace(/;\s*$/, '')

/** An interface as `field → type`, `readonly` dropped, the backend's `…Interface` names read as the SPA's. */
function declared(source: ts.SourceFile, name: string): Record<string, string> {
  const found = source.statements.find(
    (statement): statement is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(statement) && statement.name.text === name,
  )
  if (found === undefined) throw new Error(`${name} is not declared in ${source.fileName} — it moved or was renamed`)
  return Object.fromEntries(
    found.members.map((member) => {
      if (!ts.isPropertySignature(member) || member.type === undefined) {
        throw new Error(`${name}: a member that is not a plain property — ${member.getText(source)}`)
      }
      return [`${member.name.getText(source)}${member.questionToken ? '?' : ''}`, normalise(member.type.getText(source))]
    }),
  )
}

/** What an interface extends, `…Interface` names read as the SPA's. */
function heritage(source: ts.SourceFile, name: string): string[] {
  const found = source.statements.find(
    (statement): statement is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(statement) && statement.name.text === name,
  )
  return (found?.heritageClauses ?? []).flatMap((clause) => clause.types.map((type) => normalise(type.getText(source))))
}

function alias(source: ts.SourceFile, name: string): string {
  const found = source.statements.find(
    (statement): statement is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(statement) && statement.name.text === name,
  )
  if (found === undefined) throw new Error(`type ${name} is not declared in ${source.fileName}`)
  return normalise(found.type.getText(source))
}

const PAIRS: ReadonlyArray<readonly [server: string, panel: string]> = [
  ['CurrencyAmountInterface', 'CurrencyAmount'],
  ['FxRateUsedInterface', 'FxRateUsed'],
  ['MoneyViewInterface', 'MoneyView'],
  ['MoneyFigureInterface', 'MoneyFigure'],
  ['CurrencySliceInterface', 'CurrencySlice'],
  ['PartnerBalanceSpendInterface', 'PartnerBalanceSpend'],
  ['AnalyticsBucketLabelInterface', 'AnalyticsBucketLabel'],
  ['AnalyticsPeriodInterface', 'AnalyticsPeriod'],
  ['ComparedInterface', 'Compared'],
  ['KpiSummaryInterface', 'KpiSummary'],
  ['ChurnSnapshotInterface', 'ChurnSnapshot'],
  ['ChurnFigureInterface', 'ChurnFigure'],
  ['ConversionFunnelStepInterface', 'ConversionFunnelStep'],
  ['ProviderHealthInterface', 'ProviderHealth'],
  ['DailyMetricInterface', 'DailyMetric'],
  ['OverviewMetricsInterface', 'OverviewMetrics'],
  ['OverviewSeriesInterface', 'OverviewSeries'],
  ['OverviewCurrentSeriesInterface', 'OverviewCurrentSeries'],
  ['AdvancedAnalyticsReportInterface', 'AdvancedAnalyticsReport'],
  ['RevenueSeriesPointInterface', 'RevenueSeriesPoint'],
  ['RevenueKindInterface', 'RevenueKind'],
  ['RevenuePlanInterface', 'RevenuePlan'],
  ['RevenueGatewayInterface', 'RevenueGateway'],
  ['RevenueReportInterface', 'RevenueReport'],
  ['ExpiringDayInterface', 'ExpiringDay'],
  ['ExpiringReportInterface', 'ExpiringReport'],
  ['CohortRowInterface', 'CohortRow'],
  ['TopPayerInterface', 'TopPayer'],
  ['TopPayersReportInterface', 'TopPayersReport'],
  ['LtvBucketInterface', 'LtvBucket'],
  ['LtvReportInterface', 'LtvReport'],
  ['DaysToPayCountInterface', 'DaysToPayCount'],
  ['TrialConversionReport', 'TrialConversionReport'],
  ['ConvertedPlanItem', 'ConvertedPlanItem'],
  ['SubscriptionByPlanItem', 'SubscriptionByPlanItem'],
]

describe('the analytics reports are declared the same on the server and in the panel', () => {
  it.each(PAIRS)('%s ↔ %s', (server, panel) => {
    const onServer = declared(TYPES, server)
    const inPanel = declared(SPA, panel)
    expect(Object.keys(inPanel).sort(), 'the fields').toEqual(Object.keys(onServer).sort())
    expect(inPanel).toEqual(onServer)
    expect(heritage(SPA, panel)).toEqual(heritage(TYPES, server))
  })

  it('names the same kinds of purchase, bins of days and bar widths', () => {
    for (const name of ['PurchaseKind', 'DaysToPayBucket', 'AnalyticsGranularity']) {
      expect(alias(SPA, name), name).toBe(alias(TYPES, name))
    }
  })

  it('anchors: the comparison above is about something', () => {
    expect(declared(TYPES, 'AdvancedAnalyticsReportInterface')).toMatchObject({ metrics: 'OverviewMetrics', money: 'MoneyView' })
    expect(declared(TYPES, 'RevenueReportInterface').byCurrency).toBe('readonly (CurrencySlice & { readonly payments: number })[]')
    expect(Object.keys(declared(TYPES, 'RevenueReportInterface'))).toHaveLength(12)
  })
})

describe('each report is fetched from the route that serves it, and only from analytics routes', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const ROUTES: ReadonlyArray<readonly [route: string, handler: string]> = [
    ['admin/analytics/overview', 'getAdvancedReport'],
    ['admin/analytics/revenue', 'getRevenueReport'],
    ['admin/analytics/expiring', 'getExpiring'],
    ['admin/analytics/trial-conversion', 'getTrialConversion'],
    ['admin/analytics/top-payers', 'getTopPayers'],
    ['admin/analytics/ltv-distribution', 'getLtvDistribution'],
    ['admin/analytics/subscriptions-by-plan', 'getSubscriptionsByPlan'],
  ]

  it.each(ROUTES)('%s is served by %s under analytics:view', (route, handler) => {
    const escaped = route.replace(/[/-]/g, (char) => `\\${char}`)
    const block = new RegExp(`@Get\\('${escaped}'\\)\\s*@RequirePermission\\('analytics', 'view'\\)[\\s\\S]*?return this\\.analyticsService\\.(\\w+)\\(`).exec(CONTROLLER)
    expect(block, `the route ${route} or its permission moved`).not.toBeNull()
    expect(block?.[1]).toBe(handler)
  })

  it('serves none of the retired reports — the baseline summed money across currencies, and nothing calls it or the aliases', () => {
    for (const route of ['admin/business-analytics', 'admin/analytics/baseline', 'admin/analytics/revenue-by-currency']) {
      expect(CONTROLLER, route).not.toContain(`@Get('${route}')`)
    }
  })

  it('reads every body from the path it belongs to', async () => {
    const bodies: Record<string, unknown> = {
      '/admin/analytics/overview?days=7': overviewReport(),
      '/admin/analytics/revenue?days=7': revenueReport(),
      '/admin/analytics/trial-conversion?days=7': conversionReport(),
      '/admin/analytics/cohorts': { cohorts: COHORTS },
      '/admin/analytics/expiring': expiringReport(),
      '/admin/analytics/top-payers?limit=20': topPayersReport(),
      '/admin/analytics/ltv-distribution': ltvReport(),
      '/admin/analytics/subscriptions-by-plan': SUBSCRIPTIONS_BY_PLAN,
    }
    const get = vi.spyOn(api, 'get').mockImplementation((path: string) => {
      if (!(path in bodies)) throw new Error(`the page asked for ${path}`)
      return Promise.resolve({ data: JSON.parse(JSON.stringify(bodies[path])) } as AxiosResponse)
    })

    await expect(getAnalyticsOverview(7)).resolves.toEqual(overviewReport())
    await expect(getRevenueReport(7)).resolves.toEqual(revenueReport())
    await expect(getTrialConversion(7)).resolves.toEqual(conversionReport())
    await expect(getAnalyticsCohorts()).resolves.toEqual(COHORTS)
    await expect(getExpiring()).resolves.toEqual(expiringReport())
    await expect(getTopPayers(20)).resolves.toEqual(topPayersReport())
    await expect(getLtvDistribution()).resolves.toEqual(ltvReport())
    await expect(getSubscriptionsByPlan()).resolves.toEqual(SUBSCRIPTIONS_BY_PLAN)
    expect(get).toHaveBeenCalledTimes(8)
  })

  it('refuses a body from a panel a release behind rather than draw it half', async () => {
    const { metrics: _metrics, ...older } = overviewReport()
    vi.spyOn(api, 'get').mockResolvedValue({ data: older } as AxiosResponse)
    await expect(getAnalyticsOverview(7)).rejects.toThrow()
  })
})
