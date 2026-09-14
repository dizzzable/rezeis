import { type JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Activity } from 'lucide-react'

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'

import { dashboardApi, type OnlineTrendPoint } from './dashboard-api'

export function DashboardOnlineTrend(): JSX.Element {
  const { t } = useTranslation()

  const { data: trend, isLoading } = useQuery({
    queryKey: ['admin', 'remnawave', 'online-trend'],
    queryFn: () => dashboardApi.getOnlineTrend(24),
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  })

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Activity className="h-4 w-4" />
            {t('dashboardPage.onlineTrend.title')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-48 w-full" />
        </CardContent>
      </Card>
    )
  }

  if (!trend || trend.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Activity className="h-4 w-4" />
            {t('dashboardPage.onlineTrend.title')}
          </CardTitle>
          <CardDescription>{t('dashboardPage.onlineTrend.noData')}</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground py-8 text-center">
            {t('dashboardPage.onlineTrend.collectingData')}
          </p>
        </CardContent>
      </Card>
    )
  }

  const chartData = trend.map((point: OnlineTrendPoint) => ({
    time: new Date(point.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    online: point.onlineNow,
    nodes: point.nodesOnline,
  }))

  const maxOnline = Math.max(...trend.map((p) => p.onlineNow), 1)

  // THE CHART FILLS THE CARD'S HALF OF THE ROW, UP TO 32rem. This card shares
  // a grid row with the subscription card, which is the taller of the two
  // wherever they sit side by side, and the row stretches both. A fixed 12rem
  // chart left the rest of this card as an empty band under it: 244 px at 1920
  // once the ring legends moved under their rings. The chart now takes the
  // height the row gives the card, never less than 12rem, so nothing outside
  // the card moves, and a card the row does not stretch (one column, below
  // `xl`) keeps the 12rem chart it always had.
  //
  // The ceiling is for the windows where the subscription card still grows
  // tall: side by side at 1280 px it is about 660 px, about 850 with app names
  // long enough to wrap, and about 1050 at the large font size. There the chart
  // stops at 32rem and sits in the middle of the card. Measured in Chromium: at
  // 1920 the chart is 436–452 px with nothing left over, as before; at
  // 1280–1576 px with the sidebar open it is 512 px with at most 22 px to spare.
  return (
    <Card className="flex flex-col">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Activity className="h-4 w-4" />
          {t('dashboardPage.onlineTrend.title')}
        </CardTitle>
        <CardDescription>
          {t('dashboardPage.onlineTrend.description', { max: maxOnline })}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col justify-center">
        <div className="h-full min-h-48 max-h-128">
          <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
            <AreaChart data={chartData} margin={{ top: 5, right: 5, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="onlineGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="hsl(142, 71%, 45%)" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="hsl(142, 71%, 45%)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis
                dataKey="time"
                className="text-xs"
                tick={{ fontSize: 10 }}
                interval="preserveStartEnd"
              />
              <YAxis className="text-xs" tick={{ fontSize: 10 }} width={30} />
              <Tooltip
                contentStyle={{
                  borderRadius: '8px',
                  border: '1px solid var(--border)',
                  backgroundColor: 'var(--background)',
                  fontSize: '12px',
                }}
              />
              <Area
                type="monotone"
                dataKey="online"
                stroke="hsl(142, 71%, 45%)"
                fill="url(#onlineGradient)"
                strokeWidth={2}
                name={t('dashboardPage.onlineTrend.onlineLabel')}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  )
}
