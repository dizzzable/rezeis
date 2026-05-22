import { type JSX, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

import type {
  DashboardOperationsTimelineSource,
  DashboardSummaryInterface,
  DashboardTimelineEntryInterface,
  DashboardTimelineStatus,
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

export function DashboardTimelinesSection({
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
    if (activeSource === null) return entries
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
    if (activeStatus === null) return entries
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
            <Badge variant="outline">
              {String(t(`dashboardPage.timelines.financeStatuses.${entry.status}`, entry.status))}
            </Badge>
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
