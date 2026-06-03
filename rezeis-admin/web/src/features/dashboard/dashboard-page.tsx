import { type JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, Loader2, LayoutDashboard } from 'lucide-react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Skeleton } from '@/components/ui/skeleton'
import { TitleEffect } from '@/components/effects/TitleEffect'
import { AnimatedContent } from '@/components/effects/AnimatedContent'
import { adminQueryKeys } from '@/lib/admin-query-keys'

import {
  dashboardApi,
  type DashboardSummaryInterface,
  type SystemHealthResponse,
} from './dashboard-api'
import { DashboardKpiGrid } from './dashboard-kpi-grid'
import { DashboardQuickActions } from './dashboard-quick-actions'
import { DashboardSubscriptionChart } from './dashboard-subscription-chart'
import { DashboardSystemHealth } from './dashboard-system-health'
import { DashboardOnlineTrend } from './dashboard-online-trend'
import { DashboardActivityFeed } from './dashboard-activity-feed'
import { DashboardAttentionSection } from './dashboard-attention'
import { DashboardTimelinesSection } from './dashboard-timelines'

export default function DashboardPage(): JSX.Element {
  const { t } = useTranslation()

  const summaryQuery = useQuery({
    queryKey: adminQueryKeys.dashboard.summary,
    queryFn: () => dashboardApi.getSummary(),
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  })

  const healthQuery = useQuery({
    queryKey: adminQueryKeys.dashboard.systemHealth,
    queryFn: () => dashboardApi.getSystemHealth(),
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
  })

  if (summaryQuery.isLoading) {
    return <DashboardLoadingState />
  }

  if (summaryQuery.isError || !summaryQuery.data) {
    return (
      <Alert variant="destructive" className="max-w-3xl">
        <AlertTriangle className="h-4 w-4" />
        <AlertTitle>{t('dashboardPage.errorTitle')}</AlertTitle>
        <AlertDescription>{t('dashboardPage.errorDescription')}</AlertDescription>
      </Alert>
    )
  }

  return (
    <DashboardContent
      summary={summaryQuery.data}
      health={healthQuery.data ?? null}
      healthLoading={healthQuery.isLoading}
    />
  )
}

function DashboardContent({
  summary,
  health,
  healthLoading,
}: {
  readonly summary: DashboardSummaryInterface
  readonly health: SystemHealthResponse | null
  readonly healthLoading: boolean
}): JSX.Element {
  return (
    <div className="space-y-6">
      <DashboardHeader summary={summary} />
      <AnimatedContent delay={0.1}>
        <DashboardKpiGrid summary={summary} />
      </AnimatedContent>
      <AnimatedContent delay={0.15}>
        <DashboardQuickActions />
      </AnimatedContent>
      <AnimatedContent delay={0.2}>
        <div className="grid gap-4 lg:grid-cols-2">
          <DashboardOnlineTrend />
          <DashboardSubscriptionChart summary={summary} />
        </div>
      </AnimatedContent>
      <AnimatedContent delay={0.25}>
        <div className="grid gap-4 lg:grid-cols-2">
          <DashboardSystemHealth health={health} loading={healthLoading} />
          <DashboardActivityFeed />
        </div>
      </AnimatedContent>
      <AnimatedContent delay={0.3}>
        <DashboardAttentionSection summary={summary} />
      </AnimatedContent>
      <AnimatedContent delay={0.35}>
        <DashboardTimelinesSection summary={summary} />
      </AnimatedContent>
    </div>
  )
}

function DashboardHeader({ summary }: { readonly summary: DashboardSummaryInterface }): JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-1">
      <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
        <LayoutDashboard className="h-6 w-6" />
        <TitleEffect>{t('dashboardPage.title')}</TitleEffect>
      </h1>
      <p className="text-sm text-muted-foreground">
        {t('dashboardPage.snapshotAt', { time: new Date(summary.checkedAt).toLocaleString() })}
      </p>
    </div>
  )
}

function DashboardLoadingState(): JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span>{t('dashboardPage.loading')}</span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 8 }).map((_, index) => (
          <Skeleton key={index} className="h-[78px] w-full rounded-lg" />
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-64 w-full rounded-xl" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    </div>
  )
}
