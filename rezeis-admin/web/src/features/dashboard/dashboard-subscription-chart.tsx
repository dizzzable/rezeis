import { type JSX, useId, useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { Card, CardContent } from '@/components/ui/card'

import { DashboardClientApps } from './dashboard-client-apps'
import { DashboardRing, DashboardRingHeading, type DashboardRingSlice } from './dashboard-ring'
import type { DashboardSummaryInterface } from './dashboard-api'

/** The statuses' colours. Exported so the spec can hold the client-app palette beside them clear of them. */
// eslint-disable-next-line react-refresh/only-export-components
export const SUBSCRIPTION_STATUS_COLORS = {
  active: 'hsl(142, 71%, 45%)',
  limited: 'hsl(48, 96%, 53%)',
  expired: 'hsl(0, 84%, 60%)',
  expiring: 'hsl(25, 95%, 53%)',
} as const

const TOOLTIP_STYLE = {
  borderRadius: '8px',
  border: '1px solid var(--border)',
  backgroundColor: 'var(--background)',
} as const

export function DashboardSubscriptionChart({
  summary,
  className,
}: {
  readonly summary: DashboardSummaryInterface
  /** How the card sits in the page's grid — the whole row when the online card is not shown. */
  readonly className?: string
}): JSX.Element {
  const { t } = useTranslation()
  const titleId = useId()

  const data = useMemo<DashboardRingSlice[]>(() => {
    const { active, limited, expired, expiring7d } = summary.subscriptions
    // "Expiring within 7 days" is PART of active, not a fifth status: the API
    // counts it among ACTIVE subscriptions (`dashboard.service.ts`). Drawn as
    // a slice of its own it is taken out of the active one, so each
    // subscription sits in one slice and the slices add up to the total —
    // which used to count those subscriptions twice, in the heading and in
    // the ring's hole. `min`: the two are separate queries, and a subscription
    // activated between them must not leave the active slice negative.
    //
    // So the green slice is NOT every active subscription, and its label says
    // so ("> 7 days left"). Plain "Active" sat below the "Active subscriptions"
    // card, which counts all of them, and read as the same count disagreeing
    // with itself: 44 beside 52.
    const expiring = Math.min(expiring7d, active)
    return [
      {
        key: 'active',
        name: t('dashboardPage.subscriptionChart.active'),
        value: active - expiring,
        color: SUBSCRIPTION_STATUS_COLORS.active,
      },
      {
        key: 'limited',
        name: t('dashboardPage.subscriptionChart.limited'),
        value: limited,
        color: SUBSCRIPTION_STATUS_COLORS.limited,
      },
      {
        key: 'expired',
        name: t('dashboardPage.subscriptionChart.expired'),
        value: expired,
        color: SUBSCRIPTION_STATUS_COLORS.expired,
      },
      {
        key: 'expiring',
        name: t('dashboardPage.subscriptionChart.expiring'),
        value: expiring,
        color: SUBSCRIPTION_STATUS_COLORS.expiring,
      },
    ]
  }, [summary, t])

  const total = data.reduce((sum, d) => sum + d.value, 0)

  return (
    <Card className={className}>
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
