/**
 * «Конверсия»: how many trials turn into payments, how long that takes, what
 * converted customers buy — and, for everyone, how long they take to pay for
 * the first time after signing up.
 *
 * The durations are ordered bins of unequal width (a day, three days, a week…),
 * so they are drawn as bars in their own order, each with its count and share
 * printed at the tip — not as a histogram, whose area would misstate them.
 */
import { type JSX, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ArrowRightLeft, Clock, DollarSign, Hourglass, Tags, Users } from 'lucide-react'

import { cn } from '@/lib/utils'

import { type DaysToPayCount, getTrialConversion, type TrialConversionReport } from './analytics-api'
import {
  ChartCard,
  ChartSkeleton,
  EmptyState,
  MoneyNote,
  RankedBars,
  ZoneNote,
} from './analytics-chart-kit'
import { type AnalyticsRule, useChartEntrance } from './analytics-chart-support'
import { formatCount, formatDays, formatMoney, formatPercent } from './analytics-format'
import { KpiTile } from './analytics-kpi'
import { ACCENT } from './analytics-palette'

export function ConversionTab({ days, played }: { readonly days: number; readonly played: Set<string> }): JSX.Element {
  const { t } = useTranslation()
  const conversion = useQuery({
    queryKey: ['analytics', 'trial-conversion', days],
    queryFn: () => getTrialConversion(days),
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  })
  const report = conversion.data

  if (report === undefined) {
    return conversion.isError ? (
      <EmptyState className="h-40 rounded-lg border">{t('analyticsPage.common.unavailable')}</EmptyState>
    ) : (
      <div className="@container space-y-4" aria-busy="true">
        <div className="grid grid-cols-2 gap-4 @min-[56rem]:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => (
            <ChartSkeleton key={index} className="h-28" />
          ))}
        </div>
        <ChartSkeleton className="h-72" />
      </div>
    )
  }

  return (
    <div
      className={cn('@container space-y-4 motion-safe:transition-opacity', conversion.isPlaceholderData && 'opacity-60')}
      aria-busy={conversion.isPlaceholderData || undefined}
      data-analytics-tab="conversion"
    >
      <ZoneNote fallback={report.timeZoneFallback} />
      <MoneyNote money={report.money} />
      <ConversionKpis report={report} />
      <div className="grid gap-4 @min-[56rem]:grid-cols-2 @min-[88rem]:grid-cols-3">
        <DaysCard
          id="conversion-first-payment"
          played={played}
          title={t('analyticsPage.conversion.firstPayment.title')}
          info={t('analyticsPage.conversion.firstPayment.info')}
          rule="money"
          description={
            report.firstPayment.medianDays === null
              ? t('analyticsPage.conversion.firstPayment.description', { count: report.firstPayment.payers })
              : t('analyticsPage.conversion.firstPayment.descriptionMedian', {
                  count: report.firstPayment.payers,
                  median: t('analyticsPage.conversion.days', { count: Number(report.firstPayment.medianDays.toFixed(1)), value: formatDays(report.firstPayment.medianDays) }),
                })
          }
          icon={<Clock className="size-4 text-muted-foreground" aria-hidden="true" />}
          buckets={report.firstPayment.buckets}
          empty={t('analyticsPage.conversion.firstPayment.empty')}
        />
        <DaysCard
          id="conversion-trial-days"
          played={played}
          title={t('analyticsPage.conversion.trialDays.title')}
          info={t('analyticsPage.conversion.trialDays.info')}
          rule="money"
          description={t('analyticsPage.conversion.trialDays.description', { count: report.convertedUsers })}
          icon={<Hourglass className="size-4 text-muted-foreground" aria-hidden="true" />}
          buckets={report.daysToConvert}
          empty={t('analyticsPage.conversion.trialDays.empty')}
        />
        <TopPlansCard report={report} played={played} className="@min-[56rem]:col-span-2 @min-[88rem]:col-span-1" />
      </div>
    </div>
  )
}

function ConversionKpis({ report }: { readonly report: TrialConversionReport }): JSX.Element {
  const { t } = useTranslation()
  const { money } = report
  const approxMark = money.converted ? '≈\xa0' : ''
  return (
    <div className="grid grid-cols-1 gap-4 @min-[30rem]:grid-cols-2 @min-[56rem]:grid-cols-4" data-kpi-row="">
      <KpiTile
        id="conversionRate"
        icon={ArrowRightLeft}
        label={t('analyticsPage.conversion.rate')}
        info={t('analyticsPage.conversion.rateInfo')}
        rule="money"
        value={report.totalTrialUsers === 0 ? null : formatPercent(report.conversionRate, { digits: 1 })}
        subtitle={t('analyticsPage.conversion.rateSubtitle', {
          converted: formatCount(report.convertedUsers),
          total: formatCount(report.totalTrialUsers),
        })}
      />
      <KpiTile
        id="trialUsers"
        icon={Users}
        label={t('analyticsPage.conversion.trialUsers')}
        value={formatCount(report.totalTrialUsers)}
        subtitle={
          report.windowDays === 365
            ? t('analyticsPage.conversion.trialUsersSubtitleYear')
            : t('analyticsPage.conversion.trialUsersSubtitle', { count: report.windowDays })
        }
      />
      <KpiTile
        id="revenueFromConverted"
        icon={DollarSign}
        label={t('analyticsPage.conversion.revenueFromConverted')}
        info={t('analyticsPage.conversion.revenueInfo')}
        rule="money"
        value={`${approxMark}${formatMoney(report.revenueFromConverted, money.currency, { compact: true })}`}
        subtitle={t('analyticsPage.conversion.revenueSubtitle')}
      />
      <KpiTile
        id="medianDays"
        icon={Clock}
        label={t('analyticsPage.conversion.medianDays')}
        info={t('analyticsPage.conversion.medianDaysInfo')}
        rule="money"
        value={
          report.medianDaysToConvert === null
            ? null
            : t('analyticsPage.conversion.days', { count: Number(report.medianDaysToConvert.toFixed(1)), value: formatDays(report.medianDaysToConvert) })
        }
        subtitle={t('analyticsPage.conversion.medianDaysSubtitle')}
      />
    </div>
  )
}

function DaysCard({
  id,
  played,
  title,
  info,
  rule,
  description,
  icon,
  buckets,
  empty,
}: {
  readonly id: string
  readonly played: Set<string>
  readonly title: string
  readonly info: string
  readonly rule: AnalyticsRule
  readonly description: string
  readonly icon: JSX.Element
  readonly buckets: readonly DaysToPayCount[]
  readonly empty: string
}): JSX.Element {
  const { t } = useTranslation()
  const chartRef = useRef<HTMLDivElement>(null)
  const entrance = useChartEntrance(id, played, chartRef)
  const total = buckets.reduce((sum, bucket) => sum + bucket.users, 0)
  return (
    <ChartCard id={id} title={title} info={info} rule={rule} description={description} icon={icon}>
      {total === 0 ? (
        <EmptyState className="h-56">{empty}</EmptyState>
      ) : (
        <div ref={chartRef}>
          <RankedBars
            animate={entrance.animate && entrance.show}
            rows={buckets.map((bucket) => ({
              key: bucket.key,
              label: t(`analyticsPage.conversion.buckets.${bucket.key}`),
              value: bucket.users,
              valueText: formatCount(bucket.users),
              shareText: formatPercent(bucket.users / total),
              color: ACCENT,
            }))}
          />
        </div>
      )}
    </ChartCard>
  )
}

function TopPlansCard({ report, played, className }: { readonly report: TrialConversionReport; readonly played: Set<string>; readonly className?: string }): JSX.Element {
  const { t } = useTranslation()
  const chartRef = useRef<HTMLDivElement>(null)
  const entrance = useChartEntrance('conversion.topPlans', played, chartRef)
  const plans = report.topConvertedPlans
  return (
    <ChartCard
      id="conversion-top-plans"
      className={className}
      title={t('analyticsPage.conversion.topPlans.title')}
      info={t('analyticsPage.conversion.topPlans.info')}
      rule="money"
      description={t('analyticsPage.conversion.topPlans.description')}
      icon={<Tags className="size-4 text-muted-foreground" aria-hidden="true" />}
    >
      {plans.length === 0 ? (
        <EmptyState className="h-56">{t('analyticsPage.conversion.topPlans.empty')}</EmptyState>
      ) : (
        <div ref={chartRef}>
          <RankedBars
            animate={entrance.animate && entrance.show}
            rows={plans.map((plan) => ({
              key: plan.planId ?? `${plan.kind}:${plan.plan}`,
              label:
                plan.kind === 'addon'
                  ? t('analyticsPage.revenue.byPlan.addons')
                  : plan.kind === 'none'
                    ? t('analyticsPage.revenue.byPlan.none')
                    : plan.plan === ''
                      ? t('analyticsPage.revenue.byPlan.unnamed')
                      : plan.plan,
              value: plan.count,
              valueText: t('analyticsPage.conversion.customers', { count: plan.count }),
              shareText: formatPercent(plan.percentage),
              color: ACCENT,
            }))}
          />
        </div>
      )}
    </ChartCard>
  )
}
