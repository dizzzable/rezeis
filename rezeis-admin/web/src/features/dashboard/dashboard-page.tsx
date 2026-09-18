import { Suspense, type JSX } from 'react'
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
import { DashboardSystemHealth } from './dashboard-system-health'
import { DashboardActivityFeed } from './dashboard-activity-feed'
import { lazyWithChunkRecovery as lazy } from '@/lib/lazy-chunk'

// Charts pull Recharts (~439 KB). They sit below the KPI fold, so lazy-load
// them off the dashboard's critical path — Recharts no longer blocks first
// paint of the default `/` route.
const DashboardSubscriptionChart = lazy(() =>
  import('./dashboard-subscription-chart').then((m) => ({ default: m.DashboardSubscriptionChart })),
)
const DashboardOnlineTrend = lazy(() =>
  import('./dashboard-online-trend').then((m) => ({ default: m.DashboardOnlineTrend })),
)
import { DashboardAttentionSection } from './dashboard-attention'
import { DashboardTimelinesSection } from './dashboard-timelines'
import { usePermissionStore } from '@/features/rbac/use-permission-store'
import { activeLocale } from '@/lib/utils'

/**
 * Whether this operator gets the «Онлайн пользователей» card. Its data sits
 * behind `remnawave:view`; without it the card does not render, and the
 * subscription card takes the whole row instead of leaving a hole beside it.
 */
function useCanViewOnline(): boolean {
  return usePermissionStore((s) => s.hasPermission('remnawave', 'view'))
}

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

  const reiwaHealthQuery = useQuery({
    queryKey: adminQueryKeys.dashboard.reiwaSystemHealth,
    queryFn: () => dashboardApi.getReiwaSystemHealth(),
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
      reiwaHealth={reiwaHealthQuery.data ?? null}
      reiwaHealthLoading={reiwaHealthQuery.isLoading}
    />
  )
}

function DashboardContent({
  summary,
  health,
  healthLoading,
  reiwaHealth,
  reiwaHealthLoading,
}: {
  readonly summary: DashboardSummaryInterface
  readonly health: SystemHealthResponse | null
  readonly healthLoading: boolean
  readonly reiwaHealth: SystemHealthResponse | null
  readonly reiwaHealthLoading: boolean
}): JSX.Element {
  const canViewOnline = useCanViewOnline()
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
        {/* SIDE BY SIDE ONLY FROM `xl`. In a narrower half the subscription card
            stacks its rings, legends under them, and grows to about 1000 px;
            the row stretches the trend card to match, and its chart went
            862–902 px tall at 1024–1256 px with the sidebar open. Below `xl`
            the two stack at full width, as they already did below `lg`. */}
        <div className="grid gap-4 xl:grid-cols-2">
          {canViewOnline ? (
            <Suspense fallback={<Skeleton className="h-72 w-full" />}>
              <DashboardOnlineTrend />
            </Suspense>
          ) : null}
          <Suspense fallback={<Skeleton className={canViewOnline ? 'h-72 w-full' : 'h-72 w-full xl:col-span-2'} />}>
            <DashboardSubscriptionChart summary={summary} className={canViewOnline ? undefined : 'xl:col-span-2'} />
          </Suspense>
        </div>
      </AnimatedContent>
      <AnimatedContent delay={0.25}>
        <div className="grid gap-4 lg:grid-cols-2">
          <DashboardSystemHealth
            health={health}
            loading={healthLoading}
            reiwaHealth={reiwaHealth}
            reiwaLoading={reiwaHealthLoading}
          />
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
        {t('dashboardPage.snapshotAt', { time: new Date(summary.checkedAt).toLocaleString(activeLocale()) })}
      </p>
    </div>
  )
}

function DashboardLoadingState(): JSX.Element {
  const { t } = useTranslation()
  const canViewOnline = useCanViewOnline()
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
      {/* The chart row's placeholder, on the loaded row's breakpoint: side by
          side only from `xl`, so the page does not reflow the other way when
          the summary answers. */}
      <div data-testid="dashboard-chart-row-skeleton" className="grid gap-4 xl:grid-cols-2">
        {canViewOnline ? <Skeleton className="h-64 w-full rounded-xl" /> : null}
        <Skeleton className={canViewOnline ? 'h-64 w-full rounded-xl' : 'h-64 w-full rounded-xl xl:col-span-2'} />
      </div>
    </div>
  )
}
