import { type JSX, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts'

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

import { DashboardClientApps } from './dashboard-client-apps'
import type { DashboardSummaryInterface } from './dashboard-api'

const COLORS = {
  active: 'hsl(142, 71%, 45%)',
  limited: 'hsl(48, 96%, 53%)',
  expired: 'hsl(0, 84%, 60%)',
  expiring: 'hsl(25, 95%, 53%)',
}

export function DashboardSubscriptionChart({
  summary,
}: {
  readonly summary: DashboardSummaryInterface
}): JSX.Element {
  const { t } = useTranslation()

  const data = useMemo(() => [
    {
      name: t('dashboardPage.subscriptionChart.active'),
      value: summary.subscriptions.active,
      color: COLORS.active,
    },
    {
      name: t('dashboardPage.subscriptionChart.limited'),
      value: summary.subscriptions.limited,
      color: COLORS.limited,
    },
    {
      name: t('dashboardPage.subscriptionChart.expired'),
      value: summary.subscriptions.expired,
      color: COLORS.expired,
    },
    {
      name: t('dashboardPage.subscriptionChart.expiring'),
      value: summary.subscriptions.expiring7d,
      color: COLORS.expiring,
    },
  ], [summary, t])

  const total = data.reduce((sum, d) => sum + d.value, 0)

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('dashboardPage.subscriptionChart.title')}</CardTitle>
        <CardDescription>
          {t('dashboardPage.subscriptionChart.description', { total })}
        </CardDescription>
      </CardHeader>
      {/* A CONTAINER query, not a viewport one. This card is the full page
          width below `lg` and half of a two-column grid above it, so the page
          width says nothing about how much room the card itself has. The ring
          of client apps takes the right half only when the CARD is wide enough
          for two rings side by side, and drops underneath when it is not — the
          empty right half the owner pointed at is exactly the wide case. */}
      <CardContent className="@container">
        <div className="grid gap-8 @xl:grid-cols-2">
          <div className="flex items-center gap-6">
            <div className="h-48 w-48 shrink-0">
              <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
                <PieChart>
                  <Pie
                    data={data}
                    cx="50%"
                    cy="50%"
                    innerRadius={50}
                    outerRadius={80}
                    paddingAngle={2}
                    dataKey="value"
                  >
                    {data.map((entry) => (
                      <Cell key={entry.name} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip
                    formatter={(value) => [Number(value ?? 0), '']}
                    contentStyle={{
                      borderRadius: '8px',
                      border: '1px solid var(--border)',
                      backgroundColor: 'var(--background)',
                    }}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div className="flex flex-col gap-3">
              {data.map((item) => (
                <div key={item.name} className="flex items-center gap-2">
                  <div
                    className="h-3 w-3 rounded-full"
                    style={{ backgroundColor: item.color }}
                  />
                  <span className="text-sm text-muted-foreground">{item.name}</span>
                  <span className="text-sm font-medium ml-auto">{item.value}</span>
                </div>
              ))}
            </div>
          </div>
          <DashboardClientApps />
        </div>
      </CardContent>
    </Card>
  )
}
