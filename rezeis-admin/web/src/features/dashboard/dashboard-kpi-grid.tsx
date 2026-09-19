import { type JSX } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import {
  Users,
  CreditCard,
  TrendingUp,
  TrendingDown,
  Send,
  Clock,
  AlertCircle,
  Wallet,
} from 'lucide-react'

import { Card } from '@/components/ui/card'
import { InfoTip } from '@/components/ui/info-tip'
import { CountUp } from '@/components/CountUp'
import { HoverEffect } from '@/components/effects/HoverEffect'
import { Noise } from '@/components/effects/Noise'
import { approx } from '@/features/analytics/analytics-chart-support'
import { formatAmounts, formatMoney, formatShortDate } from '@/features/analytics/analytics-format'

import type { DashboardRevenue, DashboardSummaryInterface } from './dashboard-api'

/**
 * «Выручка за всё время» as the tile states it: the figure in its currency
 * («≈ 1,8 тыс. ₽» when part of it was converted), the payments it is made of,
 * and the (i) that says what the money is and what was left out.
 *
 * It replaced «Валовой оборот», which added every completed amount across
 * currencies and printed the sum with no unit — 1 000 ₽ and 10 USDT read
 * «1010», a partner's balance spend and a partial refund at face value.
 */
function revenueTile(t: TFunction, revenue: DashboardRevenue | undefined): Pick<KpiItem, 'value' | 'description' | 'info'> {
  if (revenue === undefined) return { value: '—' }
  const { figure, money } = revenue
  const unconverted = figure.byCurrency.filter((slice) => money.unconverted.includes(slice.currency))
  const value = `${approx(money, figure.byCurrency.map((slice) => slice.currency))}${formatMoney(figure.value, money.currency, { compact: true })}`
  const description = [
    t('dashboardPage.kpis.revenuePayments', { count: revenue.payments }),
    ...(unconverted.length > 0
      ? [t('dashboardPage.kpis.revenueUnconverted', { amount: unconverted.map((slice) => formatMoney(slice.amount, slice.currency, { compact: true })).join(', ') })]
      : []),
  ].join(' · ')
  const paragraphs = [t('dashboardPage.kpis.revenueInfo')]
  if (money.converted) {
    const oldest = money.rates.reduce<string | null>(
      (earliest, rate) => (earliest === null || rate.fetchedAt < earliest ? rate.fetchedAt : earliest),
      null,
    )
    paragraphs.push(
      t('dashboardPage.kpis.revenueConverted', {
        currency: money.currency,
        date: oldest === null ? '—' : formatShortDate(oldest),
        rates: money.rates.map((rate) => `1\xa0${rate.currency} = ${formatMoney(rate.rate, money.currency)}`).join(' · '),
      }),
    )
  }
  if (unconverted.length > 0) {
    paragraphs.push(
      `${t('dashboardPage.kpis.revenueNoRate', {
        count: unconverted.length,
        currencies: unconverted.map((slice) => slice.currency).join(', '),
        amount: formatAmounts(unconverted),
      })} ${t('dashboardPage.kpis.revenueWhereToSetRate')}`,
    )
  }
  return { value, description, info: paragraphs.join('\n\n') }
}

export function DashboardKpiGrid({ summary }: { readonly summary: DashboardSummaryInterface }): JSX.Element {
  const { t } = useTranslation()

  const kpis: KpiItem[] = [
    {
      id: 'total-users',
      title: t('dashboardPage.kpis.totalUsers'),
      value: summary.users.total,
      description: t('dashboardPage.kpis.totalUsersDescription', { count: summary.users.recentRegistered7d }),
      icon: Users,
      trend: summary.users.recentRegistered7d > 0 ? 'up' : 'neutral',
    },
    {
      id: 'active-subscriptions',
      title: t('dashboardPage.kpis.activeSubscriptions'),
      value: summary.subscriptions.active,
      description: t('dashboardPage.kpis.activeSubscriptionsDescription', { count: summary.subscriptions.limited }),
      icon: CreditCard,
      trend: 'neutral',
    },
    {
      id: 'revenue',
      title: t('dashboardPage.kpis.revenue'),
      ...revenueTile(t, summary.revenue),
      icon: Wallet,
      // A sum over all time only ever grows: an arrow beside it would say nothing.
      trend: 'neutral',
    },
    {
      id: 'broadcast-drafts',
      title: t('dashboardPage.kpis.broadcastDrafts'),
      value: summary.operations.broadcastDrafts,
      description: t('dashboardPage.kpis.broadcastDraftsDescription'),
      icon: Send,
      trend: 'neutral',
    },
    {
      id: 'expiring',
      title: t('dashboardPage.kpis.expiring7d'),
      value: summary.subscriptions.expiring7d,
      icon: Clock,
      trend: summary.subscriptions.expiring7d > 5 ? 'down' : 'neutral',
    },
    {
      id: 'pending-payments',
      title: t('dashboardPage.kpis.pendingPayments'),
      value: summary.transactions.pending,
      icon: Clock,
      trend: summary.transactions.pending > 0 ? 'down' : 'neutral',
    },
    {
      id: 'failed-payments',
      title: t('dashboardPage.kpis.failedPayments'),
      value: summary.transactions.failed,
      icon: AlertCircle,
      trend: summary.transactions.failed > 0 ? 'down' : 'neutral',
    },
    {
      id: 'finance-corrections',
      title: t('dashboardPage.kpis.financeCorrections'),
      value: `${summary.financeOps.correctionRequests} / ${summary.financeOps.disputeRecords}`,
      description: t('dashboardPage.kpis.financeCorrectionsDescription', {
        disputes: summary.financeOps.disputeRecords,
        exceptions: summary.financeOps.reconciliationExceptions,
      }),
      icon: TrendingDown,
      trend: 'neutral',
    },
  ]

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {kpis.map((kpi) => (
        <KpiCard key={kpi.id} {...kpi} />
      ))}
    </div>
  )
}

interface KpiItem {
  id: string
  title: string
  value: number | string
  description?: string
  /** What the figure is — an (i) beside the title. */
  info?: string
  icon: React.ComponentType<{ className?: string }>
  trend: 'up' | 'down' | 'neutral'
}

function KpiCard({ id, title, value, description, info, icon: Icon, trend }: KpiItem): JSX.Element {
  const { t } = useTranslation()
  return (
    // `HoverEffect`, not `SpotlightCard` directly: the hover category has a
    // <Select> in Settings → Appearance whose value nothing read while this
    // call site hard-coded one of the three options. Picking "Блик" or "Нет"
    // changed nothing here. The wrapper keeps the same className, so the
    // default (`spotlight`) renders exactly the markup this used to.
    <HoverEffect className="h-full rounded-lg">
      <Card className="relative flex h-full flex-col overflow-hidden p-3" data-dashboard-kpi={id}>
        <Noise opacity={0.03} />
        <div className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground line-clamp-1">
              {title}
            </span>
            {info !== undefined && (
              <InfoTip label={t('dashboardPage.kpis.aboutLabel', { title })} className="relative z-10">
                {info}
              </InfoTip>
            )}
          </span>
          <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </div>
        <div className="mt-1.5 flex items-center gap-1.5">
          <span className="text-xl font-bold leading-none" data-dashboard-kpi-value="">
            {typeof value === 'number' ? <CountUp value={value} /> : value}
          </span>
          {trend === 'up' && <TrendingUp className="h-3.5 w-3.5 text-emerald-500" />}
          {trend === 'down' && <TrendingDown className="h-3.5 w-3.5 text-red-500" />}
        </div>
        <p className="mt-auto pt-1 text-[10px] leading-tight text-muted-foreground line-clamp-1" data-dashboard-kpi-description="">
          {description ?? '\u00A0'}
        </p>
      </Card>
    </HoverEffect>
  )
}
