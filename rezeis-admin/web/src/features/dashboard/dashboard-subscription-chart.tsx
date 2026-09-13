import { type JSX, useId, useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { Card, CardContent } from '@/components/ui/card'

import { DashboardClientApps } from './dashboard-client-apps'
import { DashboardRing, DashboardRingHeading, type DashboardRingSlice } from './dashboard-ring'
import type { DashboardSummaryInterface } from './dashboard-api'

const COLORS = {
  active: 'hsl(142, 71%, 45%)',
  limited: 'hsl(48, 96%, 53%)',
  expired: 'hsl(0, 84%, 60%)',
  expiring: 'hsl(25, 95%, 53%)',
}

const TOOLTIP_STYLE = {
  borderRadius: '8px',
  border: '1px solid var(--border)',
  backgroundColor: 'var(--background)',
} as const

export function DashboardSubscriptionChart({
  summary,
}: {
  readonly summary: DashboardSummaryInterface
}): JSX.Element {
  const { t } = useTranslation()
  const titleId = useId()

  const data = useMemo<DashboardRingSlice[]>(() => [
    {
      key: 'active',
      name: t('dashboardPage.subscriptionChart.active'),
      value: summary.subscriptions.active,
      color: COLORS.active,
    },
    {
      key: 'limited',
      name: t('dashboardPage.subscriptionChart.limited'),
      value: summary.subscriptions.limited,
      color: COLORS.limited,
    },
    {
      key: 'expired',
      name: t('dashboardPage.subscriptionChart.expired'),
      value: summary.subscriptions.expired,
      color: COLORS.expired,
    },
    {
      key: 'expiring',
      name: t('dashboardPage.subscriptionChart.expiring'),
      value: summary.subscriptions.expiring7d,
      color: COLORS.expiring,
    },
  ], [summary, t])

  const total = data.reduce((sum, d) => sum + d.value, 0)

  return (
    <Card>
      {/* A CONTAINER query, not a viewport one. This card is the full page
          width below `lg` and half of a two-column grid above it, so the page
          width says nothing about how much room the card itself has. The ring
          of client apps takes the right half only when the CARD is wide enough
          for two rings side by side, and drops underneath when it is not — the
          empty right half the owner pointed at is exactly the wide case.

          No CardHeader: each half carries its own heading as the first row of
          its column (see `dashboard-ring.tsx`), which is what puts the two
          titles on one line. */}
      <CardContent className="@container pt-6">
        <div className="grid gap-8 @xl:grid-cols-2">
          <section aria-labelledby={titleId} className="flex min-w-0 flex-col gap-5">
            <DashboardRingHeading
              id={titleId}
              title={t('dashboardPage.subscriptionChart.title')}
              description={t('dashboardPage.subscriptionChart.description', { total })}
            />
            <DashboardRing slices={data} total={total} tooltipStyle={TOOLTIP_STYLE} />
          </section>
          <DashboardClientApps />
        </div>
      </CardContent>
    </Card>
  )
}
