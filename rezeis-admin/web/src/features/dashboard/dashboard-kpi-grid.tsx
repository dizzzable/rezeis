import { type JSX, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
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

import { cn } from '@/lib/utils'

import {
  dashboardApi,
  dashboardPeriodKey,
  DASHBOARD_PERIODS,
  type DashboardPeriod,
  type DashboardRevenue,
  type DashboardSummaryInterface,
} from './dashboard-api'

/**
 * «Выручка за всё время» as the tile states it: the figure in its currency
 * («≈ 1,8 тыс. ₽» when part of it was converted), the payments it is made of,
 * and the (i) that says what the money is and what was left out.
 *
 * It replaced «Валовой оборот», which added every completed amount across
 * currencies and printed the sum with no unit — 1 000 ₽ and 10 USDT read
 * «1010», a partner's balance spend and a partial refund at face value.
 */
function revenueTile(
  t: TFunction,
  revenue: DashboardRevenue | undefined,
  about: string = t('dashboardPage.kpis.revenueInfo'),
): Pick<KpiItem, 'value' | 'description' | 'info'> {
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
  const paragraphs = [about]
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

/** The viewer's last choice of period, kept in this browser only. */
export const DASHBOARD_PERIOD_PREFERENCE_KEY = 'rezeis.dashboard.kpiPeriod'

function readPeriod(): DashboardPeriod {
  try {
    const raw = window.localStorage.getItem(DASHBOARD_PERIOD_PREFERENCE_KEY)
    return DASHBOARD_PERIODS.find((known) => String(known) === raw) ?? 'all'
  } catch {
    return 'all'
  }
}

function writePeriod(period: DashboardPeriod): void {
  try {
    window.localStorage.setItem(DASHBOARD_PERIOD_PREFERENCE_KEY, String(period))
  } catch {
    // Private window or blocked storage: the choice lasts this page only.
  }
}

export function DashboardKpiGrid({ summary }: { readonly summary: DashboardSummaryInterface }): JSX.Element {
  const { t } = useTranslation()
  const [period, setPeriodState] = useState<DashboardPeriod>(readPeriod)
  const setPeriod = (next: DashboardPeriod): void => {
    setPeriodState(next)
    writePeriod(next)
  }
  const months = period === 'all' ? null : period
  const windowed = useQuery({
    queryKey: dashboardPeriodKey(months ?? 1),
    queryFn: () => dashboardApi.getPeriodSummary(months ?? 1),
    enabled: months !== null,
    staleTime: 60_000,
    refetchInterval: 60_000,
  })
  // Only the figures of the window asked for: while another loads, a dash.
  const inWindow = months !== null && windowed.data?.months === months ? windowed.data : undefined
  const periodName = months === null ? '' : t(`dashboardPage.kpis.period.${months}`)

  const kpis: KpiItem[] = [
    {
      id: 'total-users',
      title: t('dashboardPage.kpis.totalUsers'),
      value: summary.users.total,
      description:
        months === null
          ? t('dashboardPage.kpis.totalUsersDescription', { count: summary.users.recentRegistered7d })
          : inWindow === undefined
            ? undefined
            : t('dashboardPage.kpis.newUsersInPeriod', { count: inWindow.newUsers, period: periodName }),
      icon: Users,
      trend: (inWindow?.newUsers ?? summary.users.recentRegistered7d) > 0 ? 'up' : 'neutral',
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
      title: months === null ? t('dashboardPage.kpis.revenue') : t('dashboardPage.kpis.revenueInPeriod', { period: periodName }),
      ...(months === null
        ? revenueTile(t, summary.revenue)
        : revenueTile(
            t,
            inWindow?.revenue,
            inWindow === undefined
              ? undefined
              : t('dashboardPage.kpis.revenueInfoPeriod', { period: periodName, from: formatShortDate(inWindow.from) }),
          )),
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
      title:
        months === null
          ? t('dashboardPage.kpis.failedPayments')
          : t('dashboardPage.kpis.failedPaymentsInPeriod', { period: periodName }),
      value: months === null ? summary.transactions.failed : (inWindow?.failedPayments ?? '—'),
      icon: AlertCircle,
      trend: (months === null ? summary.transactions.failed : (inWindow?.failedPayments ?? 0)) > 0 ? 'down' : 'neutral',
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
    <div className="space-y-2">
      <div className="flex justify-end">
        <PeriodSwitch value={period} busy={months !== null && inWindow === undefined} onChange={setPeriod} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {kpis.map((kpi) => (
          <KpiCard key={kpi.id} {...kpi} />
        ))}
      </div>
    </div>
  )
}

/**
 * «Всё время · 1 мес · 2 мес · 3 мес» — the look of the online card's range
 * switch. The group's name says which tiles follow it: the rest are a state of
 * things now and have no period.
 *
 * No `overflow-x-auto`, as on the online card's switch. The buttons are 28px
 * inside 2px of padding and a 1px border — 34px in a 32px box — and
 * `overflow-x: auto` turns `overflow-y` to `auto` with it, so the browser drew a
 * vertical scrollbar beside four labels that never needed one. Reported from
 * the dashboard as "не могу понять, зачем там нужен скролл".
 */
function PeriodSwitch({
  value,
  busy,
  onChange,
}: {
  readonly value: DashboardPeriod
  readonly busy: boolean
  readonly onChange: (period: DashboardPeriod) => void
}): JSX.Element {
  const { t } = useTranslation()
  return (
    <div
      role="group"
      aria-label={t('dashboardPage.kpis.periodLabel')}
      title={t('dashboardPage.kpis.periodLabel')}
      aria-busy={busy || undefined}
      className="inline-flex h-8 max-w-full items-center rounded-md border bg-muted/50 p-0.5"
    >
      {DASHBOARD_PERIODS.map((option) => {
        const selected = option === value
        return (
          <button
            key={option}
            type="button"
            aria-pressed={selected}
            data-period={option}
            onClick={() => onChange(option)}
            className={cn(
              'relative h-7 shrink-0 rounded-[5px] px-2.5 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring motion-safe:transition-colors',
              selected ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {t(`dashboardPage.kpis.period.${option}`)}
          </button>
        )
      })}
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
