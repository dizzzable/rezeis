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
import { activeLocale } from '@/lib/utils'

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
      {entries.map((entry) => {
        const copy = composeTimelineCopy(entry, t)
        return (
          <li key={entry.id} className="rounded-md border p-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">{copy.title}</span>
              <Badge variant="outline">
                {String(t(`dashboardPage.timelines.financeStatuses.${entry.status}`, entry.status))}
              </Badge>
            </div>
            {copy.description ? (
              <p className="text-sm text-muted-foreground">{copy.description}</p>
            ) : null}
            <p className="text-xs text-muted-foreground">
              {new Date(entry.createdAt).toLocaleString(activeLocale())}
            </p>
          </li>
        )
      })}
    </ul>
  )
}

/**
 * Compose localized title/description for a timeline entry from its structured
 * `kind` + `meta`. Falls back to the backend-composed English `title` /
 * `description` (passed as `defaultValue`) so copy stays deterministic during
 * the async i18n-bundle load gap and for entries without structured meta.
 * Audit action codes are English identifiers and are shown verbatim.
 */
function composeTimelineCopy(
  entry: DashboardTimelineEntryInterface,
  t: ReturnType<typeof useTranslation>['t'],
): { title: string; description: string } {
  const meta = entry.meta ?? {}
  const base = 'dashboardPage.timelines.entries'

  switch (entry.kind) {
    case 'IMPORT':
      return {
        title: String(t(`${base}.import.title`, { source: meta.sourceType ?? '', defaultValue: entry.title })),
        description: String(
          t(`${base}.import.description`, {
            ok: meta.recordsOk ?? 0,
            total: meta.recordsTotal ?? 0,
            failed: meta.recordsFailed ?? 0,
            defaultValue: entry.description,
          }),
        ),
      }
    case 'BROADCAST':
      return {
        title: String(t(`${base}.broadcast.title`, { audience: meta.audience ?? '', defaultValue: entry.title })),
        description: String(
          t(`${base}.broadcast.description`, {
            success: meta.successCount ?? 0,
            total: meta.totalCount ?? 0,
            failed: meta.failedCount ?? 0,
            defaultValue: entry.description,
          }),
        ),
      }
    case 'PAYMENT': {
      const statusCode = (meta.paymentStatus ?? '').toUpperCase()
      const statusWord = String(
        t(`${base}.payment.statuses.${statusCode}`, (meta.paymentStatus ?? '').toLowerCase()),
      )
      return {
        title: String(t(`${base}.payment.title`, { status: statusWord, defaultValue: entry.title })),
        description: String(
          t(`${base}.payment.description`, {
            purchaseType: meta.purchaseType ?? '',
            channel: meta.channel ?? '—',
            amount: meta.amount ?? '0',
            currency: meta.currency ?? '',
            defaultValue: entry.description,
          }),
        ),
      }
    }
    case 'AUDIT':
      // Raw dotted action code — an English identifier, shown verbatim.
      return { title: meta.action ?? entry.title, description: entry.description }
    default:
      return { title: entry.title, description: entry.description }
  }
}
