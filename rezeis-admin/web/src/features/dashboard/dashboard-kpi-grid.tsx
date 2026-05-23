import { type JSX } from 'react'
import { useTranslation } from 'react-i18next'
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
import { CountUp } from '@/components/CountUp'
import { SpotlightCard } from '@/components/effects/SpotlightCard'
import { Noise } from '@/components/effects/Noise'

import type { DashboardSummaryInterface } from './dashboard-api'

export function DashboardKpiGrid({ summary }: { readonly summary: DashboardSummaryInterface }): JSX.Element {
  const { t } = useTranslation()

  const kpis: KpiItem[] = [
    {
      title: t('dashboardPage.kpis.totalUsers'),
      value: summary.users.total,
      description: t('dashboardPage.kpis.totalUsersDescription', { count: summary.users.recentRegistered7d }),
      icon: Users,
      trend: summary.users.recentRegistered7d > 0 ? 'up' : 'neutral',
    },
    {
      title: t('dashboardPage.kpis.activeSubscriptions'),
      value: summary.subscriptions.active,
      description: t('dashboardPage.kpis.activeSubscriptionsDescription', { count: summary.subscriptions.limited }),
      icon: CreditCard,
      trend: 'neutral',
    },
    {
      title: t('dashboardPage.kpis.grossVolume'),
      value: summary.transactions.grossVolume,
      description: t('dashboardPage.kpis.grossVolumeDescription', { count: summary.transactions.completed }),
      icon: Wallet,
      trend: 'up',
    },
    {
      title: t('dashboardPage.kpis.broadcastDrafts'),
      value: summary.operations.broadcastDrafts,
      description: t('dashboardPage.kpis.broadcastDraftsDescription'),
      icon: Send,
      trend: 'neutral',
    },
    {
      title: t('dashboardPage.kpis.expiring7d'),
      value: summary.subscriptions.expiring7d,
      icon: Clock,
      trend: summary.subscriptions.expiring7d > 5 ? 'down' : 'neutral',
    },
    {
      title: t('dashboardPage.kpis.pendingPayments'),
      value: summary.transactions.pending,
      icon: Clock,
      trend: summary.transactions.pending > 0 ? 'down' : 'neutral',
    },
    {
      title: t('dashboardPage.kpis.failedPayments'),
      value: summary.transactions.failed,
      icon: AlertCircle,
      trend: summary.transactions.failed > 0 ? 'down' : 'neutral',
    },
    {
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
        <KpiCard key={kpi.title} {...kpi} />
      ))}
    </div>
  )
}

interface KpiItem {
  title: string
  value: number | string
  description?: string
  icon: React.ComponentType<{ className?: string }>
  trend: 'up' | 'down' | 'neutral'
}

function KpiCard({ title, value, description, icon: Icon, trend }: KpiItem): JSX.Element {
  return (
    <SpotlightCard className="h-full rounded-lg">
      <Card className="relative flex h-full flex-col overflow-hidden p-3">
        <Noise opacity={0.03} />
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground line-clamp-1">
            {title}
          </span>
          <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </div>
        <div className="mt-1.5 flex items-center gap-1.5">
          <span className="text-xl font-bold leading-none">
            {typeof value === 'number' ? <CountUp value={value} /> : value}
          </span>
          {trend === 'up' && <TrendingUp className="h-3.5 w-3.5 text-emerald-500" />}
          {trend === 'down' && <TrendingDown className="h-3.5 w-3.5 text-red-500" />}
        </div>
        <p className="mt-auto pt-1 text-[10px] leading-tight text-muted-foreground line-clamp-1">
          {description ?? '\u00A0'}
        </p>
      </Card>
    </SpotlightCard>
  )
}
