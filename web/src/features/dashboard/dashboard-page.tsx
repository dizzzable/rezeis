import { useMemo, useState, type JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, Loader2 } from 'lucide-react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { CountUp } from '@/components/CountUp'
import {
  dashboardApi,
  type DashboardOperationsTimelineSource,
  type DashboardSummaryInterface,
  type DashboardTimelineEntryInterface,
  type DashboardTimelineStatus,
} from './dashboard-api'

const OPERATIONS_FILTER_OPTIONS: ReadonlyArray<DashboardOperationsTimelineSource> = [
  'BROADCAST',
  'IMPORT',
  'AUDIT',
  'OPS',
]

const FINANCE_FILTER_OPTIONS: ReadonlyArray<DashboardTimelineStatus> = [
  'INFO',
  'WARNING',
  'SUCCESS',
  'PENDING',
  'ERROR',
]

const SEVERITY_BADGE_VARIANT = {
  INFO: 'secondary',
  WARNING: 'default',
  CRITICAL: 'destructive',
} as const

export default function DashboardPage(): JSX.Element {
  const { t } = useTranslation()
  const summaryQuery = useQuery({
    queryKey: ['admin', 'dashboard', 'summary'],
    queryFn: () => dashboardApi.getSummary(),
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

  return <DashboardContent summary={summaryQuery.data} />
}

function DashboardContent({ summary }: { readonly summary: DashboardSummaryInterface }): JSX.Element {
  return (
    <div className="space-y-8">
      <DashboardHeader summary={summary} />
      <DashboardKpiGrid summary={summary} />
      <DashboardAttentionSection summary={summary} />
      <DashboardTimelinesSection summary={summary} />
    </div>
  )
}

function DashboardHeader({ summary }: { readonly summary: DashboardSummaryInterface }): JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-1">
      <h1 className="text-2xl font-bold tracking-tight">{t('dashboardPage.title')}</h1>
      <p className="text-sm text-muted-foreground">
        {t('dashboardPage.snapshotAt', { time: new Date(summary.checkedAt).toLocaleString() })}
      </p>
    </div>
  )
}

function DashboardKpiGrid({ summary }: { readonly summary: DashboardSummaryInterface }): JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
      <KpiCard
        title={t('dashboardPage.kpis.totalUsers')}
        value={summary.users.total}
        description={t('dashboardPage.kpis.totalUsersDescription', { count: summary.users.recentRegistered7d })}
      />
      <KpiCard
        title={t('dashboardPage.kpis.activeSubscriptions')}
        value={summary.subscriptions.active}
        description={t('dashboardPage.kpis.activeSubscriptionsDescription', { count: summary.subscriptions.limited })}
      />
      <KpiCard
        title={t('dashboardPage.kpis.grossVolume')}
        value={summary.transactions.grossVolume}
        description={t('dashboardPage.kpis.grossVolumeDescription', { count: summary.transactions.completed })}
      />
      <KpiCard
        title={t('dashboardPage.kpis.broadcastDrafts')}
        value={summary.operations.broadcastDrafts}
        description={t('dashboardPage.kpis.broadcastDraftsDescription')}
      />
      <KpiCard
        title={t('dashboardPage.kpis.expiring7d')}
        value={summary.subscriptions.expiring7d}
      />
      <KpiCard
        title={t('dashboardPage.kpis.pendingPayments')}
        value={summary.transactions.pending}
      />
      <KpiCard title={t('dashboardPage.kpis.failedPayments')} value={summary.transactions.failed} />
      <KpiCard
        title={t('dashboardPage.kpis.financeCorrections')}
        value={`${summary.financeOps.correctionRequests} / ${summary.financeOps.disputeRecords}`}
        description={t('dashboardPage.kpis.financeCorrectionsDescription', {
          disputes: summary.financeOps.disputeRecords,
          exceptions: summary.financeOps.reconciliationExceptions,
        })}
      />
    </div>
  )
}

function KpiCard({
  title,
  value,
  description,
}: {
  readonly title: string
  readonly value: number | string
  readonly description?: string
}): JSX.Element {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">
          {typeof value === 'number' ? <CountUp value={value} /> : value}
        </div>
        {description !== undefined ? (
          <p className="text-xs text-muted-foreground mt-1">{description}</p>
        ) : null}
      </CardContent>
    </Card>
  )
}

function DashboardAttentionSection({
  summary,
}: {
  readonly summary: DashboardSummaryInterface
}): JSX.Element {
  const { t } = useTranslation()
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('dashboardPage.attention.title')}</CardTitle>
        <CardDescription>{t('dashboardPage.attention.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {summary.attentionItems.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t('dashboardPage.attention.empty')}
          </p>
        ) : (
          summary.attentionItems.map((item) => (
            <div
              key={item.safeKey}
              className="flex flex-col gap-1 rounded-md border p-3"
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">{item.title}</span>
                <Badge variant={SEVERITY_BADGE_VARIANT[item.severity]}>
                  {String(t(`dashboardPage.severities.${item.severity}`, item.severity))}
                </Badge>
              </div>
              <p className="text-sm text-muted-foreground">{item.description}</p>
              <p className="text-xs text-muted-foreground">
                {new Date(item.occurredAt).toLocaleString()}
              </p>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  )
}

function DashboardTimelinesSection({
  summary,
}: {
  readonly summary: DashboardSummaryInterface
}): JSX.Element {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <OperationsTimeline entries={summary.operationsTimeline} />
      <FinanceOpsTimeline entries={summary.financeOpsTimeline} />
    </div>
  )
}

function OperationsTimeline({
  entries,
}: {
  readonly entries: readonly DashboardTimelineEntryInterface[]
}): JSX.Element {
  const { t } = useTranslation()
  const [activeSource, setActiveSource] =
    useState<DashboardOperationsTimelineSource | null>(null)

  const visibleEntries = useMemo(() => {
    if (activeSource === null) {
      return entries
    }
    return entries.filter((entry) => entry.source === activeSource)
  }, [activeSource, entries])

  return (
    <Card>
      <CardHeader className="space-y-3">
        <CardTitle>{t('dashboardPage.timelines.operationsTitle')}</CardTitle>
        <div className="flex flex-wrap gap-2">
          {OPERATIONS_FILTER_OPTIONS.map((source) => (
            <Button
              key={source}
              size="sm"
              variant={activeSource === source ? 'default' : 'outline'}
              onClick={() =>
                setActiveSource((current) => (current === source ? null : source))
              }
            >
              {String(t(`dashboardPage.timelines.operationsSources.${source}`, source))}
            </Button>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        {visibleEntries.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t('dashboardPage.timelines.operationsEmpty')}
          </p>
        ) : (
          <TimelineEntries entries={visibleEntries} />
        )}
      </CardContent>
    </Card>
  )
}

function FinanceOpsTimeline({
  entries,
}: {
  readonly entries: readonly DashboardTimelineEntryInterface[]
}): JSX.Element {
  const { t } = useTranslation()
  const [activeStatus, setActiveStatus] = useState<DashboardTimelineStatus | null>(null)

  const visibleEntries = useMemo(() => {
    if (activeStatus === null) {
      return entries
    }
    return entries.filter((entry) => entry.status === activeStatus)
  }, [activeStatus, entries])

  return (
    <Card>
      <CardHeader className="space-y-3">
        <CardTitle>{t('dashboardPage.timelines.financeTitle')}</CardTitle>
        <div className="flex flex-wrap gap-2">
          {FINANCE_FILTER_OPTIONS.map((status) => (
            <Button
              key={status}
              size="sm"
              variant={activeStatus === status ? 'default' : 'outline'}
              onClick={() =>
                setActiveStatus((current) => (current === status ? null : status))
              }
            >
              {String(t(`dashboardPage.timelines.financeStatuses.${status}`, status))}
            </Button>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        {visibleEntries.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t('dashboardPage.timelines.financeEmpty')}
          </p>
        ) : (
          <TimelineEntries entries={visibleEntries} />
        )}
      </CardContent>
    </Card>
  )
}

function TimelineEntries({
  entries,
}: {
  readonly entries: readonly DashboardTimelineEntryInterface[]
}): JSX.Element {
  const { t } = useTranslation()
  return (
    <ul className="space-y-3">
      {entries.map((entry) => (
        <li key={entry.id} className="rounded-md border p-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">{entry.title}</span>
            <Badge variant="outline">{String(t(`dashboardPage.timelines.financeStatuses.${entry.status}`, entry.status))}</Badge>
          </div>
          <p className="text-sm text-muted-foreground">{entry.description}</p>
          <p className="text-xs text-muted-foreground">
            {new Date(entry.createdAt).toLocaleString()}
          </p>
        </li>
      ))}
    </ul>
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
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 8 }).map((_, index) => (
          <Skeleton key={index} className="h-24 w-full" />
        ))}
      </div>
    </div>
  )
}
