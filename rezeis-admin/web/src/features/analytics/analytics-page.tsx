/**
 * «Бизнес-аналитика».
 *
 * One period switch for the tabs that have a period (Обзор, Выручка,
 * Конверсия); the other two say what their cards count instead of offering a
 * switch that would change nothing. Each tab fetches only its own reports, and
 * every one of them is `analytics:view`.
 *
 * THE PAGE ITSELF IS `analytics:view` TOO, checked before any report is asked
 * for. The admin client has no global handler for a 403: without the gate an
 * operator without the right got every card saying «Не удалось загрузить
 * данные» — five requests refused, and nothing said why.
 *
 * The page remembers, for this visit, which charts have played their entrance:
 * a tab or a period is not an arrival, and a chart that has been seen is drawn
 * finished when it comes back (see `analytics-chart-kit.tsx`).
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useIsFetching } from '@tanstack/react-query'
import { BarChart3 } from 'lucide-react'

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { holdsPermission, usePermissionStore } from '@/features/rbac/use-permission-store'
import { cn } from '@/lib/utils'

import { ChartSkeleton, EmptyState, PeriodSwitch } from './analytics-chart-kit'
import type { AnalyticsPeriodDays } from './analytics-chart-support'
import { ConversionTab } from './analytics-conversion-tab'
import { LeadersTab } from './analytics-leaders-tab'
import { OverviewTab } from './analytics-overview-tab'
import { RAMP_ANCHOR_CLASS } from './analytics-palette'
import { RetentionTab } from './analytics-retention-tab'
import { RevenueTab } from './analytics-revenue-tab'
import { useSurfaceMotion } from './surface-motion'

const TABS = ['overview', 'revenue', 'conversion', 'retention', 'leaderboard'] as const
type AnalyticsTab = (typeof TABS)[number]
const WINDOWED: ReadonlySet<AnalyticsTab> = new Set(['overview', 'revenue', 'conversion'])

/** The tab body's entrance, still for anyone who asked for stillness. */
const TAB_CONTENT = 'mt-4 motion-reduce:animate-none'

export default function AnalyticsPage() {
  const role = usePermissionStore((state) => state.role)
  const granted = usePermissionStore((state) => state.granted)
  const loaded = usePermissionStore((state) => state.loaded)
  const failed = usePermissionStore((state) => state.error !== null)
  if (holdsPermission({ role, granted }, 'analytics', 'view')) return <AnalyticsReports />
  return <AnalyticsClosed state={loaded ? 'denied' : failed ? 'unknown' : 'checking'} />
}

function PageHeading() {
  const { t } = useTranslation()
  return (
    <div>
      <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
        <BarChart3 className="h-6 w-6" aria-hidden="true" />
        {t('analyticsPage.title')}
      </h1>
      <p className="text-sm text-muted-foreground">{t('analyticsPage.subtitle')}</p>
    </div>
  )
}

/** The page for a viewer whose rights are not known yet, or do not include it: no report is requested. */
function AnalyticsClosed({ state }: { readonly state: 'checking' | 'denied' | 'unknown' }) {
  const { t } = useTranslation()
  return (
    <div className="space-y-6" data-analytics-access={state}>
      <PageHeading />
      {state === 'checking' ? (
        <ChartSkeleton className="h-40" />
      ) : (
        <EmptyState className="h-40 rounded-lg border">
          {state === 'denied' ? t('analyticsPage.access.denied') : t('analyticsPage.access.unknown')}
        </EmptyState>
      )}
    </div>
  )
}

function AnalyticsReports() {
  const { t } = useTranslation()
  const [days, setDays] = useState<AnalyticsPeriodDays>(30)
  const [activeTab, setActiveTab] = useState<AnalyticsTab>('overview')
  const animate = useSurfaceMotion()
  const fetching = useIsFetching({ queryKey: ['analytics'] }) > 0
  // The charts that have played their entrance during this visit to the page:
  // held here so that switching tabs or periods, which rebuilds everything
  // below, does not replay them.
  const [played] = useState(() => new Set<string>())

  return (
    <div className={cn('space-y-6', RAMP_ANCHOR_CLASS)}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <PageHeading />
        {WINDOWED.has(activeTab) ? (
          <PeriodSwitch value={days} onChange={setDays} busy={fetching} animate={animate} />
        ) : (
          <p className="text-xs text-muted-foreground" data-analytics-period-note="">
            {t(`analyticsPage.periods.independent.${activeTab}`)}
          </p>
        )}
      </div>

      <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as AnalyticsTab)}>
        {/* Wraps on a phone rather than scrolling: a tab past the edge is a tab nobody finds. */}
        <TabsList className="h-auto min-h-10 max-w-full flex-wrap justify-start">
          {TABS.map((tab) => (
            <TabsTrigger key={tab} value={tab}>
              {t(`analyticsPage.tabs.${tab}`)}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="overview" className={TAB_CONTENT}>
          <OverviewTab days={days} played={played} />
        </TabsContent>
        <TabsContent value="revenue" className={TAB_CONTENT}>
          <RevenueTab days={days} played={played} />
        </TabsContent>
        <TabsContent value="conversion" className={TAB_CONTENT}>
          <ConversionTab days={days} played={played} />
        </TabsContent>
        <TabsContent value="retention" className={TAB_CONTENT}>
          <RetentionTab played={played} />
        </TabsContent>
        <TabsContent value="leaderboard" className={TAB_CONTENT}>
          <LeadersTab played={played} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
