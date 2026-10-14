/**
 * «Промокоды и скидки»: the share of the window's subscription purchases paid
 * with a discount, how large the discounts were, and whether a client whose
 * first purchase had one buys again — and at the full price.
 *
 * The discount is a difference against the list price, in whole per cent; how
 * it is found for each kind of payment is in the card's (i). It is a count of
 * purchases, never money, so it follows no money rule.
 */
import { type JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { TicketPercent } from 'lucide-react'
import type { TFunction } from 'i18next'

import { cn } from '@/lib/utils'

import { type DiscountBucket, type DiscountReport, type DiscountRepeatGroup, getDiscountReport } from './analytics-api'
import { ChartCard, EmptyState, QueryBody } from './analytics-chart-kit'
import { formatCount, formatPercent } from './analytics-format'
import { ACCENT, GHOST } from './analytics-palette'

export function DiscountsCard({ days }: { readonly days: number }): JSX.Element {
  const { t } = useTranslation()
  const query = useQuery({
    queryKey: ['analytics', 'discounts', days],
    queryFn: () => getDiscountReport(days),
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  })
  return (
    <ChartCard
      id="revenue-discounts"
      title={t('analyticsPage.revenue.discounts.title')}
      icon={<TicketPercent className="size-4 text-muted-foreground" aria-hidden="true" />}
      info={t('analyticsPage.revenue.discounts.info', { days: query.data?.repeat.afterDays ?? 7 })}
      description={t('analyticsPage.revenue.discounts.description')}
    >
      <QueryBody query={query} height="h-64">
        {(report) =>
          report.purchases === 0 ? (
            <EmptyState className="h-40">{t('analyticsPage.revenue.discounts.empty')}</EmptyState>
          ) : (
            <DiscountsBody report={report} />
          )
        }
      </QueryBody>
    </ChartCard>
  )
}

function bucketLabel(t: TFunction, bucket: DiscountBucket): string {
  return bucket.to === null
    ? t('analyticsPage.revenue.discounts.bucketOpen', { from: bucket.from })
    : t('analyticsPage.revenue.discounts.bucketRange', { from: bucket.from, to: bucket.to - 1 })
}

function DiscountsBody({ report }: { readonly report: DiscountReport }): JSX.Element {
  const { t } = useTranslation()
  const share = report.discounted / report.purchases
  // The smallest bucket is shown only when somebody is in it: a 1-9 % discount is rare, and an empty bar is noise.
  const buckets = report.buckets.filter((bucket, index) => index > 0 || bucket.purchases > 0)
  const peak = Math.max(1, ...buckets.map((bucket) => bucket.purchases))
  return (
    <div className="space-y-5" data-discounts="">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 @min-[40rem]:max-w-md" data-discounts-header="">
        <div>
          <dt className="text-xs text-muted-foreground">{t('analyticsPage.revenue.discounts.shareLabel')}</dt>
          <dd className="text-2xl font-semibold tabular-nums" data-discounts-share="">{formatPercent(share)}</dd>
          <dd className="text-xs text-muted-foreground">
            {t('analyticsPage.revenue.discounts.shareOf', { discounted: formatCount(report.discounted), purchases: formatCount(report.purchases) })}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{t('analyticsPage.revenue.discounts.averageLabel')}</dt>
          <dd className="text-2xl font-semibold tabular-nums" data-discounts-average="">
            {report.averageDiscount === null ? '—' : `${formatPercent(report.averageDiscount / 100)}`}
          </dd>
        </div>
      </dl>

      <ul className="space-y-2" data-discounts-buckets="" aria-label={t('analyticsPage.revenue.discounts.bucketsLabel')}>
        {buckets.map((bucket) => (
          <li key={bucket.from} data-discount-bucket={bucket.from}>
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span>{bucketLabel(t, bucket)}</span>
              <span className="tabular-nums">
                <span className="font-medium">{formatCount(bucket.purchases)}</span>{' '}
                <span className="text-xs text-muted-foreground">
                  {report.discounted === 0 ? '—' : formatPercent(bucket.purchases / report.discounted)}
                </span>
              </span>
            </div>
            <div aria-hidden="true" className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full" style={{ width: `${Math.round((bucket.purchases / peak) * 100)}%`, backgroundColor: ACCENT }} />
            </div>
          </li>
        ))}
      </ul>

      <RepeatBlock report={report} />

      {report.unknown > 0 && (
        <p className="text-xs text-muted-foreground" data-discounts-unknown="">
          {t('analyticsPage.revenue.discounts.unknown', { count: report.unknown })}
        </p>
      )}
    </div>
  )
}

function RepeatBlock({ report }: { readonly report: DiscountReport }): JSX.Element {
  const { t } = useTranslation()
  const { repeat } = report
  const rows: readonly { readonly key: string; readonly label: string; readonly group: DiscountRepeatGroup; readonly color: string }[] = [
    { key: 'discount', label: t('analyticsPage.revenue.discounts.firstWithDiscount'), group: repeat.withDiscount, color: ACCENT },
    { key: 'full', label: t('analyticsPage.revenue.discounts.firstWithoutDiscount'), group: repeat.withoutDiscount, color: GHOST },
  ]
  return (
    <section className="space-y-2 border-t pt-4" data-discounts-repeat="" aria-labelledby="discounts-repeat-title">
      <h4 id="discounts-repeat-title" className="text-sm font-medium">{t('analyticsPage.revenue.discounts.repeatTitle')}</h4>
      <p className="text-xs text-muted-foreground">{t('analyticsPage.revenue.discounts.repeatHint', { days: repeat.afterDays })}</p>
      <ul className="space-y-2">
        {rows.map((row) => {
          const ratio = row.group.clients === 0 ? 0 : row.group.boughtAgain / row.group.clients
          return (
            <li key={row.key} data-discounts-first={row.key}>
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span>{row.label}</span>
                <span className="tabular-nums">
                  <span className={cn('font-medium', row.group.clients === 0 && 'text-muted-foreground')}>
                    {row.group.clients === 0 ? '—' : formatPercent(ratio)}
                  </span>{' '}
                  <span className="text-xs text-muted-foreground">
                    {t('analyticsPage.revenue.discounts.boughtAgain', { again: formatCount(row.group.boughtAgain), clients: formatCount(row.group.clients) })}
                  </span>
                </span>
              </div>
              <div aria-hidden="true" className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full" style={{ width: `${Math.round(ratio * 100)}%`, backgroundColor: row.color }} />
              </div>
            </li>
          )
        })}
      </ul>
      <p className="text-xs text-muted-foreground" data-discounts-footnote="">
        {repeat.secondPriceKnown === 0
          ? t('analyticsPage.revenue.discounts.footnoteNone')
          : t('analyticsPage.revenue.discounts.footnote', {
              share: formatPercent(repeat.secondFullPrice / repeat.secondPriceKnown),
              full: formatCount(repeat.secondFullPrice),
              known: formatCount(repeat.secondPriceKnown),
            })}
      </p>
    </section>
  )
}
